import {
  appConfigSchema,
  loadConfig,
  removeProviderSettings,
  resolveWritableConfigPath,
  saveProviderSettings,
  type AppConfig,
  type ModelConfig,
  type ProviderId,
} from '@personal-agent/config';
import {
  AgentLoop,
  ContextAssembler,
  PlanModeEngine,
  ProjectManager,
  SessionManager,
  TokenBudget,
  createLlmContextSummarizer,
  type Plan,
} from '@personal-agent/core';
import { MCPClientManager } from '@personal-agent/mcp';
import { ModelRequestRecorder, UsageStore } from '@personal-agent/stats';
import { FileSystemMemoryStore } from '@personal-agent/memory';
import { PluginLoader } from '@personal-agent/plugin';
import { ProviderRegistry, type LLMProvider } from '@personal-agent/provider';
import type { AgentEvent, ModelInfo, ReasoningEffort, ToolResult } from '@personal-agent/shared';
import { createLogger, ProviderFeature } from '@personal-agent/shared';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  BaseTool,
  registerBuiltinTools,
  type PermissionManager,
  type ToolContext,
  type ToolExecutor,
  type ToolRegistry,
} from '@personal-agent/tool';
import type {
  ContextUsage,
  PermissionMode,
  RuntimeInfo,
  ServerMessage,
  SessionSummary,
} from './protocol';

const log = createLogger('web-runtime');
/** Reserved output tokens used by TokenBudget (must stay in sync with its default). */
const TOKEN_BUDGET_RESERVED_OUTPUT = 8192;
const SAFE_TOOLS = ['read_file', 'list_directory', 'glob', 'grep', 'todo_write', 'ask_user'];
const PLAN_MODE_TOOLS = new Set([
  'read_file',
  'list_directory',
  'glob',
  'grep',
  'read_memory',
  'get_plan',
  'submit_plan',
]);

