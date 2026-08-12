import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ValidationBrowserSession } from './browser';
import {
  artifactFromPath,
  createRunArtifacts,
  pruneValidationRuns,
  writeTextArtifact,
  writeValidationReport,
} from './artifacts';
import { loadValidationConfig, ValidationConfigError } from './config';
import { ensureValidationServer, stopProcessTree, ValidationInfrastructureError } from './server';
import type {
  ValidationArtifact,
  ValidationConfig,
  ValidationIssue,
  ValidationProfileName,
  ValidationRunResult,
  ValidationStepResult,
  VisualReviewer,
} from './types';

export interface RunFrontendValidationOptions {
  workingDirectory: string;
  profile?: ValidationProfileName;
  configPath?: string;
  signal?: AbortSignal;
  visualReviewer?: VisualReviewer;
  onProgress?: (message: string) => void;
}

export function validationExitCode(status: ValidationRunResult['status']): 0 | 1 | 2 {
  return status === 'passed' ? 0 : status === 'failed' ? 1 : 2;
}

export async function runFrontendValidation(
  options: RunFrontendValidationOptions,
): Promise<ValidationRunResult> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const profile = options.profile ?? 'quick';
  let config: ValidationConfig;
  try {
    config = await loadValidationConfig(options.workingDirectory, options.configPath);
  } catch (error) {
    if (error instanceof ValidationConfigError) {
      return infrastructureResult(
        options.workingDirectory,
        profile,
        started,
        startedAt,
        error.message,
      );
    }
    throw error;
  }

  const run = await createRunArtifacts(
    options.workingDirectory,
    resolveArtifactRoot(config, options.workingDirectory),
  );
  const steps: ValidationStepResult[] = [];
  const issues: ValidationIssue[] = [];
  const artifacts: ValidationArtifact[] = [];
  const logLines: string[] = [];
  let server: Awaited<ReturnType<typeof ensureValidationServer>> | undefined;
  let browser: ValidationBrowserSession | undefined;
  let traceStarted = false;
  let vision: ValidationRunResult['vision'] = {
    status: 'skipped',
    reason: 'No visual reviewer configured.',
  };

  try {
    const checks =
      profile === 'full' ? [...config.checks.quick, ...config.checks.full] : config.checks.quick;
    for (const check of checks) {
      options.onProgress?.(`Running check: ${check.command}`);
      const result = await timedStep(`check: ${check.command}`, () =>
        runCommand(
          check.command,
          options.workingDirectory,
          check.timeoutMs ?? 120_000,
          options.signal,
        ),
      );
      steps.push(result.step);
      logLines.push(result.output);
      if (result.step.status === 'failed') {
        issues.push({ source: 'check', message: result.step.error ?? 'Static check failed.' });
      }
    }
    if (issues.length > 0) throw new ValidationFailure();

    options.onProgress?.('Starting or reusing the development server.');
    const serverStep = await timedStep('development server', async () => {
      server = await ensureValidationServer(config, options.workingDirectory, options.signal);
      return server.reused ? 'Reused an existing server.' : 'Started a managed server.';
    });
    steps.push(serverStep.step);
    if (serverStep.step.status === 'failed') {
      issues.push({
        source: 'infrastructure',
        message: serverStep.step.error ?? 'Development server could not start.',
      });
      throw new ValidationFailure();
    }

    browser = new ValidationBrowserSession(config, options.workingDirectory);
    await browser.open();
    if (config.artifacts.trace !== 'off') {
      await browser.startTrace();
      traceStarted = true;
    }

    for (const scenario of config.scenarios.filter((item) => item.profiles?.includes(profile))) {
      options.onProgress?.(`Validating scenario: ${scenario.name}`);
      const scenarioStart = Date.now();
      try {
        await browser.navigate(scenario.path ?? '/');
        for (const action of scenario.actions ?? []) await browser.act(action);
        for (const assertion of scenario.assertions ?? []) await browser.assert(assertion);
        const snapshot = await browser.snapshot();
        artifacts.push(
          await writeTextArtifact(
            run.directory,
            `${screenshotBaseName(scenario.name)}.dom.json`,
            `${JSON.stringify(snapshot, null, 2)}\n`,
            'dom',
            'application/json; charset=utf-8',
          ),
        );
        if (scenario.screenshot !== false) {
          const name = screenshotName(
            typeof scenario.screenshot === 'string' ? scenario.screenshot : scenario.name,
          );
          const path = join(run.directory, name);
          await browser.screenshot(path);
          artifacts.push(await artifactFromPath(path, 'screenshot', 'image/png'));
          if (options.visualReviewer) {
            try {
              const review = await options.visualReviewer({
                screenshotPath: path,
                scenario: scenario.name,
                prompt:
                  config.vision?.prompt ??
                  'Review this UI for broken layout, clipped text, overlap, missing key controls, and obvious visual regressions.',
              });
              vision = { status: review.passed ? 'passed' : 'failed', reason: review.summary };
              if (!review.passed) {
                issues.push({ source: 'vision', scenario: scenario.name, message: review.summary });
              }
            } catch (error) {
              vision = {
                status: 'skipped',
                reason: `Visual reviewer unavailable: ${formatError(error)}`,
              };
            }
          }
        }
        steps.push({
          name: `scenario: ${scenario.name}`,
          status: 'passed',
          durationMs: Date.now() - scenarioStart,
        });
      } catch (error) {
        const message = formatError(error);
        issues.push({ source: 'assertion', scenario: scenario.name, message });
        steps.push({
          name: `scenario: ${scenario.name}`,
          status: 'failed',
          durationMs: Date.now() - scenarioStart,
          error: message,
        });
        const failurePath = join(run.directory, screenshotName(`${scenario.name}-failure`));
        await browser.screenshot(failurePath).catch(() => undefined);
        try {
          artifacts.push(await artifactFromPath(failurePath, 'screenshot', 'image/png'));
        } catch {
          // A navigation-level failure may prevent a screenshot.
        }
      }
    }

    collectDiagnostics(config, browser, issues, logLines);
  } catch (error) {
    if (!(error instanceof ValidationFailure)) {
      issues.push({
        source: error instanceof ValidationInfrastructureError ? 'infrastructure' : 'assertion',
        message: formatError(error),
      });
    }
  } finally {
    if (server) logLines.push(...server.logs);
    if (browser && traceStarted) {
      const keepTrace = config.artifacts.trace === 'on' || issues.length > 0;
      const tracePath = keepTrace ? join(run.directory, 'trace.zip') : undefined;
      await browser.stopTrace(tracePath).catch((error) => {
        issues.push({
          source: 'infrastructure',
          message: `Cannot save trace: ${formatError(error)}`,
        });
      });
      if (tracePath) {
        try {
          artifacts.push(await artifactFromPath(tracePath, 'trace', 'application/zip'));
        } catch {
          // Ignore an empty/missing trace after a browser crash.
        }
      }
    }
    await browser?.close();
    await server?.stop();
  }

  const logArtifact = await writeTextArtifact(
    run.directory,
    'validation.log',
    logLines.join('\n'),
    'log',
  );
  artifacts.push(logArtifact);
  const infrastructure = issues.some((issue) => issue.source === 'infrastructure');
  const status = infrastructure ? 'infrastructure_error' : issues.length > 0 ? 'failed' : 'passed';
  const finished = Date.now();
  const result: ValidationRunResult = {
    runId: run.runId,
    projectHash: run.projectHash,
    profile,
    status,
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    summary:
      status === 'passed'
        ? `Frontend validation passed (${steps.filter((step) => step.status === 'passed').length} steps).`
        : `Frontend validation ${status === 'failed' ? 'failed' : 'could not run'} with ${issues.length} issue(s).`,
    steps,
    issues,
    artifacts,
    artifactDirectory: run.directory,
    vision,
  };
  artifacts.push(await writeValidationReport(result));
  await pruneValidationRuns(run.root, run.projectHash, config.artifacts.keepRuns);
  return result;
}

