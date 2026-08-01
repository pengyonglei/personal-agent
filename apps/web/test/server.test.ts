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
  const browsableRoot = join(directory, 'browse-root');
  const clientBuildDirectory = join(directory, 'client');
  await mkdir(browsableRoot);
  await mkdir(clientBuildDirectory);
  await writeFile(join(clientBuildDirectory, 'index.html'), '<h1>desktop client</h1>', 'utf8');

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
    clientBuildDirectory,
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

    const clientResponse = await fetch(`http://127.0.0.1:${instance.port}/`);
    assert.equal(clientResponse.status, 200);
    assert.match(await clientResponse.text(), /desktop client/);

    const rootsResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/filesystem/directories`,
    );
    assert.equal(rootsResponse.status, 200);
    const roots = (await rootsResponse.json()) as {
      entries: Array<{ name: string; path: string; hasChildren: boolean }>;
    };
    assert.ok(roots.entries.length > 0);

    const directoriesResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/filesystem/directories?path=${encodeURIComponent(
        directory,
      )}`,
    );
    assert.equal(directoriesResponse.status, 200);
    const directories = (await directoriesResponse.json()) as {
      currentPath: string;
      entries: Array<{ name: string; path: string; hasChildren: boolean }>;
    };
    assert.equal(directories.currentPath, directory);
    assert.deepEqual(
      directories.entries.find((entry) => entry.path === browsableRoot),
      { name: 'browse-root', path: browsableRoot, hasChildren: true },
    );

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
          activate: false,
          apiKey: 'test-deepseek-key',
          baseURL: 'https://api.deepseek.com',
          defaultModel: 'deepseek-v4-flash',
          models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
          thinkingEffort: 'high',
        }),
      },
    );
    assert.equal(configureDeepSeekResponse.status, 200);
    const configuredDeepSeek = (await configureDeepSeekResponse.json()) as {
      runtime: {
        provider: string;
        model: string;
        models: Array<{
          provider: string;
          id: string;
          reasoningSupported: boolean;
          reasoningOptions: string[];
        }>;
      };
      settings: { active: string; providers: Record<string, Record<string, unknown>> };
    };
    assert.equal(configuredDeepSeek.runtime.provider, 'openai');
    assert.equal(configuredDeepSeek.runtime.model, 'custom-openai-model');
    assert.equal(configuredDeepSeek.settings.active, 'openai');
    assert.equal(configuredDeepSeek.settings.providers.deepseek.hasApiKey, true);
    assert.deepEqual(
      configuredDeepSeek.runtime.models.find(
        (model) => model.provider === 'deepseek' && model.id === 'deepseek-v4-pro',
      )?.reasoningOptions,
      ['off', 'high', 'max'],
    );
    assert.equal(
      configuredDeepSeek.runtime.models.find(
        (model) => model.provider === 'openai' && model.id === 'custom-openai-model',
      )?.reasoningSupported,
      false,
    );

    const switchDeepSeekResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/runtime/model`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'max',
        }),
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

    const deleteResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/provider-settings/deepseek`,
      { method: 'DELETE' },
    );
    assert.equal(deleteResponse.status, 200);
    const deleted = (await deleteResponse.json()) as {
      runtime: { configured: boolean; provider: string };
      settings: {
        active: string;
        providers: Record<string, { configured: boolean }>;
      };
    };
    assert.equal(deleted.runtime.configured, true);
    assert.equal(deleted.runtime.provider, 'openai');
    assert.equal(deleted.settings.active, 'openai');
    assert.equal(deleted.settings.providers.deepseek.configured, false);

    const configAfterDelete = await readFile(configPath, 'utf8');
    assert.doesNotMatch(configAfterDelete, /deepseek:/);
    assert.match(configAfterDelete, /active: openai/);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('remote listening requires an explicit access token', async () => {
  await assert.rejects(createWebServer({ host: '0.0.0.0', port: 0 }), /PERSONAL_AGENT_WEB_TOKEN/);
});

