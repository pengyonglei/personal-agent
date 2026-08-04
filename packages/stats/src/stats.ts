// ---------------------------------------------------------------------------
// Aggregation statistics API + CLI-friendly text formatting
// ---------------------------------------------------------------------------

import type {
  DayAggregate,
  ModelAggregate,
  ModelRequestRecord,
  RequestSummary,
} from './types';
import type { UsageStore } from './store';

/**
 * Optional per-model pricing map used to estimate cost.
 * Key: `${provider}:${model}` — e.g. 'deepseek:deepseek-v4-flash'.
 * Built by the CLI from `provider.getModelList()` `ModelInfo.pricing`.
 */
export type PricingMap = Record<string, { inputPer1k: number; outputPer1k: number }>;

/** Price per 1k tokens for a model (USD). Undefined when unknown. */
function modelPrice(
  pricing: PricingMap | undefined,
  provider: string,
  model: string,
): { inputPer1k: number; outputPer1k: number } | undefined {
  return pricing?.[`${provider}:${model}`];
}

function costFor(
  pricing: PricingMap | undefined,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const price = modelPrice(pricing, provider, model);
  if (!price) return undefined;
  return (inputTokens / 1000) * price.inputPer1k + (outputTokens / 1000) * price.outputPer1k;
}

/**
 * Overall summary over [from, to] (epoch ms). When `pricing` is provided the
 * estimated cost is computed from the per-model aggregates.
 */
export function getSummary(
  store: UsageStore,
  from: number,
  to: number,
  pricing?: PricingMap,
): RequestSummary {
  const summary = store.querySummary(from, to);
  if (pricing) {
    const byModel = store.queryByModel(from, to);
    const totalCost = byModel.reduce(
      (sum, agg) =>
        sum +
        (costFor(pricing, agg.provider, agg.model, agg.inputTokens, agg.outputTokens) ?? 0),
      0,
    );
    summary.costUsd = totalCost;
  }
  return summary;
}

/** Per provider+model aggregates over [from, to], with optional cost. */
export function getByModel(
  store: UsageStore,
  from: number,
  to: number,
  pricing?: PricingMap,
): ModelAggregate[] {
  const aggregates = store.queryByModel(from, to);
  if (pricing) {
    for (const agg of aggregates) {
      agg.costUsd = costFor(pricing, agg.provider, agg.model, agg.inputTokens, agg.outputTokens);
    }
  }
  return aggregates;
}

/** Per-day aggregates over [from, to]. */
export function getByDay(store: UsageStore, from: number, to: number): DayAggregate[] {
  return store.queryByDay(from, to);
}

// ---------------------------------------------------------------------------
// Text formatting (CLI display)
// ---------------------------------------------------------------------------

function fmtNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(usd: number | undefined): string {
  if (usd === undefined || usd === 0) return '-';
  return `$${usd.toFixed(4)}`;
}

function excerpt(text: string | undefined, max = 80): string {
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * Render a full stats report for the CLI `/stats` command.
 */
export function formatStatsText(
  summary: RequestSummary,
  byModel: ModelAggregate[],
  byDay: DayAggregate[],
  days: number,
): string {
  const lines: string[] = [];
  lines.push(`Model request stats (last ${days} day${days === 1 ? '' : 's'})`);
  lines.push('='.repeat(48));
  lines.push(
    `Calls: ${fmtNumber(summary.count)}  (errors: ${summary.errorCount}, interrupted: ${summary.interruptedCount})`,
  );
  lines.push(
    `Tokens: ${fmtNumber(summary.inputTokens)} in / ${fmtNumber(summary.outputTokens)} out`,
  );
  lines.push(`Avg duration: ${fmtDuration(summary.avgDurationMs)}  Est. cost: ${fmtCost(summary.costUsd)}`);

  if (byModel.length > 0) {
    lines.push('', 'By model:');
    for (const agg of byModel) {
      lines.push(
        `  ${agg.provider}/${agg.model.padEnd(24)} ${fmtNumber(agg.count).padStart(5)} calls  ` +
          `${fmtNumber(agg.inputTokens)} in / ${fmtNumber(agg.outputTokens)} out  ` +
          (agg.errorCount > 0 ? `${agg.errorCount} err  ` : '') +
          fmtCost(agg.costUsd),
      );
    }
  }

  if (byDay.length > 0) {
    lines.push('', 'By day:');
    for (const agg of byDay) {
      lines.push(
        `  ${agg.day}  ${fmtNumber(agg.count).padStart(5)} calls  ` +
          `${fmtNumber(agg.inputTokens)} in / ${fmtNumber(agg.outputTokens)} out`,
      );
    }
  }

  if (summary.count === 0) {
    lines.push('', 'No model requests recorded in this period.');
  }

  return lines.join('\n');
}

/**
 * Render a recent-requests list for the CLI `/stats-recent` command.
 */
export function formatRecentText(records: ModelRequestRecord[]): string {
  const lines: string[] = [];
  lines.push(`Recent model requests (last ${records.length})`);
  lines.push('='.repeat(48));
  if (records.length === 0) {
    lines.push('No model requests recorded yet.');
    return lines.join('\n');
  }
  for (const record of records) {
    const time = new Date(record.timestamp).toLocaleString('zh-CN', {
      hour12: false,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const status =
      record.status === 'completed' ? 'completed' : record.status === 'error' ? 'error    ' : 'interrupted';
    lines.push(
      `[${time}] ${record.provider || '?'}/${record.model || '?'}  ${status}  ` +
        `${fmtNumber(record.inputTokens)} in / ${fmtNumber(record.outputTokens)} out  ` +
        `${record.durationMs !== undefined ? fmtDuration(record.durationMs) : '-'}`,
    );
    const snippet = excerpt(record.response?.text) || record.error;
    if (snippet) lines.push(`    ${snippet}`);
  }
  return lines.join('\n');
}
