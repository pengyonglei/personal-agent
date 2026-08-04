import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageStore } from '../src/store';
import { ModelRequestRecorder } from '../src/recorder';
import type { ModelCallDebugEnd, ModelCallDebugStart } from '@personal-agent/core';
import type { ModelRequestRecord } from '../src/types';

const available = UsageStore.isAvailable();

function makeStore(options: { recordPayloads?: boolean } = {}): { store: UsageStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pa-stats-rec-'));
  const store = new UsageStore({ dbPath: join(dir, 'test.db'), ...options });
  store.initialize();
  return { store, dir };
}

function fakeStart(overrides: Partial<ModelCallDebugStart> = {}): ModelCallDebugStart {
  return {
    callId: 'call-1',
    turnNumber: 2,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    startedAt: new Date('2026-08-04T10:00:00.000Z').toISOString(),
    request: {
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'read_file' }],
      options: { temperature: 0, maxTokens: 2048 },
    },
    ...overrides,
  };
}

function fakeEnd(overrides: Partial<ModelCallDebugEnd> = {}): ModelCallDebugEnd {
  return {
    callId: 'call-1',
    finishedAt: new Date('2026-08-04T10:00:03.000Z').toISOString(),
    durationMs: 3000,
    status: 'completed',
    response: {
      messageId: 'msg-123',
      model: 'deepseek-v4-flash',
      text: 'Hello there!',
      thinking: 'thinking...',
      toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 120, outputTokens: 40 },
    },
    ...overrides,
  };
}

function runRecorder(
  start: ModelCallDebugStart | undefined,
  end: ModelCallDebugEnd,
  options: { recordPayloads?: boolean; sessionId?: string } = {},
): ModelRequestRecord {
  const { store, dir } = makeStore({ recordPayloads: options.recordPayloads });
  try {
    const recorder = new ModelRequestRecorder(store, () => options.sessionId ?? 'sess-1');
    if (start) recorder.onModelCallStart(start);
    recorder.onModelCallEnd(end);
    const records = store.getRecent(10);
    assert.equal(records.length, 1);
    return records[0];
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('completed call maps all fields', { skip: !available }, () => {
  const record = runRecorder(fakeStart(), fakeEnd(), { sessionId: 'sess-x' });
  assert.equal(record.sessionId, 'sess-x');
  assert.equal(record.provider, 'deepseek');
  assert.equal(record.model, 'deepseek-v4-flash');
  assert.equal(record.turnNumber, 2);
  assert.equal(record.status, 'completed');
  assert.equal(record.stopReason, 'tool_use');
  assert.equal(record.durationMs, 3000);
  assert.equal(record.timestamp, Date.parse('2026-08-04T10:00:00.000Z'));
  assert.equal(record.inputTokens, 120);
  assert.equal(record.outputTokens, 40);
  assert.equal(record.response?.text, 'Hello there!');
  assert.equal(record.response?.thinking, 'thinking...');
  assert.deepEqual(record.response?.toolCalls, [
    { id: 'tc1', name: 'read_file', arguments: { path: 'a.ts' } },
  ]);
  assert.equal(record.response?.messageId, 'msg-123');
  assert.equal(record.error, undefined);
});

test('request payloads stored only when recordPayloads=true', { skip: !available }, () => {
  const withPayloads = runRecorder(fakeStart(), fakeEnd(), { recordPayloads: true });
  assert.deepEqual(withPayloads.requestMessages, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(withPayloads.requestTools, [{ name: 'read_file' }]);
  assert.deepEqual(withPayloads.requestOptions, { temperature: 0, maxTokens: 2048 });

  const withoutPayloads = runRecorder(fakeStart(), fakeEnd(), { recordPayloads: false });
  assert.equal(withoutPayloads.requestMessages, undefined);
  assert.equal(withoutPayloads.requestTools, undefined);
  assert.equal(withoutPayloads.requestOptions, undefined);
  // Response fields are always kept
  assert.equal(withoutPayloads.response?.text, 'Hello there!');
});

test('error call records status and error message', { skip: !available }, () => {
  const record = runRecorder(
    fakeStart(),
    fakeEnd({ status: 'error', error: 'Rate limit exceeded' }),
  );
  assert.equal(record.status, 'error');
  assert.equal(record.error, 'Rate limit exceeded');
});

test('interrupted call records status', { skip: !available }, () => {
  const record = runRecorder(fakeStart(), fakeEnd({ status: 'interrupted' }));
  assert.equal(record.status, 'interrupted');
});

test('end without cached start degrades to a partial record', { skip: !available }, () => {
  const record = runRecorder(undefined, fakeEnd());
  assert.equal(record.status, 'completed');
  assert.equal(record.model, 'deepseek-v4-flash'); // from response.model
  assert.equal(record.provider, ''); // unknown without start
  assert.equal(record.turnNumber, undefined);
  assert.equal(record.inputTokens, 120);
  assert.equal(record.response?.text, 'Hello there!');
});

test('recorder never throws on storage failures', { skip: !available }, () => {
  const { store, dir } = makeStore();
  try {
    const recorder = new ModelRequestRecorder(store, () => undefined);
    // Close the store underneath → insert will throw inside the recorder.
    store.close();
    assert.doesNotThrow(() => recorder.onModelCallStart(fakeStart()));
    assert.doesNotThrow(() => recorder.onModelCallEnd(fakeEnd()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
