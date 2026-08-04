import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { UsageStore } from '@personal-agent/stats';
import { createWebServer } from '../src/server';

const statsAvailable = UsageStore.isAvailable();

async function createTestServer() {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-stats-'));
  const configPath = join(directory, 'config.yaml');
  await writeFile(
    configPath,
    [
      'stats:',
      '  recordPayloads: false',
      'memory:',
      '  enabled: false',
      'plugins:',
      '  enabled: false',
      'mcp:',
      '  servers: []',
    ].join('\n'),
    'utf-8',
  );
  const clientBuildDirectory = join(directory, 'client');
  await mkdir(clientBuildDirectory);
  await writeFile(join(clientBuildDirectory, 'index.html'), '<h1>stats client</h1>', 'utf8');
  const statsDbPath = join(directory, 'stats', 'model-requests.db');
  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
    clientBuildDirectory,
    statsDbPath,
  });
  return { directory, configPath, statsDbPath, instance };
}

test('stats API returns empty aggregates when no records exist', { skip: !statsAvailable }, async () => {
  const { directory, instance } = await createTestServer();
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/stats?days=7`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      available: boolean;
      summary: { count: number };
      byModel: unknown[];
      byDay: unknown[];
      total: number;
      records: unknown[];
    };
    assert.equal(payload.available, true);
    assert.equal(payload.summary.count, 0);
    assert.deepEqual(payload.byModel, []);
    assert.deepEqual(payload.byDay, []);
    assert.equal(payload.total, 0);
    assert.deepEqual(payload.records, []);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('stats API aggregates inserted records', { skip: !statsAvailable }, async () => {
  const { directory, statsDbPath, instance } = await createTestServer();
  try {
    const store = new UsageStore({ dbPath: statsDbPath });
    store.initialize();
    const now = Date.now();
    store.insert({
      timestamp: now,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'completed',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 1000,
    });
    store.insert({
      timestamp: now - 1000,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'error',
      error: 'boom',
      inputTokens: 200,
      outputTokens: 100,
      durationMs: 2000,
    });
    store.close();

    const response = await fetch(`http://127.0.0.1:${instance.port}/api/stats?days=7`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      available: boolean;
      summary: {
        count: number;
        errorCount: number;
        inputTokens: number;
        outputTokens: number;
        avgDurationMs: number;
      };
      byModel: Array<{ provider: string; model: string; count: number }>;
      total: number;
      records: Array<{ id: number; status: string }>;
    };
    assert.equal(payload.available, true);
    assert.equal(payload.summary.count, 2);
    assert.equal(payload.summary.errorCount, 1);
    assert.equal(payload.summary.inputTokens, 300);
    assert.equal(payload.summary.outputTokens, 150);
    assert.equal(payload.summary.avgDurationMs, 1500);
    assert.equal(payload.byModel.length, 1);
    assert.equal(payload.byModel[0].provider, 'deepseek');
    assert.equal(payload.byModel[0].model, 'deepseek-v4-flash');
    assert.equal(payload.byModel[0].count, 2);
    assert.equal(payload.records.length, 2);
    assert.equal(payload.records[0].id, 2); // newest first (auto-increment id)
    assert.equal(payload.records[1].id, 1);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('stats-config GET/PUT round-trips recordPayloads in config.yaml', async () => {
  const { directory, configPath, instance } = await createTestServer();
  try {
    const getResponse = await fetch(`http://127.0.0.1:${instance.port}/api/stats-config`);
    assert.equal(getResponse.status, 200);
    assert.deepEqual(await getResponse.json(), { recordPayloads: false });

    const putResponse = await fetch(`http://127.0.0.1:${instance.port}/api/stats-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordPayloads: true }),
    });
    assert.equal(putResponse.status, 200);
    assert.deepEqual(await putResponse.json(), { recordPayloads: true });

    const again = await fetch(`http://127.0.0.1:${instance.port}/api/stats-config`);
    assert.deepEqual(await again.json(), { recordPayloads: true });

    const invalid = await fetch(`http://127.0.0.1:${instance.port}/api/stats-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordPayloads: 'yes' }),
    });
    assert.equal(invalid.status, 400);

    const fileContent = await readFile(configPath, 'utf8');
    assert.match(fileContent, /recordPayloads: true/);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('stats API paginates records by id desc', { skip: !statsAvailable }, async () => {
  const { directory, statsDbPath, instance } = await createTestServer();
  try {
    const store = new UsageStore({ dbPath: statsDbPath });
    store.initialize();
    for (let index = 1; index <= 25; index += 1) {
      store.insert({
        timestamp: index,
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        status: 'completed',
        inputTokens: index,
        outputTokens: index,
      });
    }
    store.close();

    const response = await fetch(
      `http://127.0.0.1:${instance.port}/api/stats?days=365&page=2&pageSize=10`,
    );
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      total: number;
      records: Array<{ id: number; inputTokens: number }>;
    };
    assert.equal(payload.total, 25);
    assert.equal(payload.records.length, 10);
    // Page 2 of 25 rows sorted by id DESC → ids 15..6.
    assert.equal(payload.records[0].id, 15);
    assert.equal(payload.records[9].id, 6);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('PUT stats-config takes effect immediately for new records', { skip: !statsAvailable }, async () => {
  const { directory, statsDbPath, instance } = await createTestServer();
  try {
    // Switch starts disabled (config.yaml) — a payload written now is dropped.
    const store = new UsageStore({ dbPath: statsDbPath, recordPayloads: false });
    store.initialize();
    store.insert({
      timestamp: Date.now(),
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'completed',
      inputTokens: 10,
      outputTokens: 5,
      requestMessages: { role: 'user', content: 'should-not-persist' },
    });
    store.close();

    const putResponse = await fetch(`http://127.0.0.1:${instance.port}/api/stats-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordPayloads: true }),
    });
    assert.equal(putResponse.status, 200);

    // After the switch, the running runtime store persists payloads immediately.
    const runtimeStore = instance.runtime.statsStore;
    assert.ok(runtimeStore);
    runtimeStore.insert({
      timestamp: Date.now(),
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      status: 'completed',
      inputTokens: 20,
      outputTokens: 10,
      requestMessages: { role: 'user', content: 'persisted-now' },
    });

    const response = await fetch(`http://127.0.0.1:${instance.port}/api/stats?days=7`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      records: Array<{ requestMessages?: unknown; inputTokens: number }>;
    };
    assert.equal(payload.records.length, 2);
    // Newest first (auto-increment id): the post-switch record is at index 0.
    assert.equal(payload.records[0].inputTokens, 20);
    assert.deepEqual(payload.records[0].requestMessages, { role: 'user', content: 'persisted-now' });
    assert.equal(payload.records[1].inputTokens, 10);
    assert.equal(payload.records[1].requestMessages, undefined);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});
