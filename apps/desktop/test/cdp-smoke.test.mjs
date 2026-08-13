import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';

test(
  'Electron WebContentsView and Playwright share one precisely selected CDP page',
  { timeout: 45_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pa-electron-cdp-'));
    const statusPath = join(directory, 'status.json');
    const commandPath = join(directory, 'command.json');
    const responsePath = join(directory, 'response.json');
    const { default: electronPath } = await import('electron');
    const fixturePath = joinPath(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'cdp-child.mjs',
    );
    const child = spawn(electronPath, [fixturePath, directory, '--no-sandbox'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout?.on('data', (chunk) => (output += String(chunk)));
    child.stderr?.on('data', (chunk) => (output += String(chunk)));

    try {
      const status = await waitForJson(statusPath).catch((error) => {
        throw new Error(`${error.message}\nElectron output:\n${output}`);
      });
      assert.equal(status.ready, true, output);
      const activePort = await waitForText(join(directory, 'DevToolsActivePort'));
      const port = Number(activePort.split(/\r?\n/, 1)[0]);
      assert.ok(Number.isInteger(port) && port > 0, activePort);

      const { chromium } = await import('playwright');
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
        noDefaults: true,
      });
      const pages = browser.contexts().flatMap((context) => context.pages());
      const embeddedPages = pages.filter((page) => page.url() === status.markerUrl);
      assert.equal(embeddedPages.length, 1, `targets: ${pages.map((page) => page.url())}`);
      assert.ok(
        pages.some((page) => page.url().startsWith('data:text/html')),
        'The main application target should remain distinct from the embedded target.',
      );
      const page = embeddedPages[0];
      const isolatedPage = pages.find((candidate) => candidate.url() === status.isolatedMarkerUrl);
      assert.ok(isolatedPage, `targets: ${pages.map((candidate) => candidate.url())}`);
      const cdp = await page.context().newCDPSession(page);
      const target = await cdp.send('Target.getTargetInfo');
      await cdp.detach();
      assert.equal(target.targetInfo.url, status.markerUrl);
      assert.equal(
        await page.locator('#shared-input').isVisible(),
        true,
        'An off-screen background WebContentsView must remain layout-visible to Playwright.',
      );
      await assert.doesNotReject(
        page.waitForFunction(() => window.wsState === 'connected', undefined, {
          timeout: 5_000,
        }),
        'The local WebSocket should work inside the embedded Electron page.',
      );
      const screenshotPath = join(directory, 'embedded-page.png');
      const screenshot = await sendCommand(commandPath, responsePath, {
        id: 1,
        action: 'screenshot',
        path: screenshotPath,
      });
      assert.equal(screenshot.error, undefined);
      assert.equal(screenshot.empty, false);
      assert.ok((await stat(screenshotPath)).size > 0);
      const screenshotBytes = await readFile(screenshotPath);
      assert.ok(
        screenshotBytes.readUInt32BE(20) > 300,
        'A full-page screenshot should be taller than the embedded viewport.',
      );

      await sendCommand(commandPath, responsePath, { id: 2, action: 'user-input' });
      assert.equal(await page.locator('#shared-input').inputValue(), 'user-value');
      assert.equal(await page.evaluate(() => localStorage.getItem('partition-key')), 'user-value');
      assert.equal(await isolatedPage.evaluate(() => localStorage.getItem('partition-key')), null);
      const tracePath = join(directory, 'trace.zip');
      await page.context().tracing.start({ screenshots: true, snapshots: true });
      await page.locator('#shared-input').fill('agent-value');
      await page.context().tracing.stop({ path: tracePath });
      assert.ok((await stat(tracePath)).size > 0);
      const inspected = await sendCommand(commandPath, responsePath, {
        id: 3,
        action: 'inspect',
      });
      assert.equal(inspected.value, 'agent-value');
      await browser.close();
      const afterDisconnect = await sendCommand(commandPath, responsePath, {
        id: 4,
        action: 'inspect',
      });
      assert.equal(afterDisconnect.value, 'agent-value');
      const resized = await sendCommand(commandPath, responsePath, {
        id: 5,
        action: 'resize',
        bounds: { x: 180, y: 90, width: 360, height: 220 },
      });
      assert.deepEqual(resized.bounds, { x: 180, y: 90, width: 360, height: 220 });
      assert.deepEqual(
        resized.viewport,
        { width: 360, height: 220 },
        'The Chromium viewport must follow WebContentsView bounds changes.',
      );
      await sendCommand(commandPath, responsePath, { id: 6, action: 'exit' });
      await onceExit(child);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await onceExit(child).catch(() => undefined);
      }
      await removeWithRetry(directory);
    }
  },
);

async function sendCommand(commandPath, responsePath, command) {
  await writeFile(commandPath, JSON.stringify(command));
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = JSON.parse(await readFile(responsePath, 'utf8'));
      if (response.id === command.id) return response;
    } catch {
      // Keep polling until the Electron child responds.
    }
    await delay(25);
  }
  throw new Error(`Electron command timed out: ${command.action}`);
}

async function waitForJson(path) {
  return JSON.parse(await waitForText(path));
}

async function waitForText(path) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const info = await stat(path);
      if (info.size > 0) return await readFile(path, 'utf8');
    } catch {
      // The file is produced asynchronously by Electron/Chromium.
    }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function onceExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    child.once('exit', () => resolveExit());
    child.once('error', rejectExit);
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function removeWithRetry(path) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await delay(100);
    }
  }
  await rm(path, { recursive: true, force: true });
}
