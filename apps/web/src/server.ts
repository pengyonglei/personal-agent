import express from 'express';
import { readdir, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import { generateId, VERSION } from '@personal-agent/shared';
import type { UserAnswer, UserQuestion } from '@personal-agent/shared';
import {
  loadConfig,
  saveAgentSettings,
  saveMemorySettings,
  savePromptSettings,
  saveStatsSettings,
  saveToolsSettings,
  saveWebSettings,
} from '@personal-agent/config';
import { UsageStore, getByDay, getByModel, getSummary } from '@personal-agent/stats';
import {
  WebAgentRuntime,
  type ProviderSettingsInput,
  type RuntimeModelSettingsInput,
  type VisionSettingsInput,
  type WebConversation,
} from './runtime';
import {
  parseClientMessage,
  type ClientMessage,
  type ProjectSummary,
  type ServerMessage,
  type TaskSummary,
} from './protocol';
import { BUILTIN_PROMPTS, PROMPT_KEYS } from './prompts';
import { installSkillFromZip, SkillUploadError } from './skill-upload';
import {
  getValidationArtifactsRoot,
  loadValidationConfig,
  projectHash,
  resolveValidationArtifact,
} from '@personal-agent/validation';

const UNTITLED_TASK_TITLE = '新任务';
/** 批准计划后自动触发执行的内部提示（作为 user 消息写入历史，驱动模型开始执行已批准的计划）。 */
const APPROVED_PLAN_EXECUTE_PROMPT = '计划已批准，请开始执行。';
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const webDirectory = resolve(sourceDirectory, '..');
const defaultClientBuildDirectory = resolve(webDirectory, 'dist/client');
const viteConfigPath = resolve(webDirectory, 'vite.config.ts');

interface PendingPermission {
  resolve: (answer: { approved: boolean; remember?: boolean }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingQuestion {
  resolve: (answer: UserAnswer) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface DirectoryEntry {
  name: string;
  path: string;
  hasChildren: boolean;
}

export interface WebServerOptions {
  host?: string;
  port?: number;
  authToken?: string;
  workingDirectory?: string;
  configPath?: string;
  projectStoragePath?: string;
  sessionsDirectory?: string;
  clientBuildDirectory?: string;
  /** Stats SQLite database path. Defaults to ~/.personal-agent/stats/model-requests.db */
  statsDbPath?: string;
  /** 计划文档落盘目录。Defaults to ~/.personal-agent/plans */
  plansDirectory?: string;
  /** 修改文件记录批次落盘目录。Defaults to ~/.personal-agent/file-changes */
  fileChangesDirectory?: string;
  /** 标准技能上传目录。Defaults to ~/.personal-agent/skills */
  skillsDirectory?: string;
  /** 验证配置路径。Defaults to ~/.personal-agent/validation.yaml */
  validationConfigPath?: string;
  viteDev?: boolean;
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
  const port = options.port ?? Number(process.env.PORT ?? 5678);
  const authToken = options.authToken ?? process.env.PERSONAL_AGENT_WEB_TOKEN;
  const clientBuildDirectory = options.clientBuildDirectory ?? defaultClientBuildDirectory;

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
    statsDbPath: options.statsDbPath,
    plansDirectory: options.plansDirectory,
    fileChangesDirectory: options.fileChangesDirectory,
    skillsDirectory: options.skillsDirectory,
  });
  // Model request stats (SQLite) — graceful degradation when node:sqlite is
  // unavailable on the runtime (Node < 22.13). Never blocks server startup.
  const configPath = options.configPath ?? process.env.PERSONAL_AGENT_CONFIG;
  let statsStore: UsageStore | null = null;
  if (UsageStore.isAvailable()) {
    try {
      const store = new UsageStore({ dbPath: options.statsDbPath });
      store.initialize();
      statsStore = store;
    } catch (error) {
      console.warn(`[web] Stats store unavailable: ${formatError(error)}`);
    }
  }
  const app = express();
  const server = createServer(app);
  // 图片以 base64 通过 prompt 消息发送；协议层仍会执行 4 张 / 单张 5 MB / 总计 10 MB 的硬限制。
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  let viteDevServer: ViteDevServer | undefined;

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'${options.viteDev ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' data:; frame-ancestors 'none'`,
    );
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    const info = runtime.getRuntimeInfo();
    res.status(info.configured ? 200 : 503).json({
      status: info.configured ? 'ok' : 'needs_configuration',
      version: VERSION,
      runtime: info,
    });
  });

  app.get('/api/validation/artifacts/:projectHash/:runId/:artifactId', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const project = runtime.projects
        .listProjects({ includeArchived: true })
        .find((candidate) => projectHash(candidate.rootPath) === req.params.projectHash);
      const projectRoot = project?.rootPath ?? runtime.workingDirectory;
      const validationConfig = await loadValidationConfig(
        projectRoot,
        options.validationConfigPath,
      ).catch(() => null);
      const configuredRoot = validationConfig?.artifacts.root;
      const root = getValidationArtifactsRoot(
        configuredRoot ? resolve(projectRoot, configuredRoot) : undefined,
      );
      const path = resolveValidationArtifact(
        root,
        req.params.projectHash,
        req.params.runId,
        req.params.artifactId,
      );
      if (!path) {
        res.status(404).json({ error: 'Validation artifact not found.' });
        return;
      }
      res.sendFile(path);
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.get('/api/prompts', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({ prompts: buildPromptInventory(runtime.promptOverrides) });
  });

  app.get('/api/plans', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const plans = await runtime.listPlanDocs();
      res.json({ plans });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.get('/api/file-changes', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const batches = await runtime.listFileChangeBatches();
      res.json({ batches });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.delete('/api/file-changes/:id', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const deleted = await runtime.deleteFileChangeBatch(req.params.id);
      res.json({ deleted });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.put('/api/prompts', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const key = typeof body.key === 'string' ? body.key : '';
      if (!PROMPT_KEYS.includes(key as (typeof PROMPT_KEYS)[number])) {
        res.status(400).json({ error: `未知的提示词 key: ${key}` });
        return;
      }
      const reset = body.reset === true;
      const content = body.content;
      if (!reset && typeof content !== 'string') {
        res.status(400).json({ error: 'content 必须为字符串，或使用 reset: true 恢复默认' });
        return;
      }
      const update: Record<string, string | null> = reset
        ? { [key]: null }
        : { [key]: content as string };
      await savePromptSettings(update, configPath);
      runtime.updatePromptOverrides(update);
      res.json({ prompts: buildPromptInventory(runtime.promptOverrides) });
    } catch (error) {
      res.status(400).json({ error: formatError(error) });
    }
  });

  app.get('/api/runtime', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json(runtime.getRuntimeInfo());
  });

  app.get('/api/skills', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({
      directory: runtime.getSkillsDirectory(),
      skills: runtime.getStandaloneSkills().map((skill) => ({
        name: skill.name,
        description: skill.description,
        triggers: skill.triggers ?? [],
        sourcePath: skill.sourcePath,
      })),
    });
  });

  app.post(
    '/api/skills/upload',
    express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '12mb' }),
    async (req, res) => {
      if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      try {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: '请求体必须是 zip 文件内容' });
          return;
        }
        // 技能目录名 = zip 文件名（去 .zip），由前端通过 ?name= 传入
        const zipName =
          typeof req.query.name === 'string' ? req.query.name.replace(/\.zip$/i, '') : '';
        const installed = await installSkillFromZip(body, runtime.getSkillsDirectory(), zipName);
        await runtime.reloadStandaloneSkills();
        res.status(201).json({ skill: installed });
      } catch (error) {
        if (error instanceof SkillUploadError) {
          const status = error.code === 'exists' ? 409 : 400;
          res.status(status).json({ error: error.message, code: error.code });
          return;
        }
        res.status(500).json({ error: formatError(error) });
      }
    },
  );

  app.get('/api/provider-settings', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json(runtime.getProviderSettings());
  });

  app.get('/api/vision-settings', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json(runtime.getVisionSettings());
  });

  app.put('/api/vision-settings', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      await runtime.configureVisionSettings(parseVisionSettings(req.body));
      const settings = runtime.getVisionSettings();
      const runtimeInfo = runtime.getRuntimeInfo();
      // 视觉开关/模型属于运行时能力，保存后立即推送到所有已连接页面。
      broadcast({ type: 'runtime_updated', runtime: runtimeInfo });
      res.json({ ...settings, runtime: runtimeInfo });
    } catch (error) {
      res.status(400).json({ error: formatError(error) });
    }
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

  app.delete('/api/provider-settings/:provider', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const provider = parseProviderId(req.params.provider);
      await runtime.removeProvider(provider);
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

  app.get('/api/stats', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!statsStore) {
      res.json({ available: false });
      return;
    }
    try {
      const days = Math.min(365, Math.max(1, Number(req.query.days ?? 7) || 7));
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20));
      const pageResult = statsStore.getPage(page, pageSize);
      const to = Date.now();
      const from = to - days * 24 * 60 * 60 * 1000;
      res.json({
        available: true,
        days,
        summary: getSummary(statsStore, from, to),
        byModel: getByModel(statsStore, from, to),
        byDay: getByDay(statsStore, from, to),
        total: pageResult.total,
        records: pageResult.records,
      });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  app.get('/api/stats-config', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const config = loadConfig({ cwd: runtime.workingDirectory, configPath: configPath });
    res.json({ recordPayloads: config.stats.recordPayloads });
  });

  app.put('/api/stats-config', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const body = req.body as Record<string, unknown> | undefined;
      if (typeof body?.recordPayloads !== 'boolean') {
        throw new Error('recordPayloads 格式无效。');
      }
      await saveStatsSettings({ recordPayloads: body.recordPayloads }, configPath);
      // Take effect immediately for new requests in the running process.
      statsStore?.setRecordPayloads(body.recordPayloads);
      runtime.statsStore?.setRecordPayloads(body.recordPayloads);
      res.json({ recordPayloads: body.recordPayloads });
    } catch (error) {
      res.status(400).json({ error: formatError(error) });
    }
  });

  // Agent 通用配置（设置 -> 通用）：最大循环轮数 maxTurns、bash 工具 shell
  app.get('/api/agent-config', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const config = loadConfig({ cwd: runtime.workingDirectory, configPath: configPath });
    res.json({ maxTurns: config.agent.maxTurns, shell: config.tools.shell });
  });

  app.put('/api/agent-config', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const maxTurns = body?.maxTurns;
      const shell = body?.shell;
      if (maxTurns === undefined && shell === undefined) {
        throw new Error('没有需要保存的配置项。');
      }
      if (maxTurns !== undefined) {
        if (typeof maxTurns !== 'number' || !Number.isInteger(maxTurns)) {
          throw new Error('maxTurns 必须是整数。');
        }
        if (maxTurns < 50) {
          throw new Error('最大循环轮数不能低于 50。');
        }
        if (maxTurns > 500) {
          throw new Error('最大循环轮数不能超过 500。');
        }
        await saveAgentSettings({ maxTurns }, configPath);
        // Take effect immediately for new tasks in the running process.
        runtime.config.agent.maxTurns = maxTurns;
      }
      if (shell !== undefined) {
        if (shell !== 'auto' && shell !== 'powershell' && shell !== 'bash') {
          throw new Error('shell 必须是 auto、powershell 或 bash。');
        }
        await saveToolsSettings({ shell }, configPath);
        // Take effect immediately for the bash tool in the running process.
        runtime.setShellPreference(shell);
      }
      res.json({ maxTurns: runtime.config.agent.maxTurns, shell: runtime.config.tools.shell });
    } catch (error) {
      res.status(400).json({ error: formatError(error) });
    }
  });

  // Web UI 外观配置（设置 -> 通用 -> 外观）：主题模式、浅色/深色主色，
  // 持久化到 config.yaml，服务启动时读取并下发给前端。
  app.get('/api/web-config', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const config = loadConfig({ cwd: runtime.workingDirectory, configPath: configPath });
    res.json({
      theme: config.web.theme,
      accentLight: config.web.accentLight,
      accentDark: config.web.accentDark,
    });
  });

  app.put('/api/web-config', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const theme = body?.theme;
      const accentLight = body?.accentLight;
      const accentDark = body?.accentDark;
      if (theme === undefined && accentLight === undefined && accentDark === undefined) {
        throw new Error('没有需要保存的配置项。');
      }
      const update: { theme?: 'light' | 'dark'; accentLight?: string; accentDark?: string } = {};
      if (theme !== undefined) {
        if (theme !== 'light' && theme !== 'dark') {
          throw new Error('theme 必须是 light 或 dark。');
        }
        update.theme = theme;
      }
      const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
      for (const [key, value] of [
        ['accentLight', accentLight],
        ['accentDark', accentDark],
      ] as const) {
        if (value === undefined) continue;
        if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
          throw new Error(`${key} 必须是 #rrggbb 格式的颜色。`);
        }
        update[key] = value;
      }
      await saveWebSettings(update, configPath);
      // Take effect immediately in the running process.
      if (update.theme !== undefined) runtime.config.web.theme = update.theme;
      if (update.accentLight !== undefined) runtime.config.web.accentLight = update.accentLight;
      if (update.accentDark !== undefined) runtime.config.web.accentDark = update.accentDark;
      res.json({
        theme: runtime.config.web.theme,
        accentLight: runtime.config.web.accentLight,
        accentDark: runtime.config.web.accentDark,
      });
    } catch (error) {
      res.status(400).json({ error: formatError(error) });
    }
  });

  // 记忆配置（设置 -> 通用）：是否开启、最大记忆条数
  app.get('/api/memory-config', (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const config = loadConfig({ cwd: runtime.workingDirectory, configPath: configPath });
    res.json({ enabled: config.memory.enabled, maxEntries: config.memory.maxEntries });
  });

  app.put('/api/memory-config', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const enabled = body?.enabled;
      const maxEntries = body?.maxEntries;
      if (enabled === undefined && maxEntries === undefined) {
        throw new Error('没有需要保存的配置项。');
      }
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        throw new Error('enabled 必须是布尔值。');
      }
      if (maxEntries !== undefined) {
        if (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries)) {
          throw new Error('最大记忆条数必须是整数。');
        }
        if (maxEntries < 1) {
          throw new Error('最大记忆条数不能低于 1。');
        }
        if (maxEntries > 100000) {
          throw new Error('最大记忆条数不能超过 100000。');
        }
      }
      await saveMemorySettings(
        { enabled: enabled as boolean | undefined, maxEntries: maxEntries as number | undefined },
        configPath,
      );
      // Take effect immediately in the running process.
      await runtime.applyMemorySettings({
        enabled: (enabled as boolean | undefined) ?? runtime.config.memory.enabled,
        maxEntries: (maxEntries as number | undefined) ?? runtime.config.memory.maxEntries,
      });
      res.json({
        enabled: runtime.config.memory.enabled,
        maxEntries: runtime.config.memory.maxEntries,
      });
    } catch (error) {
      res.status(400).json({ error: formatError(error) });
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

  app.get('/api/filesystem/directories', async (req, res) => {
    if (!isAuthorized(req.headers.authorization, req.query.token, authToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const directoryPath = parseDirectoryQuery(req.query.path);
      if (!directoryPath) {
        res.json({ entries: await listDirectoryRoots(runtime.workingDirectory) });
        return;
      }
      const resolvedPath = resolve(directoryPath);
      const info = await stat(resolvedPath);
      if (!info.isDirectory()) throw new Error(`路径不是目录: ${resolvedPath}`);
      res.json({
        currentPath: resolvedPath,
        parentPath: getParentDirectory(resolvedPath),
        entries: await listChildDirectories(resolvedPath),
      });
    } catch (error) {
      res.status(400).json({ error: formatError(error) });
    }
  });

  if (options.viteDev) {
    // Keep Vite out of desktop/production bundles while retaining the dev middleware.
    const { createServer: createViteServer } = (await import(
      resolveOptionalModuleName('vite')
    )) as typeof import('vite');
    viteDevServer = await createViteServer({
      configFile: viteConfigPath,
      server: {
        middlewareMode: true,
        hmr: { server },
      },
      appType: 'spa',
    });
    app.use(viteDevServer.middlewares);
  } else {
    app.use(express.static(clientBuildDirectory, { extensions: ['html'] }));
    app.use((_req, res) => {
      res.sendFile(join(clientBuildDirectory, 'index.html'));
    });
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws' && options.viteDev) return;
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
    const pendingQuestions = new Map<string, PendingQuestion>();
    const send = (message: ServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    /** Per-task conversations — one WebConversation per task id. */
    const conversations = new Map<string, WebConversation>();
    let activeProjectId: string | undefined;
    let activeTaskId: string | undefined;
    let messageQueue = Promise.resolve();

    const requestPermissionFor =
      (taskId: string) =>
      (
        toolName: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<{ approved: boolean; remember?: boolean }> => {
        const requestId = generateId();
        send({ type: 'permission_request', requestId, toolName, params, taskId });
        return new Promise((resolvePermission) => {
          let settled = false;
          const finish = (answer: { approved: boolean; remember?: boolean }): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            pendingPermissions.delete(requestId);
            resolvePermission(answer);
          };
          const onAbort = (): void => finish({ approved: false });
          const timeout = setTimeout(
            () => {
              finish({ approved: false });
              send({ type: 'notice', message: `工具 ${toolName} 的审批已超时并被拒绝。` });
            },
            5 * 60 * 1000,
          );
          pendingPermissions.set(requestId, { resolve: finish, timeout });
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
      };

    const requestQuestionFor =
      (taskId: string) =>
      (question: UserQuestion, signal?: AbortSignal): Promise<UserAnswer> => {
        const requestId = generateId();
        send({
          type: 'ask_user_request',
          requestId,
          question: question.question,
          options: question.options,
          multiSelect: question.multiSelect,
          allowCustom: question.allowCustom,
          taskId,
        });
        return new Promise((resolveAnswer) => {
          let settled = false;
          const finish = (answer: UserAnswer): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            pendingQuestions.delete(requestId);
            resolveAnswer(answer);
          };
          const onAbort = (): void => finish({ selections: [] });
          const timeout = setTimeout(
            () => {
              finish({ selections: [] });
              send({ type: 'notice', message: '问题等待超时，未收到回答。' });
            },
            5 * 60 * 1000,
          );
          pendingQuestions.set(requestId, { resolve: finish, timeout });
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
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
      if (!project) {
        // No active project (all projects may be archived). Load the UI with an
        // empty workspace so the user can restore or create one.
        send({
          type: 'ready',
          version: VERSION,
          runtime: runtime.getRuntimeInfo(),
        });
        sendProjectState();
        await sendSessionList(runtime, send);
        return;
      }
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
        sessionId: conversations.get(activeTaskId ?? '')?.sessionId,
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
      if (
        message.type === 'interrupt' ||
        message.type === 'permission_response' ||
        message.type === 'ask_user_response'
      ) {
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
      if (message.type === 'ask_user_response') {
        const pending = pendingQuestions.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingQuestions.delete(message.requestId);
        pending.resolve(message.answer);
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
        if (!project || project.archived) throw new Error(`项目不存在: ${message.projectId}`);
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
      if (message.type === 'archive_project') {
        const project = runtime.projects.getProject(message.projectId);
        if (!project) throw new Error(`项目不存在: ${message.projectId}`);
        const archived = await runtime.projects.archiveProject(project.id);
        send({ type: 'project_archived', project: serializeProject(archived) });
        if (activeProjectId === project.id) {
          await switchAwayFromProject(project.id);
        }
        sendProjectState();
        return;
      }
      if (message.type === 'restore_project') {
        const project = runtime.projects.getProject(message.projectId);
        if (!project) throw new Error(`项目不存在: ${message.projectId}`);
        const restored = await runtime.projects.restoreProject(project.id);
        send({ type: 'project_changed', project: serializeProject(restored) });
        sendProjectState();
        return;
      }
      if (message.type === 'delete_project') {
        const project = runtime.projects.getProject(message.projectId);
        if (!project) throw new Error(`项目不存在: ${message.projectId}`);
        const wasActive = activeProjectId === project.id;
        await runtime.projects.deleteProject(project.id);
        send({ type: 'project_deleted', projectId: project.id });
        if (wasActive) {
          await switchAwayFromProject(project.id);
        }
        sendProjectState();
        return;
      }
      if (message.type === 'rename_project') {
        const project = runtime.projects.getProject(message.projectId);
        if (!project) throw new Error(`项目不存在: ${message.projectId}`);
        const renamed = await runtime.projects.renameProject(project.id, message.name);
        send({ type: 'project_changed', project: serializeProject(renamed) });
        sendProjectState();
        return;
      }
      if (message.type === 'set_project_pinned') {
        const project = await runtime.projects.setProjectPinned(message.projectId, message.pinned);
        send({ type: 'project_changed', project: serializeProject(project) });
        sendProjectState();
        return;
      }
      if (message.type === 'reorder_projects') {
        await runtime.projects.reorderProjects(message.projectIds, message.pinned);
        sendProjectState();
        return;
      }
      if (message.type === 'create_task') {
        const task = await runtime.projects.createTask({
          projectId: message.projectId,
          title: UNTITLED_TASK_TITLE,
          permissionMode: message.permissionMode,
        });
        await activateTask(task.id);
        sendProjectState();
        return;
      }
      if (message.type === 'rename_task') {
        const task = await runtime.projects.renameTask(message.taskId, message.title);
        const conv = conversations.get(task.id);
        send({
          type: 'task_renamed',
          task: serializeTask(task, {
            running: conv?.isBusy ?? false,
            model: conv
              ? `${conv.providerInstance.providerId}:${conv.providerInstance.getModel()}`
              : undefined,
          }),
        });
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
        const closed = conversations.get(message.taskId);
        if (closed) {
          await closed.close();
          conversations.delete(message.taskId);
        }
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
      const routedTaskId = message.taskId ?? activeTaskId;
      const conversation = routedTaskId ? conversations.get(routedTaskId) : undefined;
      if (!conversation) {
        throw new Error(runtime.getRuntimeInfo().initializationError ?? 'LLM Provider 尚未配置');
      }

      switch (message.type) {
        case 'prompt':
          if (routedTaskId) {
            const task = runtime.projects.getTask(routedTaskId);
            if (task?.title === UNTITLED_TASK_TITLE) {
              // 先用截断标题立即重命名（不阻塞首条消息），再用 LLM 意图总结精炼。
              const titleInput = message.text || '图片分析';
              const fallbackTitle = deriveTaskTitle(titleInput);
              const renamed = await runtime.projects.renameTask(routedTaskId, fallbackTitle);
              // 必须带上 running/model：客户端用 task_renamed 覆盖任务条目，
              // 缺 model 会导致任务模型选择回退为全局默认（deepseek-v4-flash）。
              send({
                type: 'task_renamed',
                task: serializeTask(renamed, {
                  running: conversation.isBusy,
                  model: `${conversation.providerInstance.providerId}:${conversation.providerInstance.getModel()}`,
                }),
              });
              void refineTaskTitleWithLlm(conversation, routedTaskId, fallbackTitle, titleInput);
            }
          }
          // Run the agent loop WITHOUT blocking the message queue: while a task
          // is executing, navigation messages (open_task / create_task / ...)
          // must stay responsive so other tasks can be opened and run in
          // parallel. Each conversation guards its own prompt concurrency.
          void conversation
            .runPrompt({ text: message.text, images: message.images ?? [] })
            .then(async () => {
              if (routedTaskId) await runtime.projects.touchTask(routedTaskId);
              // 执行期间若有模型被下线：任务结束后自动摘除下线模型（不打断执行，
              // 下次执行将使用自动切换后的可用模型）。
              await runtime.refreshInvalidTaskModels();
              sendProjectState();
              await sendSessionList(runtime, send);
            })
            .catch((error) => {
              send({ type: 'error', message: formatError(error), code: 'REQUEST_FAILED' });
            });
          break;
        case 'inject_user_message':
          // 把消息插入到正在执行的任务循环内（作为补充消息引导模型思考方向）。
          // 同步调用不阻塞消息队列；busy 时入队由 AgentLoop 吸取，空闲时等价于
          // 直接执行。失败（会话已关闭等）由 handleMessage 外层统一报错。
          conversation.injectUserMessage(message.text);
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
          if (routedTaskId) {
            await runtime.projects.attachSession(routedTaskId, conversation.sessionId);
          }
          break;
        case 'set_plan_mode':
          conversation.setPlanMode(message.enabled);
          if (routedTaskId) {
            // 持久化任务级计划模式：刷新/重启后恢复。
            await runtime.projects.setTaskPlanMode(routedTaskId, message.enabled);
            sendProjectState();
          }
          send({
            type: 'notice',
            message: message.enabled
              ? 'Plan 模式已开启：当前仅允许只读工具。'
              : 'Plan 模式已关闭：计划（如有）已批准，可开始执行。',
          });
          break;
        case 'set_permission_mode':
          conversation.setPermissionMode(message.mode);
          if (routedTaskId) {
            await runtime.projects.setTaskPermissionMode(routedTaskId, message.mode);
            sendProjectState();
          }
          break;
        case 'approve_plan': {
          const before = conversation.planEngine.getPlan();
          const approvedPlan = conversation.setPlanMode(false);
          if (approvedPlan && before?.status === 'draft') {
            send({ type: 'notice', message: '计划已批准，开始执行…' });
            // 批准后自动开始执行：与 prompt 分支相同的异步执行路径，不阻塞消息队列。
            // 触发文本会作为 user 消息写入会话历史，模型按已注入的 plan-execution
            // section（依赖顺序 + update_plan_step）执行计划。
            void conversation
              .runPrompt(APPROVED_PLAN_EXECUTE_PROMPT)
              .then(async () => {
                if (routedTaskId) await runtime.projects.touchTask(routedTaskId);
                await runtime.refreshInvalidTaskModels();
                sendProjectState();
                await sendSessionList(runtime, send);
              })
              .catch((error) => {
                send({ type: 'error', message: formatError(error), code: 'REQUEST_FAILED' });
              });
          } else {
            send({ type: 'notice', message: '计划已批准，执行工具现已解锁。' });
          }
          break;
        }
        case 'compress_context':
          await conversation.compressContext();
          send({ type: 'notice', message: '上下文已压缩，早期对话已生成语义摘要。' });
          break;
        case 'set_task_model': {
          const providerId = parseProviderId(message.providerId);
          await runtime.setTaskModel(
            conversation,
            providerId,
            message.model,
            message.reasoningEffort,
          );
          // 持久化任务模型：刷新/重启后按它恢复会话模型。
          await runtime.projects.setTaskModel(routedTaskId!, `${providerId}:${message.model}`);
          // 提示信息由 conversation.replaceProvider 统一发出（仅一次），
          // 避免切换模型时出现重复提示。
          sendProjectState();
          break;
        }
        case 'set_task_rule': {
          if (!routedTaskId) throw new Error('set_task_rule 需要任务上下文');
          runtime.addTaskPermissionRule(routedTaskId, message.tool, message.action);
          send({
            type: 'notice',
            message: `已为任务添加规则：${message.tool} → ${message.action}`,
            taskId: routedTaskId,
          });
          break;
        }
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
        let conv = conversations.get(taskId);
        if (!conv) {
          // 恢复任务级模型覆盖：刷新/重连/重启后按持久化的任务模型构建会话，
          // 而不是回退到全局默认（deepseek-v4-flash）。
          const taskOverride = task.model ? await runtime.resolveTaskModel(task.model) : undefined;
          // 任务模型已失效（供应商被删除或模型已下线）：清除持久化值，
          // 回退全局默认模型，避免后续每次激活都解析失败。
          if (task.model && !taskOverride) {
            await runtime.projects.setTaskModel(task.id, undefined);
          }
          conv = runtime.createConversation(
            send,
            requestPermissionFor(task.id),
            requestQuestionFor(task.id),
            project.rootPath,
            taskOverride,
            task.id,
          );
          await conv.start();
          if (task.sessionId) {
            const restored = await conv.restoreSession(task.sessionId);
            if (!restored) {
              const missingSessionId = task.sessionId;
              await conv.checkpoint();
              await runtime.projects.attachSession(task.id, conv.sessionId);
              send({
                type: 'notice',
                message: `原会话 ${missingSessionId.slice(0, 12)} 的文件缺失或损坏，已创建新的会话。`,
              });
            }
          } else {
            await conv.checkpoint();
            await runtime.projects.attachSession(task.id, conv.sessionId);
          }
          conversations.set(taskId, conv);
          // 恢复任务级计划模式（服务端重启/会话重建后仍保持计划模式开启）。
          if (task.planMode) conv.setPlanMode(true);
        }
      } else {
        send({ type: 'history', sessionId: task.sessionId ?? '', messages: [] });
      }
      const activatedTask = runtime.projects.getTask(task.id) ?? task;
      const permissionMode = activatedTask.permissionMode ?? 'ask';
      const conv = conversations.get(taskId);
      if (conv) {
        // Must not fail when the task is still executing (no idle check).
        conv.applyPermissionMode(permissionMode);
        // 刷新/重连后客户端 planActive 初始为 false：重推当前计划状态，
        // 让「概要」Tab 与输入框的计划模式开关恢复（含已存在会话的场合）。
        conv.publishPlan();
      } else {
        send({ type: 'permission_mode', mode: permissionMode, taskId });
      }

      if (announce) {
        send({ type: 'project_changed', project: serializeProject(project) });
        const conv = conversations.get(task.id);
        send({
          type: 'task_changed',
          task: serializeTask(runtime.projects.getTask(task.id) ?? task, {
            running: conv?.isBusy ?? false,
            model: conv
              ? `${conv.providerInstance.providerId}:${conv.providerInstance.getModel()}`
              : undefined,
          }),
        });
      }
    }

    /**
     * 用大模型对用户第一个问题做意图总结，生成不超过 20 字的任务标题。
     * 调用失败或结果为空时回退到 deriveTaskTitle（纯文本截断）。
     */
    async function summarizeTaskTitle(
      conversation: WebConversation,
      input: string,
    ): Promise<string> {
      try {
        const response = await conversation.providerInstance.chat(
          [
            {
              role: 'system',
              content:
                '你是任务命名助手。用不超过 20 个字总结用户第一句话的意图，作为任务标题。只输出标题本身，不要引号、标点或任何解释。',
            },
            { role: 'user', content: input },
          ],
          [],
          { temperature: 0.2, maxTokens: 60, reasoningEffort: 'off' },
        );
        const text = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(' ')
          .trim();
        return text ? truncateTaskTitle(text) : deriveTaskTitle(input);
      } catch {
        // LLM 调用失败不阻断首条消息：回退到纯文本截断标题
        return deriveTaskTitle(input);
      }
    }

    /**
     * 异步用 LLM 精炼任务标题：先用截断标题立即重命名（不阻塞首条消息），
     * LLM 返回后若任务仍未被手动重命名，则替换为意图总结标题。
     */
    async function refineTaskTitleWithLlm(
      conversation: WebConversation,
      taskId: string,
      fallbackTitle: string,
      input: string,
    ): Promise<void> {
      try {
        const title = await summarizeTaskTitle(conversation, input);
        if (!title || title === fallbackTitle) return;
        const current = runtime.projects.getTask(taskId);
        if (!current || current.title !== fallbackTitle) return; // 已被手动重命名
        const renamed = await runtime.projects.renameTask(taskId, title);
        send({
          type: 'task_renamed',
          task: serializeTask(renamed, {
            running: conversation.isBusy,
            model: `${conversation.providerInstance.providerId}:${conversation.providerInstance.getModel()}`,
          }),
        });
      } catch {
        // 保持当前标题，不阻断任何流程
      }
    }

    async function switchAwayFromProject(removedProjectId: string): Promise<void> {
      const nextProject = runtime.projects
        .listProjects()
        .find((project) => project.id !== removedProjectId);
      if (nextProject) {
        let task = runtime.projects.listTasks(nextProject.id)[0];
        if (!task) {
          task = await runtime.projects.createTask({
            projectId: nextProject.id,
            title: UNTITLED_TASK_TITLE,
          });
        }
        await activateTask(task.id);
        return;
      }
      activeProjectId = undefined;
      activeTaskId = undefined;
      for (const [taskId, conv] of [...conversations]) {
        const task = runtime.projects.getTask(taskId);
        if (task?.projectId === removedProjectId) {
          await conv.close();
          conversations.delete(taskId);
        }
      }
    }

    function sendProjectState(): void {
      send({
        type: 'project_list',
        projects: runtime.projects.listProjects({ includeArchived: true }).map(serializeProject),
        activeProjectId,
      });
      if (activeProjectId) {
        send({
          type: 'task_list',
          // 一次性下发所有项目的任务，由前端按项目组织成树
          tasks: runtime.projects
            .listProjects({ includeArchived: true })
            .flatMap((project) => runtime.projects.listTasks(project.id))
            .map((task) => {
              const conv = conversations.get(task.id);
              return serializeTask(task, {
                running: conv?.isBusy ?? false,
                model: conv
                  ? `${conv.providerInstance.providerId}:${conv.providerInstance.getModel()}`
                  : undefined,
              });
            }),
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
      for (const pending of pendingQuestions.values()) {
        clearTimeout(pending.timeout);
        pending.resolve({ selections: [] });
      }
      pendingQuestions.clear();
      for (const conv of conversations.values()) {
        void conv.close().catch(() => undefined);
      }
      conversations.clear();
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
      await viteDevServer?.close();
      statsStore?.close();
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
    input.provider !== undefined &&
    input.provider !== 'anthropic' &&
    input.provider !== 'openai' &&
    input.provider !== 'ollama' &&
    input.provider !== 'deepseek' &&
    input.provider !== 'volcano'
  ) {
    throw new Error('provider 格式无效。');
  }
  if (
    input.provider !== 'anthropic' &&
    input.provider !== 'openai' &&
    input.provider !== 'ollama' &&
    input.provider !== 'deepseek' &&
    input.provider !== 'volcano'
  ) {
    throw new Error('不支持的 Provider。');
  }

  const result: ProviderSettingsInput = { provider: input.provider };
  if (input.activate !== undefined) {
    if (typeof input.activate !== 'boolean') throw new Error('activate 格式无效。');
    result.activate = input.activate;
  }
  for (const field of ['apiKey', 'baseURL', 'defaultModel'] as const) {
    const fieldValue = input[field];
    if (fieldValue === undefined || fieldValue === null) continue;
    if (typeof fieldValue !== 'string' || fieldValue.length > 4096) {
      throw new Error(`${field} 格式无效。`);
    }
    result[field] = fieldValue;
  }
  if (input.models !== undefined) {
    if (!Array.isArray(input.models) || input.models.length > 100) {
      throw new Error('models 格式无效。');
    }
    for (const entry of input.models) {
      if (typeof entry === 'string') {
        if (!entry.trim() || entry.length > 256) throw new Error('models 格式无效。');
        continue;
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('models 格式无效。');
      }
      const model = entry as Record<string, unknown>;
      const contextWindow = model.contextWindow;
      const maxOutputTokens = model.maxOutputTokens;
      const imageInput = model.imageInput;
      if (
        typeof model.id !== 'string' ||
        !model.id.trim() ||
        model.id.length > 256 ||
        (contextWindow !== undefined &&
          (typeof contextWindow !== 'number' ||
            !Number.isInteger(contextWindow) ||
            contextWindow < 1024 ||
            contextWindow > 10_000_000)) ||
        (maxOutputTokens !== undefined &&
          (typeof maxOutputTokens !== 'number' ||
            !Number.isInteger(maxOutputTokens) ||
            maxOutputTokens < 1 ||
            maxOutputTokens > 10_000_000)) ||
        (imageInput !== undefined && typeof imageInput !== 'boolean')
      ) {
        throw new Error('models 格式无效。');
      }
    }
    result.models = input.models as ProviderSettingsInput['models'];
  }
  if (input.thinkingEffort !== undefined) {
    result.thinkingEffort = parseReasoningEffort(input.thinkingEffort);
  }
  return result;
}

function parseVisionSettings(value: unknown): VisionSettingsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('视觉模型配置格式无效。');
  }
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== 'boolean') throw new Error('enabled 格式无效。');
  if (typeof input.prompt !== 'string') throw new Error('prompt 格式无效。');
  if (
    input.provider !== undefined &&
    input.provider !== 'anthropic' &&
    input.provider !== 'openai' &&
    input.provider !== 'ollama' &&
    input.provider !== 'deepseek' &&
    input.provider !== 'volcano'
  ) {
    throw new Error('不支持的视觉模型供应商。');
  }
  if (input.model !== undefined && typeof input.model !== 'string') {
    throw new Error('model 格式无效。');
  }
  return {
    enabled: input.enabled,
    provider: input.provider as VisionSettingsInput['provider'],
    model: input.model,
    prompt: input.prompt,
  };
}

function parseProviderId(value: string): ProviderSettingsInput['provider'] {
  if (
    value !== 'anthropic' &&
    value !== 'openai' &&
    value !== 'ollama' &&
    value !== 'deepseek' &&
    value !== 'volcano'
  ) {
    throw new Error('不支持的 Provider。');
  }
  return value;
}

function parseRuntimeModelSettings(value: unknown): RuntimeModelSettingsInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型运行配置格式无效。');
  }
  const input = value as Record<string, unknown>;
  if (
    input.provider !== undefined &&
    input.provider !== 'anthropic' &&
    input.provider !== 'openai' &&
    input.provider !== 'ollama' &&
    input.provider !== 'deepseek' &&
    input.provider !== 'volcano'
  ) {
    throw new Error('provider 格式无效。');
  }
  if (typeof input.model !== 'string' || input.model.length > 256) {
    throw new Error('model 格式无效。');
  }
  return {
    provider: input.provider as RuntimeModelSettingsInput['provider'],
    model: input.model,
    reasoningEffort:
      input.reasoningEffort === undefined ? undefined : parseReasoningEffort(input.reasoningEffort),
  };
}

function parseReasoningEffort(value: unknown): 'off' | 'low' | 'medium' | 'high' | 'max' {
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

function parseDirectoryQuery(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > 4096) {
    throw new Error('目录路径格式无效。');
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

async function listDirectoryRoots(workingDirectory: string): Promise<DirectoryEntry[]> {
  const candidates = new Map<string, string>();
  const addRoot = (value: string | undefined): void => {
    if (!value) return;
    const root = parse(resolve(value)).root;
    if (!root) return;
    candidates.set(normalizePathKey(root), root);
  };

  addRoot(workingDirectory);
  addRoot(process.cwd());
  addRoot(homedir());

  if (process.platform === 'win32') {
    const systemDrive = process.env.SystemDrive;
    if (systemDrive) addRoot(`${systemDrive.replace(/[\\\/]+$/, '')}\\`);
    for (let code = 65; code <= 90; code += 1) {
      addRoot(`${String.fromCharCode(code)}:\\`);
    }
  } else {
    addRoot('/');
  }

  const entries: DirectoryEntry[] = [];
  for (const directoryPath of candidates.values()) {
    try {
      const info = await stat(directoryPath);
      if (!info.isDirectory()) continue;
      entries.push({
        name: directoryPath,
        path: directoryPath,
        hasChildren: true,
      });
    } catch {
      // Ignore inaccessible or unmounted roots.
    }
  }
  return sortDirectoryEntries(entries);
}

async function listChildDirectories(directoryPath: string): Promise<DirectoryEntry[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const directories: DirectoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const childPath = join(directoryPath, entry.name);
    try {
      const info = await stat(childPath);
      if (!info.isDirectory()) continue;
      directories.push({
        name: entry.name,
        path: childPath,
        hasChildren: true,
      });
    } catch {
      // Skip directories that cannot be inspected by the current process.
    }
  }
  return sortDirectoryEntries(directories);
}

function sortDirectoryEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  return entries.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

function getParentDirectory(directoryPath: string): string | undefined {
  const parent = dirname(directoryPath);
  return normalizePathKey(parent) === normalizePathKey(directoryPath) ? undefined : parent;
}

function normalizePathKey(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function serializeProject(project: {
  id: string;
  name: string;
  rootPath: string;
  archived?: boolean;
  pinned?: boolean;
  sortOrder?: number;
  createdAt: Date;
  updatedAt: Date;
}): ProjectSummary {
  return {
    ...project,
    archived: project.archived === true,
    pinned: project.pinned === true,
    sortOrder: Number.isFinite(project.sortOrder) ? (project.sortOrder as number) : 0,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function serializeTask(
  task: {
    id: string;
    projectId: string;
    title: string;
    sessionId?: string;
    model?: TaskSummary['model'];
    permissionMode?: TaskSummary['permissionMode'];
    status: 'active' | 'archived';
    createdAt: Date;
    updatedAt: Date;
  },
  extra: { running?: boolean; model?: string } = {},
): TaskSummary {
  return {
    ...task,
    permissionMode: task.permissionMode ?? 'ask',
    running: extra.running ?? false,
    model: extra.model ?? task.model,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

/** 自动生成任务标题（回退/兜底路径）：归一化空白后截断到 20 字以内。 */
export function deriveTaskTitle(intent: string): string {
  return truncateTaskTitle(intent.replace(/\s+/g, ' ').trim());
}

/** 把任意文本截断到不超过 20 个字符（超长时以省略号结尾，总长 20）。 */
export function truncateTaskTitle(text: string): string {
  const characters = Array.from(text.trim());
  if (characters.length <= 20) return characters.join('');
  return `${characters.slice(0, 19).join('')}…`;
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

/** 合并用户覆盖，生成前端可展示的提示词清单（含生效内容与自定义标记） */
function buildPromptInventory(
  promptOverrides: Record<string, string>,
): Array<Record<string, unknown>> {
  return BUILTIN_PROMPTS.map((prompt) => {
    const customized = promptOverrides[prompt.key] !== undefined;
    return {
      ...prompt,
      content: customized ? promptOverrides[prompt.key] : prompt.content,
      defaultContent: prompt.content,
      customized,
    };
  });
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host.toLowerCase());
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveOptionalModuleName(moduleName: string): string {
  return moduleName;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isEntrypoint) {
  createWebServer({ viteDev: basename(sourceDirectory) === 'src' })
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
