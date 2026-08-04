// ---------------------------------------------------------------------------
// UsageStore — SQLite-backed model request storage
// ---------------------------------------------------------------------------
//
// Backed by Node's built-in `node:sqlite` (DatabaseSync). All methods are
// synchronous because the AgentLoop hooks we consume (`onModelCallStart` /
// `onModelCallEnd`) are synchronous callbacks.
//
// When `node:sqlite` is unavailable (old Node), `isAvailable()` returns false
// and callers should skip creating a store — the feature degrades gracefully
// without affecting the main flow.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createLogger } from '@personal-agent/shared';
import {
  loadDatabaseSync,
  type DatabaseSyncCtor,
  type DatabaseSyncLike,
  type StatementSyncLike,
} from './sqlite';
import type { DayAggregate, ModelAggregate, ModelRequestRecord, RequestSummary } from './types';

const log = createLogger('stats');

const DEFAULT_DB_PATH = resolve(homedir(), '.personal-agent', 'stats', 'model-requests.db');

/**
 * Table comment embedded in the CREATE TABLE statement (kept verbatim in
 * sqlite_master.sql and shown by sqlite3 .schema / DBeaver / DB Browser).
 */
const SCHEMA_COMMENT_MARKER = '模型请求统计明细';

// ---------------------------------------------------------------------------
// Schema v4 (table + column comments are stored in sqlite_master.sql)
//
// `id` is an auto-increment primary key — the stable sort key (insertion
// order). `created_at` is the row write time, `timestamp` the request start
// time; both are epoch milliseconds. `turn_number` is the agent loop turn.
// Request payloads (request_messages/tools/options) and the full response
// (`response` JSON) are only meaningful when recordPayloads is enabled; the
// response JSON holds { text, thinking, toolCalls, messageId }.
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS model_requests ( -- ${SCHEMA_COMMENT_MARKER}
  id                          INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增主键（插入顺序即创建顺序，稳定排序键）
  created_at                  INTEGER NOT NULL,           -- 创建时间（epoch 毫秒，记录写入时刻）
  session_id                  TEXT,                       -- 所属会话 ID（可空，非会话链路调用无值）
  timestamp                   INTEGER NOT NULL,           -- 请求开始时间（epoch 毫秒）
  provider                    TEXT NOT NULL,              -- 模型供应商（deepseek/anthropic/openai/ollama/volcano）
  model                       TEXT NOT NULL,              -- 模型名称（如 deepseek-v4-flash）
  turn_number                 INTEGER,                    -- Agent 循环轮次（第几轮调用，可空）
  status                      TEXT NOT NULL,              -- 请求状态：completed | error | interrupted
  stop_reason                 TEXT,                       -- 停止原因（end_turn/tool_use/max_tokens 等）
  duration_ms                 INTEGER,                    -- 请求耗时（毫秒）
  input_tokens                INTEGER NOT NULL DEFAULT 0, -- 输入 token 数
  output_tokens               INTEGER NOT NULL DEFAULT 0, -- 输出 token 数
  cache_creation_input_tokens INTEGER,                    -- Prompt 缓存写入 token（可空）
  cache_read_input_tokens     INTEGER,                    -- Prompt 缓存读取 token（可空）
  request_messages            TEXT,                       -- 请求入参 messages（JSON，仅 recordPayloads=true 时写入）
  request_tools               TEXT,                       -- 请求入参工具定义（JSON，同上）
  request_options             TEXT,                       -- 请求入参选项（JSON，同上）
  response                    TEXT,                       -- 响应出参（JSON：text/thinking/toolCalls/messageId）
  error                       TEXT                        -- 错误信息（status=error 时）
);
`;

/**
 * Copy legacy rows into the v4 schema. `id` is intentionally omitted so the
 * auto-increment column renumbers rows in the legacy insertion order
 * (`ORDER BY rowid`). The response JSON is assembled from the legacy
 * flat response columns via the JSON1 `json_object` function.
 *
 * `createdAtColumn` differs between v3 (has `created_at`) and v1/v2 (does
 * not) — the caller picks the right SELECT expression.
 */
function migrateInsertSql(createdAtExpression: string): string {
  return `
