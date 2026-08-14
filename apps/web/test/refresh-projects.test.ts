import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { createWebServer } from '../src/server';

/**
 * 「刷新项目和任务」按钮行为验证：
 * 客户端发送 list_projects 后，服务端应先从磁盘重新加载项目/任务存储，
 * 再下发最新的 project_list / task_list，从而拾取外部进程对存储文件所做的变更。
 */
test('refreshing projects re-reads the storage file and pushes the latest list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-refresh-'));
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
      'memory:',
      '  enabled: false',
      'plugins:',
      '  enabled: false',
      'mcp:',
      '  servers: []',
    ].join('\n'),
    'utf8',
  );

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
    const { ws, messages, ready } = await connect();
    await ready;
    await waitFor(messages, (m) => m.type === 'project_list');
    const firstList = messages.find(
      (m) => m.type === 'project_list',
    ) as unknown as { projects: Array<{ name: string }> };
    assert.ok(
      firstList.projects.every((project) => project.name !== '外部新增项目'),
      '初始列表不应包含外部新增项目',
    );

    // 模拟其他进程直接修改存储文件：新增一个项目。
    const raw = JSON.parse(await readFile(projectStoragePath, 'utf8')) as {
      projects: Array<Record<string, unknown>>;
    };
    raw.projects.push({
      id: 'project-external-1',
      name: '外部新增项目',
      rootPath: workspace,
      archived: false,
      pinned: false,
      sortOrder: 5,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await writeFile(projectStoragePath, JSON.stringify(raw, null, 2), 'utf8');

    // 点击「刷新项目和任务」：发送 list_projects。
    // 记录发送前的消息总数，仅匹配发送后新到达的 project_list。
    const messageCountBefore = messages.length;
    ws.send(JSON.stringify({ type: 'list_projects' }));
    const refreshed = (await waitFor(
      messages,
      (m) => m.type === 'project_list' && messages.indexOf(m) >= messageCountBefore,
    )) as unknown as { projects: Array<{ name: string }> };

    assert.ok(
      refreshed.projects.some((project) => project.name === '外部新增项目'),
      '刷新后应读取到外部新增的项目',
    );
    assert.ok(
      refreshed.projects.some((project) => project.name === 'workspace'),
      '刷新后原有项目应保留',
    );

    // task_list 也应随刷新重新下发。
    await waitFor(messages, (m) => m.type === 'task_list');
    ws.close();
  } finally {
    await instance.close();
    // 等待会话保存等异步写盘完成后再清理临时目录。
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(directory, { recursive: true, force: true });
  }
});
