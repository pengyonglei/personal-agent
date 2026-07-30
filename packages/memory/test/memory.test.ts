import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSystemMemoryStore } from '../src/index';

test('memory persists, searches, injects context, and records access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-memory-'));
  try {
    const first = new FileSystemMemoryStore({ baseDir: directory, maxEntries: 10 });
    await first.initialize();
    const created = await first.create({
      type: 'preference',
      content: 'The user prefers a Web UI.',
      tags: ['ui', 'web'],
      metadata: { importance: 1 },
    });
    assert.match(await first.getRelevantContext('web interface', 100), /Web UI/);
    assert.equal((await first.read(created.id))?.metadata.accessCount, 2);

    const restored = new FileSystemMemoryStore({ baseDir: directory, maxEntries: 10 });
    await restored.initialize();
    assert.equal((await restored.read(created.id))?.metadata.accessCount, 3);
    assert.equal((await restored.searchByTags(['web'])).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('memory enforces maxEntries while retaining newly written entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-memory-limit-'));
  try {
    const store = new FileSystemMemoryStore({ baseDir: directory, maxEntries: 2 });
    await store.initialize();
    await store.create({ type: 'fact', content: 'one', tags: [], metadata: { importance: 3 } });
    await store.create({ type: 'fact', content: 'two', tags: [], metadata: { importance: 2 } });
    const newest = await store.create({
      type: 'fact',
      content: 'three',
      tags: [],
      metadata: { importance: 1 },
    });
    assert.equal((await store.getStats()).totalEntries, 2);
    assert.equal((await store.read(newest.id))?.content, 'three');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
