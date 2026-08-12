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

export class ValidationBrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  readonly diagnostics: BrowserDiagnostics = {
    console: [],
    pageErrors: [],
    requestFailures: [],
    responses: [],
  };

  constructor(
    private readonly config: ValidationConfig,
    private readonly workingDirectory: string,
  ) {}

  async open(url = this.config.server.url): Promise<void> {
    assertLocalUrl(url);
    if (!this.browser) {
      const executablePath = resolveExecutablePath(
        this.config.browser.executablePath,
        this.workingDirectory,
      );
      try {
        this.browser = await chromium.launch({ headless: true, executablePath });
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
    await this.requirePage().goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
    await this.requirePage().goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  async act(action: ValidationAction): Promise<void> {
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
    await this.requirePage().screenshot({ path, fullPage });
  }

  async close(): Promise<void> {
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
    ['http:', 'https:'].includes(url.protocol) &&
    ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  );
}

function resolveExecutablePath(configured: string | undefined, workingDirectory: string) {
  const value = process.env.PERSONAL_AGENT_CHROMIUM_EXECUTABLE ?? configured;
  if (value) return resolve(workingDirectory, value);
  const bundledRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!bundledRoot || !existsSync(bundledRoot)) return undefined;
  for (const directory of readdirSync(bundledRoot).sort().reverse()) {
    const candidates = [
      resolve(bundledRoot, directory, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
