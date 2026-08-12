import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
import type { ValidationConfig } from './types';

export class ValidationInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationInfrastructureError';
  }
}

export interface ManagedValidationServer {
  reused: boolean;
  logs: string[];
  stop: () => Promise<void>;
}

export async function ensureValidationServer(
  config: ValidationConfig,
  workingDirectory: string,
  signal?: AbortSignal,
): Promise<ManagedValidationServer> {
  const healthUrl = config.server.healthUrl ?? config.server.url;
  if (config.server.reuseExisting && (await isReachable(healthUrl))) {
    return { reused: true, logs: [`Reused server at ${healthUrl}`], stop: async () => undefined };
  }
  if (!config.server.command) {
    throw new ValidationInfrastructureError(
      `No server is listening at ${healthUrl}, and server.command is not configured.`,
    );
  }

  const logs: string[] = [];
  const child = spawn(config.server.command, {
    cwd: workingDirectory,
    env: { ...process.env, ...config.server.env },
    shell: true,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  capture(child.stdout, logs);
  capture(child.stderr, logs);

  try {
    await waitForHealth(child, healthUrl, config.server.timeoutMs, signal, logs);
  } catch (error) {
    await stopProcessTree(child);
    throw error;
  }
  return {
    reused: false,
    logs,
    stop: () => stopProcessTree(child),
  };
}

async function waitForHealth(
  child: ChildProcess,
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  logs: string[],
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ValidationInfrastructureError('Validation was interrupted.');
    if (child.exitCode !== null) {
      throw new ValidationInfrastructureError(
        `Development server exited with code ${child.exitCode}.\n${logs.slice(-20).join('\n')}`,
      );
    }
    if (await isReachable(url)) return;
    await delay(250, signal);
  }
  throw new ValidationInfrastructureError(
    `Development server did not become healthy within ${timeoutMs}ms: ${url}`,
  );
}

export async function isReachable(url: string): Promise<boolean> {
  return new Promise((resolveReachable) => {
    const parsed = new URL(url);
    const send = parsed.protocol === 'https:' ? secureRequest : request;
    const req = send(parsed, { method: 'GET', timeout: 2_000 }, (res) => {
      res.resume();
      resolveReachable((res.statusCode ?? 500) < 500);
    });
    req.once('timeout', () => req.destroy());
    req.once('error', () => resolveReachable(false));
    req.end();
  });
}

export async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolveStop) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('exit', () => resolveStop());
      killer.once('error', () => {
        child.kill();
        resolveStop();
      });
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    delay(2_000).then(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }),
  ]);
}

function capture(stream: NodeJS.ReadableStream | null, logs: string[]): void {
  stream?.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
      logs.push(line);
      if (logs.length > 1_000) logs.shift();
    }
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveDelay, rejectDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        rejectDelay(new ValidationInfrastructureError('Validation was interrupted.'));
      },
      { once: true },
    );
  });
}
