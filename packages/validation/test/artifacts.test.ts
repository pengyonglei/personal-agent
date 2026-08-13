import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  artifactFromPath,
  pruneValidationRuns,
  resolveValidationArtifact,
} from '../src/artifacts';

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

test('screenshot artifacts reject Chromium placeholder surfaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pa-artifacts-shot-'));
  const path = join(root, 'blank.png');
  const placeholder = Buffer.from(
    '89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d240000001549444154789c63606060f8cfc0c0c0c0c0c4c000000d1d010375060d4e0000000049454e44ae426082',
    'hex',
  );
  await writeFile(path, placeholder);
  await assert.rejects(
    () => artifactFromPath(path, 'screenshot', 'image/png'),
    /unusable 2x2 capture surface/,
  );
});
