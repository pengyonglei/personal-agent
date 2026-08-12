import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import type { ValidationArtifact, ValidationArtifactKind, ValidationRunResult } from './types';

const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;

export function getValidationArtifactsRoot(configuredRoot?: string): string {
  if (configuredRoot) {
    return isAbsolute(configuredRoot) ? configuredRoot : resolve(configuredRoot);
  }
  return resolve(homedir(), '.personal-agent', 'validation-runs');
}

export function projectHash(workingDirectory: string): string {
  return createHash('sha256')
    .update(resolve(workingDirectory).toLowerCase())
    .digest('hex')
    .slice(0, 16);
}

export async function createRunArtifacts(
  workingDirectory: string,
  configuredRoot?: string,
): Promise<{ root: string; projectHash: string; runId: string; directory: string }> {
  const root = getValidationArtifactsRoot(configuredRoot);
  const hash = projectHash(workingDirectory);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const directory = resolve(root, hash, runId);
  await mkdir(directory, { recursive: true });
  return { root, projectHash: hash, runId, directory };
}

export async function writeTextArtifact(
  directory: string,
  name: string,
  content: string,
  kind: ValidationArtifactKind,
  mimeType = 'text/plain; charset=utf-8',
): Promise<ValidationArtifact> {
  const safeName = safeArtifactName(name);
  const path = resolve(directory, safeName);
  await writeFile(path, content, 'utf8');
  return artifactFromPath(path, kind, mimeType);
}

export async function artifactFromPath(
  path: string,
  kind: ValidationArtifactKind,
  mimeType: string,
): Promise<ValidationArtifact> {
  const info = await stat(path);
  return {
    id: basename(path),
    kind,
    name: basename(path),
    mimeType,
    size: info.size,
  };
}

export async function writeValidationReport(
  result: ValidationRunResult,
): Promise<ValidationArtifact> {
  return writeTextArtifact(
    result.artifactDirectory,
    'report.json',
    `${JSON.stringify({ ...result, artifactDirectory: undefined }, null, 2)}\n`,
    'report',
    'application/json; charset=utf-8',
  );
}

export async function pruneValidationRuns(
  root: string,
  project: string,
  keepRuns: number,
): Promise<void> {
  const directory = resolve(root, project);
  if (!existsSync(directory)) return;
  const entries = await readdir(directory, { withFileTypes: true });
  const runs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of runs.slice(keepRuns)) {
    if (!SAFE_SEGMENT.test(name)) continue;
    await rm(resolve(directory, name), { recursive: true, force: true });
  }
}

export function resolveValidationArtifact(
  root: string,
  project: string,
  runId: string,
  artifactId: string,
): string | null {
  if (![project, runId, artifactId].every((part) => SAFE_SEGMENT.test(part))) return null;
  const path = resolve(root, project, runId, artifactId);
  return existsSync(path) ? path : null;
}

export async function readValidationReport(path: string): Promise<ValidationRunResult> {
  return JSON.parse(await readFile(path, 'utf8')) as ValidationRunResult;
}

function safeArtifactName(value: string): string {
  const normalized = basename(value).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return normalized || 'artifact.txt';
}
