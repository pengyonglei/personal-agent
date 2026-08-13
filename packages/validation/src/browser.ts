import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  BrowserSnapshot,
  ValidationAction,
  ValidationAssertion,
  ValidationConfig,
} from './types';
import { ValidationInfrastructureError } from './server';

export interface BrowserDiagnostics {
  console: Array<{ level: string; text: string }>;
  pageErrors: string[];
  requestFailures: Array<{ url: string; error: string }>;
  responses: Array<{ url: string; status: number }>;
}

/**
 * Browser operations used by validation and browser tools. Implementations may
 * own a Playwright-launched browser or control an Electron-embedded page.
 */
export interface ValidationBrowserController {
  readonly diagnostics: BrowserDiagnostics;
  open(url?: string): Promise<void>;
  reset(url?: string): Promise<void>;
  startTrace(): Promise<void>;
  stopTrace(path?: string): Promise<void>;
  navigate(path: string): Promise<void>;
  act(action: ValidationAction): Promise<void>;
  assert(assertion: ValidationAssertion): Promise<void>;
  snapshot(): Promise<BrowserSnapshot>;
  screenshot(path: string, fullPage?: boolean): Promise<void>;
  close(): Promise<void>;
}

export interface ValidationBrowserAcquireOptions {
  sessionId: string;
  config: ValidationConfig;
  workingDirectory: string;
  /** Recreate the underlying browsing partition before returning the controller. */
  reset?: boolean;
}

/** Desktop-only injection point. Web and CLI omit it and keep using Playwright Chromium. */
export interface ValidationBrowserHost {
  acquire(options: ValidationBrowserAcquireOptions): Promise<ValidationBrowserController>;
  close(sessionId: string): Promise<void>;
  closeAll?(): Promise<void>;
  /** Notifies the tool layer when a page disappears without browser_close. */
  onSessionClosed?(listener: (sessionId: string) => void): () => void;
}

export interface ConnectedValidationBrowserOptions {
  page: Page;
  context: BrowserContext;
  onAutomationActive?: (active: boolean) => void | Promise<void>;
  /** Electron WebContentsView cannot reliably use CDP Page.captureScreenshot. */
  captureScreenshot?: (path: string, fullPage: boolean) => Promise<void>;
  onClose?: () => void | Promise<void>;
}

export class ValidationBrowserSession implements ValidationBrowserController {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private automationDepth = 0;
  readonly diagnostics: BrowserDiagnostics = {
    console: [],
    pageErrors: [],
    requestFailures: [],
    responses: [],
  };

  constructor(
    private readonly config: ValidationConfig,
    private readonly workingDirectory: string,
    private readonly connected?: ConnectedValidationBrowserOptions,
  ) {
    if (connected) {
      this.context = connected.context;
      this.page = connected.page;
      this.observe(connected.page);
    }
  }

  async open(url = this.config.server.url): Promise<void> {
    assertLocalUrl(url);
    if (!this.page) {
      const headless = resolveHeadless(this.config.browser.headless);
      const executablePath = resolveExecutablePath(
        this.config.browser.executablePath,
        this.workingDirectory,
        headless,
      );
      try {
        this.browser = await chromium.launch({ headless, executablePath });
      } catch (error) {
        throw new ValidationInfrastructureError(
          `Chromium could not start: ${formatError(error)}. Run \"pnpm exec playwright install chromium\" or package the configured browser.`,
        );
      }
      this.context = await this.browser.newContext({
        viewport: this.config.browser.viewport,
        colorScheme: this.config.browser.colorScheme,
        locale: this.config.browser.locale,
      });
      await this.context.route('**/*', async (route) => {
        if (isAllowedLocalResource(route.request().url())) await route.continue();
        else await route.abort('blockedbyclient');
      });
      this.page = await this.context.newPage();
      this.observe(this.page);
    }
    await this.withAutomationLock(() =>
      this.requirePage().goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
    );
  }

