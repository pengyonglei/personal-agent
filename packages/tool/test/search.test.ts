import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GrepTool } from '../src/tools/search';

test('grep ignores generated directories and honors files_with_matches head_limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-grep-'));
  try {
    await mkdir(join(directory, 'src'));
    await mkdir(join(directory, 'out'));
    await writeFile(join(directory, 'src', 'first.ts'), 'needle\n');
    await writeFile(join(directory, 'src', 'second.ts'), 'needle\n');
    await writeFile(join(directory, 'out', 'generated.js'), 'needle\n');

    const result = await new GrepTool().execute(
      { pattern: 'needle', output_mode: 'files_with_matches', head_limit: 1 },
      { sessionId: 'test', workingDirectory: directory },
    );

    assert.equal(result.success, true);
    assert.equal(result.content.split('\n').length, 1);
    assert.match(result.content, /^src[/\\]/);
    assert.doesNotMatch(result.content, /out[/\\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('grep rejects invalid regular expressions before scanning files', async () => {
  const result = await new GrepTool().execute(
    { pattern: '[' },
    { sessionId: 'test', workingDirectory: process.cwd() },
  );

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /Invalid regular expression/);
});

test('grep respects an aborted tool context', async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await new GrepTool().execute(
    { pattern: 'anything' },
    { sessionId: 'test', workingDirectory: process.cwd(), signal: controller.signal },
  );

  assert.equal(result.success, false);
  assert.equal(result.metadata?.interrupted, true);
});
