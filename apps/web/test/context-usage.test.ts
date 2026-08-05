import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectManager, SessionManager } from '@personal-agent/core';
import { WebSocket } from 'ws';
import { createWebServer } from '../src/server';

/**
 * 模拟「发出一次请求 → 刷新页面」：预置一个带 lastInputTokens 的会话，
 * 通过带 task 参数的 WS 连接模拟刷新重连，断言最终收到的 context_usage
 * 恢复为持久化的值（而不是 0）。
 */
test('refresh restores the persisted context usage instead of resetting it to 0', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-context-'));
  const workspace = join(directory, 'workspace');
  const sessionsDirectory = join(directory, 'sessions');
  const projectStoragePath = join(directory, 'projects.json');
  const configPath = join(directory, 'config.yaml');
  await mkdir(workspace);
  await writeFile(
    configPath,
    [
      'providers:',
      '  active: openai',
      '  openai:',
      '    apiKey: test-local-key',
      '    defaultModel: gpt-4o-mini',
      'memory:',
      '  enabled: false',
      'plugins:',
      '  enabled: false',
      'mcp:',
      '  servers: []',
    ].join('\n'),
    'utf8',
  );

  // 预置带历史消息与已用上下文（最近一次模型调用输入 token）的会话
  const sessions = new SessionManager(workspace, 'gpt-4o-mini', 'openai', sessionsDirectory);
  sessions.replaceMessages([
    { role: 'user', content: '之前发过一次请求' },
    { role: 'assistant', content: '这是回复。' },
  ]);
  sessions.setLastInputTokens(12345);
  const sessionId = await sessions.save();

  const projects = new ProjectManager(projectStoragePath);
  await projects.initialize();
  const project = await projects.createProject({ name: 'Context workspace', rootPath: workspace });
  const task = await projects.createTask({
    projectId: project.id,
    title: '上下文持久化',
    sessionId,
  });

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: workspace,
    configPath,
    projectStoragePath,
    sessionsDirectory,
  });

  const connectAndReadUsage = () =>
    new Promise<{ usedTokens: number; eventTaskId?: string }>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${instance.port}/ws?task=${encodeURIComponent(task.id)}`,
      );
      const usages: Array<{ usedTokens: number; taskId?: string }> = [];
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out while waiting for ready / context_usage'));
      }, 10_000);
      ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === 'context_usage') {
          const usage = message.usage as { usedTokens: number };
          usages.push({ usedTokens: usage.usedTokens, taskId: message.taskId as string | undefined });
        }
        if (message.type === 'ready') {
          clearTimeout(timeout);
          ws.close();
          const last = usages[usages.length - 1];
          resolve({ usedTokens: last?.usedTokens ?? -1, eventTaskId: last?.taskId });
        }
      });
    });

  try {
    // 第一次“刷新”：恢复的上下文用量应为持久化的 12345，而不是 0
    const first = await connectAndReadUsage();
    assert.equal(first.usedTokens, 12345, `首次刷新后 usedTokens 应为 12345，实际为 ${first.usedTokens}`);
    // context_usage 事件应带任务路由信息，前端才能正确归因
    assert.equal(first.eventTaskId, task.id);

    // 再次“刷新”：结果一致，且会话文件中的持久化值未被破坏
    const second = await connectAndReadUsage();
    assert.equal(second.usedTokens, 12345, `二次刷新后 usedTokens 应为 12345，实际为 ${second.usedTokens}`);

    const sessionFile = JSON.parse(
      await readFile(join(sessionsDirectory, `${sessionId}.json`), 'utf8'),
    ) as {
      metadata: { lastInputTokens: number; lastInputTokensByModel: Record<string, number> };
    };
    assert.equal(sessionFile.metadata.lastInputTokens, 12345);
    assert.equal(sessionFile.metadata.lastInputTokensByModel['openai:gpt-4o-mini'], 12345);
  } finally {
    await instance.close();
    // 会话保存为异步写盘，等待落盘完成后再清理目录（避免 Windows 句柄占用）
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(directory, { recursive: true, force: true });
  }
});