async function infrastructureResult(
  workingDirectory: string,
  profile: ValidationProfileName,
  started: number,
  startedAt: string,
  message: string,
): Promise<ValidationRunResult> {
  const run = await createRunArtifacts(workingDirectory);
  const finished = Date.now();
  const result: ValidationRunResult = {
    runId: run.runId,
    projectHash: run.projectHash,
    profile,
    status: 'infrastructure_error',
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    summary: `Frontend validation could not run: ${message}`,
    steps: [],
    issues: [{ source: 'infrastructure', message }],
    artifacts: [],
    artifactDirectory: run.directory,
    vision: { status: 'skipped', reason: 'Validation infrastructure was unavailable.' },
  };
  result.artifacts.push(await writeValidationReport(result));
  return result;
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, {
      cwd,
      env: process.env,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let settled = false;
    child.stdout?.on('data', (chunk) => (output += String(chunk)));
    child.stderr?.on('data', (chunk) => (output += String(chunk)));
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void stopProcessTree(child).finally(() =>
        rejectCommand(new Error(`Command timed out after ${timeoutMs}ms: ${command}`)),
      );
    }, timeoutMs);
    const abort = () => {
      if (settled) return;
      settled = true;
      void stopProcessTree(child).finally(() =>
        rejectCommand(new Error('Validation was interrupted.')),
      );
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectCommand(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolveCommand(output);
      else rejectCommand(new Error(`Command exited with code ${code}: ${command}\n${output}`));
    });
  });
}

