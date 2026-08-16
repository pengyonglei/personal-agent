import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GlobTool, GrepTool } from '../src/tools/search';

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

test('glob skips heavy generated directories (node_modules, dist, ...)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-glob-'));
  try {
    await mkdir(join(directory, 'src'));
    await mkdir(join(directory, 'node_modules', 'some-pkg', 'lib'), { recursive: true });
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'src', 'a.ts'), '');
    await writeFile(join(directory, 'node_modules', 'some-pkg', 'lib', 'b.js'), '');
    await writeFile(join(directory, 'dist', 'c.js'), '');
    await writeFile(join(directory, 'package.json'), '{}');

    const result = await new GlobTool().execute(
      { pattern: '**/*' },
      { sessionId: 'test', workingDirectory: directory },
    );

    assert.equal(result.success, true);
    const lines = (result.content ?? '').split('\n');
    assert.ok(lines.includes('src/a.ts'), `missing src/a.ts in ${result.content}`);
    assert.ok(lines.includes('package.json'), `missing package.json in ${result.content}`);
    assert.doesNotMatch(result.content ?? '', /node_modules|dist[/\\]c\.js/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('glob stops early at maxResults and flags truncation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-glob-cap-'));
  try {
    for (let i = 0; i < 6; i++) {
      await writeFile(join(directory, `file-${i}.txt`), '');
    }

    const result = await new GlobTool({ maxResults: 3, timeoutMs: 10_000 }).execute(
      { pattern: '**/*' },
      { sessionId: 'test', workingDirectory: directory },
    );

    assert.equal(result.success, true);
    assert.equal(result.metadata?.truncated, true);
    const lines = (result.content ?? '').split('\n').filter((l) => l.length > 0 && !l.includes('[truncated'));
    assert.equal(lines.length, 3);
    assert.match(result.content ?? '', /\[truncated/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('glob respects an aborted tool context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-glob-abort-'));
  try {
    await writeFile(join(directory, 'a.txt'), '');
    const controller = new AbortController();
    controller.abort();

    const result = await new GlobTool().execute(
      { pattern: '**/*' },
      { sessionId: 'test', workingDirectory: directory, signal: controller.signal },
    );

    assert.equal(result.success, false);
    assert.equal(result.metadata?.interrupted, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
