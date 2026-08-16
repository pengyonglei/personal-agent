import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BashTool,
  describeResolvedShell,
  describeShell,
  getCachedShellDescription,
  resetShellCache,
  resolveShell,
  toWindowsPathLike,
  toWslPath,
  warmShellDescription,
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

test('describeShell includes the version when provided', () => {
  assert.equal(describeShell('win32', 'powershell', '5.1.26100.9168'), 'PowerShell 5.1.26100.9168 (Windows)');
  assert.equal(describeShell('win32', 'auto', '7.4.6'), 'PowerShell 7.4.6 (Windows)');
  assert.equal(describeShell('win32', 'bash', '5.2.26'), 'bash 5.2.26 (Git Bash or WSL)');
  assert.equal(describeShell('linux', 'auto', '5.2.26'), 'bash 5.2.26 (Unix)');
  // 无版本时保持原有标签
  assert.equal(describeShell('win32', 'powershell'), 'PowerShell (Windows)');
});

test('describeResolvedShell composes a versioned label per shell kind', () => {
  const base = {
    args: (c: string) => ['-c', c],
    toWorkingDirectory: (c: string) => c,
  };
  assert.equal(
    describeResolvedShell({ ...base, kind: 'powershell', command: 'powershell.exe', label: 'PowerShell (Windows)', version: '5.1.26100.9168' }),
    'PowerShell 5.1.26100.9168 (Windows)',
  );
  assert.equal(
    describeResolvedShell({ ...base, kind: 'bash', command: 'bash.exe', label: 'bash (Git Bash)', version: '5.2.26' }),
    'bash 5.2.26 (Git Bash)',
  );
  assert.equal(
    describeResolvedShell({ ...base, kind: 'wsl-bash', command: 'bash', label: 'bash (WSL)', version: '5.2.15' }),
    'bash 5.2.15 (WSL)',
  );
  assert.equal(
    describeResolvedShell({ ...base, kind: 'bash', command: '/bin/bash', label: 'bash (Unix)' }),
    'bash (Git Bash)',
  );
});

test('warmShellDescription probes the real PowerShell version on win32 and caches it', async () => {
  resetShellCache();
  const description = await warmShellDescription({ platform: 'win32', prefer: 'powershell' });
  // powershell.exe 在 Windows 上必定存在：探测成功时带版本号，
  // 探测失败（如非 Windows CI 上执行）时回退为无版本标签。
  assert.ok(
    description === 'PowerShell (Windows)' || /^PowerShell \d+\./.test(description),
    `unexpected: ${description}`,
  );
  // 同步读取返回与异步探测一致的结果（缓存已写入）
  assert.equal(getCachedShellDescription({ platform: 'win32', prefer: 'powershell' }), description);
});

test('resolveShell on win32 defaults to PowerShell with -Command', async () => {
  resetShellCache();
  const shell = await resolveShell({ platform: 'win32', prefer: 'auto' });
  assert.equal(shell.kind, 'powershell');
  assert.ok(shell.command === 'pwsh' || shell.command === 'powershell.exe');
  // UTF-8 前缀：强制 PowerShell 以 UTF-8 写管道输出，避免中文系统上
  // Windows PowerShell 5.1 的 GBK 输出被 Node 按 UTF-8 解码成乱码。
  assert.deepEqual(shell.args('git status'), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);git status',
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
