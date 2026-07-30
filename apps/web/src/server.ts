import express from 'express';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { generateId } from '@personal-agent/shared';
import {
  WebAgentRuntime,
  type ProviderSettingsInput,
  type RuntimeModelSettingsInput,
  type WebConversation,
} from './runtime';
import {
  parseClientMessage,
  type ClientMessage,
  type ProjectSummary,
  type ServerMessage,
  type TaskSummary,
} from './protocol';

const VERSION = '0.1.0';
const UNTITLED_TASK_TITLE = '新任务';
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = resolve(sourceDirectory, '..', 'public');
const require = createRequire(import.meta.url);
const markedClientPath = join(dirname(require.resolve('marked')), 'marked.esm.js');
const domPurifyClientPath = join(dirname(require.resolve('dompurify')), 'purify.es.mjs');

interface PendingPermission {
  resolve: (answer: { approved: boolean; remember?: boolean }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface WebServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  workingDirectory?: string;
  configPath?: string;
  projectStoragePath?: string;
  sessionsDirectory?: string;
}

export async function createWebServer(options: WebServerOptions = {}): Promise<{
  app: express.Express;
  server: Server;
  runtime: WebAgentRuntime;
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const host = options.host ?? process.env.PERSONAL_AGENT_WEB_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT ?? 3456);
  const authToken = options.authToken ?? process.env.PERSONAL_AGENT_WEB_TOKEN;

