import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectManager, SessionManager } from '@personal-agent/core';
import { WebSocket } from 'ws';
import { createWebServer, deriveTaskTitle } from '../src/server';

test('task titles use the normalized first intent and respect the storage limit', () => {
  assert.equal(deriveTaskTitle('  修复构建\n并补充测试  '), '修复构建 并补充测试');
  const title = deriveTaskTitle('任务'.repeat(150));
  assert.equal(Array.from(title).length, 200);
  assert.equal(title.endsWith('…'), true);
});

test('web server exposes health and websocket readiness without a configured provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-'));
  const configPath = join(directory, 'config.yaml');
  await writeFile(
    configPath,
    ['memory:', '  enabled: false', 'plugins:', '  enabled: false', 'mcp:', '  servers: []'].join(
      '\n',
    ),
    'utf-8',
  );

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
  });

  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/health`);
    assert.equal(response.status, 503);
    const health = (await response.json()) as {
      status: string;
      runtime: { configured: boolean };
    };
    assert.equal(health.status, 'needs_configuration');
    assert.equal(health.runtime.configured, false);

    const [markedResponse, domPurifyResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${instance.port}/vendor/marked.js`),
      fetch(`http://127.0.0.1:${instance.port}/vendor/dompurify.js`),
    ]);
    assert.equal(markedResponse.status, 200);
    assert.match(markedResponse.headers.get('content-type') ?? '', /javascript/);
    assert.equal(domPurifyResponse.status, 200);
    assert.match(domPurifyResponse.headers.get('content-type') ?? '', /javascript/);

    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/ws`);
      ws.once('error', reject);
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === 'ready') {
          ws.close();
          resolve(message);
        }
      });
    });
    assert.equal(ready.type, 'ready');
    assert.equal((ready.runtime as { configured: boolean }).configured, false);
    assert.equal(typeof ready.activeProjectId, 'string');
    assert.equal(typeof ready.activeTaskId, 'string');

    const renamedTask = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/ws`);
      let createdTaskId: string | undefined;
      ws.once('error', reject);
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === 'ready') {
          ws.send(
            JSON.stringify({
              type: 'create_task',
              projectId: message.activeProjectId,
            }),
          );
        } else if (message.type === 'task_changed' && !createdTaskId) {
          createdTaskId = (message.task as { id: string }).id;
          ws.send(
            JSON.stringify({
              type: 'rename_task',
              taskId: createdTaskId,
              title: '重命名后的任务',
            }),
          );
        } else if (message.type === 'task_renamed') {
          ws.close();
          resolve(message.task as Record<string, unknown>);
        }
      });
    });
    assert.equal(renamedTask.title, '重命名后的任务');

    const secondRoot = join(directory, 'second-workspace');
    await mkdir(secondRoot);
    const createdProject = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/ws`);
      ws.once('error', reject);
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === 'ready') {
          ws.send(
            JSON.stringify({
              type: 'create_project',
              name: 'Second workspace',
              rootPath: secondRoot,
            }),
          );
        }
        if (message.type === 'project_changed') {
          ws.close();
          resolve(message.project as Record<string, unknown>);
        }
      });
    });
    assert.equal(createdProject.name, 'Second workspace');
    assert.equal(createdProject.rootPath, secondRoot);

    const settingsResponse = await fetch(`http://127.0.0.1:${instance.port}/api/provider-settings`);
    assert.equal(settingsResponse.status, 200);
    const initialSettings = (await settingsResponse.json()) as {
      configPath: string;
      providers: Record<
        string,
        { hasApiKey: boolean; defaultModel: string; models: string[]; thinkingEffort: string }
      >;
    };
    assert.equal(initialSettings.configPath, configPath);
    assert.equal(initialSettings.providers.openai.hasApiKey, false);
    assert.equal(initialSettings.providers.deepseek.defaultModel, 'deepseek-v4-flash');
    assert.deepEqual(initialSettings.providers.deepseek.models, [
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ]);
    assert.equal(initialSettings.providers.deepseek.thinkingEffort, 'high');

    const configureResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/provider-settings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          apiKey: 'test-local-key',
          baseURL: 'https://api.openai.com/v1',
          defaultModel: 'gpt-4o-mini',
          models: ['gpt-4o-mini', 'custom-openai-model'],
        }),
      },
    );
    assert.equal(configureResponse.status, 200);
    const configured = (await configureResponse.json()) as {
      runtime: { configured: boolean; provider: string; model: string };
      settings: {
        active: string;
        providers: Record<string, Record<string, unknown>>;
      };
    };
    assert.equal(configured.runtime.configured, true);
    assert.equal(configured.runtime.provider, 'openai');
    assert.equal(configured.runtime.model, 'gpt-4o-mini');
    assert.equal(configured.settings.active, 'openai');
    assert.equal(configured.settings.providers.openai.hasApiKey, true);
    assert.equal('apiKey' in configured.settings.providers.openai, false);
    assert.deepEqual(configured.settings.providers.openai.models, [
      'gpt-4o-mini',
      'custom-openai-model',
    ]);

    const savedConfig = await readFile(configPath, 'utf8');
    assert.match(savedConfig, /active: openai/);
    assert.match(savedConfig, /apiKey: test-local-key/);
    assert.match(savedConfig, /enabled: false/);

    const configuredHealth = await fetch(`http://127.0.0.1:${instance.port}/api/health`);
    assert.equal(configuredHealth.status, 200);

    const switchOpenAIResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/runtime/model`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'custom-openai-model', reasoningEffort: 'off' }),
      },
    );
    assert.equal(switchOpenAIResponse.status, 200);
    const switchedOpenAI = (await switchOpenAIResponse.json()) as {
      runtime: { model: string; reasoningSupported: boolean; reasoningEffort: string };
    };
    assert.equal(switchedOpenAI.runtime.model, 'custom-openai-model');
    assert.equal(switchedOpenAI.runtime.reasoningSupported, false);
    assert.equal(switchedOpenAI.runtime.reasoningEffort, 'off');

    const configureDeepSeekResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/provider-settings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'deepseek',
          apiKey: 'test-deepseek-key',
          baseURL: 'https://api.deepseek.com',
          defaultModel: 'deepseek-v4-flash',
          models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
          thinkingEffort: 'high',
        }),
      },
    );
    assert.equal(configureDeepSeekResponse.status, 200);

    const switchDeepSeekResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/runtime/model`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4-pro', reasoningEffort: 'max' }),
      },
    );
    assert.equal(switchDeepSeekResponse.status, 200);
    const switchedDeepSeek = (await switchDeepSeekResponse.json()) as {
      runtime: {
        provider: string;
        model: string;
        reasoningSupported: boolean;
        reasoningEffort: string;
      };
    };
    assert.equal(switchedDeepSeek.runtime.provider, 'deepseek');
    assert.equal(switchedDeepSeek.runtime.model, 'deepseek-v4-pro');
    assert.equal(switchedDeepSeek.runtime.reasoningSupported, true);
    assert.equal(switchedDeepSeek.runtime.reasoningEffort, 'max');

    const updatedConfig = await readFile(configPath, 'utf8');
    assert.match(updatedConfig, /active: deepseek/);
    assert.match(updatedConfig, /defaultModel: deepseek-v4-pro/);
    assert.match(updatedConfig, /thinkingEffort: max/);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('remote listening requires an explicit access token', async () => {
  await assert.rejects(createWebServer({ host: '0.0.0.0', port: 0 }), /PERSONAL_AGENT_WEB_TOKEN/);
});

