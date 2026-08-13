import {
  ValidationBrowserSession,
  createRunArtifacts,
  ensureValidationServer,
  loadValidationConfig,
  runFrontendValidation,
  artifactFromPath,
  type ManagedValidationServer,
  type ValidationAction,
  type ValidationBrowserController,
} from '@personal-agent/validation';
import { join, resolve } from 'node:path';
import { BaseTool, type ToolContext, type ToolResult } from '../types';

interface BrowserEntry {
  browser: ValidationBrowserController;
  server: ManagedValidationServer;
  artifactDirectory: string;
  projectHash: string;
  runId: string;
  /** 自动截图序号：每个动作后 +1，保证工件文件名唯一。 */
  shotIndex: number;
}

const sessions = new Map<string, BrowserEntry>();
const hostCleanupSubscriptions = new WeakMap<object, () => void>();
const BROWSER_SNAPSHOT_TIMEOUT_MS = 10_000;
const BROWSER_SCREENSHOT_TIMEOUT_MS = 8_000;
const BROWSER_CLOSE_TIMEOUT_MS = 8_000;
const SERVER_STOP_TIMEOUT_MS = 15_000;

/**
 * 自动截取当前页面（视口尺寸，速度快）并生成工件元数据，
 * 前端借此在「浏览器」Tab 与工具卡片中实时展示页面画面。
 * 截图失败不影响动作本身的结果（返回空 metadata）。
 */
async function capturePageScreenshot(
  entry: BrowserEntry,
  prefix: string,
): Promise<ToolResult['metadata']> {
  try {
    entry.shotIndex += 1;
    const name = `${prefix}-${entry.shotIndex}.png`;
    const path = join(entry.artifactDirectory, name);
    await withBrowserTimeout(
      entry.browser.screenshot(path, false),
      BROWSER_SCREENSHOT_TIMEOUT_MS,
      'Embedded browser screenshot timed out. The page remains available without a screenshot artifact.',
    );
    const artifact = await artifactFromPath(path, 'screenshot', 'image/png');
    return {
      duration: 0,
      artifacts: [artifact],
      validation: screenshotValidation(entry, 'Live page screenshot.'),
    };
  } catch {
    return { duration: 0 };
  }
}

/** 手动截图 / 自动截图共用的验证元数据（前端据此解析工件 URL）。 */
function screenshotValidation(
  entry: BrowserEntry,
  summary: string,
): NonNullable<ToolResult['metadata']>['validation'] {
  return {
    runId: entry.runId,
    projectHash: entry.projectHash,
    profile: 'quick',
    status: 'passed',
    summary,
    durationMs: 0,
    steps: [],
    issues: [],
    vision: { status: 'skipped', reason: 'Screenshot artifact only.' },
  };
}

export class BrowserOpenTool extends BaseTool {
  readonly name = 'browser_open';
  readonly description =
    'Open an isolated local browser session using ~/.personal-agent/validation.yaml. External URLs are rejected.';
  readonly category = 'web' as const;
  readonly requiresPermission = true;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string' as const,
        description: 'Optional localhost URL; defaults to server.url.',
      },
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    observeHostCleanup(context);
    await closeEntry(context.sessionId);
    const config = await loadValidationConfig(context.workingDirectory);
    let server: ManagedValidationServer | undefined;
    try {
      server = await ensureValidationServer(config, context.workingDirectory, context.signal);
    } catch (error) {
      if (context.browserHost) await context.browserHost.close(context.sessionId);
      throw error;
    }
    const run = await createRunArtifacts(
      context.workingDirectory,
      config.artifacts.root ? resolve(context.workingDirectory, config.artifacts.root) : undefined,
    );
    let browser: ValidationBrowserController | undefined;
    try {
      browser = context.browserHost
        ? await context.browserHost.acquire({
            sessionId: context.sessionId,
            config,
            workingDirectory: context.workingDirectory,
            reset: true,
          })
        : new ValidationBrowserSession(config, context.workingDirectory);
      await browser.open(typeof params.url === 'string' ? params.url : undefined);
    } catch (error) {
      await cleanupAfterOpenFailure(browser, server);
      throw error;
    }
    sessions.set(context.sessionId, {
      browser,
      server,
      artifactDirectory: run.directory,
      projectHash: run.projectHash,
      runId: run.runId,
      shotIndex: 0,
    });
    const entry = sessions.get(context.sessionId)!;
    try {
      const snapshot = await snapshotWithTimeout(browser);
      return this.success(
        JSON.stringify(snapshot, null, 2),
        await capturePageScreenshot(entry, 'open'),
      );
    } catch (error) {
      await closeEntry(context.sessionId).catch(() => undefined);
      throw error;
    }
  }
}