test('archiving the active project switches the workspace to another project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-archive-'));
  const configPath = join(directory, 'config.yaml');
  await writeFile(
    configPath,
    ['memory:', '  enabled: false', 'plugins:', '  enabled: false', 'mcp:', '  servers: []'].join(
      '\n',
    ),
    'utf-8',
  );
  const alphaRoot = join(directory, 'alpha');
  const betaRoot = join(directory, 'beta');
  await Promise.all([mkdir(alphaRoot), mkdir(betaRoot)]);

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
  });

  try {
    const result = await new Promise<{
      alphaId: string;
      betaId: string;
      activeAfterArchive?: string;
      archived?: string;
    }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/ws`);
      let alphaId: string | undefined;
      let betaId: string | undefined;
      let archived: string | undefined;
      let state: Record<string, unknown> | undefined;
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out while archiving a project'));
      }, 10_000);
      const finish = () => {
        clearTimeout(timeout);
        ws.close();
        resolve({
          alphaId: alphaId!,
          betaId: betaId!,
          activeAfterArchive: state?.activeProjectId as string | undefined,
          archived,
        });
      };

      ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === 'ready') {
          alphaId = message.activeProjectId as string;
          ws.send(JSON.stringify({ type: 'create_project', name: 'Beta', rootPath: betaRoot }));
          return;
        }
        if (message.type === 'project_changed') {
          const project = message.project as { id: string; name: string };
          if (project.name === 'Beta' && !betaId) {
            betaId = project.id;
            // Creating a project activates it, so the active project is now Beta.
            ws.send(JSON.stringify({ type: 'archive_project', projectId: project.id }));
            return;
          }
        }
        if (message.type === 'project_archived') {
          archived = (message.project as { id: string }).id;
          return;
        }
        if (message.type === 'project_list' && archived) {
          state = message;
          finish();
        }
      });
    });

    assert.equal(result.archived, result.betaId);
    // The workspace should have switched back to the remaining active project.
    assert.equal(result.activeAfterArchive, result.alphaId);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('task permission mode is persisted and restored when switching tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-permission-'));
  const workspace = join(directory, 'workspace');
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

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: workspace,
    configPath,
    projectStoragePath,
  });

  try {
    const taskIds = await new Promise<{ firstTaskId: string; secondTaskId: string }>(
      (resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/ws`);
        let stage: 'ready' | 'allow' | 'second' | 'approval' | 'restore' = 'ready';
        let projectId: string | undefined;
        let firstTaskId: string | undefined;
        let secondTaskId: string | undefined;
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error(`Timed out while waiting for permission stage: ${stage}`));
        }, 10_000);
        const finish = () => {
          clearTimeout(timeout);
          ws.close();
          resolve({ firstTaskId: firstTaskId!, secondTaskId: secondTaskId! });
        };

        ws.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        ws.on('message', (data) => {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (message.type === 'ready' && stage === 'ready') {
            projectId = message.activeProjectId as string;
            firstTaskId = message.activeTaskId as string;
            stage = 'allow';
            ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'allow' }));
            return;
          }
          if (message.type === 'permission_mode' && message.mode === 'allow' && stage === 'allow') {
            stage = 'second';
            ws.send(JSON.stringify({ type: 'create_task', projectId }));
            return;
          }
          if (message.type === 'task_changed' && stage === 'second') {
            secondTaskId = (message.task as { id: string }).id;
            stage = 'approval';
            ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'approval' }));
            return;
          }
          if (
            message.type === 'permission_mode' &&
            message.mode === 'approval' &&
            stage === 'approval'
          ) {
            stage = 'restore';
            ws.send(JSON.stringify({ type: 'open_task', taskId: firstTaskId }));
            return;
          }
          if (
            message.type === 'permission_mode' &&
            message.mode === 'allow' &&
            stage === 'restore'
          ) {
            finish();
          }
        });
      },
    );

    const saved = JSON.parse(await readFile(projectStoragePath, 'utf8')) as {
      tasks: Array<{ id: string; permissionMode?: string }>;
    };
    assert.equal(
      saved.tasks.find((task) => task.id === taskIds.firstTaskId)?.permissionMode,
      'allow',
    );
    assert.equal(
      saved.tasks.find((task) => task.id === taskIds.secondTaskId)?.permissionMode,
      'approval',
    );
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
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
    // 会话保存为异步写盘，等待落盘完成后再清理目录（避免 Windows 句柄占用）
    await new Promise((resolve) => setTimeout(resolve, 200));
    await rm(directory, { recursive: true, force: true });
  }
});
