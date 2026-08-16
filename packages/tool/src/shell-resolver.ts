import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

// ---------------------------------------------------------------------------
// Cross-platform shell resolution for the bash tool
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

export type ShellKind = 'powershell' | 'bash' | 'wsl-bash';

/** How the bash tool picks its shell on Windows. 'auto' resolves to PowerShell. */
export type ShellPreference = 'auto' | 'powershell' | 'bash';

export interface ResolvedShell {
  kind: ShellKind;
  /** Executable to spawn (e.g. 'powershell.exe', 'bash', '/bin/bash'). */
  command: string;
  /** Build argv for a given command string. */
  args: (command: string) => string[];
  /** Translate a working directory before passing it to the child process. */
  toWorkingDirectory: (cwd: string) => string;
  /** Human-readable shell label used in system prompts. */
  label: string;
  /** Detected shell version (e.g. '5.1.26100.9168', '7.4.6', '5.2.26'). */
  version?: string;
}

/** Translate a Windows path to its WSL /mnt/ form (non-drive paths unchanged). */
export function toWslPath(winPath: string): string {
  const normalized = winPath.replace(/\\/g, '/');
  const match = /^([A-Za-z]):(\/.*)$/.exec(normalized);
  if (!match) return normalized;
  return `/mnt/${match[1].toLowerCase()}${match[2]}`;
}

/** Translate a WSL /mnt/ path back to a Windows path (other paths unchanged). */
export function toWindowsPathLike(wslPath: string): string {
  const match = /^\/mnt\/([a-zA-Z])(\/.*)$/.exec(wslPath);
  if (!match) return wslPath;
  return `${match[1].toUpperCase()}:\\${match[2].slice(1).replace(/\//g, '\\')}`;
}

/**
 * Synchronous shell description for system prompts. Kept cheap on purpose —
 * the runtime only needs the strategy-level label, not the async probing.
 * Pass a detected `version` to include it (e.g. 'PowerShell 7.4.6 (Windows)').
 */
export function describeShell(
  platform: NodeJS.Platform = process.platform,
  prefer: ShellPreference = 'auto',
  version?: string,
): string {
  const withVersion = (label: string): string =>
    version ? label.replace('(', `${version} (`) : label;
  if (platform !== 'win32') return withVersion('bash (Unix)');
  return prefer === 'bash' ? withVersion('bash (Git Bash or WSL)') : withVersion('PowerShell (Windows)');
}

/**
 * Compose the model-facing shell description from a resolved shell, including
 * the detected version so the model knows which syntax features are available
 * (e.g. PowerShell 5.1 lacks `&&`/`||`, PowerShell 7 has them).
 */
export function describeResolvedShell(shell: ResolvedShell): string {
  const version = shell.version;
  const withVersion = (label: string): string =>
    version ? label.replace('(', `${version} (`) : label;
  switch (shell.kind) {
    case 'powershell':
      return withVersion('PowerShell (Windows)');
    case 'wsl-bash':
      return withVersion('bash (WSL)');
    case 'bash':
      return withVersion('bash (Git Bash)');
  }
}

async function commandExists(executable: string): Promise<string | null> {
  try {
    const probe = await execFileAsync('where', [executable], { timeout: 3000 });
    const first = probe.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first ?? executable;
  } catch {
    return null;
  }
}

/** Detect whether a bash executable is the WSL bash (Linux semantics). */
async function detectWsl(bashPath: string): Promise<boolean> {
  try {
    const probe = await execFileAsync(
      bashPath,
      ['-c', 'uname -s; grep -qi microsoft /proc/version && echo wsl'],
      { timeout: 3000 },
    );
    return probe.stdout.includes('Linux') && probe.stdout.includes('wsl');
  } catch {
    return false;
  }
}

/** Probe the PowerShell version string (e.g. '5.1.26100.9168' or '7.4.6'). */
async function probePowerShellVersion(command: string): Promise<string | undefined> {
  try {
    const probe = await execFileAsync(command, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // UTF-8 前缀保证管道输出可被 Node 正确解码（PS 5.1 默认按系统 ANSI 代码页输出）。
      POWERSHELL_UTF8_PREFIX + '$PSVersionTable.PSVersion.ToString()',
    ], { timeout: 5000 });
    const version = probe.stdout.trim().split(/\r?\n/)[0]?.trim();
    return version || undefined;
  } catch {
    return undefined;
  }
}

/** Probe the bash version string (e.g. '5.2.26' from `bash --version`). */
async function probeBashVersion(bashPath: string): Promise<string | undefined> {
  try {
    const probe = await execFileAsync(bashPath, ['--version'], { timeout: 5000 });
    const match = /version\s+([0-9][0-9.]*)/i.exec(probe.stdout);
    return match?.[1] ?? undefined;
  } catch {
    return undefined;
  }
}

async function resolveWindowsBash(): Promise<ResolvedShell> {
  // Prefer Git Bash (native Windows paths) over any bash found in PATH.
  const gitBashCandidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  const gitBash = gitBashCandidates.find((candidate) => existsSync(candidate));
  if (gitBash) {
    return {
      kind: 'bash',
      command: gitBash,
      args: (command) => ['-c', command],
      toWorkingDirectory: (cwd) => cwd,
      label: 'bash (Git Bash)',
      version: await probeBashVersion(gitBash),
    };
  }
  const pathBash = await commandExists('bash');
  if (!pathBash) {
    throw new Error(
      '未找到可用的 bash 可执行文件。请安装 Git for Windows（自带 Git Bash），或改用 tools.shell 的 powershell 模式。',
    );
  }
  const isWsl = await detectWsl(pathBash);
  return {
    kind: isWsl ? 'wsl-bash' : 'bash',
    command: pathBash,
    args: (command) => ['-c', command],
    // WSL interprets Windows drive paths as /mnt/<drive>/... — translate the
    // working directory so commands run in the intended folder.
    toWorkingDirectory: (cwd) => (isWsl ? toWslPath(cwd) : cwd),
    label: isWsl ? 'bash (WSL)' : 'bash (Git Bash)',
    version: await probeBashVersion(pathBash),
  };
}