export class BrowserSnapshotTool extends BaseTool {
  readonly name = 'browser_snapshot';
  readonly description =
    'Return the current local browser URL, visible text, and interactive DOM elements.';
  readonly category = 'web' as const;
  readonly inputSchema = { type: 'object' as const, properties: {} };

  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const entry = requireEntry(context.sessionId);
    const snapshot = await snapshotWithTimeout(entry.browser);
    return this.success(
      JSON.stringify(snapshot, null, 2),
      await capturePageScreenshot(entry, 'snapshot'),
    );
  }
}

export class BrowserActTool extends BaseTool {
  readonly name = 'browser_act';
  readonly description =
    'Perform one deterministic browser action. Locators must resolve to exactly one element.';
  readonly category = 'web' as const;
  readonly requiresPermission = true;
  readonly inputSchema = {
    type: 'object' as const,
    required: ['action'],
    properties: {
      action: {
        type: 'string' as const,
        enum: ['click', 'fill', 'press', 'check', 'uncheck', 'select', 'wait'],
      },
      role: { type: 'string' as const },
      name: { type: 'string' as const },
      testId: { type: 'string' as const },
      text: { type: 'string' as const },
      selector: { type: 'string' as const },
      value: { type: 'string' as const },
      key: { type: 'string' as const },
      timeoutMs: { type: 'number' as const },
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const entry = requireEntry(context.sessionId);
    await entry.browser.act(params as unknown as ValidationAction);
    const snapshot = await snapshotWithTimeout(entry.browser);
    return this.success(
      JSON.stringify(snapshot, null, 2),
      await capturePageScreenshot(entry, 'act'),
    );
  }
}

export class BrowserScreenshotTool extends BaseTool {
  readonly name = 'browser_screenshot';
  readonly description = 'Capture a PNG screenshot from the current local browser session.';
  readonly category = 'web' as const;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const, description: 'Artifact file name without directories.' },
      fullPage: { type: 'boolean' as const },
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const entry = requireEntry(context.sessionId);
    const baseName =
      typeof params.name === 'string'
        ? params.name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/\.png$/i, '')
        : 'browser';
    const path = join(entry.artifactDirectory, `${baseName || 'browser'}.png`);
    await withBrowserTimeout(
      entry.browser.screenshot(path, params.fullPage !== false),
      BROWSER_SCREENSHOT_TIMEOUT_MS,
      'Embedded browser screenshot timed out. Check that the browser view has a non-zero viewport.',
    );
    const artifact = await artifactFromPath(path, 'screenshot', 'image/png');
    return this.success(`Screenshot captured: ${artifact.name}`, {
      duration: 0,
      artifacts: [artifact],
      validation: screenshotValidation(entry, 'Manual browser screenshot captured.'),
    });
  }
}

export class BrowserCloseTool extends BaseTool {
  readonly name = 'browser_close';
  readonly description =
    'Close the isolated Chromium session and any development server it started.';
  readonly category = 'web' as const;
  readonly inputSchema = { type: 'object' as const, properties: {} };

  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    await closeEntry(context.sessionId);
    return this.success('Browser session closed.');
  }
}

