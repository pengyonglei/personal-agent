import {
  ValidationBrowserSession,
  createRunArtifacts,
  ensureValidationServer,
  loadValidationConfig,
  runFrontendValidation,
  artifactFromPath,
  type ManagedValidationServer,
  type ValidationAction,
} from '@personal-agent/validation';
import { join, resolve } from 'node:path';
import { BaseTool, type ToolContext, type ToolResult } from '../types';

interface BrowserEntry {
  browser: ValidationBrowserSession;
  server: ManagedValidationServer;
  artifactDirectory: string;
  projectHash: string;
  runId: string;
}

const sessions = new Map<string, BrowserEntry>();

export class BrowserOpenTool extends BaseTool {
  readonly name = 'browser_open';
  readonly description =
    'Open an isolated local Chromium session using ~/.personal-agent/validation.yaml. External URLs are rejected.';
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
    await closeEntry(context.sessionId);
    const config = await loadValidationConfig(context.workingDirectory);
    const server = await ensureValidationServer(config, context.workingDirectory, context.signal);
    const run = await createRunArtifacts(
      context.workingDirectory,
      config.artifacts.root ? resolve(context.workingDirectory, config.artifacts.root) : undefined,
    );
    const browser = new ValidationBrowserSession(config, context.workingDirectory);
    try {
      await browser.open(typeof params.url === 'string' ? params.url : undefined);
    } catch (error) {
      await browser.close();
      await server.stop();
      throw error;
    }
    sessions.set(context.sessionId, {
      browser,
      server,
      artifactDirectory: run.directory,
      projectHash: run.projectHash,
      runId: run.runId,
    });
    return this.success(JSON.stringify(await browser.snapshot(), null, 2));
  }
}

export class BrowserSnapshotTool extends BaseTool {
  readonly name = 'browser_snapshot';
  readonly description =
    'Return the current local browser URL, visible text, and interactive DOM elements.';
  readonly category = 'web' as const;
  readonly inputSchema = { type: 'object' as const, properties: {} };

  async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    return this.success(
      JSON.stringify(await requireEntry(context.sessionId).browser.snapshot(), null, 2),
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
    return this.success(JSON.stringify(await entry.browser.snapshot(), null, 2));
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
    await entry.browser.screenshot(path, params.fullPage !== false);
    const artifact = await artifactFromPath(path, 'screenshot', 'image/png');
    return this.success(`Screenshot captured: ${artifact.name}`, {
      duration: 0,
      artifacts: [artifact],
      validation: {
        runId: entry.runId,
        projectHash: entry.projectHash,
        profile: 'quick',
        status: 'passed',
        summary: 'Manual browser screenshot captured.',
        durationMs: 0,
        steps: [],
        issues: [],
        vision: { status: 'skipped', reason: 'Manual screenshot only.' },
      },
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
    const result = await runFrontendValidation({
      workingDirectory: context.workingDirectory,
      profile: params.profile === 'full' ? 'full' : 'quick',
      signal: context.signal,
      onProgress: context.onProgress,
      visualReviewer: context.reviewImage,
    });
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
  await entry.browser.close();
  await entry.server.stop();
}

export async function closeBrowserSession(sessionId: string): Promise<void> {
  await closeEntry(sessionId);
}