  async reset(url = this.config.server.url): Promise<void> {
    if (this.connected) {
      await this.withAutomationLock(async () => {
        await this.requireContext().clearCookies();
        await this.requireContext().clearPermissions();
        await this.requirePage()
          .evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          })
          .catch(() => undefined);
      });
      await this.open(url);
      return;
    }
    await this.close();
    await this.open(url);
  }

  async startTrace(): Promise<void> {
    await this.requireContext().tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
  }

  async stopTrace(path?: string): Promise<void> {
    await this.requireContext().tracing.stop(path ? { path } : undefined);
  }

  async navigate(path: string): Promise<void> {
    const url = new URL(path, this.config.server.url).toString();
    assertLocalUrl(url);
    await this.withAutomationLock(() =>
      this.requirePage().goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
    );
  }

  async act(action: ValidationAction): Promise<void> {
    await this.withAutomationLock(() => this.actUnlocked(action));
  }

  private async actUnlocked(action: ValidationAction): Promise<void> {
    const page = this.requirePage();
    if (action.action === 'wait') {
      await page.waitForTimeout(action.timeoutMs ?? 500);
      return;
    }
    const locator = locate(page, action);
    const count = await locator.count();
    if (count !== 1) {
      throw new Error(
        `Locator must match exactly one element, but matched ${count}: ${describeLocator(action)}`,
      );
    }
    const timeout = action.timeoutMs ?? 5_000;
    switch (action.action) {
      case 'click':
        await locator.click({ timeout });
        break;
      case 'fill':
        await locator.fill(action.value ?? '', { timeout });
        break;
      case 'press':
        await locator.press(action.key ?? 'Enter', { timeout });
        break;
      case 'check':
        await locator.check({ timeout });
        break;
      case 'uncheck':
        await locator.uncheck({ timeout });
        break;
      case 'select':
        await locator.selectOption(action.value ?? '', { timeout });
        break;
    }
  }

  async assert(assertion: ValidationAssertion): Promise<void> {
    await this.withAutomationLock(() => this.assertUnlocked(assertion));
  }

  private async assertUnlocked(assertion: ValidationAssertion): Promise<void> {
    const page = this.requirePage();
    if (assertion.assert === 'url') {
      const actual = page.url();
      if (!actual.includes(assertion.value ?? '')) {
        throw new Error(
          `Expected URL to contain ${JSON.stringify(assertion.value)}, got ${actual}`,
        );
      }
      return;
    }
    const locator = locate(page, assertion);
    let count = await locator.count();
    if (assertion.assert === 'count') {
      if (count !== assertion.count) {
        throw new Error(
          `Expected ${assertion.count} matches, got ${count}: ${describeLocator(assertion)}`,
        );
      }
      return;
    }
    if (assertion.assert === 'visible') {
      try {
        await locator.waitFor({ state: 'visible', timeout: 5_000 });
      } catch {
        // Fall through to the exact-count diagnostic below.
      }
      count = await locator.count();
    } else if (assertion.assert === 'hidden') {
      try {
        await locator.waitFor({ state: 'hidden', timeout: 5_000 });
        return;
      } catch {
        // Fall through to the exact-count diagnostic below.
      }
    }
    if (count !== 1) {
      throw new Error(
        `Locator must match exactly one element, but matched ${count}: ${describeLocator(assertion)}`,
      );
    }
    if (assertion.assert === 'visible' && !(await locator.isVisible())) {
      throw new Error(`Expected visible element: ${describeLocator(assertion)}`);
    }
    if (assertion.assert === 'hidden' && (await locator.isVisible())) {
      throw new Error(`Expected hidden element: ${describeLocator(assertion)}`);
    }
    if (assertion.assert === 'text') {
      const actual = (await locator.textContent()) ?? '';
      if (!actual.includes(assertion.value ?? '')) {
        throw new Error(
          `Expected element text to contain ${JSON.stringify(assertion.value)}, got ${JSON.stringify(actual)}`,
        );
      }
    }
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const page = this.requirePage();
    const elements = await page
      .locator('button, a, input, textarea, select, [role], [data-testid]')
      .evaluateAll((nodes) =>
        nodes.slice(0, 300).map((node) => {
          const element = node as HTMLElement;
          const role =
            element.getAttribute('role') ||
            ({
              A: 'link',
              BUTTON: 'button',
              INPUT: 'textbox',
              TEXTAREA: 'textbox',
              SELECT: 'combobox',
            }[element.tagName] ??
              element.tagName.toLowerCase());
          const input = element as HTMLInputElement;
          return {
            role,
            name:
              element.getAttribute('aria-label') ||
              element.getAttribute('title') ||
              input.placeholder ||
              element.innerText?.trim().slice(0, 160) ||
              input.value ||
              '',
            testId: element.getAttribute('data-testid') || undefined,
            disabled:
              input.disabled || element.getAttribute('aria-disabled') === 'true' || undefined,
          };
        }),
      );
    return {
      url: page.url(),
      title: await page.title(),
      text: (await page.locator('body').innerText()).slice(0, 20_000),
      elements,
    };
  }

  async screenshot(path: string, fullPage = true): Promise<void> {
    if (this.connected?.captureScreenshot) {
      await this.connected.captureScreenshot(path, fullPage);
      return;
    }
    await this.requirePage().screenshot({ path, fullPage });
  }

  async close(): Promise<void> {
    if (this.connected) {
      this.page = undefined;
      this.context = undefined;
      await this.connected.onClose?.();
      return;
    }
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }

  private observe(page: Page): void {
    page.on('console', (message) => {
      this.diagnostics.console.push({ level: message.type(), text: message.text() });
    });
    page.on('pageerror', (error) => this.diagnostics.pageErrors.push(error.message));
    page.on('requestfailed', (request) => {
      this.diagnostics.requestFailures.push({
        url: request.url(),
        error: request.failure()?.errorText ?? 'Request failed',
      });
    });
    page.on('response', (response) => {
      if (response.status() >= this.config.network.failOnHttpStatus) {
        this.diagnostics.responses.push({ url: response.url(), status: response.status() });
      }
    });
  }

  private requirePage(): Page {
    if (!this.page) throw new ValidationInfrastructureError('Browser session is not open.');
    return this.page;
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new ValidationInfrastructureError('Browser session is not open.');
    return this.context;
  }

  private async withAutomationLock<T>(work: () => Promise<T>): Promise<T> {
    this.automationDepth += 1;
    if (this.automationDepth === 1) await this.connected?.onAutomationActive?.(true);
    try {
      return await work();
    } finally {
      this.automationDepth -= 1;
      if (this.automationDepth === 0) await this.connected?.onAutomationActive?.(false);
    }
  }
}