export type RuntimeEmitter = (message: ServerMessage) => void;
export type PermissionRequester = (
  toolName: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<{ approved: boolean; remember?: boolean }>;

export interface ProviderSettingsInput {
  provider: ProviderId;
  activate?: boolean;
  apiKey?: string;
  baseURL?: string;
  defaultModel?: string;
  models?: Array<string | ModelConfig>;
  thinkingEffort?: ReasoningEffort;
}

export interface RuntimeModelSettingsInput {
  provider?: ProviderId;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ProviderSettingsInfo {
  active?: ProviderId;
  configPath: string;
  providers: Record<
    ProviderId,
    {
      configured: boolean;
      hasApiKey: boolean;
      requiresApiKey: boolean;
      baseURL: string;
      defaultModel: string;
      models: Array<string | ModelConfig>;
      thinkingEffort: ReasoningEffort;
      reasoningSupported: boolean;
    }
  >;
}

export class WebAgentRuntime {
  config: AppConfig;
  readonly workingDirectory: string;
  readonly projects: ProjectManager;
  readonly sessionsDirectory?: string;

  private readonly configPath?: string;
  private providerRegistry: ProviderRegistry | null = null;
  private provider: LLMProvider | null = null;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private permissionManager: PermissionManager;
  private memoryStore: FileSystemMemoryStore | null = null;
  private mcpManager: MCPClientManager;
  private pluginLoader: PluginLoader;
  private initializationError: string | undefined;
  private conversations = new Map<string, WebConversation>();
  /** Shared stats store for all conversations (null when unavailable). */
  readonly statsStore: UsageStore | null;

  private constructor(
    config: AppConfig,
    workingDirectory: string,
    projectStoragePath?: string,
    configPath?: string,
    sessionsDirectory?: string,
  ) {
    this.config = config;
    this.workingDirectory = workingDirectory;
    this.configPath = configPath;
    this.sessionsDirectory = sessionsDirectory;
    this.projects = new ProjectManager(projectStoragePath);

    const tools = registerBuiltinTools();
    this.toolRegistry = tools.registry;
    this.toolExecutor = tools.executor;
    this.permissionManager = tools.permissionManager;
    this.mcpManager = new MCPClientManager(this.toolRegistry);
    this.pluginLoader = new PluginLoader(config.plugins.paths, {
      disabled: config.plugins.disabled,
    });

    tools.sandbox.updateConstraints({
      restrictPaths: config.tools.sandbox.restrictPaths,
      allowedPaths: config.tools.sandbox.allowedPaths,
      deniedCommands: [
        ...tools.sandbox.getConstraints().deniedCommands,
        ...config.tools.sandbox.deniedCommands,
      ],
      shellTimeout: config.tools.shellTimeout,
      webFetchTimeout: config.tools.webFetchTimeout,
    });

    for (const rule of config.tools.permissions) this.permissionManager.addRule(rule);
    for (const tool of SAFE_TOOLS) {
      this.permissionManager.addRule({ tool, action: 'allow', scope: 'session' });
    }
    this.statsStore = createRuntimeStatsStore(config.stats);
  }

  static async create(
    options: {
      workingDirectory?: string;
      configPath?: string;
      projectStoragePath?: string;
      sessionsDirectory?: string;
      /** Stats SQLite path override (defaults to config stats.dbPath). */
      statsDbPath?: string;
    } = {},
  ): Promise<WebAgentRuntime> {
    const workingDirectory =
      options.workingDirectory ??
      process.env.PERSONAL_AGENT_WORKSPACE ??
      findWorkspaceRoot(process.cwd());
    const config = normalizeRuntimeConfig(
      loadConfig({ cwd: workingDirectory, configPath: options.configPath }),
    );
    if (options.statsDbPath) config.stats.dbPath = options.statsDbPath;
    const runtime = new WebAgentRuntime(
      config,
      workingDirectory,
      options.projectStoragePath,
      options.configPath,
      options.sessionsDirectory,
    );
    await runtime.initialize();
    return runtime;
  }

  private async initialize(): Promise<void> {
    await this.projects.initialize();
    const projectStoreWasEmpty = this.projects.listProjects({ includeArchived: true }).length === 0;
    const defaultProject = await this.projects.ensureDefaultProject(this.workingDirectory);
    if (projectStoreWasEmpty) {
      await this.importLegacySessions(defaultProject);
    }

    try {
      this.providerRegistry = await ProviderRegistry.fromConfig(this.config);
      this.provider =
        this.providerRegistry.getActiveProviderId() !== null
          ? this.providerRegistry.getActive()
          : null;
      if (!this.provider) {
        this.initializationError =
          '未配置 LLM Provider。请设置 PERSONAL_AGENT_OPENAI_API_KEY、PERSONAL_AGENT_ANTHROPIC_API_KEY，或在配置文件中启用 Ollama。';
      }
    } catch (error) {
      this.initializationError = formatError(error);
      log.error('Provider initialization failed:', this.initializationError);
    }

    if (this.config.memory.enabled) {
      try {
        this.memoryStore = new FileSystemMemoryStore({
          maxEntries: this.config.memory.maxEntries,
        });
        await this.memoryStore.initialize();
        this.registerMemoryTools();
      } catch (error) {
        log.warn(`Memory initialization failed: ${formatError(error)}`);
        this.memoryStore = null;
      }
    }

    if (this.config.plugins.enabled) {
      await this.pluginLoader.loadAll();
    }

    this.registerPlanTools();

    for (const serverConfig of this.config.mcp.servers) {
      try {
        await this.mcpManager.connect(serverConfig);
        for (const toolName of serverConfig.autoApprove ?? []) {
          this.permissionManager.addRule({
            tool:
              toolName === '*'
                ? `mcp__${serverConfig.name}__*`
                : `mcp__${serverConfig.name}__${toolName}`,
            action: 'allow',
            scope: 'session',
          });
        }
      } catch (error) {
        log.warn(`MCP server '${serverConfig.name}' failed: ${formatError(error)}`);
      }
    }
    this.pluginLoader.registerTools(this.toolRegistry);
  }

  private async importLegacySessions(project: { id: string; rootPath: string }): Promise<void> {
    const manager = new SessionManager(
      project.rootPath,
      'unknown',
      'unknown',
      this.sessionsDirectory,
    );
    const sessions = await manager.listSessions();
    const matchingSessions = sessions.filter((session) =>
      isSameWorkspace(session.workingDirectory, project.rootPath),
    );
    for (const session of matchingSessions) {
      await this.projects.createTask({
        projectId: project.id,
        title: `${session.provider || 'agent'} · ${session.id.slice(0, 8)}`,
        sessionId: session.id,
      });
    }
    if (matchingSessions.length > 0) {
      log.info(`Imported ${matchingSessions.length} legacy sessions into the default project`);
    }
  }

  createConversation(
    emit: RuntimeEmitter,
    requestPermission: PermissionRequester,
    workingDirectory = this.workingDirectory,
  ): WebConversation {
    if (!this.provider) {
      throw new Error(this.initializationError ?? 'No LLM provider configured');
    }
    const conversation = new WebConversation(
      this,
      this.provider,
      emit,
      requestPermission,
      workingDirectory,
      this.sessionsDirectory,
    );
    this.attachConversation(conversation);
    return conversation;
  }

  attachConversation(conversation: WebConversation): void {
    this.conversations.set(conversation.sessionId, conversation);
  }

  detachConversation(conversation: WebConversation, previousId?: string): void {
    const id = previousId ?? conversation.sessionId;
    if (this.conversations.get(id) === conversation) this.conversations.delete(id);
  }

  getRuntimeInfo(): RuntimeInfo {
    const providers = this.providerRegistry?.listAll() ?? [];
    return {
      configured: this.provider !== null,
      initializationError: this.initializationError,
      provider: this.provider?.providerId,
      providerName: this.provider?.displayName,
      model: this.provider?.getModel(),
      models: providers.flatMap((provider) =>
        provider.getModelList().map((model) => {
          const providerId = provider.providerId as ProviderId;
          const reasoningSupported = supportsRuntimeReasoning(providerId, model);
          return {
            id: model.id,
            displayName: model.displayName,
            provider: provider.providerId,
            providerName: provider.displayName,
            reasoningSupported,
            reasoningEffort: reasoningSupported
              ? resolveProviderReasoningEffort(providerId, this.config.providers[providerId])
              : 'off',
            reasoningOptions: reasoningSupported
              ? reasoningOptionsForProvider(providerId)
              : ['off'],
          };
        }),
      ),
      reasoningSupported: this.provider
        ? supportsRuntimeReasoning(
            this.provider.providerId as ProviderId,
            this.provider.getModelList().find((model) => model.id === this.provider?.getModel()),
          )
        : false,
      reasoningEffort: this.getReasoningEffort(),
      workingDirectory: this.workingDirectory,
      toolCount: this.toolRegistry.listAll().length,
      plugins: this.pluginLoader.getLoadedPlugins().map((plugin) => ({
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        skills: plugin.skills.length,
        tools: plugin.tools.length,
      })),
      mcpServers: this.mcpManager.listServers(),
      memoryEnabled: this.memoryStore !== null,
    };
  }

  getProviderSettings(): ProviderSettingsInfo {
    const providerIds: ProviderId[] = ['anthropic', 'openai', 'ollama', 'deepseek', 'volcano'];
    const providers = Object.fromEntries(
      providerIds.map((id) => {
        const defaults = getProviderDefaults(id);
        const configured = this.config.providers[id];
        const requiresApiKey = id !== 'ollama';
        const configuredRecord = (configured ?? {}) as Record<string, unknown>;
        const hasApiKey = Boolean(configuredRecord.apiKey);
        return [
          id,
          {
            configured: id === 'ollama' ? Boolean(configured) : hasApiKey,
            hasApiKey,
            requiresApiKey,
            baseURL: configured?.baseURL ?? defaults.baseURL,
            defaultModel: configured?.defaultModel ?? defaults.defaultModel,
            models: normalizeModelList(
              configured?.models ?? defaults.models,
              configured?.defaultModel ?? defaults.defaultModel,
            ),
            thinkingEffort:
              configured?.thinkingEffort ??
              (id === 'deepseek' || id === 'volcano' ? defaults.thinkingEffort : 'off'),
            reasoningSupported: id === 'deepseek' || id === 'volcano',
          },
        ];
      }),
    ) as ProviderSettingsInfo['providers'];

    return {
      active: (this.provider?.providerId ?? this.config.providers.active) as ProviderId | undefined,
      configPath: resolveWritableConfigPath(this.configPath),
      providers,
    };
  }

  async configureProvider(input: ProviderSettingsInput): Promise<void> {
    if ([...this.conversations.values()].some((conversation) => conversation.isBusy)) {
      throw new Error('Agent 正在运行，请等待当前请求完成后再切换模型。');
    }

    const apiKey = input.apiKey?.trim();
    const baseURL = normalizeProviderBaseURL(input.provider, input.baseURL);
    const defaults = getProviderDefaults(input.provider);
    const defaultModel = normalizeProviderModel(
      input.provider,
      input.defaultModel?.trim() || defaults.defaultModel,
    );
    const models = normalizeModelList(
      (input.models ?? defaults.models).map((model) =>
        typeof model === 'string'
          ? normalizeProviderModel(input.provider, model)
          : { ...model, id: normalizeProviderModel(input.provider, model.id) },
      ),
      defaultModel,
    );
    const thinkingEffort = normalizeRuntimeReasoningEffort(
      input.provider,
      input.provider === 'deepseek' || input.provider === 'volcano'
        ? (input.thinkingEffort ?? defaults.thinkingEffort)
        : 'off',
    );
    const nextConfigValue = structuredClone(this.config) as unknown as Record<string, unknown>;
    const providers = nextConfigValue.providers as Record<string, unknown>;
    const current =
      providers[input.provider] &&
      typeof providers[input.provider] === 'object' &&
      !Array.isArray(providers[input.provider])
        ? { ...(providers[input.provider] as Record<string, unknown>) }
        : {};

    const shouldActivate = input.activate !== false || this.provider === null;
    const shouldPersistActive = shouldActivate || !providers.active;
    if (shouldPersistActive) providers.active = input.provider;
    if (apiKey) current.apiKey = apiKey;
    if (baseURL) current.baseURL = baseURL;
    else delete current.baseURL;
    current.defaultModel = defaultModel;
    current.models = models;
    current.thinkingEffort = thinkingEffort;
    providers[input.provider] = current;

    if (input.provider !== 'ollama' && !current.apiKey) {
      throw new Error(`${providerLabel(input.provider)} 需要 API Key。`);
    }

    const nextConfig = appConfigSchema.parse(nextConfigValue);
    const nextRegistry = await ProviderRegistry.fromConfig(nextConfig);
    const savedProvider = nextRegistry.get(input.provider);
    if (!savedProvider) {
      await nextRegistry.disposeAll();
      throw new Error(`无法启用 ${providerLabel(input.provider)}。`);
    }
    if (shouldActivate) nextRegistry.setActive(input.provider);
    const nextProvider =
      nextRegistry.getActiveProviderId() !== null ? nextRegistry.getActive() : savedProvider;

    try {
      await saveProviderSettings(
        {
          provider: input.provider,
          activate: shouldPersistActive,
          apiKey: apiKey || undefined,
          baseURL: baseURL || null,
          defaultModel,
          models,
          thinkingEffort,
        },
        this.configPath,
      );
    } catch (error) {
      await nextRegistry.disposeAll();
      throw error;
    }

    const previousRegistry = this.providerRegistry;
    this.config = nextConfig;
    this.providerRegistry = nextRegistry;
    this.provider = nextProvider;
    this.initializationError = undefined;

    for (const conversation of this.conversations.values()) {
      await conversation.replaceProvider(nextProvider);
    }
    await previousRegistry?.disposeAll();
  }

  async removeProvider(providerId: ProviderId): Promise<void> {
    if ([...this.conversations.values()].some((conversation) => conversation.isBusy)) {
      throw new Error('Agent 正在运行，请等待当前请求完成后再删除模型供应商。');
    }
    if (!this.getProviderSettings().providers[providerId].configured) {
      throw new Error(`${providerLabel(providerId)} 尚未配置。`);
    }

    const nextConfigValue = structuredClone(this.config) as unknown as Record<string, unknown>;
    const providers = nextConfigValue.providers as Record<string, unknown>;
    delete providers[providerId];
    if (providers.active === providerId) delete providers.active;

    const preliminaryConfig = appConfigSchema.parse(nextConfigValue);
    const nextRegistry = await ProviderRegistry.fromConfig(preliminaryConfig);
    const nextProvider =
      nextRegistry.getActiveProviderId() !== null ? nextRegistry.getActive() : null;
    if (nextProvider) providers.active = nextProvider.providerId;
    else delete providers.active;
    const nextConfig = appConfigSchema.parse(nextConfigValue);

    try {
      await removeProviderSettings(
        providerId,
        nextProvider?.providerId as ProviderId | undefined,
        this.configPath,
      );
    } catch (error) {
      await nextRegistry.disposeAll();
      throw error;
    }

    const previousRegistry = this.providerRegistry;
    this.config = nextConfig;
    this.providerRegistry = nextRegistry;
    this.provider = nextProvider;
    this.initializationError = nextProvider
      ? undefined
      : '未配置 LLM Provider。请在设置中添加一个模型供应商。';

    if (nextProvider) {
      for (const conversation of this.conversations.values()) {
        await conversation.replaceProvider(nextProvider);
      }
    }
    await previousRegistry?.disposeAll();
  }

  async configureRuntimeModel(input: RuntimeModelSettingsInput): Promise<void> {
    if ([...this.conversations.values()].some((conversation) => conversation.isBusy)) {
      throw new Error('Agent 正在运行，请等待当前请求完成后再切换模型。');
    }
    if (!this.provider) throw new Error(this.initializationError ?? '未配置 LLM Provider。');
    if (!this.providerRegistry)
      throw new Error(this.initializationError ?? '未配置 LLM Provider。');
    const registry = this.providerRegistry;

    const model = input.model.trim();
    if (!model) throw new Error('模型 ID 不能为空。');
    const providerId = input.provider ?? (this.provider.providerId as ProviderId);
    const provider = registry.get(providerId);
    if (!provider) throw new Error(`${providerLabel(providerId)} 尚未配置或不可用。`);
    const modelInfo = provider.getModelList().find((candidate) => candidate.id === model);
    if (!modelInfo) {
      throw new Error(`模型 ${model} 不在当前供应商的已配置模型列表中。`);
    }

    const current = this.config.providers[providerId];
    if (!current) throw new Error('当前供应商配置不存在。');
    const reasoningSupported = supportsRuntimeReasoning(providerId, modelInfo);
    const reasoningEffort = reasoningSupported
      ? normalizeRuntimeReasoningEffort(
          providerId,
          input.reasoningEffort ?? resolveProviderReasoningEffort(providerId, current),
        )
      : 'off';
    const nextConfigValue = structuredClone(this.config);
    const nextProviderConfig = nextConfigValue.providers[providerId];
    if (!nextProviderConfig) throw new Error('当前供应商配置不存在。');
    nextProviderConfig.defaultModel = model;
    nextProviderConfig.thinkingEffort = reasoningEffort;
    nextConfigValue.providers.active = providerId;
    const nextConfig = appConfigSchema.parse(nextConfigValue);

    await saveProviderSettings(
      {
        provider: providerId,
        activate: true,
        defaultModel: model,
        thinkingEffort: reasoningEffort,
      },
      this.configPath,
    );

    this.config = nextConfig;
    provider.setModel(model);
    registry.setActive(providerId);
    this.provider = provider;
    for (const conversation of this.conversations.values()) {
      await conversation.replaceProvider(provider);
    }
  }

  getReasoningEffort(): ReasoningEffort {
    if (!this.provider) return 'off';
    const provider = this.config.providers[this.provider.providerId as ProviderId];
    return resolveProviderReasoningEffort(this.provider.providerId as ProviderId, provider);
  }

  async listSessions(): Promise<SessionSummary[]> {
    if (!this.provider) return [];
    const manager = new SessionManager(
      this.workingDirectory,
      this.provider.getModel(),
      this.provider.providerId,
      this.sessionsDirectory,
    );
    const sessions = await manager.listSessions();
    return sessions.map((session) => ({
      ...session,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    }));
  }

  async injectPromptContext(conversation: WebConversation, userInput: string): Promise<void> {
    conversation.context.removeSection('automatic-memory-context');
    conversation.context.removeSection('active-plugin-skills');

    if (this.memoryStore) {
      try {
        const memory = await this.memoryStore.getRelevantContext(userInput, 2000);
        if (memory) {
          conversation.context.addSection({
            name: 'automatic-memory-context',
            priority: 6,
            content: `## Remembered Context\n\n${memory}`,
          });
        }
      } catch (error) {
        log.warn(`Memory injection failed: ${formatError(error)}`);
      }
    }

    const skills = this.pluginLoader.findSkills(userInput);
    if (skills.length > 0) {
      conversation.context.addSection({
        name: 'active-plugin-skills',
        priority: 7,
        content: skills.map((skill) => `## Skill: ${skill.name}\n\n${skill.content}`).join('\n\n'),
      });
    }
  }

  async executeTool(
    conversation: WebConversation,
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    await this.pluginLoader.dispatchHook('on_tool_execute', {
      sessionId: conversation.sessionId,
      toolName: name,
      input,
    });
    const context: ToolContext = {
      sessionId: conversation.sessionId,
      workingDirectory: conversation.workingDirectory,
      signal,
    };
    const result = await this.toolExecutor.executeWithPermission(name, input, context, true);
    await this.pluginLoader.dispatchHook('on_tool_result', {
      sessionId: conversation.sessionId,
      toolName: name,
      input,
      result,
    });
    return result;
  }

  async requestToolPermission(
    conversation: WebConversation,
    toolName: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const mode = conversation.getPermissionMode();
    if (mode === 'allow') return true;

    const remembered = conversation.getRememberedPermission(toolName);
    if (remembered !== undefined) return remembered;

    const tool = this.toolRegistry.get(toolName);
    if (mode === 'approval') {
      const answer = await conversation.askPermission(toolName, params, signal);
      if (answer.remember) conversation.rememberPermission(toolName, answer.approved);
      return answer.approved;
    }

    const configured = this.permissionManager.check(toolName, params);
    if (configured === 'allow') return true;
    if (configured === 'ask' && tool && !tool.requiresPermission && !tool.isDangerous) {
      return true;
    }

    const answer = await conversation.askPermission(toolName, params, signal);
    if (answer.remember) conversation.rememberPermission(toolName, answer.approved);
    return answer.approved;
  }

  async dispatchUserInput(conversation: WebConversation, input: string): Promise<void> {
    await this.pluginLoader.dispatchHook('on_user_input', {
      sessionId: conversation.sessionId,
      input,
    });
  }

  async dispatchSessionStart(conversation: WebConversation): Promise<void> {
    await this.pluginLoader.dispatchHook('on_session_start', {
      sessionId: conversation.sessionId,
      workingDirectory: conversation.workingDirectory,
    });
  }

  async dispatchSessionEnd(conversation: WebConversation): Promise<void> {
    await this.pluginLoader.dispatchHook('on_session_end', {
      sessionId: conversation.sessionId,
    });
  }

  getToolDefinitions() {
    return this.toolRegistry.listDefinitions();
  }

  async dispose(): Promise<void> {
    for (const conversation of [...this.conversations.values()]) {
      await conversation.close();
    }
    await this.mcpManager.disconnectAll();
    await this.providerRegistry?.disposeAll();
    this.statsStore?.close();
  }

  private registerMemoryTools(): void {
    const store = this.memoryStore;
    if (!store) return;

    this.toolRegistry.register(
      new (class extends BaseTool {
        readonly name = 'read_memory';
        readonly description = 'Search persistent memory for relevant facts and preferences.';
        readonly category = 'memory' as const;
        readonly inputSchema = {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search query' } },
          required: ['query'],
        };

        async execute(params: Record<string, unknown>): Promise<ToolResult> {
          const results = await store.search(String(params.query), { maxResults: 5 });
          return {
            success: true,
            content:
              results.map(({ entry }) => `[${entry.type}] ${entry.content}`).join('\n') ||
              '(no relevant memories found)',
          };
        }
      })(),
    );

    this.toolRegistry.register(
      new (class extends BaseTool {
        readonly name = 'write_memory';
        readonly description = 'Persist a fact, preference, or decision for later conversations.';
        readonly category = 'memory' as const;
        readonly requiresPermission = true;
        readonly inputSchema = {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Content to remember' },
            type: {
              type: 'string',
              enum: ['fact', 'preference', 'decision'],
              description: 'Memory type',
            },
            importance: { type: 'number', description: '1=critical, 2=important, 3=info' },
          },
          required: ['content'],
        };

        async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
          const importance = Number(params.importance ?? 2);
          if (![1, 2, 3].includes(importance)) {
            return { success: false, content: '', error: 'importance must be 1, 2, or 3' };
          }
          const entry = await store.create({
            type: (params.type as 'fact' | 'preference' | 'decision') ?? 'fact',
            content: String(params.content),
            tags: [],
            metadata: {
              importance: importance as 1 | 2 | 3,
              sourceSessionId: context.sessionId,
            },
          });
          return { success: true, content: `Memory saved: ${entry.id}` };
        }
      })(),
    );
  }

  private registerPlanTools(): void {
    const findConversation = (context: ToolContext): WebConversation | null =>
      this.conversations.get(context.sessionId) ?? null;

    this.toolRegistry.register(
      new (class extends BaseTool {
        readonly name = 'submit_plan';
        readonly description =
          'Submit a structured implementation plan for user approval, including dependencies and risks.';
        readonly category = 'plan' as const;
        readonly inputSchema = {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            risks: { type: 'array', items: { type: 'string' } },
            estimated_tokens: { type: 'number' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  tool_calls: { type: 'array', items: { type: 'string' } },
                  dependencies: { type: 'array', items: { type: 'string' } },
                },
                required: ['title', 'description'],
              },
            },
          },
          required: ['title', 'steps'],
        };

        async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
          const conversation = findConversation(context);
          if (!conversation?.planModeActive) {
            return {
              success: false,
              content: '',
              error: 'submit_plan is only available in plan mode',
            };
          }
          const rawSteps = Array.isArray(params.steps) ? params.steps : [];
          const plan = conversation.planEngine.createPlan({
            title: String(params.title ?? ''),
            description: String(params.description ?? ''),
            risks: Array.isArray(params.risks) ? params.risks.map(String) : [],
            estimatedTokens: Number(params.estimated_tokens ?? 0),
            steps: rawSteps.map((raw, index) => {
              const step = raw as Record<string, unknown>;
              return {
                id: String(step.id ?? `step-${index + 1}`),
                title: String(step.title ?? ''),
                description: String(step.description ?? ''),
                toolCalls: Array.isArray(step.tool_calls) ? step.tool_calls.map(String) : [],
                dependencies: Array.isArray(step.dependencies) ? step.dependencies.map(String) : [],
              };
            }),
          });
          conversation.publishPlan();
          return { success: true, content: formatPlan(plan) };
        }
      })(),
    );

    this.toolRegistry.register(
      new (class extends BaseTool {
        readonly name = 'get_plan';
        readonly description = 'Get the current structured plan and progress.';
        readonly category = 'plan' as const;
        readonly inputSchema = { type: 'object', properties: {} };

        async execute(_params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
          const plan = findConversation(context)?.planEngine.getPlan();
          return { success: true, content: plan ? formatPlan(plan) : 'No active plan.' };
        }
      })(),
    );

    this.toolRegistry.register(
      new (class extends BaseTool {
        readonly name = 'update_plan_step';
        readonly description = 'Update an approved plan step as execution progresses.';
        readonly category = 'plan' as const;
        readonly inputSchema = {
          type: 'object',
          properties: {
            step_id: { type: 'string' },
            status: {
              type: 'string',
              enum: ['in_progress', 'completed', 'failed', 'skipped'],
            },
            output: { type: 'string' },
          },
          required: ['step_id', 'status'],
        };

        async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
          const conversation = findConversation(context);
          if (!conversation) {
            return { success: false, content: '', error: 'Conversation not found' };
          }
          const stepId = String(params.step_id);
          const status = String(params.status);
          const output = params.output === undefined ? undefined : String(params.output);
          const step =
            status === 'in_progress'
              ? await conversation.planEngine.startStep(stepId)
              : status === 'completed'
                ? await conversation.planEngine.completeStep(stepId, output)
                : status === 'failed'
                  ? await conversation.planEngine.failStep(stepId, output)
                  : status === 'skipped'
                    ? await conversation.planEngine.skipStep(stepId)
                    : null;
          conversation.publishPlan();
          return step
            ? {
                success: true,
                content: `Step ${step.id} is ${step.status}. Progress: ${conversation.planEngine.getProgress().percentage}%`,
              }
            : { success: false, content: '', error: `Unknown step/status: ${stepId}/${status}` };
        }
      })(),
    );
  }
}

