import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow, View, WebContentsView, type Rectangle } from 'electron';
import { chromium, type Browser, type Page } from 'playwright';
import {
  ValidationBrowserSession,
  ValidationInfrastructureError,
  type ValidationBrowserAcquireOptions,
  type ValidationBrowserController,
  type ValidationBrowserHost,
} from '@personal-agent/validation';
import { isAllowedLocalNavigation, isAllowedLocalResource } from './browser-network-policy.js';

export type EmbeddedBrowserStatus =
  'creating' | 'loading' | 'ready' | 'crashed' | 'closed' | 'error';

export interface EmbeddedBrowserState {
  sessionId: string;
  status: EmbeddedBrowserStatus;
  url: string;
  title: string;
  locked: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
}

export interface EmbeddedBrowserLayout {
  sessionId: string;
  bounds: Rectangle;
  visible: boolean;
}

interface BrowserHostEntry {
  browser: Browser;
  view: WebContentsView;
  inputBarrier: View;
  controller: ValidationBrowserController;
  markerUrl: string;
  targetId: string;
  state: EmbeddedBrowserState;
  closing: boolean;
}

interface ElectronValidationBrowserHostOptions {
  getWindow: () => BrowserWindow | null;
  cdpEndpoint: Promise<string>;
  onState: (state: EmbeddedBrowserState) => void;
}

const EMBEDDED_CDP_CONNECT_TIMEOUT_MS = 10_000;
const EMBEDDED_CDP_COMMAND_TIMEOUT_MS = 8_000;
const EMBEDDED_BROWSER_CLOSE_TIMEOUT_MS = 8_000;

/** Hosts one non-persistent WebContentsView per validation session. */
export class ElectronValidationBrowserHost implements ValidationBrowserHost {
  private readonly entries = new Map<string, BrowserHostEntry>();
  private readonly layouts = new Map<string, EmbeddedBrowserLayout>();
  private readonly generations = new Map<string, number>();
  private windowVisible = true;
  private readonly sessionClosedListeners = new Set<(sessionId: string) => void>();

  constructor(private readonly options: ElectronValidationBrowserHostOptions) {}

  async acquire(options: ValidationBrowserAcquireOptions): Promise<ValidationBrowserController> {
    if (options.reset) await this.close(options.sessionId);
    const existing = this.entries.get(options.sessionId);
    if (existing && !existing.closing) return existing.controller;

    const window = this.requireWindow();
    const generation = (this.generations.get(options.sessionId) ?? 0) + 1;
    this.generations.set(options.sessionId, generation);
    // No `persist:` prefix: this partition is in-memory and dies with the view.
    const partition = `pa-validation-${safePartition(options.sessionId)}-${generation}`;
    const markerUrl = `about:blank#pa-validation-${randomUUID()}`;
    const view = new WebContentsView({
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
      },
    });
    const inputBarrier = new View();
    inputBarrier.setBackgroundColor('#18f3f5f1');
    inputBarrier.setVisible(false);
    view.setBackgroundColor('#ffffff');
    view.setBorderRadius(8);
    inputBarrier.setBorderRadius(8);
    const initialBounds = defaultBounds(window);
    view.setBounds(initialBounds);
    inputBarrier.setBounds(initialBounds);
    view.setVisible(false);
    window.contentView.addChildView(view);
    window.contentView.addChildView(inputBarrier);

    const initialState: EmbeddedBrowserState = {
      sessionId: options.sessionId,
      status: 'creating',
      url: '',
      title: '',
      locked: false,
      canGoBack: false,
      canGoForward: false,
    };
    this.options.onState(initialState);
    let browser: Browser | undefined;