function locate(page: Page, value: ValidationAction | ValidationAssertion): Locator {
  if (value.testId) return page.getByTestId(value.testId);
  if (value.role) return page.getByRole(value.role as never, { name: value.name, exact: true });
  if (value.text) return page.getByText(value.text, { exact: true });
  if (value.selector) return page.locator(value.selector);
  throw new Error('Action/assertion requires role+name, testId, text, or selector.');
}

function describeLocator(value: ValidationAction | ValidationAssertion): string {
  if (value.testId) return `testId=${JSON.stringify(value.testId)}`;
  if (value.role) return `role=${value.role}, name=${JSON.stringify(value.name)}`;
  if (value.text) return `text=${JSON.stringify(value.text)}`;
  return `selector=${JSON.stringify(value.selector)}`;
}

function assertLocalUrl(value: string): void {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Only http(s) URLs are allowed.');
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error(`External browser URL rejected: ${value}`);
  }
}

function isAllowedLocalResource(value: string): boolean {
  const url = new URL(value);
  if (['data:', 'blob:', 'about:'].includes(url.protocol)) return true;
  return (
    ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  );
}

function resolveExecutablePath(
  configured: string | undefined,
  workingDirectory: string,
  headless: boolean,
) {
  const value = process.env.PERSONAL_AGENT_CHROMIUM_EXECUTABLE ?? configured;
  if (value) return resolve(workingDirectory, value);
  const bundledRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!bundledRoot || !existsSync(bundledRoot)) return undefined;
  const directories = readdirSync(bundledRoot).sort().reverse();
  // The headless shell cannot show a window; in headed mode prefer the full Chromium build.
  if (!headless) {
    for (const directory of directories) {
      const candidates = [
        resolve(bundledRoot, directory, 'chrome-win64', 'chrome.exe'),
        resolve(bundledRoot, directory, 'chrome-linux', 'chrome'),
        resolve(
          bundledRoot,
          directory,
          'chrome-mac',
          'Chromium.app',
          'Contents',
          'MacOS',
          'Chromium',
        ),
      ];
      const match = candidates.find(existsSync);
      if (match) return match;
    }
  }
  for (const directory of directories) {
    const candidates = [
      resolve(bundledRoot, directory, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
      resolve(bundledRoot, directory, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      resolve(bundledRoot, directory, 'chrome-headless-shell-mac64', 'chrome-headless-shell'),
      resolve(bundledRoot, directory, 'chrome-win64', 'chrome.exe'),
      resolve(bundledRoot, directory, 'chrome-linux', 'chrome'),
      resolve(
        bundledRoot,
        directory,
        'chrome-mac',
        'Chromium.app',
        'Contents',
        'MacOS',
        'Chromium',
      ),
    ];
    const match = candidates.find(existsSync);
    if (match) return match;
  }
  return undefined;
}

/**
 * Resolves whether the browser window should be visible.
 * Config value wins unless overridden by the PERSONAL_AGENT_HEADLESS environment
 * variable ('1'/'true' forces headless, '0'/'false' forces a visible window).
 */
function resolveHeadless(configured: boolean): boolean {
  const value = process.env.PERSONAL_AGENT_HEADLESS?.trim().toLowerCase();
  if (value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  return configured;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