export class FrontendValidateTool extends BaseTool {
  readonly name = 'frontend_validate';
  readonly description =
    'Run the repository frontend validation profile and return hard DOM/interaction/console/network evidence plus screenshots and trace artifacts.';
  readonly category = 'utility' as const;
  readonly requiresPermission = true;
  readonly inputSchema = {
    type: 'object' as const,
    properties: {
      profile: { type: 'string' as const, enum: ['quick', 'full'] },
    },
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    observeHostCleanup(context);
    const existing = sessions.get(context.sessionId);
    let embeddedBrowserAcquireStarted = false;
    const result = await runFrontendValidation({
      workingDirectory: context.workingDirectory,
      profile: params.profile === 'full' ? 'full' : 'quick',
      signal: context.signal,
      onProgress: context.onProgress,
      visualReviewer: context.reviewImage,
      browserHost: context.browserHost,
      browserSessionId: context.sessionId,
      server: context.browserHost ? existing?.server : undefined,
      retainResources: Boolean(context.browserHost),
      acquireTraceLock: context.browserHost ? acquireTraceLock : undefined,
      onBrowserAcquireStarted: context.browserHost
        ? () => {
            embeddedBrowserAcquireStarted = true;
          }
        : undefined,
      onResourcesAcquired: context.browserHost
        ? async (resources) => {
            sessions.set(context.sessionId, {
              browser: resources.browser,
              server: resources.server,
              artifactDirectory: resources.artifactDirectory,
              projectHash: resources.projectHash,
              runId: resources.runId,
              shotIndex: 0,
            });
            if (existing && existing.server !== resources.server) {
              await existing.server.stop();
            }
          }
        : undefined,
    });
    if (
      context.browserHost &&
      embeddedBrowserAcquireStarted &&
      result.status === 'infrastructure_error'
    ) {
      if (sessions.has(context.sessionId)) await closeEntry(context.sessionId);
      else await context.browserHost.close(context.sessionId);
    }
    const summary = {
      runId: result.runId,
      projectHash: result.projectHash,
      profile: result.profile,
      status: result.status,
      summary: result.summary,
      durationMs: result.durationMs,
      steps: result.steps,
      issues: result.issues,
      vision: result.vision,
    };
    const content = [
      result.summary,
      ...result.issues.map(
        (issue) =>
          `- [${issue.source}] ${issue.scenario ? `${issue.scenario}: ` : ''}${issue.message}`,
      ),
      `Artifacts: ${result.artifacts.map((artifact) => artifact.name).join(', ') || 'none'}`,
    ].join('\n');
    return {
      success: result.status === 'passed',
      content,
      error: result.status === 'passed' ? undefined : result.summary,
      metadata: { duration: result.durationMs, artifacts: result.artifacts, validation: summary },
    };
  }
}

function requireEntry(sessionId: string): BrowserEntry {
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error('No browser session is open. Call browser_open first.');
  return entry;
}

async function closeEntry(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  const results = await Promise.allSettled([
    withBrowserTimeout(
      entry.browser.close(),
      BROWSER_CLOSE_TIMEOUT_MS,
      'Embedded browser session close timed out.',
    ),
    withBrowserTimeout(
      entry.server.stop(),
      SERVER_STOP_TIMEOUT_MS,
      'Validation development server stop timed out.',
    ),
  ]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

async function snapshotWithTimeout(
  browser: ValidationBrowserController,
): Promise<Awaited<ReturnType<ValidationBrowserController['snapshot']>>> {
  return withBrowserTimeout(
    browser.snapshot(),
    BROWSER_SNAPSHOT_TIMEOUT_MS,
    'Embedded browser DOM snapshot timed out. Check the Electron CDP connection and renderer state.',
  );
}

async function cleanupAfterOpenFailure(
  browser: ValidationBrowserController | undefined,
  server: ManagedValidationServer,
): Promise<void> {
  await Promise.allSettled([
    browser
      ? withBrowserTimeout(
          browser.close(),
          BROWSER_CLOSE_TIMEOUT_MS,
          'Embedded browser cleanup timed out.',
        )
      : Promise.resolve(),
    withBrowserTimeout(
      server.stop(),
      SERVER_STOP_TIMEOUT_MS,
      'Validation development server cleanup timed out.',
    ),
  ]);
}

export function withBrowserTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function closeBrowserSession(sessionId: string): Promise<void> {
  await closeEntry(sessionId);
}

/** Close every browser session and its validation development server. */
export async function closeAllBrowserSessions(): Promise<void> {
  const results = await Promise.allSettled(
    [...sessions.keys()].map((sessionId) => closeEntry(sessionId)),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      'One or more browser validation sessions failed to close.',
    );
  }
}

function observeHostCleanup(context: ToolContext): void {
  const host = context.browserHost;
  if (!host?.onSessionClosed || hostCleanupSubscriptions.has(host)) return;
  const unsubscribe = host.onSessionClosed((sessionId) => {
    void closeEntry(sessionId).catch(() => undefined);
  });
  hostCleanupSubscriptions.set(host, unsubscribe);
}

let traceQueue = Promise.resolve();

/** Serializes Playwright tracing because CDP-connected Electron targets share one browser. */
async function acquireTraceLock(signal?: AbortSignal): Promise<() => void> {
  let release!: () => void;
  const previous = traceQueue;
  traceQueue = new Promise<void>((resolveLock) => {
    release = resolveLock;
  });
  try {
    await waitForLock(previous, signal);
  } catch (error) {
    void previous.then(release, release);
    throw error;
  }
  return release;
}

async function waitForLock(lock: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return lock;
  if (signal.aborted) throw new Error('Validation was interrupted while waiting for trace.');
  await Promise.race([
    lock,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new Error('Validation was interrupted while waiting for trace.')),
        { once: true },
      );
    }),
  ]);
}