    try {
      this.secureWebContents(options.sessionId, view);
      await view.webContents.loadURL(markerUrl);
      browser = await this.connectBrowser();
      const page = await this.findMarkedPage(browser, markerUrl);
      const targetId = await resolveTargetId(page);
      const controller = new ValidationBrowserSession(options.config, options.workingDirectory, {
        page,
        context: page.context(),
        onAutomationActive: (active) => this.setAutomationActive(options.sessionId, active),
        captureScreenshot: (path: string, fullPage: boolean) =>
          captureEmbeddedPage(view, path, fullPage),
        onClose: () => this.close(options.sessionId),
      });
      const entry: BrowserHostEntry = {
        browser,
        view,
        inputBarrier,
        controller,
        markerUrl,
        targetId,
        state: initialState,
        closing: false,
      };
      this.entries.set(options.sessionId, entry);
      this.applyLayout(options.sessionId);
      this.publishState(options.sessionId, { status: 'ready' });
      return controller;
    } catch (error) {
      window.contentView.removeChildView(inputBarrier);
      window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
      if (browser) {
        await withEmbeddedTimeout(
          browser.close(),
          EMBEDDED_BROWSER_CLOSE_TIMEOUT_MS,
          'Embedded browser cleanup timed out.',
        ).catch(() => undefined);
      }
      const message = formatError(error);
      this.options.onState({ ...initialState, status: 'error', error: message });
      throw new ValidationInfrastructureError(
        `Embedded browser host could not create the session: ${message}`,
      );
    }
  }

  setLayout(layout: EmbeddedBrowserLayout): void {
    const sanitized: EmbeddedBrowserLayout = {
      sessionId: layout.sessionId,
      visible: layout.visible,
      bounds: sanitizeBounds(layout.bounds),
    };
    this.layouts.set(layout.sessionId, sanitized);
    this.applyLayout(layout.sessionId);
  }

  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible;
    for (const sessionId of this.entries.keys()) this.applyLayout(sessionId);
  }

  getState(sessionId: string): EmbeddedBrowserState | undefined {
    const entry = this.entries.get(sessionId);
    return entry && !entry.closing ? { ...entry.state } : undefined;
  }

  navigate(sessionId: string, action: 'back' | 'forward' | 'reload'): void {
    const entry = this.requireEntry(sessionId);
    if (entry.state.locked) {
      throw new Error('Agent 正在操作浏览器，请稍后再试。');
    }
    const contents = entry.view.webContents;
    if (action === 'reload') {
      contents.reload();
    } else if (action === 'back' && contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    } else if (action === 'forward' && contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
  }

  onSessionClosed(listener: (sessionId: string) => void): () => void {
    this.sessionClosedListeners.add(listener);
    return () => this.sessionClosedListeners.delete(listener);
  }

  async close(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.closing) return;
    entry.closing = true;
    this.entries.delete(sessionId);
    await withEmbeddedTimeout(
      entry.browser.close(),
      EMBEDDED_BROWSER_CLOSE_TIMEOUT_MS,
      'Embedded browser CDP disconnect timed out.',
    ).catch(() => undefined);
    const window = this.options.getWindow();
    if (window && !window.isDestroyed()) {
      window.contentView.removeChildView(entry.inputBarrier);
      window.contentView.removeChildView(entry.view);
    }
    entry.inputBarrier.setVisible(false);
    entry.view.setVisible(false);
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close({ waitForBeforeUnload: false });
    }
    this.options.onState({
      ...entry.state,
      status: entry.state.status === 'crashed' ? 'crashed' : 'closed',
      locked: false,
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((sessionId) => this.close(sessionId)));
    this.layouts.clear();
  }

  private secureWebContents(sessionId: string, view: WebContentsView): void {
    const contents = view.webContents;
    const isolatedSession = contents.session;
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    isolatedSession.setSpellCheckerEnabled(false);
    isolatedSession.on('will-download', (event) => event.preventDefault());
    isolatedSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isAllowedLocalResource(details.url) });
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!isAllowedLocalNavigation(url)) event.preventDefault();
    });
    contents.on('will-frame-navigate', (event) => {
      if (!isAllowedLocalResource(event.url)) event.preventDefault();
    });
    contents.on('did-start-loading', () => this.publishState(sessionId, { status: 'loading' }));
    contents.on('did-stop-loading', () => this.publishState(sessionId, { status: 'ready' }));
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.publishState(sessionId, {
        status: 'error',
        error: `Page load failed (${code}) ${description}: ${url}`,
      });
    });
    contents.on('did-navigate', () => this.publishState(sessionId));
    contents.on('did-navigate-in-page', () => this.publishState(sessionId));
    contents.on('page-title-updated', () => this.publishState(sessionId));
    contents.on('render-process-gone', (_event, details) => {
      this.publishState(sessionId, {
        status: 'crashed',
        error: `Renderer process exited: ${details.reason}`,
      });
      this.notifyUnexpectedClose(sessionId);
      void this.close(sessionId);
    });
    contents.on('destroyed', () => {
      const entry = this.entries.get(sessionId);
      if (!entry || entry.closing) return;
      this.entries.delete(sessionId);
      const window = this.options.getWindow();
      if (window && !window.isDestroyed()) {
        window.contentView.removeChildView(entry.inputBarrier);
        window.contentView.removeChildView(entry.view);
      }
      this.options.onState({ ...entry.state, status: 'closed', locked: false });
      this.notifyUnexpectedClose(sessionId);
    });
  }

  private async findMarkedPage(browser: Browser, markerUrl: string): Promise<Page> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const context of browser.contexts()) {
        const page = context.pages().find((candidate) => candidate.url() === markerUrl);
        if (page) return page;
      }
      await delay(50);
    }
    throw new Error('CDP connected, but the marked WebContentsView target was not found.');
  }

  private async connectBrowser(): Promise<Browser> {
    const endpoint = await withEmbeddedTimeout(
      this.options.cdpEndpoint,
      EMBEDDED_CDP_CONNECT_TIMEOUT_MS,
      'Electron CDP endpoint was not ready in time.',
    );
    return chromium.connectOverCDP(endpoint, {
      noDefaults: true,
      timeout: EMBEDDED_CDP_CONNECT_TIMEOUT_MS,
    });
  }

  private async setAutomationActive(sessionId: string, active: boolean): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.closing) return;
    entry.state.locked = active;
    if (active) this.requireWindow().webContents.focus();
    this.applyLayout(sessionId);
    this.publishState(sessionId);
  }

  private applyLayout(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.closing) return;
    const layout = this.layouts.get(sessionId);
    const usable = !['crashed', 'error', 'closed'].includes(entry.state.status);
    const userVisible = Boolean(layout?.visible && this.windowVisible && usable);
    const window = this.requireWindow();
    // Renderer coordinates can briefly become stale while the sidebar is being
    // dragged or the window is resizing. Always clip native views to the current
    // content area so a stale rectangle can never cover unrelated application UI.
    const activeBounds = clipBoundsToWindow(layout?.bounds ?? defaultBounds(window), window);
    // setVisible(false) also makes DOM visibility checks fail and collapses Chromium's
    // paint surface. Keep background sessions rendered at their real viewport size,
    // but move them outside the host window so they cannot cover the application UI.
    const viewBounds = userVisible ? activeBounds : offscreenBounds(window, activeBounds);
    entry.view.setBounds(viewBounds);
    entry.inputBarrier.setBounds(viewBounds);
    entry.view.setVisible(usable);
    entry.inputBarrier.setVisible(userVisible && entry.state.locked);
  }

  private publishState(sessionId: string, update: Partial<EmbeddedBrowserState> = {}): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.closing) return;
    const contents = entry.view.webContents;
    const markerVisible = contents.getURL() === entry.markerUrl;
    entry.state = {
      ...entry.state,
      ...update,
      url: markerVisible ? '' : contents.getURL(),
      title: markerVisible ? '' : contents.getTitle(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    };
    this.options.onState({ ...entry.state });
  }

  private requireWindow(): BrowserWindow {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) {
      throw new ValidationInfrastructureError('Desktop browser window is unavailable.');
    }
    return window;
  }

  private requireEntry(sessionId: string): BrowserHostEntry {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.closing) throw new Error('No embedded browser session is open.');
    return entry;
  }

  private notifyUnexpectedClose(sessionId: string): void {
    for (const listener of this.sessionClosedListeners) listener(sessionId);
  }
}

