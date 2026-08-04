// ---------------------------------------------------------------------------
// ModelRequestRecorder — bridges AgentLoop diagnostics hooks to UsageStore
// ---------------------------------------------------------------------------
//
// The core AgentLoop already emits `onModelCallStart` / `onModelCallEnd`
// diagnostics hooks with full request/response details. This recorder consumes
// those hooks (core is unchanged) and persists one `ModelRequestRecord` per
// model call.
//
// Design notes:
// - Start info is cached keyed by callId; the end event carries the outcome.
// - If the end event arrives without a cached start (e.g. recorder attached
//   after the loop started), a half record is still written.
// - Every hook handler is wrapped in try/catch — a storage failure must never
//   affect the agent loop.

import { createLogger } from '@personal-agent/shared';
import type { ModelCallDebugEnd, ModelCallDebugStart } from '@personal-agent/core';
import type { UsageStore } from './store';
import type { ModelRequestRecord } from './types';

const log = createLogger('stats-recorder');

/** Upper bound for the pending-start cache; prevents unbounded growth. */
const MAX_PENDING_STARTS = 2000;

export class ModelRequestRecorder {
  private readonly store: UsageStore;
  private readonly getSessionId: () => string | undefined;
  private readonly starts = new Map<string, ModelCallDebugStart>();

  constructor(store: UsageStore, getSessionId?: () => string | undefined) {
    this.store = store;
    this.getSessionId = getSessionId ?? (() => undefined);
  }

  /** AgentLoop `onModelCallStart` hook — cache the request context. */
  onModelCallStart(call: ModelCallDebugStart): void {
    try {
      this.starts.set(call.callId, call);
      if (this.starts.size > MAX_PENDING_STARTS) {
        // Drop the oldest entries (Map preserves insertion order).
        let overflow = this.starts.size - MAX_PENDING_STARTS;
        for (const key of this.starts.keys()) {
          if (overflow <= 0) break;
          this.starts.delete(key);
          overflow--;
        }
      }
    } catch (err) {
      log.warn(`Failed to cache model call start: ${(err as Error).message}`);
    }
  }

  /** AgentLoop `onModelCallEnd` hook — assemble and persist the record. */
  onModelCallEnd(call: ModelCallDebugEnd): void {
    try {
      const start = this.starts.get(call.callId);
      this.starts.delete(call.callId);
      this.store.insert(this.buildRecord(start, call));
    } catch (err) {
      log.warn(`Failed to record model call: ${(err as Error).message}`);
    }
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private buildRecord(
    start: ModelCallDebugStart | undefined,
    call: ModelCallDebugEnd,
  ): ModelRequestRecord {
    const usage = call.response.usage;
    const toolCalls = call.response.toolCalls;
    return {
      sessionId: this.getSessionId(),
      timestamp: start ? Date.parse(start.startedAt) : Date.parse(call.finishedAt),
      provider: start?.provider ?? '',
      model: call.response.model ?? start?.model ?? '',
      turnNumber: start?.turnNumber,
      status: call.status,
      stopReason: call.response.stopReason,
      durationMs: call.durationMs,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
      cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
      requestMessages: start ? start.request.messages : undefined,
      requestTools: start ? start.request.tools : undefined,
      requestOptions: start ? start.request.options : undefined,
      response: {
        text: call.response.text || undefined,
        thinking: call.response.thinking || undefined,
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        messageId: call.response.messageId,
      },
      error: call.error,
    };
  }
}
