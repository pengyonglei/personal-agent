import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pruneValidationRuns, resolveValidationArtifact } from '../src/artifacts';

test('artifact resolver rejects traversal and pruning keeps the newest runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pa-artifacts-'));
  const project = 'project123';
  for (const run of ['2026-01', '2026-02', '2026-03']) {
    await mkdir(join(root, project, run), { recursive: true });
    await writeFile(join(root, project, run, 'report.json'), '{}');
  }
  assert.equal(resolveValidationArtifact(root, '..', '2026-03', 'report.json'), null);
  assert.equal(resolveValidationArtifact(root, project, '2026-03', '../report.json'), null);
  assert.ok(resolveValidationArtifact(root, project, '2026-03', 'report.json'));
  await pruneValidationRuns(root, project, 2);
  assert.equal(resolveValidationArtifact(root, project, '2026-01', 'report.json'), null);
  assert.ok(resolveValidationArtifact(root, project, '2026-03', 'report.json'));
});