/**
 * Prefix that forces UTF-8 on PowerShell's pipe output.
 *
 * Windows PowerShell 5.1 writes to redirected/piped stdout using the system
 * ANSI codepage (GBK on Chinese Windows), which Node's UTF-8 decoding turns
 * into mojibake (U+FFFD) — the bash tool then "returns no readable content".
 * Setting [Console]::OutputEncoding normalizes everything (PowerShell's own
 * output AND native commands like git/npx/tsc) to UTF-8 on both PS 5.1 and 7.
 */
const POWERSHELL_UTF8_PREFIX = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);';

async function resolveWindowsPowerShell(): Promise<ResolvedShell> {
  // Prefer PowerShell 7 (pwsh) when installed, fall back to the built-in
  // Windows PowerShell 5.1 (powershell.exe) which is always present.
  const pwsh = await commandExists('pwsh');
  const command = pwsh ?? 'powershell.exe';
  return {
    kind: 'powershell',
    command,
    args: (cmd) => ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_UTF8_PREFIX + cmd],
    toWorkingDirectory: (cwd) => cwd,
    label: 'PowerShell (Windows)',
    version: await probePowerShellVersion(command),
  };
}

const shellCache = new Map<string, Promise<ResolvedShell>>();

/**
 * Runtime-default shell preference. Callers (CLI / Web runtime) sync this from
 * config so the bash tool reacts to setting changes without being rebuilt.
 */
let defaultPreference: ShellPreference = 'auto';

export function setDefaultShellPreference(prefer: ShellPreference): void {
  defaultPreference = prefer;
}

export function getDefaultShellPreference(): ShellPreference {
  return defaultPreference;
}

/**
 * Resolve the shell the bash tool should use, based on the platform and the
 * configured preference. Results are cached per (platform, preference) pair.
 */
export function resolveShell(options?: {
  platform?: NodeJS.Platform;
  prefer?: ShellPreference;
}): Promise<ResolvedShell> {
  const platform = options?.platform ?? process.platform;
  const prefer = options?.prefer ?? defaultPreference;
  const key = `${platform}:${prefer}`;
  const cached = shellCache.get(key);
  if (cached) return cached;

  let pending: Promise<ResolvedShell>;
  if (platform !== 'win32') {
    const bashPath = existsSync('/bin/bash') ? '/bin/bash' : 'bash';
    pending = Promise.resolve({
      kind: 'bash',
      command: bashPath,
      args: (command) => ['-c', command],
      toWorkingDirectory: (cwd) => cwd,
      label: 'bash (Unix)',
    });
  } else if (prefer === 'bash') {
    pending = resolveWindowsBash();
  } else {
    pending = resolveWindowsPowerShell();
  }

  // Cache failures too (e.g. missing bash) so we don't re-probe on every call.
  const tracked = pending.catch((error: unknown) => {
    shellCache.delete(key);
    throw error;
  });
  shellCache.set(key, tracked);
  return tracked;
}

/** Clear the module-level shell resolution cache (mainly for tests). */
export function resetShellCache(): void {
  shellCache.clear();
  shellDescriptionCache.clear();
}

// ---------------------------------------------------------------------------
// Versioned shell description (for system prompts)
// ---------------------------------------------------------------------------
//
// resolveShell() is async, but runtimes often build the prompt context
// synchronously (e.g. a conversation constructor). These helpers expose a
// sync cached description that is warmed asynchronously once, so the model
// sees the detected version (e.g. 'PowerShell 5.1.26100.9168 (Windows)')
// without blocking startup.

const shellDescriptionCache = new Map<string, string>();

function descriptionKey(platform: NodeJS.Platform, prefer: ShellPreference): string {
  return `${platform}:${prefer}`;
}

/**
 * Synchronous best-effort description: returns the versioned description when
 * the async probe has already completed, otherwise the plain strategy label.
 */
export function getCachedShellDescription(
  options?: { platform?: NodeJS.Platform; prefer?: ShellPreference },
): string {
  const platform = options?.platform ?? process.platform;
  const prefer = options?.prefer ?? defaultPreference;
  return shellDescriptionCache.get(descriptionKey(platform, prefer)) ?? describeShell(platform, prefer);
}

/**
 * Resolve the shell and warm the description cache with the detected version.
 * Never throws: falls back to the plain label when probing fails.
 */
export async function warmShellDescription(options?: {
  platform?: NodeJS.Platform;
  prefer?: ShellPreference;
}): Promise<string> {
  const platform = options?.platform ?? process.platform;
  const prefer = options?.prefer ?? defaultPreference;
  try {
    const shell = await resolveShell({ platform, prefer });
    const description = describeResolvedShell(shell);
    shellDescriptionCache.set(descriptionKey(platform, prefer), description);
    return description;
  } catch {
    return describeShell(platform, prefer);
  }
}
