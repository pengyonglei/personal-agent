import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProjectManager, SessionManager } from '@personal-agent/core';
import { WebSocket } from 'ws';
import { createWebServer, deriveTaskTitle, truncateTaskTitle } from '../src/server';

test('task titles use the normalized first intent and respect the storage limit', () => {
  assert.equal(deriveTaskTitle('  修复构建\n并补充测试  '), '修复构建 并补充测试');
  const title = deriveTaskTitle('任务'.repeat(150));
  assert.equal(Array.from(title).length, 20);
  assert.equal(title.endsWith('…'), true);
});

test('truncateTaskTitle keeps any text within 20 characters', () => {
  assert.equal(truncateTaskTitle('  修复构建错误  '), '修复构建错误');
  assert.equal(truncateTaskTitle('修复'.repeat(30)), '修复'.repeat(9) + '修…');
  assert.equal(Array.from(truncateTaskTitle('a'.repeat(100))).length, 20);
  assert.equal(truncateTaskTitle('a'.repeat(100)).endsWith('…'), true);
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
      ['off', 'low', 'high', 'max'],
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

test('LM Studio provider configures without an API key and exposes xhigh thinking strength', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-lmstudio-'));
  const configPath = join(directory, 'config.yaml');
  await writeFile(
    configPath,
    ['memory:', '  enabled: false', 'plugins:', '  enabled: false', 'mcp:', '  servers: []'].join(
      '\n',
    ),
    'utf8',
  );
  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
  });

  try {
    const initialResponse = await fetch(`http://127.0.0.1:${instance.port}/api/provider-settings`);
    const initial = (await initialResponse.json()) as {
      providers: Record<string, { requiresApiKey: boolean; baseURL: string }>;
    };
    assert.equal(initial.providers.lmstudio.requiresApiKey, false);
    assert.equal(initial.providers.lmstudio.baseURL, 'http://localhost:1234/v1');

    const configureResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/provider-settings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'lmstudio',
          activate: true,
          baseURL: 'http://localhost:1234/v1',
          defaultModel: 'qwen3.8-27b-a3b-thinking',
          models: ['qwen3.8-27b-a3b-thinking', 'qwen3-14b'],
          thinkingEffort: 'xhigh',
        }),
      },
    );
    assert.equal(configureResponse.status, 200);
    const configured = (await configureResponse.json()) as {
      runtime: {
        configured: boolean;
        provider: string;
        model: string;
        reasoningSupported: boolean;
        reasoningEffort: string;
        models: Array<{
          provider: string;
          id: string;
          reasoningSupported: boolean;
          reasoningOptions: string[];
        }>;
      };
      settings: {
        active: string;
        providers: Record<string, Record<string, unknown>>;
      };
    };
    assert.equal(configured.runtime.configured, true);
    assert.equal(configured.runtime.provider, 'lmstudio');
    assert.equal(configured.runtime.model, 'qwen3.8-27b-a3b-thinking');
    assert.equal(configured.runtime.reasoningSupported, true);
    assert.equal(configured.runtime.reasoningEffort, 'xhigh');
    assert.equal(configured.settings.active, 'lmstudio');
    assert.equal(configured.settings.providers.lmstudio.reasoningSupported, true);
    assert.equal(configured.settings.providers.lmstudio.thinkingEffort, 'xhigh');
    assert.equal('apiKey' in configured.settings.providers.lmstudio, false);
    assert.deepEqual(
      configured.runtime.models.find((model) => model.id === 'qwen3.8-27b-a3b-thinking')
        ?.reasoningOptions,
      ['off', 'low', 'medium', 'xhigh'],
    );

    const switchResponse = await fetch(`http://127.0.0.1:${instance.port}/api/runtime/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'lmstudio',
        model: 'qwen3-14b',
        reasoningEffort: 'medium',
      }),
    });
    assert.equal(switchResponse.status, 200);
    const switched = (await switchResponse.json()) as {
      runtime: { provider: string; model: string; reasoningEffort: string };
    };
    assert.equal(switched.runtime.provider, 'lmstudio');
    assert.equal(switched.runtime.model, 'qwen3-14b');
    assert.equal(switched.runtime.reasoningEffort, 'medium');

    const persisted = await readFile(configPath, 'utf8');
    assert.match(persisted, /active: lmstudio/);
    assert.match(persisted, /defaultModel: qwen3-14b/);
    assert.match(persisted, /thinkingEffort: medium/);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('remote listening requires an explicit access token', async () => {
  await assert.rejects(createWebServer({ host: '0.0.0.0', port: 0 }), /PERSONAL_AGENT_WEB_TOKEN/);
});

test('global vision settings only expose configured ImageInput models', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-vision-'));
  const configPath = join(directory, 'config.yaml');
  await writeFile(
    configPath,
    [
      'providers:',
      '  active: openai',
      '  openai:',
      '    apiKey: test-local-key',
      '    defaultModel: gpt-4o',
      '    models: [gpt-4o, gpt-4o-mini]',
      'vision:',
      '  enabled: false',
      'memory:',
      '  enabled: false',
      'plugins:',
      '  enabled: false',
      'mcp:',
      '  servers: []',
    ].join('\n'),
    'utf8',
  );
  await mkdir(join(directory, '.personal-agent'));
  await writeFile(
    join(directory, '.personal-agent', 'config.yaml'),
    ['vision:', '  enabled: true', '  provider: deepseek', '  model: ignored-project-model'].join(
      '\n',
    ),
    'utf8',
  );
  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
  });

  try {
    const settingsResponse = await fetch(`http://127.0.0.1:${instance.port}/api/vision-settings`);
    assert.equal(settingsResponse.status, 200);
    const settings = (await settingsResponse.json()) as {
      enabled: boolean;
      models: Array<{ provider: string; model: string }>;
    };
    assert.equal(settings.enabled, false);
    assert.deepEqual(settings.models, [
      {
        provider: 'openai',
        providerName: 'OpenAI (GPT)',
        model: 'gpt-4o',
        displayName: 'GPT-4o',
      },
    ]);

    const configureOllamaResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/provider-settings`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'ollama',
          activate: false,
          baseURL: 'http://localhost:11434',
          defaultModel: 'qwen2.5vl:7b',
          models: [
            { id: 'qwen2.5vl:7b', imageInput: true },
            { id: 'qwen3:8b', imageInput: false },
          ],
        }),
      },
    );
    assert.equal(configureOllamaResponse.status, 200);
    const configuredOllama = (await configureOllamaResponse.json()) as {
      settings: {
        providers: Record<string, { models: Array<string | { id: string; imageInput?: boolean }> }>;
      };
    };
    assert.deepEqual(configuredOllama.settings.providers.ollama.models, [
      { id: 'qwen2.5vl:7b', imageInput: true },
      { id: 'qwen3:8b', imageInput: false },
    ]);

    const refreshedVisionResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/vision-settings`,
    );
    assert.equal(refreshedVisionResponse.status, 200);
    const refreshedVision = (await refreshedVisionResponse.json()) as {
      models: Array<{ provider: string; model: string }>;
    };
    assert.deepEqual(refreshedVision.models, [
      {
        provider: 'openai',
        providerName: 'OpenAI (GPT)',
        model: 'gpt-4o',
        displayName: 'GPT-4o',
      },
      {
        provider: 'ollama',
        providerName: 'Ollama',
        model: 'qwen2.5vl:7b',
        displayName: 'qwen2.5vl:7b',
      },
    ]);

    const saveResponse = await fetch(`http://127.0.0.1:${instance.port}/api/vision-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        provider: 'openai',
        model: 'gpt-4o',
      }),
    });
    assert.equal(saveResponse.status, 200);
    const saved = (await saveResponse.json()) as {
      enabled: boolean;
      provider: string;
      model: string;
      runtime: { visionReady: boolean };
    };
    assert.deepEqual(
      {
        enabled: saved.enabled,
        provider: saved.provider,
        model: saved.model,
      },
      {
        enabled: true,
        provider: 'openai',
        model: 'gpt-4o',
      },
    );
    const persisted = await readFile(configPath, 'utf8');
    assert.match(persisted, /vision:\s+[\s\S]*enabled: true/);
    assert.match(persisted, /model: gpt-4o/);
    assert.match(persisted, /apiKey: test-local-key/);
    assert.equal(saved.runtime.visionReady, true, '视觉设置保存响应应立即返回最新运行时能力');

    const unsupportedResponse = await fetch(
      `http://127.0.0.1:${instance.port}/api/vision-settings`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          provider: 'openai',
          model: 'gpt-4o-mini',
        }),
      },
    );
    assert.equal(unsupportedResponse.status, 400);
    assert.match(await unsupportedResponse.text(), /不支持图片输入/);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
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