async function timedStep<T>(name: string, work: () => Promise<T>) {
  const started = Date.now();
  try {
    const value = await work();
    return {
      value,
      output: typeof value === 'string' ? value : '',
      step: { name, status: 'passed', durationMs: Date.now() - started } as ValidationStepResult,
    };
  } catch (error) {
    return {
      value: undefined,
      output: formatError(error),
      step: {
        name,
        status: 'failed',
        durationMs: Date.now() - started,
        error: formatError(error),
      } as ValidationStepResult,
    };
  }
}

function collectDiagnostics(
  config: ValidationConfig,
  browser: ValidationBrowserSession,
  issues: ValidationIssue[],
  logs: string[],
): void {
  for (const entry of browser.diagnostics.console) {
    logs.push(`[console:${entry.level}] ${entry.text}`);
    if (
      config.console.failOn.includes(entry.level as 'error' | 'warning') &&
      !matchesIgnore(entry.text, config.console.ignore)
    ) {
      issues.push({ source: 'console', message: `[${entry.level}] ${entry.text}` });
    }
  }
  for (const error of browser.diagnostics.pageErrors) {
    logs.push(`[pageerror] ${error}`);
    if (!matchesIgnore(error, config.console.ignore))
      issues.push({ source: 'page', message: error });
  }
  if (config.network.failOnRequestError) {
    for (const failure of browser.diagnostics.requestFailures) {
      if (!matchesIgnore(failure.url, config.network.ignore)) {
        issues.push({ source: 'network', message: `${failure.url}: ${failure.error}` });
      }
    }
  }
  for (const response of browser.diagnostics.responses) {
    if (!matchesIgnore(response.url, config.network.ignore)) {
      issues.push({ source: 'network', message: `${response.status} ${response.url}` });
    }
  }
}

function matchesIgnore(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

function screenshotName(value: string): string {
  return `${screenshotBaseName(value)}.png`;
}

function screenshotBaseName(value: string): string {
  const name = value
    .trim()
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name || 'screenshot';
}

function resolveArtifactRoot(
  config: ValidationConfig,
  workingDirectory: string,
): string | undefined {
  if (!config.artifacts.root) return undefined;
  return resolve(workingDirectory, config.artifacts.root);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ValidationFailure extends Error {}
