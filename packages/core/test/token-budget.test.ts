import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TokenBudget } from '../src/index';
import type { UnifiedMessage } from '@personal-agent/shared';

const tinyHistory: UnifiedMessage[] = [{ role: 'user', content: 'hi' }];

/**
 * TokenBudget 压缩判断的「已使用 token」应优先采用外部注入的权威来源
 * （如上下文仪表盘同源的最近一次模型请求输入 token 数），而不是本地字符估算。
 */
test('shouldCompact uses the injected used-tokens source when provided', () => {
  // 外部来源报告已使用 90k（> 75% × 100k 阈值），即使历史消息本身极小
  const overBudget = new TokenBudget(100_000, 0, undefined, () => 90_000);
  assert.equal(overBudget.shouldCompact(tinyHistory), true);
  assert.equal(overBudget.checkUsage(tinyHistory).used, 90_000);

  // 外部来源报告已使用 10k，未达阈值
  const underBudget = new TokenBudget(100_000, 0, undefined, () => 10_000);
  assert.equal(underBudget.shouldCompact(tinyHistory), false);
  assert.equal(underBudget.checkUsage(tinyHistory).used, 10_000);
});

test('shouldCompact falls back to character estimation when no source is provided', () => {
  const budget = new TokenBudget(100_000, 0);
  // 历史为空/极小：估算用量远低于阈值，不应压缩
  assert.equal(budget.shouldCompact([]), false);
  assert.equal(budget.shouldCompact(tinyHistory), false);
  // 超长历史：估算用量超过阈值（约 3 字符/token → 250k 字符 ≈ 83.4k token）
  const hugeHistory: UnifiedMessage[] = [{ role: 'user', content: 'x'.repeat(250_000) }];
  assert.equal(budget.shouldCompact(hugeHistory), true);
});

test('shouldCompact falls back to character estimation when the source returns undefined', () => {
  // 子 agent 首轮尚无任何模型请求时，来源返回 undefined → 兜底字符估算
  const budget = new TokenBudget(100_000, 0, undefined, () => undefined);
  assert.equal(budget.shouldCompact(tinyHistory), false);
  const hugeHistory: UnifiedMessage[] = [{ role: 'user', content: 'x'.repeat(250_000) }];
  assert.equal(budget.shouldCompact(hugeHistory), true);
});