INSERT INTO model_requests (
  created_at, session_id, timestamp, provider, model, turn_number, status,
  stop_reason, duration_ms, input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens, request_messages,
  request_tools, request_options, response, error
) SELECT
  ${createdAtExpression}, session_id, timestamp, provider, model, turn_number, status,
  stop_reason, duration_ms, input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens, request_messages,
  request_tools, request_options,
  json_object(
    'text', response_text,
    'thinking', response_thinking,
    'toolCalls', json(response_tool_calls),
    'messageId', response_message_id
  ),
  error
FROM model_requests_legacy
ORDER BY rowid ASC
`;
}

const CREATE_INDEXES_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_model_requests_ts ON model_requests(timestamp);',
  'CREATE INDEX IF NOT EXISTS idx_model_requests_session ON model_requests(session_id);',
  'CREATE INDEX IF NOT EXISTS idx_model_requests_model ON model_requests(provider, model);',
];

const INSERT_SQL = `
INSERT INTO model_requests (
  created_at, session_id, timestamp, provider, model, turn_number, status,
  stop_reason, duration_ms, input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens, request_messages,
  request_tools, request_options, response, error
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export interface UsageStoreOptions {
  /** SQLite database file path. Defaults to ~/.personal-agent/stats/model-requests.db */
  dbPath?: string;
  /**
   * Whether to persist full request payloads (messages / tools / options) and
   * the response JSON. Default false — payloads can be large; enabling affects
   * NEW requests only (existing rows keep their data).
   */
  recordPayloads?: boolean;
}

export class UsageStore {
  private db: DatabaseSyncLike | null = null;
  private readonly dbPath: string;
  private recordPayloads: boolean;

  /** True when the current runtime provides node:sqlite (Node >= 22.13). */
  static isAvailable(): boolean {
    return loadDatabaseSync() !== null;
  }

  constructor(options: UsageStoreOptions = {}) {
    if (!loadDatabaseSync()) {
      throw new Error(
        'node:sqlite is not available on this Node runtime (requires >= 22.13). Stats tracking disabled.',
      );
    }
    this.dbPath = options.dbPath ?? DEFAULT_DB_PATH;
    this.recordPayloads = options.recordPayloads ?? false;
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  /** Whether full request payloads are persisted for new records. */
  isRecordPayloadsEnabled(): boolean {
    return this.recordPayloads;
  }

  /**
   * Update whether NEW records persist request payloads. Takes effect
   * immediately for subsequent inserts; existing rows are never modified.
   */
  setRecordPayloads(enabled: boolean): void {
    this.recordPayloads = enabled;
  }

  /**
   * Open (or re-open) the database, create the table/indexes and enable WAL.
   * Idempotent — safe to call multiple times. Databases created with older
   * schemas (v1/v2/v3) are migrated to v4 in place.
   */
  initialize(): void {
    if (this.db) return;
    const ctor = loadDatabaseSync() as DatabaseSyncCtor | null;
    if (!ctor) throw new Error('node:sqlite is not available on this Node runtime.');
    mkdirSync(dirname(this.dbPath), { recursive: true });
    const db = new ctor(this.dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(CREATE_TABLE_SQL);
    this.migrateSchemaIfNeeded(db);
    for (const indexSql of CREATE_INDEXES_SQL) {
      db.exec(indexSql);
    }
    this.db = db;
    log.info(`Stats store initialized: ${this.dbPath}`);
  }

  /**
   * Insert a model request record. The `id` column is auto-assigned by SQLite
   * (an explicit `record.id` is ignored); `created_at` defaults to now unless
   * `record.createdAt` is provided. Synchronous; throws on failure.
   */
  insert(record: ModelRequestRecord): void {
    const stmt = this.prepare(INSERT_SQL);
    stmt.run(
      record.createdAt ?? Date.now(),
      record.sessionId ?? null,
      record.timestamp,
      record.provider,
      record.model,
      record.turnNumber ?? null,
      record.status,
      record.stopReason ?? null,
      record.durationMs ?? null,
      record.inputTokens ?? 0,
      record.outputTokens ?? 0,
      record.cacheCreationInputTokens ?? null,
      record.cacheReadInputTokens ?? null,
      this.recordPayloads ? jsonOrNull(record.requestMessages) : null,
      this.recordPayloads ? jsonOrNull(record.requestTools) : null,
      this.recordPayloads ? jsonOrNull(record.requestOptions) : null,
      jsonOrNull(record.response),
      record.error ?? null,
    );
  }

  /** Most recent N records, newest first (stable: auto-increment id order). */
  getRecent(limit: number): ModelRequestRecord[] {
    const rows = this.prepare(
      `SELECT * FROM model_requests ORDER BY id DESC LIMIT ?`,
    ).all(Math.max(1, Math.min(limit, 500)));
    return rows.map((row) => rowToRecord(row));
  }

  /**
   * Paged records, newest first (stable: auto-increment id order).
   * Returns the requested page plus the total row count for pagination.
   */
  getPage(page: number, pageSize: number): { records: ModelRequestRecord[]; total: number } {
    const safePage = Math.max(1, Math.floor(page) || 1);
    const safePageSize = Math.min(100, Math.max(1, Math.floor(pageSize) || 20));
    const totalRow = this.prepare(`SELECT COUNT(*) AS total FROM model_requests`).get() as
      | Record<string, unknown>
      | undefined;
    const rows = this.prepare(
      `SELECT * FROM model_requests ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(safePageSize, (safePage - 1) * safePageSize);
    return {
      records: rows.map((row) => rowToRecord(row)),
      total: Number(totalRow?.total ?? 0),
    };
  }

  /** Most recent N records for a session, newest first. */
  getBySession(sessionId: string, limit: number): ModelRequestRecord[] {
    const rows = this.prepare(
      `SELECT * FROM model_requests WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
    ).all(sessionId, Math.max(1, Math.min(limit, 500)));
    return rows.map((row) => rowToRecord(row));
  }

  /** Aggregated totals over a time window [from, to] (epoch ms, inclusive). */
  querySummary(from: number, to: number): RequestSummary {
    const row = this.prepare(
      `SELECT
         COUNT(*) AS count,
         COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errorCount,
         COALESCE(SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END), 0) AS interruptedCount,
         COALESCE(SUM(input_tokens), 0) AS inputTokens,
         COALESCE(SUM(output_tokens), 0) AS outputTokens,
         COALESCE(AVG(duration_ms), 0) AS avgDurationMs
       FROM model_requests WHERE timestamp >= ? AND timestamp <= ?`,
    ).get(from, to) as Record<string, unknown> | undefined;
    return {
      count: Number(row?.count ?? 0),
      errorCount: Number(row?.errorCount ?? 0),
      interruptedCount: Number(row?.interruptedCount ?? 0),
      inputTokens: Number(row?.inputTokens ?? 0),
      outputTokens: Number(row?.outputTokens ?? 0),
      avgDurationMs: Number(row?.avgDurationMs ?? 0),
    };
  }

  /** Per provider+model aggregates over a time window, most used first. */
  queryByModel(from: number, to: number): ModelAggregate[] {
    const rows = this.prepare(
      `SELECT provider, model,
         COUNT(*) AS count,
         COALESCE(SUM(input_tokens), 0) AS inputTokens,
         COALESCE(SUM(output_tokens), 0) AS outputTokens,
         COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errorCount
       FROM model_requests
       WHERE timestamp >= ? AND timestamp <= ?
       GROUP BY provider, model
       ORDER BY count DESC, provider ASC, model ASC`,
    ).all(from, to) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      provider: String(row.provider ?? ''),
      model: String(row.model ?? ''),
      count: Number(row.count ?? 0),
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      errorCount: Number(row.errorCount ?? 0),
    }));
  }

  /** Per-day aggregates over a time window (UTC dates), oldest first. */
  queryByDay(from: number, to: number): DayAggregate[] {
    const rows = this.prepare(
      `SELECT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') AS day,
         COUNT(*) AS count,
         COALESCE(SUM(input_tokens), 0) AS inputTokens,
         COALESCE(SUM(output_tokens), 0) AS outputTokens
       FROM model_requests
       WHERE timestamp >= ? AND timestamp <= ?
       GROUP BY day
       ORDER BY day ASC`,
    ).all(from, to) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      day: String(row.day ?? ''),
      count: Number(row.count ?? 0),
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
    }));
  }

  /**
   * Delete records older than `retentionDays` days. Returns the number of
   * deleted rows. A value <= 0 disables pruning (returns 0).
   */
  prune(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const result = this.prepare(`DELETE FROM model_requests WHERE timestamp < ?`).run(cutoff);
    const changes = Number(result.changes ?? 0);
    if (changes > 0) log.info(`Pruned ${changes} model request records (retention ${retentionDays}d)`);
    return changes;
  }

  /** Close the underlying database. Safe to call multiple times. */
  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch (err) {
      log.warn(`Failed to close stats store: ${(err as Error).message}`);
    }
    this.db = null;
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Tables created before schema v4 (flat response_* columns) are rebuilt in
   * place inside a transaction with the v4 schema; all rows are copied over
   * and renumbered in the legacy insertion order.
   */
  private migrateSchemaIfNeeded(db: DatabaseSyncLike): void {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_requests'`)
      .get() as { sql?: string } | undefined;
    const existingSql = row?.sql ?? '';
    // v4 has a single `response` JSON column; older schemas have flat
    // response_text / response_thinking / response_tool_calls columns.
    if (!existingSql.includes('response_tool_calls')) return;

    // v3 introduced `created_at`; v1/v2 fall back to `timestamp`.
    const legacyRow = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_requests_legacy'`,
      )
      .get() as { sql?: string } | undefined;
    const legacySql = legacyRow?.sql ?? existingSql;
    const createdAtExpression = legacySql.includes('created_at')
      ? 'created_at'
      : 'timestamp';

    log.info('Migrating model_requests table to schema v4…');
    db.exec('BEGIN;');
    try {
      db.exec('ALTER TABLE model_requests RENAME TO model_requests_legacy;');
      db.exec(CREATE_TABLE_SQL);
      db.exec(migrateInsertSql(createdAtExpression));
      db.exec('DROP TABLE model_requests_legacy;');
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  private prepare(sql: string): StatementSyncLike {
    return this.requireDb().prepare(sql);
  }

  private requireDb(): DatabaseSyncLike {
    if (!this.db) {
      throw new Error('UsageStore not initialized. Call initialize() first.');
    }
    return this.db;
  }
}

