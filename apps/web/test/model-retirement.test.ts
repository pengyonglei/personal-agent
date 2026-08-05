import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectManager } from '@personal-agent/core';
import { WebSocket } from 'ws';
import { createWebServer } from '../src/server';

/**
 * 供应商模型列表变更（下线模型）的行为验证：
 * - 空闲任务自动切换到可用默认模型并持久化
 * - 正在执行的任务不被打断（isBusy 跳过，由执行完成后兜底）
 * - 已下线模型无法再通过持久化的 task.model 恢复（resolveTaskModel 校验）
 */
test('removing a model from provider config auto-switches idle tasks and blocks restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-retire-'));
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
      '    models:',
      '      - gpt-4o-mini',
      '      - custom-openai-model',
      'memory:',
      '  enabled: false',
      'plugins:',
      '  enabled: false',
      'mcp:',
      '  servers: []',
    ].join('\n'),
    'utf8',
  );

  let instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: workspace,
    configPath,
    projectStoragePath,
    sessionsDirectory,
  });
  const baseUrl = `http://127.0.0.1:${instance.port}`;

  const connect = (taskQuery = '') =>
    new Promise<{ ws: WebSocket; messages: Array<Record<string, unknown>>; ready: Promise<void> }>(
      (resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/ws${taskQuery}`);
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

  const waitFor = async <T>(
    messages: Array<Record<string, unknown>>,
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs = 10_000,
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
    // ---- 1. 连接并切换任务模型到 custom-openai-model ----
    const { ws, messages, ready } = await connect();
    await ready;
    const readyMessage = await waitFor(messages, (m) => m.type === 'ready');
    const taskId = readyMessage.activeTaskId as string;
    ws.send(
      JSON.stringify({
        type: 'set_task_model',
        taskId,
        providerId: 'openai',
        model: 'custom-openai-model',
      }),
    );
    await waitFor(messages, (m) => m.type === 'notice');
    let saved = JSON.parse(await readFile(projectStoragePath, 'utf8')) as {
      tasks: Array<{ id: string; model?: string }>;
    };
    assert.equal(
      saved.tasks.find((task) => task.id === taskId)?.model,
      'openai:custom-openai-model',
      '切换后任务模型应持久化',
    );

    // ---- 2. 从供应商配置中移除 custom-openai-model ----
    const configureResponse = await fetch(`${baseUrl}/api/provider-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        activate: true,
        defaultModel: 'gpt-4o-mini',
        models: ['gpt-4o-mini'],
      }),
    });
    assert.equal(configureResponse.status, 200, '移除模型配置应成功');

    // ---- 3. 空闲任务应自动切换到剩余的默认模型并持久化 ----
    ws.send(JSON.stringify({ type: 'list_projects' }));
    const taskList = await waitFor(messages, (m) => m.type === 'task_list');
    const tasks = taskList.tasks as Array<{ id: string; model?: string }>;
    assert.equal(
      tasks.find((task) => task.id === taskId)?.model,
      'openai:gpt-4o-mini',
      '被移除模型的任务应自动切换到可用默认模型',
    );
    saved = JSON.parse(await readFile(projectStoragePath, 'utf8')) as {
      tasks: Array<{ id: string; model?: string }>;
    };
    assert.equal(
      saved.tasks.find((task) => task.id === taskId)?.model,
      'openai:gpt-4o-mini',
      '自动切换后任务模型应持久化为新模型',
    );
    ws.close();

    // ---- 4. 模拟服务端重启前 task.model 残留已下线模型：关闭服务端后篡改文件 ----
    await instance.close();
    const projects = new ProjectManager(projectStoragePath);
    await projects.initialize();
    await projects.setTaskModel(taskId, 'openai:custom-openai-model');

    // ---- 5. 重启后重连：已下线模型不应被恢复，回退默认模型并清除残留 ----
    instance = await createWebServer({
      host: '127.0.0.1',
      port: 0,
      workingDirectory: workspace,
      configPath,
      projectStoragePath,
      sessionsDirectory,
    });
    const { ws: ws2, messages: messages2, ready: ready2 } = await connect(
      `?task=${encodeURIComponent(taskId)}`,
    );
    await ready2;
    ws2.send(JSON.stringify({ type: 'list_projects' }));
    const taskList2 = await waitFor(messages2, (m) => m.type === 'task_list');
    const tasks2 = taskList2.tasks as Array<{ id: string; model?: string }>;
    assert.equal(
      tasks2.find((task) => task.id === taskId)?.model,
      'openai:gpt-4o-mini',
      '已下线模型刷新后不应恢复，应回退到可用默认模型',
    );
    saved = JSON.parse(await readFile(projectStoragePath, 'utf8')) as {
      tasks: Array<{ id: string; model?: string }>;
    };
    assert.equal(
      saved.tasks.find((task) => task.id === taskId)?.model,
      undefined,
      '失效的任务模型持久化值应被清除',
    );
    ws2.close();
  } finally {
    await instance.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(directory, { recursive: true, force: true });
  }
});
