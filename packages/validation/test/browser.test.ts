import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ValidationBrowserSession } from '../src/browser';
import { runFrontendValidation } from '../src/runner';
import { normalizeValidationConfig } from '../src/config';

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