  if (!isLoopback(host) && !authToken) {
    throw new Error('远程监听必须设置 PERSONAL_AGENT_WEB_TOKEN；本地使用请监听 127.0.0.1。');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`无效端口: ${port}`);
  }

  const runtime = await WebAgentRuntime.create({
    workingDirectory: options.workingDirectory,
    configPath: options.configPath ?? process.env.PERSONAL_AGENT_CONFIG,
    projectStoragePath: options.projectStoragePath ?? process.env.PERSONAL_AGENT_PROJECTS_PATH,
    sessionsDirectory: options.sessionsDirectory ?? process.env.PERSONAL_AGENT_SESSIONS_PATH,
  });
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self'; frame-ancestors 'none'",
    );
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.get('/vendor/marked.js', (_req, res) =>
    res.sendFile(markedClientPath, { dotfiles: 'allow' }),
  );
  app.get('/vendor/dompurify.js', (_req, res) =>
    res.sendFile(domPurifyClientPath, { dotfiles: 'allow' }),
  );
  app.use(express.static(publicDirectory, { extensions: ['html'] }));

  app.get('/api/health', (_req, res) => {
    const info = runtime.getRuntimeInfo();
    res.status(info.configured ? 200 : 503).json({
      status: info.configured ? 'ok' : 'needs_configuration',
      version: VERSION,
      runtime: info,
    });
  });

  app.get('/api/runtime', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json(runtime.getRuntimeInfo());
  });

  app.get('/api/provider-settings', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json(runtime.getProviderSettings());
  });

  app.post('/api/provider-settings', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const settings = parseProviderSettings(req.body);
      await runtime.configureProvider(settings);
      const runtimeInfo = runtime.getRuntimeInfo();
      broadcast({ type: 'runtime_updated', runtime: runtimeInfo });
      res.json({
        runtime: runtimeInfo,
        settings: runtime.getProviderSettings(),
      });
    } catch (error) {
      const message = formatError(error);
      res.status(message.includes('正在运行') ? 409 : 400).json({ error: message });
    }
  });

  app.post('/api/runtime/model', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      await runtime.configureRuntimeModel(parseRuntimeModelSettings(req.body));
      const runtimeInfo = runtime.getRuntimeInfo();
      broadcast({ type: 'runtime_updated', runtime: runtimeInfo });
      res.json({ runtime: runtimeInfo });
    } catch (error) {
      const message = formatError(error);
      res.status(message.includes('正在运行') ? 409 : 400).json({ error: message });
    }
  });

  app.use((_req, res) => {
    res.sendFile(join(publicDirectory, 'index.html'));
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (
      url.pathname !== '/ws' ||
      !isAuthorized(request.headers.authorization, url.searchParams.get('token'), authToken)
    ) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (ws, request) => {
    const connectionUrl = new URL(
      request.url ?? '/ws',
      `http://${request.headers.host ?? 'localhost'}`,
    );
    const preferredTaskId = connectionUrl.searchParams.get('task') ?? undefined;
    const pendingPermissions = new Map<string, PendingPermission>();
    const send = (message: ServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    let conversation: WebConversation | null = null;
    let activeProjectId: string | undefined;
    let activeTaskId: string | undefined;
    let messageQueue = Promise.resolve();

    const requestPermission = (
      toolName: string,
      params: Record<string, unknown>,
    ): Promise<{ approved: boolean; remember?: boolean }> => {
      const requestId = generateId();
      send({ type: 'permission_request', requestId, toolName, params });
      return new Promise((resolvePermission) => {
        const timeout = setTimeout(
          () => {
            pendingPermissions.delete(requestId);
            resolvePermission({ approved: false });
            send({ type: 'notice', message: `工具 ${toolName} 的审批已超时并被拒绝。` });
          },
          5 * 60 * 1000,
        );
        pendingPermissions.set(requestId, { resolve: resolvePermission, timeout });
      });
    };

    const bootstrap = initializeWorkspace().catch((error) => {
      send({ type: 'error', message: formatError(error), code: 'WORKSPACE_START_FAILED' });
    });

    async function initializeWorkspace(): Promise<void> {
      const preferredTask = preferredTaskId ? runtime.projects.getTask(preferredTaskId) : undefined;
      const preferredProject =
        preferredTask?.status === 'active'
          ? runtime.projects.getProject(preferredTask.projectId)
          : undefined;
      const project = preferredProject ?? runtime.projects.listProjects()[0];
      if (!project) throw new Error('没有可用项目');
      let task =
        preferredTask?.status === 'active' && preferredTask.projectId === project.id
          ? preferredTask
          : runtime.projects.listTasks(project.id)[0];
      if (!task) {
        task = await runtime.projects.createTask({
          projectId: project.id,
          title: UNTITLED_TASK_TITLE,
        });
      }
      await activateTask(task.id, false);
      send({
        type: 'ready',
        version: VERSION,
        sessionId: conversation?.sessionId,
        activeProjectId,
        activeTaskId,
        runtime: runtime.getRuntimeInfo(),
      });
      sendProjectState();
      await sendSessionList(runtime, send);
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        send({ type: 'error', message: '不支持二进制消息', code: 'INVALID_MESSAGE' });
        return;
      }
      let message: ClientMessage;
      try {
        message = parseClientMessage(data.toString());
      } catch (error) {
        send({ type: 'error', message: formatError(error), code: 'INVALID_MESSAGE' });
        return;
      }
      if (message.type === 'interrupt' || message.type === 'permission_response') {
        void handleMessage(message).catch(sendRequestError);
        return;
      }
      messageQueue = messageQueue
        .then(() => bootstrap)
        .then(() => handleMessage(message))
        .catch(sendRequestError);
    });

    async function handleMessage(message: ClientMessage): Promise<void> {
      if (message.type === 'ping') {
        send({ type: 'pong' });
        return;
      }
      if (message.type === 'permission_response') {
        const pending = pendingPermissions.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingPermissions.delete(message.requestId);
        pending.resolve({ approved: message.approved, remember: message.remember });
        return;
      }
      if (message.type === 'list_sessions') {
        await sendSessionList(runtime, send);
        return;
      }
      if (message.type === 'list_projects') {
        sendProjectState();
        return;
      }

      if (message.type === 'create_project') {
        const project = await runtime.projects.createProject({
          name: message.name,
          rootPath: message.rootPath,
        });
        const task = await runtime.projects.createTask({
          projectId: project.id,
          title: UNTITLED_TASK_TITLE,
        });
        await activateTask(task.id);
        sendProjectState();
        return;
      }
      if (message.type === 'select_project') {
        const project = runtime.projects.getProject(message.projectId);
        if (!project) throw new Error(`项目不存在: ${message.projectId}`);
        let task = runtime.projects.listTasks(project.id)[0];
        if (!task) {
          task = await runtime.projects.createTask({
            projectId: project.id,
            title: UNTITLED_TASK_TITLE,
          });
        }
        await activateTask(task.id);
        sendProjectState();
        return;
      }
      if (message.type === 'create_task') {
        const task = await runtime.projects.createTask({
          projectId: message.projectId,
          title: UNTITLED_TASK_TITLE,
        });
        await activateTask(task.id);
        sendProjectState();
        return;
      }
      if (message.type === 'rename_task') {
        const task = await runtime.projects.renameTask(message.taskId, message.title);
        send({ type: 'task_renamed', task: serializeTask(task) });
        sendProjectState();
        return;
      }
      if (message.type === 'open_task') {
        await activateTask(message.taskId);
        sendProjectState();
        return;
      }
      if (message.type === 'archive_task') {
        const archived = await runtime.projects.archiveTask(message.taskId);
        if (activeTaskId === archived.id) {
          let next = runtime.projects.listTasks(archived.projectId)[0];
          if (!next) {
            next = await runtime.projects.createTask({
              projectId: archived.projectId,
              title: UNTITLED_TASK_TITLE,
            });
          }
          await activateTask(next.id);
        }
        sendProjectState();
        return;
      }
      if (!conversation) {
        throw new Error(runtime.getRuntimeInfo().initializationError ?? 'LLM Provider 尚未配置');
      }

      switch (message.type) {
        case 'prompt':
          if (activeTaskId) {
            const task = runtime.projects.getTask(activeTaskId);
            if (task?.title === UNTITLED_TASK_TITLE) {
              const renamed = await runtime.projects.renameTask(
                activeTaskId,
                deriveTaskTitle(message.text),
              );
              send({ type: 'task_renamed', task: serializeTask(renamed) });
            }
          }
          await conversation.runPrompt(message.text);
          if (activeTaskId) await runtime.projects.touchTask(activeTaskId);
          sendProjectState();
          await sendSessionList(runtime, send);
          break;
        case 'interrupt':
          conversation.interrupt();
          break;
        case 'new_session':
          if (!activeProjectId) throw new Error('请先选择项目');
          {
            const task = await runtime.projects.createTask({
              projectId: activeProjectId,
              title: UNTITLED_TASK_TITLE,
            });
            await activateTask(task.id);
            sendProjectState();
          }
          break;
        case 'load_session':
          if (!(await conversation.restoreSession(message.sessionId))) {
            throw new Error(`找不到会话 ${message.sessionId}`);
          }
          if (activeTaskId) {
            await runtime.projects.attachSession(activeTaskId, conversation.sessionId);
          }
          break;
        case 'set_plan_mode':
          conversation.setPlanMode(message.enabled);
          send({
            type: 'notice',
            message: message.enabled
              ? 'Plan 模式已开启：当前仅允许只读工具。'
              : 'Plan 模式已关闭：计划（如有）已批准，可开始执行。',
          });
          break;
        case 'set_permission_mode':
          conversation.setPermissionMode(message.mode);
          break;
        case 'approve_plan':
          conversation.setPlanMode(false);
          send({ type: 'notice', message: '计划已批准，执行工具现已解锁。' });
          break;
      }
    }

    async function activateTask(taskId: string, announce = true): Promise<void> {
      const task = runtime.projects.getTask(taskId);
      if (!task || task.status === 'archived') throw new Error(`任务不存在: ${taskId}`);
      const project = runtime.projects.getProject(task.projectId);
      if (!project) throw new Error(`项目不存在: ${task.projectId}`);

      activeProjectId = project.id;
      activeTaskId = task.id;
      if (runtime.getRuntimeInfo().configured) {
        if (!conversation) {
          conversation = runtime.createConversation(send, requestPermission, project.rootPath);
          await conversation.start();
          if (task.sessionId) {
            const restored = await conversation.restoreSession(task.sessionId);
            if (!restored) {
              const missingSessionId = task.sessionId;
              await conversation.checkpoint();
              await runtime.projects.attachSession(task.id, conversation.sessionId);
              send({
                type: 'notice',
                message: `原会话 ${missingSessionId.slice(0, 12)} 的文件缺失或损坏，已创建新的会话。`,
              });
            }
          } else {
            await conversation.checkpoint();
            await runtime.projects.attachSession(task.id, conversation.sessionId);
          }
        } else {
          const restored = await conversation.switchWorkspace(project.rootPath, task.sessionId);
          if (!restored) {
            const missingSessionId = task.sessionId;
            await conversation.checkpoint();
            await runtime.projects.attachSession(task.id, conversation.sessionId);
            if (missingSessionId) {
              send({
                type: 'notice',
                message: `原会话 ${missingSessionId.slice(0, 12)} 的文件缺失或损坏，已创建新的会话。`,
              });
            }
          }
        }
      } else {
        send({ type: 'history', sessionId: task.sessionId ?? '', messages: [] });
      }
      send({
        type: 'permission_mode',
        mode: conversation?.getPermissionMode() ?? 'ask',
      });

      if (announce) {
        send({ type: 'project_changed', project: serializeProject(project) });
        send({
          type: 'task_changed',
          task: serializeTask(runtime.projects.getTask(task.id) ?? task),
        });
      }
    }

    function sendProjectState(): void {
      send({
        type: 'project_list',
        projects: runtime.projects.listProjects().map(serializeProject),
        activeProjectId,
      });
      if (activeProjectId) {
        send({
          type: 'task_list',
          projectId: activeProjectId,
          tasks: runtime.projects.listTasks(activeProjectId).map(serializeTask),
          activeTaskId,
        });
      }
    }

    function sendRequestError(error: unknown): void {
      send({ type: 'error', message: formatError(error), code: 'REQUEST_FAILED' });
    }

    ws.on('close', () => {
      for (const pending of pendingPermissions.values()) {
        clearTimeout(pending.timeout);
        pending.resolve({ approved: false });
      }
      pendingPermissions.clear();
      void conversation?.close().catch(() => undefined);
    });
  });

  function broadcast(message: ServerMessage): void {
    const serialized = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(serialized);
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const actualAddress = server.address();
  const actualPort = actualAddress && typeof actualAddress === 'object' ? actualAddress.port : port;

  return {
    app,
    server,
    runtime,
    host,
    port: actualPort,
    close: async () => {
      for (const client of wss.clients) client.close(1001, 'Server shutting down');
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
      await runtime.dispose();
    },
  };
}