// ---------------------------------------------------------------------------
// Row <-> record mapping helpers
// ---------------------------------------------------------------------------

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function parseJson(value: unknown): unknown | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.parse(String(value));
  } catch {
    return undefined;
  }
}

function rowToRecord(row: Record<string, unknown>): ModelRequestRecord {
  return {
    id: Number(row.id ?? 0),
    sessionId: (row.session_id as string | null) ?? undefined,
    createdAt: (row.created_at as number | null) ?? undefined,
    timestamp: Number(row.timestamp ?? 0),
    provider: String(row.provider ?? ''),
    model: String(row.model ?? ''),
    turnNumber: (row.turn_number as number | null) ?? undefined,
    status: (row.status as ModelRequestRecord['status']) ?? 'completed',
    stopReason: (row.stop_reason as string | null) ?? undefined,
    durationMs: (row.duration_ms as number | null) ?? undefined,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    cacheCreationInputTokens: (row.cache_creation_input_tokens as number | null) ?? null,
    cacheReadInputTokens: (row.cache_read_input_tokens as number | null) ?? null,
    requestMessages: parseJson(row.request_messages),
    requestTools: parseJson(row.request_tools),
    requestOptions: parseJson(row.request_options),
    response: parseJson(row.response) as ModelRequestRecord['response'] | undefined,
    error: (row.error as string | null) ?? undefined,
  };
}
