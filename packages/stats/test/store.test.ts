import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore } from '../src/store';
import { loadDatabaseSync } from '../src/sqlite';
import type { ModelRequestRecord } from '../src/types';

const available = UsageStore.isAvailable();

function makeStore(
  options: { recordPayloads?: boolean } = {},
): { store: UsageStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pa-stats-'));
  const store = new UsageStore({ dbPath: join(dir, 'test.db'), ...options });
  store.initialize();
  return { store, dir };
}

function sampleRecord(overrides: Partial<ModelRequestRecord> = {}): ModelRequestRecord {
  return {
    sessionId: 'sess-1',
    timestamp: Date.now() - 24 * 60 * 60 * 1000,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    turnNumber: 1,
    status: 'completed',
    stopReason: 'end_turn',
    durationMs: 1200,
    inputTokens: 100,
    outputTokens: 50,
    requestMessages: { role: 'user', content: 'hello' },
    requestTools: [{ name: 'read_file' }],
    requestOptions: { temperature: 0 },
    response: {
      text: 'Hello!',
      thinking: '',
      toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } }],
      messageId: 'msg-1',
    },
    ...overrides,
  };
}

test('UsageStore.isAvailable returns false when node:sqlite missing', () => {
  // Smoke test only — on modern Node this is true. The remaining tests skip
  // when unavailable.
  assert.equal(typeof available, 'boolean');
});