function parseProviderSettings(value: unknown): ProviderSettingsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider 配置格式无效。');
  }
  const input = value as Record<string, unknown>;
  if (
    input.provider !== 'anthropic' &&
    input.provider !== 'openai' &&
    input.provider !== 'ollama' &&
    input.provider !== 'deepseek'
  ) {
    throw new Error('不支持的 Provider。');
  }

  const result: ProviderSettingsInput = { provider: input.provider };
  for (const field of ['apiKey', 'baseURL', 'defaultModel'] as const) {
    const fieldValue = input[field];
    if (fieldValue === undefined || fieldValue === null) continue;
    if (typeof fieldValue !== 'string' || fieldValue.length > 4096) {
      throw new Error(`${field} 格式无效。`);
    }
    result[field] = fieldValue;
  }
  if (input.models !== undefined) {
    if (
      !Array.isArray(input.models) ||
      input.models.length > 100 ||
      input.models.some((model) => typeof model !== 'string' || model.length > 256)
    ) {
      throw new Error('models 格式无效。');
    }
    result.models = input.models as string[];
  }
  if (input.thinkingEffort !== undefined) {
    result.thinkingEffort = parseReasoningEffort(input.thinkingEffort);
  }
  return result;
}

function parseRuntimeModelSettings(value: unknown): RuntimeModelSettingsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型运行配置格式无效。');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.model !== 'string' || input.model.length > 256) {
    throw new Error('model 格式无效。');
  }
  return {
    model: input.model,
    reasoningEffort:
      input.reasoningEffort === undefined
        ? undefined
        : parseReasoningEffort(input.reasoningEffort),
  };
}