test('refresh restores the last opened task and its persisted conversation history', async () => {
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
      'memory:',
      '  enabled: false',
      'plugins:',
      '  enabled: false',
      'mcp:',
      '  servers: []',
    ].join('\n'),
    'utf8',
  );

  const sessions = new SessionManager(workspace, 'gpt-4o-mini', 'openai', sessionsDirectory);
  sessions.replaceMessages([
    { role: 'user', content: '刷新后还在吗？' },
    { role: 'assistant', content: '会话内容仍然存在。' },
  ]);
  const sessionId = await sessions.save();

  const projects = new ProjectManager(projectStoragePath);
  await projects.initialize();
  const project = await projects.createProject({ name: 'Refresh workspace', rootPath: workspace });
  const task = await projects.createTask({
    projectId: project.id,
    title: '持久化会话',
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

  const readHistory = () =>
    new Promise<Array<{ role: string; content: unknown }>>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${instance.port}/ws?task=${encodeURIComponent(task.id)}`,
      );
      let history: Array<{ role: string; content: unknown }> | undefined;
      let ready = false;
      ws.once('error', reject);
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === 'history') {
          history = message.messages as Array<{ role: string; content: unknown }>;
        }
        if (message.type === 'ready') ready = true;
        if (ready && history) {
          ws.close();
          resolve(history);
        }
      });
    });

  try {
    const firstLoad = await readHistory();
    assert.deepEqual(
      firstLoad.map((message) => message.content),
      ['刷新后还在吗？', '会话内容仍然存在。'],
    );

    const refreshed = await readHistory();
    assert.deepEqual(refreshed, firstLoad);
    const sessionFile = await readFile(join(sessionsDirectory, `${sessionId}.json`), 'utf8');
    assert.ok(sessionFile.length > 0);
    assert.equal(JSON.parse(sessionFile).messages.length, 2);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});