export class WebConversation {
  context!: ContextAssembler;
  planEngine!: PlanModeEngine;
  planModeActive = false;

  private session!: SessionManager;
  private agentLoop!: AgentLoop;
  private tokenBudget!: TokenBudget;
  private busy = false;
  private closed = false;
  private rememberedPermissions = new Map<string, boolean>();
  private permissionMode: PermissionMode = 'ask';
  private statsRecorder: ModelRequestRecorder | null = null;

  constructor(
    private runtime: WebAgentRuntime,
    private provider: LLMProvider,
    private emit: RuntimeEmitter,
    private permissionRequester: PermissionRequester,
    public workingDirectory: string,
    private sessionsDirectory?: string,
  ) {
    this.createState();
  }

  get sessionId(): string {
    return this.session.getSessionId();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  async start(): Promise<void> {
    await this.session.ensureDir();
    await this.runtime.dispatchSessionStart(this);
    this.publishPlan();
  }

  async runPrompt(input: string): Promise<void> {
    if (this.closed) throw new Error('Conversation is closed');
    if (this.busy) throw new Error('Agent 正在处理上一条消息');

    this.busy = true;
    this.emit({ type: 'busy', busy: true });
    try {
      await this.runtime.dispatchUserInput(this, input);
      await this.runtime.injectPromptContext(this, input);
      for await (const event of this.agentLoop.run(input)) {
        this.forwardAgentEvent(event);
      }
      this.session.replaceMessages(this.context.getHistory());
      const usage = this.agentLoop.getTotalUsage();
      this.session.addTokensUsed(usage.inputTokens, usage.outputTokens);
      const lastUsage = this.agentLoop.getLastUsage();
      if (lastUsage) this.session.setLastInputTokens(lastUsage.inputTokens);
      this.session.incrementTurnCount();
      this.publishContextUsage();
    } finally {
      try {
        await this.checkpoint();
      } catch (error) {
        log.error(`Session checkpoint failed: ${formatError(error)}`);
        this.emit({
          type: 'error',
          message: `会话保存失败：${formatError(error)}`,
          code: 'SESSION_SAVE_FAILED',
        });
      } finally {
        this.busy = false;
        this.emit({ type: 'busy', busy: false });
        this.publishPlan();
      }
    }
  }

  interrupt(): void {
    if (this.busy) this.agentLoop.interrupt();
  }

  async checkpoint(): Promise<void> {
    this.session.replaceMessages(this.context.getHistory());
    await this.session.save();
  }

  /**
   * Manually compact the conversation context: older messages are replaced by
   * an LLM-generated semantic summary while the recent turns are preserved.
   * The compacted history is persisted and pushed to the client (timeline +
   * context usage refresh).
   */
  async compressContext(): Promise<void> {
    this.assertIdle();
    const history = this.context.getHistory();
    const compacted = await this.tokenBudget.compact(history);
    this.context.clearHistory();
    for (const msg of compacted.filter((m) => m.role !== 'system')) {
      this.context.addMessage(msg);
    }
    await this.checkpoint();
    this.emit({
      type: 'history',
      sessionId: this.sessionId,
      messages: this.context.getHistory(),
    });
    this.publishContextUsage();
  }

  async newSession(): Promise<void> {
    this.assertIdle();
    const previousId = this.sessionId;
    if (this.context.getHistory().length > 0) {
      this.session.replaceMessages(this.context.getHistory());
      await this.session.save();
    }
    await this.runtime.dispatchSessionEnd(this);
    this.runtime.detachConversation(this, previousId);
    this.createState();
    await this.session.ensureDir();
    this.runtime.attachConversation(this);
    await this.runtime.dispatchSessionStart(this);
    this.emit({ type: 'session_changed', sessionId: this.sessionId, isNew: true });
    this.emit({ type: 'history', sessionId: this.sessionId, messages: [] });
    this.publishPlan();
  }

  async restoreSession(sessionId: string): Promise<boolean> {
    this.assertIdle();
    const previousId = this.sessionId;
    const restored = await this.session.restore(sessionId);
    if (!restored) return false;
    this.runtime.detachConversation(this, previousId);
    this.context.replaceHistory(this.session.getMessages());
    this.planEngine.clearPlan();
    this.planModeActive = false;
    this.context.setMode('chat');
    this.runtime.attachConversation(this);
    this.emit({ type: 'session_changed', sessionId: this.sessionId, isNew: false });
    this.emit({
      type: 'history',
      sessionId: this.sessionId,
      messages: this.session.getMessages(),
    });
    this.publishPlan();
    this.publishContextUsage();
    return true;
  }

  async switchWorkspace(workingDirectory: string, sessionId?: string): Promise<boolean> {
    this.assertIdle();
    const previousId = this.sessionId;
    if (this.context.getHistory().length > 0) {
      this.session.replaceMessages(this.context.getHistory());
      await this.session.save();
    }
    await this.runtime.dispatchSessionEnd(this);
    this.runtime.detachConversation(this, previousId);
    this.workingDirectory = resolve(workingDirectory);
    this.createState();
    await this.session.ensureDir();
    const restored = sessionId ? await this.session.restore(sessionId) : false;
    if (restored) {
      this.context.replaceHistory(this.session.getMessages());
    }
    this.runtime.attachConversation(this);
    await this.runtime.dispatchSessionStart(this);
    this.emit({ type: 'session_changed', sessionId: this.sessionId, isNew: !restored });
    this.emit({
      type: 'history',
      sessionId: this.sessionId,
      messages: this.context.getHistory(),
    });
    this.publishPlan();
    return restored;
  }

  async replaceProvider(provider: LLMProvider): Promise<void> {
    this.assertIdle();
    const history = this.context.getHistory();
    this.provider = provider;
    this.session.updateProvider(provider.getModel(), provider.providerId);
    this.createAgentState(history);
    if (history.length > 0) {
      this.session.replaceMessages(history);
      await this.session.save();
    }
    this.emit({
      type: 'notice',
      message: `模型已切换为 ${provider.displayName} · ${provider.getModel()}`,
    });
    this.publishPlan();
  }

  setPlanMode(enabled: boolean): Plan | null {
    this.assertIdle();
    this.planModeActive = enabled;
    this.context.setMode(enabled ? 'plan' : 'chat');
    this.context.removeSection('web-plan-mode');
    this.context.removeSection('plan-execution');

    if (enabled) {
      this.planEngine.clearPlan();
      this.context.addSection({
        name: 'web-plan-mode',
        priority: 2,
        content: `## Plan Mode (READ-ONLY)

Inspect the project with read-only tools, create a detailed plan, and call submit_plan.
Do not execute changes until the user approves the plan in the Web UI.`,
      });
    } else {
      const approved = this.planEngine.approvePlan();
      if (approved) {
        this.context.addSection({
          name: 'plan-execution',
          priority: 5,
          content: `## Approved Plan

${formatPlan(approved)}

Execute in dependency order and use update_plan_step to report progress.`,
        });
      }
    }
    this.publishPlan();
    return this.planEngine.getPlan();
  }

  publishPlan(): void {
    this.emit({
      type: 'plan',
      active: this.planModeActive,
      plan: this.planEngine.getPlan(),
      progress: this.planEngine.getProgress(),
    });
  }

  askPermission(
    toolName: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ approved: boolean; remember?: boolean }> {
    return this.permissionRequester(toolName, params, signal);
  }

  rememberPermission(toolName: string, approved: boolean): void {
    this.rememberedPermissions.set(toolName, approved);
  }

  getRememberedPermission(toolName: string): boolean | undefined {
    return this.rememberedPermissions.get(toolName);
  }

  setPermissionMode(mode: PermissionMode): void {
    this.assertIdle();
    this.permissionMode = mode;
    this.rememberedPermissions.clear();
    this.publishPermissionMode();
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  publishPermissionMode(): void {
    this.emit({ type: 'permission_mode', mode: this.permissionMode });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    if (!this.busy) await this.checkpoint();
    await this.runtime.dispatchSessionEnd(this);
    this.runtime.detachConversation(this);
  }

  private createState(): void {
    this.permissionMode = 'ask';
    this.session = new SessionManager(
      this.workingDirectory,
      this.provider.getModel(),
      this.provider.providerId,
      this.sessionsDirectory,
    );
    this.createAgentState();
  }

  private createAgentState(history: ReturnType<ContextAssembler['getHistory']> = []): void {
    this.context = new ContextAssembler({
      workingDirectory: this.workingDirectory,
      platform: `${process.platform} ${process.arch}`,
      model: this.provider.getModel(),
      provider: this.provider.providerId,
      mode: 'chat',
    });
    this.planEngine = new PlanModeEngine();
    this.statsRecorder = this.runtime.statsStore
      ? new ModelRequestRecorder(this.runtime.statsStore, () => this.sessionId)
      : null;
    this.planModeActive = false;
    this.rememberedPermissions.clear();
    this.tokenBudget = new TokenBudget(
      resolveContextWindow(this.provider),
      TOKEN_BUDGET_RESERVED_OUTPUT,
      createLlmContextSummarizer(this.provider),
    );
    this.agentLoop = new AgentLoop({
      provider: this.provider,
      contextAssembler: this.context,
      tokenBudget: this.tokenBudget,
      toolDefinitions: this.runtime.getToolDefinitions(),
      getExposedToolDefinitions: () => {
        const definitions = this.runtime.getToolDefinitions();
        return this.planModeActive
          ? definitions.filter((definition) => PLAN_MODE_TOOLS.has(definition.name))
          : definitions;
      },
      isToolBlocked: (name) => this.planModeActive && !PLAN_MODE_TOOLS.has(name),
      maxTurns: this.runtime.config.agent.maxTurns,
      executeTool: (name, input, signal) => this.runtime.executeTool(this, name, input, signal),
      requestPermission: (name, params, signal) =>
        this.runtime.requestToolPermission(this, name, params, signal),
      streamOptions: {
        temperature: this.runtime.config.agent.temperature,
        maxTokens: this.runtime.config.agent.maxTokens,
        reasoningEffort: this.runtime.getReasoningEffort(),
      },
      onModelCallStart: (call) => {
        this.statsRecorder?.onModelCallStart(call);
        this.emit({ type: 'llm_call_start', call });
      },
      onModelCallEnd: (call) => {
        this.statsRecorder?.onModelCallEnd(call);
        this.emit({ type: 'llm_call_end', call });
        // 每次模型请求结束立即刷新“已使用上下文”：即使一次任务执行中
        // 会循环调用多次模型，UI 上的 token 数也能实时更新。
        if (call.status === 'completed' && call.response.usage) {
          this.session.setLastInputTokens(call.response.usage.inputTokens);
          this.publishContextUsage();
        }
      },
    });
    if (history.length > 0) this.context.replaceHistory(history);
    this.publishContextUsage();
  }

  /**
   * Push the current conversation's context usage to the client.
   * "Used" tokens reflect the input tokens of the most recent model request,
   * i.e. the exact context size the last request was sent with.
   */
  private publishContextUsage(): void {
    try {
      // Use the API-reported input token count of the most recent model
      // request, instead of a cumulative total or a local character-based
      // estimate.
      const usedTokens = this.session.getLastInputTokens();
      const totalTokens = resolveContextWindow(this.provider);
      const percentage =
        totalTokens > 0 ? Math.min(100, Math.round((usedTokens / totalTokens) * 100)) : 0;
      const usage: ContextUsage = {
        usedTokens,
        totalTokens,
        reservedOutputTokens: TOKEN_BUDGET_RESERVED_OUTPUT,
        percentage,
      };
      this.emit({ type: 'context_usage', usage });
    } catch (error) {
      log.warn(`Failed to compute context usage: ${formatError(error)}`);
    }
  }

  private forwardAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'turn_start':
        this.emit(event);
        break;
      case 'assistant_thinking_delta':
        this.emit({
          type: 'thinking_delta',
          thinking: event.thinkingDelta,
          turnNumber: event.turnNumber,
        });
        break;
      case 'assistant_text_delta':
        this.emit({
          type: 'assistant_delta',
          text: event.textDelta,
          turnNumber: event.turnNumber,
        });
        break;
      case 'tool_call_start':
        this.emit({
          type: 'tool_start',
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          turnNumber: event.turnNumber,
        });
        break;
      case 'tool_call_progress':
        this.emit({
          type: 'tool_progress',
          toolCallId: event.toolCallId,
          content: event.content,
          turnNumber: event.turnNumber,
        });
        break;
      case 'tool_call_end':
        this.emit({
          type: 'tool_end',
          toolCallId: event.toolCallId,
          result: event.result,
          turnNumber: event.turnNumber,
        });
        break;
      case 'turn_end':
      case 'done':
      case 'interrupted':
        this.emit(event);
        this.publishContextUsage();
        break;
      case 'permission_request':
        break;
      case 'error':
        this.emit({ type: 'error', message: event.error.message, code: 'AGENT_ERROR' });
        break;
    }
  }