test('agent-config API reads and persists maxTurns (minimum 50)', async () => {
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
  await writeFile(join(clientBuildDirectory, 'index.html'), '<h1>test client</h1>', 'utf8');

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
    clientBuildDirectory,
  });

  const baseUrl = `http://127.0.0.1:${instance.port}`;

  try {
    // 未配置时读取默认值 100
    const initial = await fetch(`${baseUrl}/api/agent-config`);
    assert.equal(initial.status, 200);
    assert.equal(((await initial.json()) as { maxTurns: number }).maxTurns, 100);

    // 更新为允许的最低值 50
    const updated = await fetch(`${baseUrl}/api/agent-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxTurns: 50 }),
    });
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as { maxTurns: number }).maxTurns, 50);

    // 低于 50 被拒绝
    const tooLow = await fetch(`${baseUrl}/api/agent-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxTurns: 49 }),
    });
    assert.equal(tooLow.status, 400);

    // 超过 500 被拒绝
    const tooHigh = await fetch(`${baseUrl}/api/agent-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxTurns: 501 }),
    });
    assert.equal(tooHigh.status, 400);

    // 非整数被拒绝
    const notInteger = await fetch(`${baseUrl}/api/agent-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxTurns: 50.5 }),
    });
    assert.equal(notInteger.status, 400);

    // 配置已持久化到 YAML 文件
    const savedYaml = await readFile(configPath, 'utf8');
    assert.match(savedYaml, /maxTurns:\s*50/);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('agent-config API reads and persists the bash tool shell preference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-shell-'));
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
  await writeFile(join(clientBuildDirectory, 'index.html'), '<h1>test client</h1>', 'utf8');

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
    clientBuildDirectory,
  });

  const baseUrl = `http://127.0.0.1:${instance.port}`;

  try {
    // 未配置时读取默认值 auto
    const initial = await fetch(`${baseUrl}/api/agent-config`);
    assert.equal(initial.status, 200);
    const initialPayload = (await initial.json()) as { maxTurns: number; shell: string };
    assert.equal(initialPayload.maxTurns, 100);
    assert.equal(initialPayload.shell, 'auto');

    // 更新为 bash
    const updated = await fetch(`${baseUrl}/api/agent-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shell: 'bash' }),
    });
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as { shell: string }).shell, 'bash');

    // 重启后仍持久化到 YAML
    const savedYaml = await readFile(configPath, 'utf8');
    assert.match(savedYaml, /shell: bash/);

    // 非法值被拒绝
    const tooHigh = await fetch(`${baseUrl}/api/agent-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shell: 'fish' }),
    });
    assert.equal(tooHigh.status, 400);

    // 空请求体被拒绝
    const empty = await fetch(`${baseUrl}/api/agent-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
  } finally {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('web-config API reads defaults, persists theme to config.yaml and restores after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-agent-web-theme-'));
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
  await writeFile(join(clientBuildDirectory, 'index.html'), '<h1>test client</h1>', 'utf8');

  const serverOptions = {
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
    clientBuildDirectory,
  };
  const instance = await createWebServer(serverOptions);

  const baseUrl = `http://127.0.0.1:${instance.port}`;

  try {
    // 未配置时读取默认值
    const initial = await fetch(`${baseUrl}/api/web-config`);
    assert.equal(initial.status, 200);
    const initialPayload = (await initial.json()) as {
      theme: string;
      accentLight: string;
      accentDark: string;
    };
    assert.equal(initialPayload.theme, 'light');
    assert.equal(initialPayload.accentLight, '#1677ff');
    assert.equal(initialPayload.accentDark, '#91caff');

    // 更新主题模式与主色
    const updated = await fetch(`${baseUrl}/api/web-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark', accentLight: '#722ed1', accentDark: '#d3adf7' }),
    });
    assert.equal(updated.status, 200);
    const updatedPayload = (await updated.json()) as {
      theme: string;
      accentLight: string;
      accentDark: string;
    };
    assert.equal(updatedPayload.theme, 'dark');
    assert.equal(updatedPayload.accentLight, '#722ed1');
    assert.equal(updatedPayload.accentDark, '#d3adf7');

    // 配置已持久化到 YAML 文件
    const savedYaml = await readFile(configPath, 'utf8');
    assert.match(savedYaml, /theme:\s*dark/);
    assert.match(savedYaml, /#722ed1/);
    assert.match(savedYaml, /#d3adf7/);

    // 非法 theme 被拒绝
    const badTheme = await fetch(`${baseUrl}/api/web-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'blue' }),
    });
    assert.equal(badTheme.status, 400);

    // 非法颜色格式被拒绝
    const badColor = await fetch(`${baseUrl}/api/web-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accentLight: 'red' }),
    });
    assert.equal(badColor.status, 400);

    // 空请求体被拒绝
    const empty = await fetch(`${baseUrl}/api/web-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);

    await instance.close();

    // 重启后从 config.yaml 恢复最新主题配置
    const restarted = await createWebServer(serverOptions);
    try {
      const restored = await fetch(`http://127.0.0.1:${restarted.port}/api/web-config`);
      assert.equal(restored.status, 200);
      const restoredPayload = (await restored.json()) as {
        theme: string;
        accentLight: string;
        accentDark: string;
      };
      assert.equal(restoredPayload.theme, 'dark');
      assert.equal(restoredPayload.accentLight, '#722ed1');
      assert.equal(restoredPayload.accentDark, '#d3adf7');
    } finally {
      await restarted.close();
    }
  } finally {
    await instance.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('ollama per-model reasoning options drive runtime options and defaults', async () => {
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
  await writeFile(join(clientBuildDirectory, 'index.html'), '<h1>client</h1>', 'utf8');

  const instance = await createWebServer({
    host: '127.0.0.1',
    port: 0,
    workingDirectory: directory,
    configPath,
    projectStoragePath: join(directory, 'projects.json'),
    clientBuildDirectory,
  });

  try {
    const baseUrl = `http://127.0.0.1:${instance.port}`;

    const configureResponse = await fetch(`${baseUrl}/api/provider-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        activate: true,
        baseURL: 'http://localhost:11434',
        defaultModel: 'qwen3:8b',
        models: [
          { id: 'qwen3:8b', reasoningOptions: ['off', 'medium', 'high', 'max'] },
          { id: 'deepseek-r1:7b', reasoningOptions: ['off', 'high'] },
          { id: 'llama3.1' },
        ],
      }),
    });
    assert.equal(configureResponse.status, 200);
    const configured = (await configureResponse.json()) as {
      runtime: {
        provider: string;
        model: string;
        reasoningSupported: boolean;
        reasoningEffort: string;
        models: Array<{
          id: string;
          provider: string;
          reasoningSupported: boolean;
          reasoningOptions: string[];
          reasoningEffort: string;
        }>;
      };
    };
    assert.equal(configured.runtime.provider, 'ollama');
    assert.equal(configured.runtime.model, 'qwen3:8b');
    // 激活模型带档位子集 → 支持思考，默认档取第一个非 off。
    assert.equal(configured.runtime.reasoningSupported, true);
    assert.equal(configured.runtime.reasoningEffort, 'medium');
    const models = configured.runtime.models.filter((model) => model.provider === 'ollama');
    const qwen3 = models.find((model) => model.id === 'qwen3:8b');
    assert.equal(qwen3?.reasoningSupported, true);
    assert.deepEqual(qwen3?.reasoningOptions, ['off', 'medium', 'high', 'max']);
    assert.equal(qwen3?.reasoningEffort, 'medium');
    const r1 = models.find((model) => model.id === 'deepseek-r1:7b');
    assert.equal(r1?.reasoningSupported, true);
    assert.deepEqual(r1?.reasoningOptions, ['off', 'high']);
    assert.equal(r1?.reasoningEffort, 'high');
    const llama = models.find((model) => model.id === 'llama3.1');
    assert.equal(llama?.reasoningSupported, false);
    assert.deepEqual(llama?.reasoningOptions, ['off']);
    assert.equal(llama?.reasoningEffort, 'off');

    // 切到未配置 reasoningOptions 的模型 → 不开启思考。
    const switchPlain = await fetch(`${baseUrl}/api/runtime/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.1' }),
    });
    assert.equal(switchPlain.status, 200);
    const switchedPlain = (await switchPlain.json()) as {
      runtime: { model: string; reasoningSupported: boolean; reasoningEffort: string };
    };
    assert.equal(switchedPlain.runtime.model, 'llama3.1');
    assert.equal(switchedPlain.runtime.reasoningSupported, false);
    assert.equal(switchedPlain.runtime.reasoningEffort, 'off');

    // 切回 qwen3:8b（不带显式档位）→ 默认档跟随该模型。
    const switchBack = await fetch(`${baseUrl}/api/runtime/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:8b' }),
    });
    assert.equal(switchBack.status, 200);
    const switchedBack = (await switchBack.json()) as {
      runtime: { model: string; reasoningEffort: string };
    };
    assert.equal(switchedBack.runtime.reasoningEffort, 'medium');

    const persisted = await readFile(configPath, 'utf8');
    assert.match(persisted, /reasoningOptions:\s*\n\s*- off/);
    // Ollama 的思考强度按模型配置，Provider 级 thinkingEffort 不应被写入。
    assert.doesNotMatch(persisted, /thinkingEffort: medium/);
  } finally {
    await instance.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