function parseReasoningEffort(
  value: unknown,
): 'off' | 'low' | 'medium' | 'high' | 'max' {
  if (
    value !== 'off' &&
    value !== 'low' &&
    value !== 'medium' &&
    value !== 'high' &&
    value !== 'max'
  ) {
    throw new Error('thinkingEffort 格式无效。');
  }
  return value;
}

async function sendSessionList(
  runtime: WebAgentRuntime,
  send: (message: ServerMessage) => void,
): Promise<void> {
  send({ type: 'session_list', sessions: await runtime.listSessions() });
}

function serializeProject(project: {
  id: string;
  name: string;
  rootPath: string;
  createdAt: Date;
  updatedAt: Date;
}): ProjectSummary {
  return {
    ...project,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function serializeTask(task: {
  id: string;
  projectId: string;
  title: string;
  sessionId?: string;
  status: 'active' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}): TaskSummary {
  return {
    ...task,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function deriveTaskTitle(intent: string): string {
  const normalized = intent.replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length <= 200) return normalized;
  return `${characters.slice(0, 199).join('')}…`;
}

function isAuthorized(
  authorization: string | undefined,
  queryToken: unknown,
  configuredToken: string | undefined,
): boolean {
  if (!configuredToken) return true;
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  return bearer === configuredToken || queryToken === configuredToken;
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isEntrypoint) {
  createWebServer()
    .then(({ host, port, runtime, close }) => {
      const configured = runtime.getRuntimeInfo().configured ? 'ready' : 'needs configuration';
      console.log(`personal-agent Web UI: http://${host}:${port} (${configured})`);
      const shutdown = (): void => {
        void close().finally(() => process.exit(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((error) => {
      console.error(`[web] ${formatError(error)}`);
      process.exitCode = 1;
    });
}
