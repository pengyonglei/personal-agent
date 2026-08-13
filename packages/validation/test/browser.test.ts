import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ValidationBrowserSession } from '../src/browser';
import { runFrontendValidation } from '../src/runner';
import { normalizeValidationConfig } from '../src/config';
import type {
  BrowserDiagnostics,
  ValidationBrowserAcquireOptions,
  ValidationBrowserController,
  ValidationBrowserHost,
} from '../src/browser';
import type { BrowserSnapshot, ValidationAction, ValidationAssertion } from '../src/types';

test('browser rejects external URLs before launching Chromium', async () => {
  const config = normalizeValidationConfig({
    server: { url: 'http://localhost:3000' },
    scenarios: [{ name: 'home' }],
  });
  const browser = new ValidationBrowserSession(config, process.cwd());
  await assert.rejects(() => browser.open('https://example.com'), /External browser URL rejected/);
});

test(
  'browser blocks subresource requests to external hosts',
  { timeout: 30_000 },
  async (context) => {
    let externalRequests = 0;
    const external = createServer((_request, response) => {
      externalRequests += 1;
      response.end('external');
    });
    await new Promise<void>((resolveListen) => external.listen(0, '127.0.0.2', resolveListen));
    context.after(() => external.close());
    const externalAddress = external.address();
    assert.ok(externalAddress && typeof externalAddress === 'object');
    const local = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(`<img src="http://127.0.0.2:${externalAddress.port}/pixel.png">`);
    });
    await new Promise<void>((resolveListen) => local.listen(0, '127.0.0.1', resolveListen));
    context.after(() => local.close());
    const localAddress = local.address();
    assert.ok(localAddress && typeof localAddress === 'object');
    const config = normalizeValidationConfig({
      server: { url: `http://127.0.0.1:${localAddress.port}` },
      scenarios: [{ name: 'home' }],
    });
    const browser = new ValidationBrowserSession(config, process.cwd());
    try {
      await browser.open();
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      assert.equal(externalRequests, 0);
    } finally {
      await browser.close();
    }
  },
);

test('connected browser delegates screenshots to its embedded host', async () => {
  const config = normalizeValidationConfig({
    server: { url: 'http://127.0.0.1:3000' },
    scenarios: [{ name: 'home' }],
  });
  const directory = await mkdtemp(join(tmpdir(), 'pa-connected-shot-'));
  const screenshotPath = join(directory, 'shot.png');
  const calls: Array<{ path: string; fullPage: boolean }> = [];
  const fakePage = { on: () => fakePage };
  const fakeContext = {};
  const browser = new ValidationBrowserSession(config, process.cwd(), {
    page: fakePage as never,
    context: fakeContext as never,
    captureScreenshot: async (path, fullPage) => {
      calls.push({ path, fullPage });
      await writeFile(path, 'embedded-shot');
    },
  });

  await browser.screenshot(screenshotPath, false);

  assert.deepEqual(calls, [{ path: screenshotPath, fullPage: false }]);
  assert.equal(await readFile(screenshotPath, 'utf8'), 'embedded-shot');
});

test(
  'runner generates screenshot/report and captures a console error',
  { timeout: 60_000 },
  async (context) => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<!doctype html><title>fixture</title><button aria-label="Continue">Go</button><script>console.error("fixture boom")</script>',
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    context.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const directory = await mkdtemp(join(tmpdir(), 'pa-browser-test-'));
    const artifactRoot = join(directory, 'runs');
    const validationConfigPath = join(directory, 'validation.yaml');
    await writeFile(
      validationConfigPath,
      [
        'version: 1',
        'server:',
        `  url: http://127.0.0.1:${address.port}`,
        '  reuseExisting: true',
        'browser:',
        '  viewport: { width: 800, height: 600 }',
        'artifacts:',
        `  root: ${JSON.stringify(artifactRoot)}`,
        '  trace: retain-on-failure',
        'console:',
        '  failOn: [error]',
        'scenarios:',
        '  - name: fixture',
        '    assertions:',
        '      - { assert: visible, role: button, name: Continue }',
      ].join('\n'),
    );
    const result = await runFrontendValidation({
      workingDirectory: directory,
      configPath: validationConfigPath,
    });
    assert.equal(result.status, 'failed');
    assert.ok(
      result.issues.some(
        (issue) => issue.source === 'console' && issue.message.includes('fixture boom'),
      ),
    );
    assert.ok(result.artifacts.some((artifact) => artifact.kind === 'screenshot'));
    assert.ok(result.artifacts.some((artifact) => artifact.kind === 'trace'));
    assert.ok(result.artifacts.some((artifact) => artifact.kind === 'report'));
  },
);

test(
  'runner can reset and retain an injected browser host and server',
  { timeout: 30_000 },
  async (context) => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>embedded</title><button>Ready</button>');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    context.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const directory = await mkdtemp(join(tmpdir(), 'pa-injected-browser-test-'));
    const validationConfigPath = join(directory, 'validation.yaml');
    await writeFile(
      validationConfigPath,
      [
        'version: 1',
        'server:',
        `  url: http://127.0.0.1:${address.port}`,
        '  reuseExisting: true',
        'artifacts:',
        `  root: ${JSON.stringify(join(directory, 'runs'))}`,
        '  trace: off',
        'scenarios:',
        '  - name: embedded',
      ].join('\n'),
    );

    const controller = new FakeBrowserController();
    const host = new FakeBrowserHost(controller);
    let acquired = false;
    const result = await runFrontendValidation({
      workingDirectory: directory,
      configPath: validationConfigPath,
      browserHost: host,
      browserSessionId: 'session-a',
      retainResources: true,
      onResourcesAcquired: () => {
        acquired = true;
      },
    });

    assert.equal(result.status, 'passed');
    assert.deepEqual(host.acquireOptions.map(({ sessionId, reset }) => ({ sessionId, reset })), [
      { sessionId: 'session-a', reset: true },
    ]);
    assert.equal(acquired, true);
    assert.equal(controller.openCount, 1);
    assert.equal(controller.closeCount, 0);
  },
);

class FakeBrowserHost implements ValidationBrowserHost {
  readonly acquireOptions: ValidationBrowserAcquireOptions[] = [];

  constructor(private readonly controller: ValidationBrowserController) {}

  async acquire(options: ValidationBrowserAcquireOptions) {
    this.acquireOptions.push(options);
    return this.controller;
  }

  async close(): Promise<void> {}
}

class FakeBrowserController implements ValidationBrowserController {
  readonly diagnostics: BrowserDiagnostics = {
    console: [],
    pageErrors: [],
    requestFailures: [],
    responses: [],
  };
  openCount = 0;
  closeCount = 0;

  async open(): Promise<void> {
    this.openCount += 1;
  }
  async reset(): Promise<void> {}
  async startTrace(): Promise<void> {}
  async stopTrace(): Promise<void> {}
  async navigate(): Promise<void> {}
  async act(_action: ValidationAction): Promise<void> {}
  async assert(_assertion: ValidationAssertion): Promise<void> {}
  async snapshot(): Promise<BrowserSnapshot> {
    return { url: 'http://127.0.0.1/', title: 'embedded', text: 'Ready', elements: [] };
  }
  async screenshot(path: string): Promise<void> {
    await writeFile(
      path,
      Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff610000000d49444154789c63601805a3000001100001d0492f680000000049454e44ae426082',
        'hex',
      ),
    );
  }
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}