  private assertIdle(): void {
    if (this.busy) throw new Error('请先停止当前生成，再切换会话或模式');
  }
}

function getProviderDefaults(provider: ProviderId): {
  baseURL: string;
  defaultModel: string;
  models: string[];
  thinkingEffort: ReasoningEffort;
} {
  switch (provider) {
    case 'anthropic':
      return {
        baseURL: '',
        defaultModel: 'claude-sonnet-5-20251001',
        models: ['claude-sonnet-5-20251001', 'claude-opus-5-20251001', 'claude-fable-5-20251001'],
        thinkingEffort: 'off',
      };
    case 'openai':
      return {
        baseURL: '',
        defaultModel: 'gpt-4o',
        models: ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'o4-mini'],
        thinkingEffort: 'off',
      };
    case 'ollama':
      return {
        baseURL: 'http://localhost:11434',
        defaultModel: 'llama3.1',
        models: ['llama3.1'],
        thinkingEffort: 'off',
      };
    case 'deepseek':
      return {
        baseURL: 'https://api.deepseek.com',
        defaultModel: 'deepseek-v4-flash',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
        thinkingEffort: 'high',
      };
    case 'volcano':
      return {
        baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
        defaultModel: 'doubao-seed-1-6-250615',
        models: [
          'doubao-seed-1-6-250615',
          'doubao-1-5-pro-32k-250115',
          'doubao-seed-thinking-250615',
          'deepseek-v3-250324',
          'deepseek-r1-250528',
        ],
        thinkingEffort: 'off',
      };
  }
}

