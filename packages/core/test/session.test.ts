import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionManager } from '../src/session';

/**
 * 「已使用 token 数量」的统计口径：
 * 已使用 = 最近一次模型请求的 `usage.inputTokens + usage.outputTokens`。
 * Ollama 本地部署的模型只分别上报输入/输出（本地思考模型的思考 token 计入
 * 输出，可能远超输入），只计输入会严重低估——必须两者相加，并随会话
 * 持久化，刷新/重启后按当前模型恢复。
 */
test('used tokens = last request input + output, persisted per model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-session-'));
  const sessionsDirectory = join(directory, 'sessions');
  try {
    const session = new SessionManager(directory, 'qwen3.8:8b', 'ollama', sessionsDirectory);
    assert.equal(session.getLastUsedTokens(), 0);

    // 用户提供的 Ollama 返回示例：input 16152 / output 19495
    session.setLastInputTokens(16152);
    session.setLastOutputTokens(19495);
    assert.equal(session.getLastInputTokens(), 16152);
    assert.equal(session.getLastOutputTokens(), 19495);
    assert.equal(session.getLastUsedTokens(), 16152 + 19495);

    // 会话中切换模型后，新模型尚无记录时回退到全局最近一次的值（既有口径），
    // 记录新模型的输入/输出后按新模型各自的值计算
    session.updateProvider('deepseek-v4', 'deepseek');
    assert.equal(session.getLastUsedTokens(), 16152 + 19495);
    session.setLastInputTokens(1000);
    session.setLastOutputTokens(50);
    assert.equal(session.getLastUsedTokens(), 1050);
    session.updateProvider('qwen3.8:8b', 'ollama');
    assert.equal(session.getLastUsedTokens(), 16152 + 19495);

    // 保存后重新恢复：已使用 tokens 不丢失（刷新/重启场景）
    const sessionId = await session.save();
    const restored = new SessionManager(directory, 'qwen3.8:8b', 'ollama', sessionsDirectory);
    assert.equal(await restored.restore(sessionId), true);
    assert.equal(restored.getLastUsedTokens(), 16152 + 19495);

    // 旧会话文件（无 lastOutputTokens 字段的遗留数据）恢复不报错，已使用按输入计
    const legacyId = 'legacy-session';
    await writeFile(
      join(sessionsDirectory, `${legacyId}.json`),
      JSON.stringify({
        id: legacyId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
        metadata: {
          workingDirectory: directory,
          model: 'gpt-4o-mini',
          provider: 'openai',
          totalTokensUsed: 0,
          totalCost: 0,
          turnCount: 1,
          lastInputTokens: 2048,
          lastInputTokensByModel: { 'openai:gpt-4o-mini': 2048 },
        },
      }),
      'utf8',
    );
    const restoredLegacy = new SessionManager(
      directory,
      'gpt-4o-mini',
      'openai',
      sessionsDirectory,
    );
    assert.equal(await restoredLegacy.restore(legacyId), true);
    assert.equal(restoredLegacy.getLastUsedTokens(), 2048);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
