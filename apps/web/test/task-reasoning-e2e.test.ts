import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createWebServer } from '../src/server';

/**
 * 新建任务草稿流程（create_task → set_task_model 带档位 → prompt）的端到端验证：
 * 任务执行时发给 Ollama 的请求必须带上草稿中设置的思考强度（reasoning_effort 原样透传），
 * 而不是回退到模型默认档。
 */
test('draft reasoning effort is applied to the first task execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-reasoning-'));
  const workspace = join(directory, 'workspace');
  const sessionsDirectory = join(directory, 'sessions');
  const projectStoragePath = join(directory, 'projects.json');
  const configPath = join(directory, 'config.yaml');
  await mkdir(workspace);
  await writeFile(
    configPath,
    [
      'providers:',
      '  active: ollama',
      '  ollama:',
      '    baseURL: http://localhost:11434',
      '    defaultModel: qwen3:8b',
      '    models:',
      '      - id: qwen3:8b',
      '        reasoningOptions: [off, medium, high, xhigh]',
      'memory:',
      '  enabled: false',
      'plugins:',
      '  enabled: false',
      'mcp:',
      '  servers: []',
    ].join('\n'),
    'utf-8',
  );

  // 拦截 Ollama /api/chat：记录请求体，返回固定响应（文本 + 结束）。
  interface CapturedChatRequest {
    stream: boolean;
    think?: unknown;
    reasoning_effort?: unknown;
  }
  const ollamaRequests: CapturedChatRequest[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/chat')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      ollamaRequests.push(body as unknown as CapturedChatRequest);
      if (body.stream === true) {
        return new Response(
          [
            JSON.stringify({ model: 'qwen3:8b', message: { content: '收到' }, done: false }),
            JSON.stringify({ model: 'qwen3:8b', message: {}, done: true, done_reason: 'stop' }),
          ].join('\n'),
          { headers: { 'content-type': 'application/x-ndjson' } },
        );
      }
      return Response.json({
        model: 'qwen3:8b',
        message: { content: 'ok' },
        done: true,
        done_reason: 'stop',
      });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: workspace,
    configPath,
    projectStoragePath,
    sessionsDirectory,
  });

  const connect = () =>
    new Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>>; ready: Promise<void> }>(
      (resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/ws`);
        const messages: Array<Record<string, unknown>> = [];
        ws.on('message', (data) => {
          messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
        });
        const ready = new Promise<void>((resolveReady, rejectReady) => {
          ws.once('error', rejectReady);
          const onMessage = (data: WebSocket.RawData) => {
            const message = JSON.parse(data.toString()) as Record<string, unknown>;
            if (message.type === 'ready') {
              ws.off('message', onMessage);
              resolveReady();
            }
          };
          ws.on('message', onMessage);
        });
        resolve({ ws, messages, ready });
      },
    );

  const waitFor = async (
    messages: Array<Record<string, unknown>>,
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown>> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for message');
  };

  try {
    const { ws, messages, ready } = await connect();
    await ready;
    const readyMessage = await waitFor(messages, (m) => m.type === 'ready');
    const projectId = readyMessage.activeProjectId as string;

    // 与客户端草稿流程一致：先 create_task，任务创建后发 set_task_model（带档位），再发 prompt。
    ws.send(
      JSON.stringify({
        type: 'create_task',
        projectId,
        permissionMode: 'ask',
      }),
    );
    const taskChanged = await waitFor(messages, (m) => m.type === 'task_changed');
    const taskId = (taskChanged.task as { id: string }).id;

    ws.send(
      JSON.stringify({
        type: 'set_task_model',
        taskId,
        providerId: 'ollama',
        model: 'qwen3:8b',
        reasoningEffort: 'xhigh',
      }),
    );
    ws.send(JSON.stringify({ type: 'prompt', taskId, text: '你好' }));

    await waitFor(messages, (m) => m.type === 'busy' && m.busy === false);
    // 等待所有模型请求落地后校验
    await new Promise((resolve) => setTimeout(resolve, 300));

    const streamed = ollamaRequests.filter((request) => request.stream === true);
    assert.ok(streamed.length >= 1, `应至少有一次流式模型请求，实际 ${ollamaRequests.length} 次`);
    // 主执行请求（第一次流式调用）必须携带草稿设置的档位
    assert.equal(streamed[0].think, true, '主请求应开启思考');
    assert.equal(streamed[0].reasoning_effort, 'xhigh', '主请求应透传草稿设置的思考强度');

    // 执行开始时会推送 task_renamed：该消息必须保留思考强度，
    // 否则客户端任务条目会被覆盖回默认档（历史 bug）。
    const renamed = messages.find((m) => m.type === 'task_renamed');
    assert.ok(renamed, '执行时应收到 task_renamed');
    assert.equal(
      (renamed.task as { reasoningEffort?: string }).reasoningEffort,
      'xhigh',
      'task_renamed 不应覆盖任务的思考强度',
    );

    // 任务列表最终应携带已持久化的档位
    await waitFor(
      messages,
      (m) =>
        m.type === 'task_list' &&
        (m.tasks as Array<{ id: string; reasoningEffort?: string }>).find(
          (task) => task.id === taskId,
        )?.reasoningEffort === 'xhigh',
    );
    ws.close();
  } finally {
    await instance.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
