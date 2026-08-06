import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BashTool,
  describeShell,
  resetShellCache,
  resolveShell,
  toWindowsPathLike,
  toWslPath,
} from '../src/index';

test('describeShell reports the strategy-level shell label per platform', () => {
  assert.equal(describeShell('win32', 'auto'), 'PowerShell (Windows)');
  assert.equal(describeShell('win32', 'powershell'), 'PowerShell (Windows)');
  assert.equal(describeShell('win32', 'bash'), 'bash (Git Bash or WSL)');
  assert.equal(describeShell('linux', 'auto'), 'bash (Unix)');
  assert.equal(describeShell('darwin', 'bash'), 'bash (Unix)');
});

test('toWslPath translates Windows drive paths and leaves others untouched', () => {
  assert.equal(toWslPath('D:\\workspace\\repo\\src'), '/mnt/d/workspace/repo/src');
  assert.equal(toWslPath('C:/work/file.txt'), '/mnt/c/work/file.txt');
  assert.equal(toWslPath('/mnt/d/work'), '/mnt/d/work');
  assert.equal(toWslPath('relative/path'), 'relative/path');
  assert.equal(toWslPath('\\\\server\\share\\x'), '//server/share/x');
});

test('toWindowsPathLike translates WSL /mnt paths back to Windows form', () => {
  assert.equal(toWindowsPathLike('/mnt/d/workspace/repo/src'), 'D:\\workspace\\repo\\src');
  assert.equal(toWindowsPathLike('/mnt/c/work'), 'C:\\work');
  assert.equal(toWindowsPathLike('D:\\work'), 'D:\\work');
});

test('resolveShell on non-win32 platforms uses bash with -c', async () => {
  resetShellCache();
  const shell = await resolveShell({ platform: 'linux' });
  // '/bin/bash' on Unix hosts, 'bash' when probing from Windows.
  assert.ok(shell.command === '/bin/bash' || shell.command === 'bash');
  assert.deepEqual(shell.args('ls -la'), ['-c', 'ls -la']);
  assert.equal(shell.toWorkingDirectory('/home/user'), '/home/user');
  assert.equal(shell.label, 'bash (Unix)');
});

test('resolveShell on win32 defaults to PowerShell with -Command', async () => {
  resetShellCache();
  const shell = await resolveShell({ platform: 'win32', prefer: 'auto' });
  assert.equal(shell.kind, 'powershell');
  assert.ok(shell.command === 'pwsh' || shell.command === 'powershell.exe');
  assert.deepEqual(shell.args('git status'), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'git status',
  ]);
  assert.equal(shell.toWorkingDirectory('D:\\work'), 'D:\\work');
  assert.equal(shell.label, 'PowerShell (Windows)');
});

test('resolveShell on win32 with bash preference resolves bash and translates WSL cwd', async () => {
  resetShellCache();
  const shell = await resolveShell({ platform: 'win32', prefer: 'bash' });
  assert.ok(shell.kind === 'bash' || shell.kind === 'wsl-bash');
  assert.ok(shell.command.length > 0);
  assert.deepEqual(shell.args('ls'), ['-c', 'ls']);
  if (shell.kind === 'wsl-bash') {
    // WSL bash must translate the working directory to /mnt/... form.
    assert.equal(shell.toWorkingDirectory('D:\\work\\repo'), '/mnt/d/work/repo');
  } else {
    // Git Bash keeps Windows paths as-is.
    assert.equal(shell.toWorkingDirectory('D:\\work\\repo'), 'D:\\work\\repo');
  }
});

test('BashTool smoke test: executes a trivial command through the resolved shell', async () => {
  const tool = new BashTool();
  const result = await tool.execute(
    { command: 'echo shell-smoke-ok' },
    { sessionId: 'test-session', workingDirectory: process.cwd() },
  );
  assert.equal(result.success, true, `command failed: ${result.error ?? ''}`);
  assert.match(result.content ?? '', /shell-smoke-ok/);
});
