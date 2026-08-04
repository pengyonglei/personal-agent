// ---------------------------------------------------------------------------
// Model request statistics types
// ---------------------------------------------------------------------------

/**
 * One recorded model request (one row in the `model_requests` table).
 *
 * Metadata (tokens / model / status / duration / provider / session) is always
 * stored. The `requestMessages` / `requestTools` / `requestOptions` payloads
 * are only persisted when the store is configured with `recordPayloads: true`
 * (they can be large). Response text/thinking/tool calls are always stored —
 * they are comparatively small and valuable for debugging.
 */
export interface ModelRequestRecord {
  /**
   * Auto-increment primary key assigned by SQLite on insert. Optional on the
   * way in (omit to let the database allocate it), always present when read.
   */
  id?: number;
  /** Session id (nullable — not every caller has a session). */
  sessionId?: string;
  /** Record creation time as epoch milliseconds (when the row was written). */
  createdAt?: number;
  /** Request start time as epoch milliseconds. */
  timestamp: number;
  /** Provider id, e.g. 'deepseek' | 'anthropic' | 'openai' | 'ollama'. */
  provider: string;
  /** Model id, e.g. 'deepseek-v4-flash'. */
  model: string;
  /** Agent loop turn number (when the request came from the main loop). */
  turnNumber?: number;
  status: 'completed' | 'error' | 'interrupted';
  stopReason?: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  /** Full request messages (JSON-serialized). Only when recordPayloads=true. */
  requestMessages?: unknown;
  /** Tool definitions sent with the request. Only when recordPayloads=true. */
  requestTools?: unknown;
  /** Stream options (temperature/maxTokens/...). Only when recordPayloads=true. */
  requestOptions?: unknown;
  /** Full response payload (JSON-serialized) — text/thinking/toolCalls/messageId. */
  response?: {
    text?: string;
    thinking?: string;
    toolCalls?: unknown;
    messageId?: string;
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// Aggregation result types
// ---------------------------------------------------------------------------

export interface RequestSummary {
  count: number;
  errorCount: number;
  interruptedCount: number;
  inputTokens: number;
  outputTokens: number;
  avgDurationMs: number;
  costUsd?: number;
}

export interface ModelAggregate {
  provider: string;
  model: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
  errorCount: number;
  costUsd?: number;
}

export interface DayAggregate {
  /** Local date string 'YYYY-MM-DD'. */
  day: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
}
