import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserDirectory = resolve(desktopDirectory, '.playwright-browsers');
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
await mkdir(browserDirectory, { recursive: true });

await new Promise((resolveInstall, rejectInstall) => {
  const child = spawn(
    packageManager,
    ['exec', 'playwright', 'install', '--only-shell', 'chromium'],
    {
      cwd: desktopDirectory,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDirectory },
      shell: process.platform === 'win32',
      windowsHide: true,
      stdio: 'inherit',
    },
  );
  child.once('error', rejectInstall);
  child.once('exit', (code) => {
    if (code === 0) resolveInstall();
    else
      rejectInstall(new Error(`Chromium installation failed with exit code ${code ?? 'unknown'}.`));
  });
});