function supportsRuntimeReasoning(providerId: ProviderId, model?: ModelInfo): boolean {
  return (
    (providerId === 'deepseek' || providerId === 'volcano') &&
    Boolean(model?.features.includes(ProviderFeature.Thinking))
  );
}

function reasoningOptionsForProvider(providerId: ProviderId): ReasoningEffort[] {
  if (providerId === 'deepseek') return ['off', 'high', 'max'];
  if (providerId === 'volcano') return ['off', 'low', 'medium', 'high'];
  return ['off'];
}

function resolveProviderReasoningEffort(
  providerId: ProviderId,
  providerConfig: AppConfig['providers'][ProviderId],
): ReasoningEffort {
  if (providerId !== 'deepseek' && providerId !== 'volcano') return 'off';
  const fallback = providerId === 'deepseek' ? 'high' : 'off';
  return normalizeRuntimeReasoningEffort(providerId, providerConfig?.thinkingEffort ?? fallback);
}

function normalizeRuntimeReasoningEffort(
  providerId: ProviderId,
  effort: ReasoningEffort,
): ReasoningEffort {
  if (providerId === 'deepseek') {
    if (effort === 'off' || effort === 'max') return effort;
    return 'high';
  }
  if (providerId === 'volcano') {
    // Volcano Ark exposes low/medium/high; 'max' is not supported.
    if (effort === 'max') return 'high';
    return effort;
  }
  return 'off';
}