test('initialize is idempotent (migration safe)', { skip: !available }, () => {
  const { store, dir } = makeStore();
  store.initialize(); // second call must not throw
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('insert assigns auto-increment ids; getRecent returns newest first', { skip: !available }, () => {
  const { store, dir } = makeStore();
  store.insert(sampleRecord({ timestamp: 1000 }));
  store.insert(sampleRecord({ timestamp: 2000 }));
  store.insert(sampleRecord({ timestamp: 3000, status: 'error', error: 'boom' }));

  const recent = store.getRecent(10);
  assert.equal(recent.length, 3);
  // Auto-increment ids follow insertion order; getRecent sorts by id DESC.
  assert.deepEqual(recent.map((r) => r.id), [3, 2, 1]);
  assert.equal(recent[0].status, 'error');
  assert.equal(recent[0].error, 'boom');

  const limited = store.getRecent(2);
  assert.equal(limited.length, 2);
  assert.equal(limited[0].id, 3);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('created_at defaults to insert time and is readable', { skip: !available }, () => {
  const { store, dir } = makeStore();
  const before = Date.now();
  store.insert(sampleRecord({ timestamp: 1000 }));
  const after = Date.now();
  const [record] = store.getRecent(1);
  assert.ok(record.createdAt !== undefined);
  assert.ok(record.createdAt >= before && record.createdAt <= after);

  // Explicit createdAt is honored.
  store.insert(sampleRecord({ timestamp: 2000, createdAt: 123456 }));
  assert.equal(store.getRecent(1)[0].createdAt, 123456);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('getBySession filters by session', { skip: !available }, () => {
  const { store, dir } = makeStore();
  store.insert(sampleRecord({ sessionId: 'sess-a', timestamp: 1000 }));
  store.insert(sampleRecord({ sessionId: 'sess-b', timestamp: 2000 }));
  store.insert(sampleRecord({ sessionId: 'sess-a', timestamp: 3000 }));

  const forA = store.getBySession('sess-a', 10);
  assert.equal(forA.length, 2);
  assert.equal(forA[0].id, 3); // newest first
  assert.equal(forA[1].id, 1);
  assert.equal(store.getBySession('sess-b', 10).length, 1);
  assert.equal(store.getBySession('sess-missing', 10).length, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('querySummary aggregates counts/tokens/duration', { skip: !available }, () => {
  const { store, dir } = makeStore();
  const base = Date.now();
  store.insert(sampleRecord({ timestamp: base, status: 'completed', inputTokens: 100, outputTokens: 50, durationMs: 1000 }));
  store.insert(sampleRecord({ timestamp: base + 1000, status: 'error', inputTokens: 200, outputTokens: 100, durationMs: 3000 }));
  store.insert(sampleRecord({ timestamp: base + 2000, status: 'interrupted', inputTokens: 300, outputTokens: 0, durationMs: 500 }));

  const summary = store.querySummary(base - 1, base + 3000);
  assert.equal(summary.count, 3);
  assert.equal(summary.errorCount, 1);
  assert.equal(summary.interruptedCount, 1);
  assert.equal(summary.inputTokens, 600);
  assert.equal(summary.outputTokens, 150);
  assert.equal(summary.avgDurationMs, 1500);

  // Out-of-window records are excluded
  store.insert(sampleRecord({ timestamp: base + 999999, inputTokens: 1 }));
  const narrow = store.querySummary(base - 1, base + 3000);
  assert.equal(narrow.count, 3);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('queryByModel groups by provider+model', { skip: !available }, () => {
  const { store, dir } = makeStore();
  const base = Date.now();
  store.insert(sampleRecord({ timestamp: base, provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 100, status: 'completed' }));
  store.insert(sampleRecord({ timestamp: base, provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 200, status: 'error' }));
  store.insert(sampleRecord({ timestamp: base, provider: 'deepseek', model: 'deepseek-v4-pro', inputTokens: 400, status: 'completed' }));

  const byModel = store.queryByModel(base - 1, base + 1);
  assert.equal(byModel.length, 2);
  const flash = byModel.find((m) => m.model === 'deepseek-v4-flash');
  const pro = byModel.find((m) => m.model === 'deepseek-v4-pro');
  assert.equal(flash?.count, 2);
  assert.equal(flash?.inputTokens, 300);
  assert.equal(flash?.errorCount, 1);
  assert.equal(pro?.count, 1);
  assert.equal(pro?.inputTokens, 400);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('queryByDay groups by UTC day', { skip: !available }, () => {
  const { store, dir } = makeStore();
  const day1 = Date.UTC(2026, 7, 3, 12, 0, 0); // 2026-08-03
  const day2 = Date.UTC(2026, 7, 4, 12, 0, 0); // 2026-08-04
  store.insert(sampleRecord({ timestamp: day1, inputTokens: 10 }));
  store.insert(sampleRecord({ timestamp: day1, inputTokens: 20 }));
  store.insert(sampleRecord({ timestamp: day2, inputTokens: 30 }));

  const byDay = store.queryByDay(day1 - 1, day2 + 1);
  assert.equal(byDay.length, 2);
  assert.equal(byDay[0].day, '2026-08-03');
  assert.equal(byDay[0].count, 2);
  assert.equal(byDay[0].inputTokens, 30);
  assert.equal(byDay[1].day, '2026-08-04');
  assert.equal(byDay[1].count, 1);
  assert.equal(byDay[1].inputTokens, 30);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('prune deletes records older than retentionDays', { skip: !available }, () => {
  const { store, dir } = makeStore();
  const now = Date.now();
  store.insert(sampleRecord({ timestamp: now - 100 * 24 * 60 * 60 * 1000 }));
  store.insert(sampleRecord({ timestamp: now - 10 * 24 * 60 * 60 * 1000 }));

  assert.equal(store.prune(30), 1);
  assert.equal(store.getRecent(10).length, 1);
  assert.equal(store.getRecent(10)[0].timestamp, now - 10 * 24 * 60 * 60 * 1000);

  // 0 disables pruning
  store.insert(sampleRecord({ timestamp: now - 300 * 24 * 60 * 60 * 1000 }));
  assert.equal(store.prune(0), 0);
  assert.equal(store.getRecent(10).length, 2);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('recordPayloads=false omits request payloads but keeps responses', { skip: !available }, () => {
  const { store, dir } = makeStore({ recordPayloads: false });
  store.insert(
    sampleRecord({
      requestMessages: { role: 'user', content: 'secret prompt' },
      requestTools: [{ name: 'bash' }],
      requestOptions: { temperature: 1 },
    }),
  );
  const [record] = store.getRecent(1);
  assert.equal(record.requestMessages, undefined);
  assert.equal(record.requestTools, undefined);
  assert.equal(record.requestOptions, undefined);
  assert.deepEqual(record.response, {
    text: 'Hello!',
    thinking: '',
    toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } }],
    messageId: 'msg-1',
  });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('recordPayloads=true persists request payloads', { skip: !available }, () => {
  const { store, dir } = makeStore({ recordPayloads: true });
  store.insert(
    sampleRecord({
      requestMessages: { role: 'user', content: 'secret prompt' },
      requestTools: [{ name: 'bash' }],
      requestOptions: { temperature: 1 },
    }),
  );
  const [record] = store.getRecent(1);
  assert.deepEqual(record.requestMessages, { role: 'user', content: 'secret prompt' });
  assert.deepEqual(record.requestTools, [{ name: 'bash' }]);
  assert.deepEqual(record.requestOptions, { temperature: 1 });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('database file is created on initialize', { skip: !available }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-stats-'));
  const dbPath = join(dir, 'nested', 'dir', 'model-requests.db');
  const store = new UsageStore({ dbPath });
  store.initialize();
  assert.equal(existsSync(dbPath), true);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('UsageStore constructor throws when node:sqlite unavailable', () => {
  // On runtimes without node:sqlite the constructor must throw so callers can
  // catch and degrade. On modern runtimes the store simply works.
  if (!available) {
    assert.throws(() => new UsageStore());
  } else {
    assert.doesNotThrow(() => new UsageStore({ dbPath: join(tmpdir(), 'pa-stats-unused.db') }));
  }
});

test('getPage returns id-desc pages with correct totals', { skip: !available }, () => {
  const { store, dir } = makeStore();
  for (let index = 1; index <= 25; index += 1) {
    store.insert(sampleRecord({ timestamp: index }));
  }

  const firstPage = store.getPage(1, 10);
  assert.equal(firstPage.total, 25);
  assert.equal(firstPage.records.length, 10);
  assert.deepEqual(firstPage.records.map((r) => r.id), [25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);

  const thirdPage = store.getPage(3, 10);
  assert.equal(thirdPage.records.length, 5);
  assert.deepEqual(thirdPage.records.map((r) => r.id), [5, 4, 3, 2, 1]);

  // Out-of-range page yields an empty list but keeps the total.
  const emptyPage = store.getPage(99, 10);
  assert.equal(emptyPage.records.length, 0);
  assert.equal(emptyPage.total, 25);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('legacy schema is migrated to schema v4 with data preserved and renumbered', { skip: !available }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-stats-'));
  const dbPath = join(dir, 'legacy.db');
  const ctor = loadDatabaseSync();
  assert.ok(ctor);
  const legacyDb = new ctor(dbPath);
  // v1/v2 legacy schema: TEXT id, no created_at, no AUTOINCREMENT.
  legacyDb.exec(
    `CREATE TABLE model_requests (
       id TEXT PRIMARY KEY, session_id TEXT, timestamp INTEGER NOT NULL,
       provider TEXT NOT NULL, model TEXT NOT NULL, turn_number INTEGER,
       status TEXT NOT NULL, stop_reason TEXT, duration_ms INTEGER,
       input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
       cache_creation_input_tokens INTEGER, cache_read_input_tokens INTEGER,
       request_messages TEXT, request_tools TEXT, request_options TEXT,
       response_text TEXT, response_thinking TEXT, response_tool_calls TEXT,
       response_message_id TEXT, error TEXT
     );`,
  );
  // Insert out of chronological order to prove the migration preserves the
  // INSERTION order (via rowid), not the timestamp order.
  const insert = legacyDb.prepare(
    `INSERT INTO model_requests (id, timestamp, provider, model, status, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run('legacy-2', 2000, 'deepseek', 'deepseek-v4-flash', 'completed', 200, 100);
  insert.run('legacy-1', 1000, 'deepseek', 'deepseek-v4-flash', 'completed', 100, 50);
  legacyDb.close();

  const store = new UsageStore({ dbPath });
  store.initialize();

  // Data survived; ids renumbered in legacy insertion order (rowid).
  const records = store.getRecent(10);
  assert.equal(records.length, 2);
  assert.equal(records[0].id, 2);
  assert.equal(records[0].inputTokens, 100); // legacy-1 inserted second
  assert.equal(records[0].createdAt, 1000); // created_at fell back to timestamp
  // Legacy flat response columns are merged into a JSON `response` object.
  assert.deepEqual(records[0].response, {
    text: null,
    thinking: null,
    toolCalls: null,
    messageId: null,
  });
  assert.equal(records[1].id, 1);
  assert.equal(records[1].inputTokens, 200);

  // The rebuilt table now carries the v3 schema with comments.
  const ctor2 = loadDatabaseSync();
  assert.ok(ctor2);
  const inspectDb = new ctor2(dbPath);
  const row = inspectDb
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_requests'`)
    .get() as { sql: string };
  assert.match(row.sql, /AUTOINCREMENT/);
  assert.match(row.sql, /模型请求统计明细/);
  assert.match(row.sql, /-- 输入 token 数/);
  assert.match(row.sql, /response\s+TEXT/);
  inspectDb.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