export async function waitForElectronCdpEndpoint(
  userDataDirectory: string,
  startedAt: number,
): Promise<string> {
  const portFile = join(userDataDirectory, 'DevToolsActivePort');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const [fileStat, value] = await Promise.all([stat(portFile), readFile(portFile, 'utf8')]);
      const port = Number(value.split(/\r?\n/, 1)[0]);
      if (fileStat.mtimeMs >= startedAt - 2_000 && Number.isInteger(port) && port > 0) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {
      // Chromium writes this file shortly after Electron is ready.
    }
    await delay(50);
  }
  throw new ValidationInfrastructureError(
    'Electron CDP endpoint was not published on 127.0.0.1 within 15 seconds.',
  );
}

async function resolveTargetId(page: Page): Promise<string> {
  const client = await page.context().newCDPSession(page);
  try {
    const result = await client.send('Target.getTargetInfo');
    if (result.targetInfo.url !== page.url()) {
      throw new Error('CDP target URL changed while binding the embedded page.');
    }
    return result.targetInfo.targetId;
  } finally {
    await client.detach();
  }
}

function safePartition(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || randomUUID();
}

function sanitizeBounds(bounds: Rectangle): Rectangle {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

function clipBoundsToWindow(bounds: Rectangle, window: BrowserWindow): Rectangle {
  const content = window.getContentBounds();
  const sanitized = sanitizeBounds(bounds);
  const x = Math.min(content.width, sanitized.x);
  const y = Math.min(content.height, sanitized.y);
  return {
    x,
    y,
    width: Math.max(1, Math.min(sanitized.width, content.width - x)),
    height: Math.max(1, Math.min(sanitized.height, content.height - y)),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function defaultBounds(window: BrowserWindow): Rectangle {
  const content = window.getContentBounds();
  const width = Math.min(356, Math.max(1, content.width - 24));
  return {
    x: Math.max(0, content.width - width - 12),
    y: 64,
    width,
    height: Math.max(240, content.height - 128),
  };
}

function offscreenBounds(window: BrowserWindow, bounds: Rectangle): Rectangle {
  const content = window.getContentBounds();
  return {
    x: Math.max(content.width, bounds.x + bounds.width) + 64,
    y: Math.max(0, bounds.y),
    width: bounds.width,
    height: bounds.height,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function captureEmbeddedPage(
  view: WebContentsView,
  path: string,
  fullPage: boolean,
): Promise<void> {
  const debug = view.webContents.debugger;
  const attachedHere = !debug.isAttached();
  if (attachedHere) debug.attach('1.3');
  try {
    const metrics = (await withEmbeddedTimeout(
      debug.sendCommand('Page.getLayoutMetrics'),
      EMBEDDED_CDP_COMMAND_TIMEOUT_MS,
      'Embedded browser viewport inspection timed out.',
    )) as {
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
      cssVisualViewport?: { clientWidth: number; clientHeight: number };
      visualViewport?: { clientWidth: number; clientHeight: number };
    };
    const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
    if (!viewport || viewport.clientWidth < 1 || viewport.clientHeight < 1) {
      throw new ValidationInfrastructureError(
        'Embedded browser viewport is 0x0. Keep the WebContentsView rendered while it is off-screen.',
      );
    }
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (fullPage) {
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size) {
        clip = {
          x: 0,
          y: 0,
          width: Math.max(1, Math.ceil(size.width)),
          height: Math.max(1, Math.ceil(size.height)),
          scale: 1,
        };
      }
    }
    const result = (await withEmbeddedTimeout(
      debug.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: fullPage,
        ...(clip ? { clip } : {}),
      }),
      EMBEDDED_CDP_COMMAND_TIMEOUT_MS,
      'Embedded browser screenshot timed out.',
    )) as { data?: unknown };
    if (typeof result.data !== 'string' || result.data.length === 0) {
      throw new ValidationInfrastructureError(
        'Electron returned an empty embedded browser screenshot.',
      );
    }
    await writeFile(path, Buffer.from(result.data, 'base64'));
  } finally {
    if (attachedHere && debug.isAttached()) debug.detach();
  }
}

function withEmbeddedTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ValidationInfrastructureError(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