function normalizeModelList(
  models: Array<string | ModelConfig>,
  defaultModel: string,
): Array<string | ModelConfig> {
  const normalized: Array<string | ModelConfig> = [];
  const seen = new Set<string>();
  const push = (id: string, config?: ModelConfig): void => {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    normalized.push(config ? { ...config, id: trimmed } : trimmed);
  };
  push(defaultModel);
  for (const model of models) {
    if (typeof model === 'string') push(model);
    else push(model.id, model);
  }
  return normalized;
}

function normalizeProviderModel(provider: ProviderId, model: string): string {
  if (provider === 'deepseek' && (model === 'deepseek-chat' || model === 'deepseek-reasoner')) {
    return 'deepseek-v4-flash';
  }
  return model;
}

function normalizeRuntimeConfig(config: AppConfig): AppConfig {
  const next = structuredClone(config);
  const deepseek = next.providers.deepseek;
  if (!deepseek) return next;

  const legacyModel = deepseek.defaultModel;
  deepseek.defaultModel = normalizeProviderModel('deepseek', legacyModel ?? 'deepseek-v4-flash');
  deepseek.models = normalizeModelList(
    (deepseek.models ?? ['deepseek-v4-flash', 'deepseek-v4-pro']).map((model) =>
      typeof model === 'string'
        ? normalizeProviderModel('deepseek', model)
        : { ...model, id: normalizeProviderModel('deepseek', model.id) },
    ),
    deepseek.defaultModel,
  );
  deepseek.thinkingEffort ??= legacyModel === 'deepseek-chat' ? 'off' : 'high';
  return next;
}

function normalizeProviderBaseURL(provider: ProviderId, input?: string): string {
  const value = input?.trim() || getProviderDefaults(provider).baseURL;
  if (!value) return '';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Base URL 必须是有效的 HTTP(S) 地址。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL 仅支持 http:// 或 https://。');
  }
  return value.replace(/\/+$/, '');
}

function providerLabel(provider: ProviderId): string {
  return {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    ollama: 'Ollama',
    deepseek: 'DeepSeek',
    volcano: '火山方舟',
  }[provider];
}

function resolveContextWindow(provider: LLMProvider): number {
  return (
    provider.getModelList().find((model) => model.id === provider.getModel())?.contextWindow ??
    128_000
  );
}

function formatPlan(plan: Plan): string {
  const steps = plan.steps
    .map(
      (step) =>
        `${step.order}. [${step.status}] ${step.title}\n   ${step.description}${
          step.dependencies.length > 0 ? `\n   Dependencies: ${step.dependencies.join(', ')}` : ''
        }`,
    )
    .join('\n');
  return `${plan.title}\n${plan.description}\n\n${steps}`;
}

function createRuntimeStatsStore(statsConfig: {
  enabled?: boolean;
  dbPath?: string;
  recordPayloads?: boolean;
}): UsageStore | null {
  if (statsConfig.enabled === false || !UsageStore.isAvailable()) return null;
  try {
    const store = new UsageStore({
      dbPath: statsConfig.dbPath || undefined,
      recordPayloads: statsConfig.recordPayloads,
    });
    store.initialize();
    return store;
  } catch (error) {
    console.warn(`[web] Stats store unavailable: ${formatError(error)}`);
    return null;
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSameWorkspace(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function findWorkspaceRoot(start: string): string {
  let candidate = resolve(start);
  while (true) {
    if (existsSync(join(candidate, 'pnpm-workspace.yaml'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return resolve(start);
    candidate = parent;
  }
}
