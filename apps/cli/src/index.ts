#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, mergeCliFlags, type StatsConfig } from '@personal-agent/config';
import { ProviderRegistry, type LLMProvider } from '@personal-agent/provider';
import {
  AgentLoop,
  ContextAssembler,
  TokenBudget,
  createLlmContextSummarizer,
  SessionManager,
  SubAgentManager,
  PlanModeEngine,
  type Plan,
} from '@personal-agent/core';
import {
  BaseTool,
  describeShell,
  registerBuiltinTools,
  setDefaultShellPreference,
  type Tool,
  type ToolContext,
  type ToolResult,
} from '@personal-agent/tool';
import {
  createLogger,
  setLogLevel,
  LogLevel,
  VERSION,
  VERSION_LABEL,
  type ModelInfo,
} from '@personal-agent/shared';
import { FileSystemMemoryStore } from '@personal-agent/memory';
import {
  ModelRequestRecorder,
  UsageStore,
  formatRecentText,
  formatStatsText,
  getByDay,
  getByModel,
  getSummary,
  type PricingMap,
} from '@personal-agent/stats';
import { MCPClientManager } from '@personal-agent/mcp';
import { PluginLoader } from '@personal-agent/plugin';
import * as readline from 'node:readline';

const log = createLogger('cli');

// ---------------------------------------------------------------------------
// Model request stats (SQLite) helpers
// ---------------------------------------------------------------------------

/**
 * Create the stats store for the current process. Returns null (with a warn
 * log) when stats are unavailable — e.g. old Node without node:sqlite or a
 * database failure — so the main flow is never affected.
 */
function createStatsStore(statsConfig: StatsConfig): UsageStore | null {
  if (!UsageStore.isAvailable()) {
    log.warn(
      'node:sqlite is not available on this Node runtime (>= 22.13 required) — model request stats disabled.',
    );
    return null;
  }
  try {
    const store = new UsageStore({
      dbPath: statsConfig.dbPath || undefined,
      recordPayloads: statsConfig.recordPayloads,
    });
    store.initialize();
    if (statsConfig.retentionDays > 0) {
      try {
        store.prune(statsConfig.retentionDays);
      } catch (err) {
        log.warn(`Stats prune failed: ${(err as Error).message}`);
      }
    }
    return store;
  } catch (err) {
    log.warn(`Failed to initialize stats store: ${(err as Error).message}`);
    return null;
  }
}

/** Build a PricingMap from the active provider's model list (if pricing known). */
function buildPricingMap(provider: { getModelList?: () => ModelInfo[] }): PricingMap {
  const map: PricingMap = {};
  if (!provider.getModelList) return map;
  for (const model of provider.getModelList()) {
    if (model.pricing) {
      map[`${model.provider}:${model.id}`] = {
        inputPer1k: model.pricing.inputPer1k,
        outputPer1k: model.pricing.outputPer1k,
      };
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('personal-agent')
  .description('A powerful AI agent CLI tool')
  .version(VERSION)
  .argument('[prompt]', 'Single prompt to execute (non-interactive mode)')
  .option('-m, --model <model>', 'Model to use')
  .option('-p, --provider <provider>', 'Provider to use (anthropic, openai, ollama, deepseek)')
  .option('--max-turns <n>', 'Maximum turns per prompt', parseInt)
  .option('--temperature <n>', 'Temperature for generation', parseFloat)
  .option('--max-tokens <n>', 'Maximum output tokens', parseInt)
  .option('-c, --config <path>', 'Path to config file')
  .option('--no-tui', 'Disable TUI (use plain readline)')
  .option('-d, --debug', 'Enable debug logging')
  .option('-y, --yes', 'Auto-approve all tool permissions')
  .option('--resume', 'Resume the most recent saved session')
  .option('--session <id>', 'Resume a specific session by id')
  .action(async (prompt: string | undefined, options: Record<string, unknown>) => {
    if (options.debug) {
      setLogLevel(LogLevel.Debug);
    }

    const autoApprove = options.yes as boolean;
    const useTui = options.tui !== false; // --no-tui disables TUI

    // Load configuration
    const config = loadConfig({
      configPath: options.config as string | undefined,
      cwd: process.cwd(),
    });

    const mergedConfig = mergeCliFlags(config, {
      model: options.model as string | undefined,
      provider: options.provider as string | undefined,
      maxTurns: options.maxTurns as number | undefined,
      temperature: options.temperature as number | undefined,
      maxTokens: options.maxTokens as number | undefined,
    });

    // Initialize providers
    log.info('Initializing providers...');
    const registry = await ProviderRegistry.fromConfig(mergedConfig);

    if (options.provider) {
      registry.setActive(options.provider as string);
    }

    const provider = registry.getActive();
    if (!provider) {
      console.error(
        'No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or DEEPSEEK_API_KEY.',
      );
      console.error('Or create ~/.personal-agent/config.yaml with provider settings.');
      process.exit(1);
    }

    if (options.model) {
      provider.setModel(options.model as string);
    }

    // Initialize tool system
    setDefaultShellPreference(mergedConfig.tools.shell);
    const {
      registry: toolRegistry,
      executor: toolExecutor,
      permissionManager,
      sandbox,
    } = registerBuiltinTools();

    // Add default permission rules
    permissionManager.addRule({ tool: 'read_file', action: 'allow', scope: 'session' });
    permissionManager.addRule({ tool: 'list_directory', action: 'allow', scope: 'session' });
    permissionManager.addRule({ tool: 'glob', action: 'allow', scope: 'session' });
    permissionManager.addRule({ tool: 'grep', action: 'allow', scope: 'session' });
    permissionManager.addRule({ tool: 'todo_write', action: 'allow', scope: 'session' });
    permissionManager.addRule({ tool: 'ask_user', action: 'allow', scope: 'session' });

    if (autoApprove) {
      permissionManager.addRule({ tool: '*', action: 'allow', scope: 'session' });
    }

    sandbox.updateConstraints({
      restrictPaths: mergedConfig.tools.sandbox.restrictPaths,
      allowedPaths: mergedConfig.tools.sandbox.allowedPaths,
      deniedCommands: [
        ...sandbox.getConstraints().deniedCommands,
        ...mergedConfig.tools.sandbox.deniedCommands,
      ],
      shellTimeout: mergedConfig.tools.shellTimeout,
      webFetchTimeout: mergedConfig.tools.webFetchTimeout,
    });

    const pluginLoader = new PluginLoader(mergedConfig.plugins.paths, {
      disabled: mergedConfig.plugins.disabled,
    });
    if (mergedConfig.plugins.enabled) {
      await pluginLoader.loadAll();
    }

    // Create context assembler
    const contextAssembler = new ContextAssembler({
      workingDirectory: process.cwd(),
      platform: `${process.platform} ${process.arch}`,
      shell: describeShell(process.platform, mergedConfig.tools.shell),
      model: provider.getModel(),
      provider: provider.providerId,
      mode: 'chat',
    });

    // Initialize memory store for context injection
    const memoryStore = mergedConfig.memory.enabled
      ? new FileSystemMemoryStore({ maxEntries: mergedConfig.memory.maxEntries })
      : null;
    await memoryStore?.initialize();

    /**
     * Search memory and inject relevant context before each turn.
     */
    async function injectMemoryContext(userInput: string): Promise<void> {
      contextAssembler.removeSection('automatic-memory-context');
      contextAssembler.removeSection('active-plugin-skills');
      await pluginLoader.dispatchHook('on_user_input', {
        sessionId: session.getSessionId(),
        input: userInput,
      });
      if (memoryStore) {
        try {
          const context = await memoryStore.getRelevantContext(userInput, 2000);
          if (context) {
            contextAssembler.addSection({
              name: 'automatic-memory-context',
              priority: 6,
              content: `## Remembered Context (auto-injected from memory)\n\n${context}\n\nUse this context when relevant to the user's request.`,
            });
          }
        } catch {
          // Memory injection is best-effort — don't fail the turn
        }
      }
      const skills = pluginLoader.findSkills(userInput);
      if (skills.length > 0) {
        contextAssembler.addSection({
          name: 'active-plugin-skills',
          priority: 7,
          content: skills
            .map((skill) => `## Skill: ${skill.name}\n\n${skill.content}`)
            .join('\n\n'),
        });
      }
    }

    // Add read_memory and write_memory tools when persistent memory is enabled
    if (memoryStore) {
      const readMemoryTool = new (class extends BaseTool {
        readonly name = 'read_memory';
        readonly description =
          'Query the persistent memory store for relevant facts and preferences.';
        readonly inputSchema = {
          type: 'object',
          properties: { query: { type: 'string', description: 'Search query' } },
          required: ['query'],
        };
        readonly category = 'memory';
        async execute(p: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
          const results = await memoryStore.search(p.query as string, { maxResults: 5 });
          const text = results
            .map(
              (r: { entry: { type: string; content: string } }) =>
                `[${r.entry.type}] ${r.entry.content}`,
            )
            .join('\n');
          return { success: true, content: text || '(no relevant memories found)' };
        }
      })();
      toolRegistry.register(readMemoryTool);

      const writeMemoryTool = new (class extends BaseTool {
        readonly name = 'write_memory';
        readonly description = 'Write a fact or preference to persistent memory.';
        readonly inputSchema = {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Content to remember' },
            type: {
              type: 'string',
              enum: ['fact', 'preference', 'decision'],
              description: 'Memory type',
            },
            importance: {
              type: 'number',
              description: 'Importance level (1=critical, 2=important, 3=info)',
            },
          },
          required: ['content'],
        };
        readonly category = 'memory';
        readonly requiresPermission = true;
        async execute(p: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
          const importance = Number(p.importance ?? 2);
          if (![1, 2, 3].includes(importance)) {
            return { success: false, content: '', error: 'importance must be 1, 2, or 3' };
          }
          const entry = await memoryStore.create({
            type: (p.type as any) ?? 'fact',
            content: p.content as string,
            tags: [],
            metadata: {
              importance: importance as 1 | 2 | 3,
              sourceSessionId: session.getSessionId(),
            },
          });
          return { success: true, content: `Memory saved: ${entry.id}` };
        }
      })();
      toolRegistry.register(writeMemoryTool);
    }

    // Initialize MCP client and connect to configured servers
    const mcpManager = new MCPClientManager(toolRegistry);
    const mcpServers = mergedConfig.mcp?.servers ?? [];
    for (const serverConfig of mcpServers) {
      try {
        await mcpManager.connect(serverConfig as any);
        for (const toolName of serverConfig.autoApprove ?? []) {
          const qualifiedName =
            toolName === '*'
              ? `mcp__${serverConfig.name}__*`
              : `mcp__${serverConfig.name}__${toolName}`;
          permissionManager.addRule({
            tool: qualifiedName,
            action: 'allow',
            scope: 'session',
          });
        }
      } catch (err) {
        log.warn(`MCP server ${serverConfig.name} failed to connect: ${(err as Error).message}`);
      }
    }

    const session = new SessionManager(process.cwd(), provider.getModel(), provider.providerId);
    await session.ensureDir();

    // Session resumption
    const resumeSessionId = options.session as string | undefined;
    if (resumeSessionId) {
      const restored = await session.restore(resumeSessionId);
      if (restored) {
        // Replay messages into context assembler
        for (const msg of session.getMessages()) {
          contextAssembler.addMessage(msg);
        }
        console.log(
          `\x1b[2m📋 Resumed session ${resumeSessionId.slice(0, 8)} (${session.getMessages().length} messages, ${session.getSession().metadata.turnCount} turns)\x1b[0m`,
        );
      } else {
        console.log(
          `\x1b[33mSession ${resumeSessionId.slice(0, 8)} not found. Starting fresh.\x1b[0m`,
        );
      }
    } else if (options.resume) {
      const lastId = await session.getLastSessionId();
      if (lastId) {
        await session.restore(lastId);
        for (const msg of session.getMessages()) {
          contextAssembler.addMessage(msg);
        }
        console.log(
          `\x1b[2m📋 Resumed session ${lastId.slice(0, 8)} (${session.getMessages().length} messages)\x1b[0m`,
        );
      } else {
        console.log(`\x1b[2mNo previous session found. Starting fresh.\x1b[0m`);
      }
    }
    await pluginLoader.dispatchHook('on_session_start', {
      sessionId: session.getSessionId(),
      workingDirectory: process.cwd(),
    });
    const tokenBudget = new TokenBudget(
      resolveCliContextWindow(provider),
      8192,
      createLlmContextSummarizer(provider),
    );
    const planEngine = new PlanModeEngine();
    const planModeState: PlanModeState = { active: false };

    // Model request stats tracking (SQLite, graceful degradation)
    const statsStore = mergedConfig.stats.enabled ? createStatsStore(mergedConfig.stats) : null;
    const statsRecorder = statsStore
      ? new ModelRequestRecorder(statsStore, () => session.getSessionId())
      : null;

    const submitPlanTool = new (class extends BaseTool {
      readonly name = 'submit_plan';
      readonly description =
        'Submit a structured implementation plan for user approval. Use stable step ids such as step-1 and reference those ids from dependencies.';
      readonly category = 'plan';
      readonly inputSchema = {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short plan title' },
          description: { type: 'string', description: 'Plan overview' },
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
      } as any;

      async execute(params: Record<string, unknown>): Promise<ToolResult> {
        if (!planModeState.active) {
          return {
            success: false,
            content: '',
            error: 'submit_plan is only available in plan mode',
          };
        }
        const rawSteps = Array.isArray(params.steps) ? params.steps : [];
        const plan = planEngine.createPlan({
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
        return { success: true, content: formatPlan(plan) };
      }
    })();
    toolRegistry.register(submitPlanTool);

    const getPlanTool = new (class extends BaseTool {
      readonly name = 'get_plan';
      readonly description = 'Get the current structured plan and its execution progress.';
      readonly category = 'plan';
      readonly inputSchema = { type: 'object', properties: {} } as const;

      async execute(): Promise<ToolResult> {
        const plan = planEngine.getPlan();
        return { success: true, content: plan ? formatPlan(plan) : 'No active plan.' };
      }
    })();
    toolRegistry.register(getPlanTool);

    const updatePlanStepTool = new (class extends BaseTool {
      readonly name = 'update_plan_step';
      readonly description = 'Update a step in the approved plan as execution progresses.';
      readonly category = 'plan';
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
      } as any;

      async execute(params: Record<string, unknown>): Promise<ToolResult> {
        const stepId = String(params.step_id);
        const status = String(params.status);
        const output = params.output === undefined ? undefined : String(params.output);
        const step =
          status === 'in_progress'
            ? await planEngine.startStep(stepId)
            : status === 'completed'
              ? await planEngine.completeStep(stepId, output)
              : status === 'failed'
                ? await planEngine.failStep(stepId, output)
                : status === 'skipped'
                  ? await planEngine.skipStep(stepId)
                  : null;
        if (!step) {
          return {
            success: false,
            content: '',
            error: `Unknown step or status: ${stepId}/${status}`,
          };
        }
        return {
          success: true,
          content: `Step ${step.id} is ${step.status}. Plan progress: ${planEngine.getProgress().percentage}%`,
        };
      }
    })();
    toolRegistry.register(updatePlanStepTool);
    pluginLoader.registerTools(toolRegistry);

    const planModeToolNames = new Set([
      'read_file',
      'list_directory',
      'glob',
      'grep',
      'read_memory',
      'get_plan',
      'submit_plan',
    ]);

    const agentLoop = new AgentLoop({
      onModelCallStart: (call) => statsRecorder?.onModelCallStart(call),
      onModelCallEnd: (call) => statsRecorder?.onModelCallEnd(call),
      provider,
      contextAssembler,
      tokenBudget,
      toolDefinitions: toolRegistry.listDefinitions(),
      getExposedToolDefinitions: () => {
        const definitions = toolRegistry.listDefinitions();
        return planModeState.active
          ? definitions.filter((definition) => planModeToolNames.has(definition.name))
          : definitions;
      },
      isToolBlocked: (name) => planModeState.active && !planModeToolNames.has(name),
      maxTurns: mergedConfig.agent.maxTurns,
      executeTool: async (name: string, input: Record<string, unknown>, signal: AbortSignal) => {
        if (planModeState.active && !planModeToolNames.has(name)) {
          return {
            success: false,
            content: '',
            error: `Tool '${name}' is blocked in plan mode. Use /exit-plan to unlock.`,
          };
        }
        const toolCtx: ToolContext = {
          sessionId: session.getSessionId(),
          workingDirectory: process.cwd(),
          signal,
        };
        await pluginLoader.dispatchHook('on_tool_execute', {
          sessionId: session.getSessionId(),
          toolName: name,
          input,
        });
        const result = await toolExecutor.executeWithPermission(name, input, toolCtx, true);
        await pluginLoader.dispatchHook('on_tool_result', {
          sessionId: session.getSessionId(),
          toolName: name,
          input,
          result,
        });
        return result;
      },
      requestPermission: async (toolName: string, params: Record<string, unknown>) => {
        const tool = toolRegistry.get(toolName);
        const decision = permissionManager.check(toolName, params);
        if (decision === 'allow') return true;
        if (decision === 'ask' && tool && !tool.requiresPermission && !tool.isDangerous) {
          return true;
        }
        return promptUserPermission(toolName, params);
      },
    });

    // Initialize sub-agent manager and register spawn_sub_agent tool
    const subAgentManager = new SubAgentManager(
      async (toolName: string, toolInput: Record<string, unknown>, signal?: AbortSignal) => {
        const toolCtx: ToolContext = {
          sessionId: session.getSessionId(),
          workingDirectory: process.cwd(),
          signal,
        };
        return toolExecutor.execute(toolName, toolInput, toolCtx);
      },
    );

    const spawnSubAgentTool = new (class extends BaseTool {
      readonly name = 'spawn_sub_agent';
      readonly description =
        'Spawn a sub-agent to handle a complex subtask independently. The sub-agent runs in an isolated context with a restricted tool set. Use this to parallelize work on independent subtasks.';
      readonly inputSchema = {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description:
              'Short description of what this sub-agent should do (shown in progress indicators)',
          },
          prompt: { type: 'string', description: 'The full task prompt for the sub-agent' },
          allowed_tools: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Tool names this sub-agent is allowed to use (e.g., ["read_file", "grep", "glob", "bash"])',
          },
        },
        required: ['description', 'prompt', 'allowed_tools'],
      } as any;
      readonly category = 'agent';
      async execute(p: Record<string, unknown>, _c: ToolContext): Promise<ToolResult> {
        const requested = new Set((p.allowed_tools as string[]) ?? []);
        const allowed = toolRegistry
          .listAll()
          .filter((tool) => requested.has(tool.name) && tool.canBeUsedInSubAgent)
          .map((tool) => tool.name);
        const filteredToolDefs = toolRegistry
          .listDefinitions()
          .filter((definition) => allowed.includes(definition.name));

        const handle = subAgentManager.spawn({
          description: p.description as string,
          prompt: p.prompt as string,
          allowedTools: allowed,
          toolDefinitions: filteredToolDefs,
          provider,
          maxTurns: 50,
          workingDirectory: process.cwd(),
        });

        const result = await handle.result;
        return {
          success: result.success,
          content: result.summary,
          metadata: {
            duration: 0,
            tokensUsed: result.tokensUsed,
          },
        };
      }
    })() as any;
    toolRegistry.register(spawnSubAgentTool);

    // Rebuild tool instructions now that we have all tools
    contextAssembler.removeSection('tools');
    contextAssembler.addSection({
      name: 'tools',
      priority: 5,
      conditional: () => false,
      content: buildToolInstructions(toolRegistry.listAll()),
    });

    // Inject plan system prompt section (disabled by default)
    contextAssembler.addSection({
      name: 'plan',
      priority: 2,
      conditional: () => planModeState.active,
      content: `## Plan Mode (READ-ONLY)
You are currently in PLAN MODE. In this mode:
1. You may inspect the project with the exposed read-only tools, but you MUST NOT cause side effects.
2. Analyze the request and create a detailed implementation plan with explicit dependencies and risks.
3. You MUST call submit_plan with the final structured plan before finishing your response.
4. Do not execute the plan until the user approves it with /exit-plan.
5. The plan should be comprehensive — break the task into logical phases with clear dependencies.
6. Do NOT ask the user questions — just output the best plan you can.

When the user is satisfied, they will use /exit-plan to leave plan mode. Then you can execute the plan step by step using the available tools.`,
    });

    // Single prompt mode
    if (prompt) {
      console.log(`\x1b[2m> ${prompt}\x1b[0m\n`);
      await runSinglePrompt(agentLoop, prompt, session, contextAssembler);
      statsStore?.close();
      await pluginLoader.dispatchHook('on_session_end', {
        sessionId: session.getSessionId(),
      });
      await subAgentManager.cancelAll();
      await mcpManager.disconnectAll();
      await provider.dispose();
      process.exit(0);
    }

    // TUI mode (default)
    if (useTui && process.stdin.isTTY) {
      await runTuiMode({
        agentLoop,
        provider,
        session,
        contextAssembler,
        permissionManager,
        autoApprove,
        planEngine,
        injectMemoryContext,
        statsStore,
        planModeState,
        onExit: async () => {
          statsStore?.close();
          await pluginLoader.dispatchHook('on_session_end', {
            sessionId: session.getSessionId(),
          });
          await subAgentManager.cancelAll();
          await mcpManager.disconnectAll();
        },
      });
      return;
    }

    // Fallback: readline mode
    console.log(`\n\x1b[1;36m⚡ personal-agent ${VERSION_LABEL}\x1b[0m`);
    console.log(`\x1b[2mModel: ${provider.displayName} (${provider.getModel()})\x1b[0m`);
    console.log(`\x1b[2mType /help for commands, /exit to quit.\x1b[0m\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '\x1b[36m▸ \x1b[0m',
      terminal: true,
      historySize: 1000,
    });

    rl.prompt();

    rl.on('line', async (line: string) => {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        return;
      }

      if (input.startsWith('/')) {
        const result = await handleSlashCommand(input, {
          rl,
          contextAssembler,
          provider,
          permissionManager,
          session,
          autoApprove,
          statsStore,
          planEngine,
          planModeState,
        });
        if (result.status === 'exit') {
          syncSessionMessages(session, contextAssembler);
          await session.save();
          await pluginLoader.dispatchHook('on_session_end', {
            sessionId: session.getSessionId(),
          });
          await subAgentManager.cancelAll();
          await mcpManager.disconnectAll();
          await provider.dispose();
          rl.close();
          statsStore?.close();
          process.exit(0);
          process.exit(0);
        }
        if (result.output) {
          console.log(`\n${result.output}`);
        }
        rl.prompt();
        return;
      }

      try {
        await injectMemoryContext(input);
        for await (const event of agentLoop.run(input)) {
          renderEvent(event);
        }
        recordCompletedTurn(session, contextAssembler, agentLoop);
        await session.save();
      } catch (err) {
        console.error('\x1b[31mError:\x1b[0m', (err as Error).message);
      }

      console.log('');
      rl.prompt();
    });

    rl.on('close', async () => {
      console.log('\nGoodbye!');
      statsStore?.close();
      syncSessionMessages(session, contextAssembler);
      await session.save();
      await pluginLoader.dispatchHook('on_session_end', {
        sessionId: session.getSessionId(),
      });
      await subAgentManager.cancelAll();
      await mcpManager.disconnectAll();
      await provider.dispose();
      process.exit(0);
    });

    process.on('SIGINT', () => {
      agentLoop.interrupt();
    });
  });

// ---------------------------------------------------------------------------
// TUI mode
// ---------------------------------------------------------------------------

interface PlanModeState {
  active: boolean;
}

interface TuiModeOptions {
  agentLoop: AgentLoop;
  provider: {
    providerId: string;
    displayName: string;
    getModel(): string;
    dispose(): Promise<void>;
    getModelList(): ModelInfo[];
  };
  session: SessionManager;
  contextAssembler: ContextAssembler;
  permissionManager: {
    addRule(r: { tool: string; action: 'allow' | 'ask' | 'approval'; scope: string }): void;
    getRules(): Array<{ tool: string; action: string; scope: string }>;
  };
  autoApprove: boolean;
  statsStore: UsageStore | null;
  planEngine?: PlanModeEngine;
  injectMemoryContext?: (userInput: string) => Promise<void>;
  planModeState: PlanModeState;
  onExit?: () => Promise<void>;
}

async function runTuiMode(opts: TuiModeOptions) {
  // Dynamic imports for TUI mode — use import() to handle top-level await deps
  const [{ render }, React, { App }] = await Promise.all([
    import('ink'),
    import('react'),
    import('@personal-agent/tui'),
  ]);
  const { createElement } = React as typeof import('react');

  // Collect TUI state for rendering
  let tuiDispatch: ((action: any) => void) | null = null;
  const syncTuiPlan = () => {
    if (!tuiDispatch) return;
    const plan = opts.planEngine?.getPlan();
    const progress = opts.planEngine?.getProgress();
    tuiDispatch({
      type: 'SET_PLAN',
      plan: plan
        ? {
            title: plan.title,
            status: plan.status,
            percentage: progress?.percentage ?? 0,
            steps: plan.steps.map((step) => ({
              id: step.id,
              title: step.title,
              status: step.status,
            })),
          }
        : null,
    });
  };
  opts.planEngine?.onUpdate(syncTuiPlan);

  // Build the TUI app
  const tuiInstance = render(
    createElement(App, {
      model: opts.provider.getModel(),
      provider: opts.provider.displayName,
      onDispatchReady: (dispatch: (action: any) => void) => {
        tuiDispatch = dispatch;
        syncTuiPlan();
      },
      onUserInput: async (text: string) => {
        try {
          if (opts.injectMemoryContext) {
            await opts.injectMemoryContext(text);
          }
          for await (const event of opts.agentLoop.run(text)) {
            handleTuiEvent(event, tuiDispatch);
          }
          recordCompletedTurn(opts.session, opts.contextAssembler, opts.agentLoop);
          syncTuiPlan();
          // Auto-save after each turn
          await opts.session.save();
        } catch (err) {
          if (tuiDispatch) {
            tuiDispatch({ type: 'ADD_SYSTEM_MESSAGE', text: `Error: ${(err as Error).message}` });
          }
        }
      },
      onSlashCommand: async (input: string): Promise<string | void> => {
        try {
          const ctx: CommandContext = {
            rl: null,
            contextAssembler: opts.contextAssembler,
            provider: {
              providerId: opts.provider.providerId,
              displayName: opts.provider.displayName,
              getModel: opts.provider.getModel,
              dispose: opts.provider.dispose,
              getModelList: opts.provider.getModelList,
            },
            permissionManager: opts.permissionManager,
            session: opts.session,
            autoApprove: opts.autoApprove,
            statsStore: opts.statsStore,
            planEngine: opts.planEngine,
            planModeState: opts.planModeState,
          };
          const result = await handleSlashCommand(input, ctx);
          syncTuiPlan();
          if (result.status === 'exit') {
            await opts.session.save();
            await opts.onExit?.();
            await opts.provider.dispose();
            process.exit(0);
          }
          return result.output || undefined;
        } catch (err) {
          return `Error processing command: ${(err as Error).message}`;
        }
      },
      themeName: 'dark',
    }),
  );

  // Wait for cleanup
  await tuiInstance.waitUntilExit();
  await opts.session.save();
  await opts.onExit?.();
  await opts.provider.dispose();
  process.exit(0);
}

function handleTuiEvent(
  event: unknown,
  dispatch: ((a: { type: string; [k: string]: unknown }) => void) | null,
) {
  if (!dispatch) return;
  const ev = event as Record<string, unknown>;

  switch (ev.type) {
    case 'assistant_text_delta':
      dispatch({ type: 'APPEND_TEXT', text: ev.textDelta as string });
      break;

    case 'tool_call_start':
      dispatch({
        type: 'TOOL_CALL_START',
        id: ev.toolCallId as string,
        name: ev.toolName as string,
      });
      break;

    case 'tool_call_end':
      dispatch({
        type: 'TOOL_CALL_END',
        id: ev.toolCallId as string,
        result: ev.result as ToolResult,
      });
      break;

    case 'error':
      dispatch({ type: 'ADD_SYSTEM_MESSAGE', text: `Error: ${(ev.error as Error).message}` });
      break;

    case 'interrupted':
      dispatch({ type: 'ADD_SYSTEM_MESSAGE', text: '⏎ Interrupted' });
      break;

    case 'done': {
      const usage = ev.totalUsage as { inputTokens: number; outputTokens: number } | undefined;
      if (usage) {
        dispatch({ type: 'UPDATE_USAGE', input: usage.inputTokens, output: usage.outputTokens });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Single prompt mode
// ---------------------------------------------------------------------------

function syncSessionMessages(session: SessionManager, contextAssembler: ContextAssembler): void {
  session.replaceMessages(contextAssembler.getHistory());
}

function recordCompletedTurn(
  session: SessionManager,
  contextAssembler: ContextAssembler,
  agentLoop: AgentLoop,
): void {
  syncSessionMessages(session, contextAssembler);
  const usage = agentLoop.getTotalUsage();
  session.addTokensUsed(usage.inputTokens, usage.outputTokens);
  session.incrementTurnCount();
}

async function runSinglePrompt(
  agentLoop: AgentLoop,
  prompt: string,
  session: SessionManager,
  contextAssembler: ContextAssembler,
): Promise<void> {
  try {
    for await (const event of agentLoop.run(prompt)) {
      renderEvent(event);
    }
    recordCompletedTurn(session, contextAssembler, agentLoop);
    await session.save();
  } catch (err) {
    console.error('\x1b[31mError:\x1b[0m', (err as Error).message);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Tool instructions
// ---------------------------------------------------------------------------

function buildToolInstructions(tools: Tool[]): string {
  const lines: string[] = ['## Tool Usage Instructions', ''];
  lines.push(
    'You have access to tools. Use them by including tool_use content blocks in your response.',
  );
  lines.push('');
  lines.push('Available tools:');
  for (const tool of tools) {
    const perm = tool.isDangerous
      ? '⚠️ requires approval'
      : tool.requiresPermission
        ? '🔒 requires permission'
        : '✅ auto-approved';
    lines.push(`- **${tool.name}** (${tool.category}) ${perm}`);
    lines.push(`  ${tool.description.split('\n')[0]}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Permission prompt
// ---------------------------------------------------------------------------

function promptUserPermission(toolName: string, params: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    console.log(`\n\x1b[33m⚠ Permission required: ${toolName}\x1b[0m`);
    if (params.command) {
      console.log(`\x1b[2m  Command: ${(params.command as string).slice(0, 200)}\x1b[0m`);
    } else if (params.file_path) {
      console.log(`\x1b[2m  File: ${params.file_path}\x1b[0m`);
    } else if (params.url) {
      console.log(`\x1b[2m  URL: ${params.url}\x1b[0m`);
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('\x1b[33m  Allow? [y/n/a(ll)/d(eny)]: \x1b[0m', (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes' || a === 'a' || a === 'all');
    });
  });
}

// ---------------------------------------------------------------------------
// Event rendering (readline fallback mode)
// ---------------------------------------------------------------------------

function renderEvent(event: unknown): void {
  const ev = event as Record<string, unknown>;

  switch (ev.type) {
    case 'assistant_text_delta':
      process.stdout.write(ev.textDelta as string);
      break;

    case 'tool_call_start':
      process.stdout.write(`\n\x1b[33m  ⚙ ${ev.toolName}\x1b[0m `);
      break;

    case 'tool_call_end': {
      const result = ev.result as ToolResult | undefined;
      if (result?.success) {
        const preview = (result.content ?? '').slice(0, 300);
        process.stdout.write(`\x1b[32m✓\x1b[0m\n`);
        if (preview) {
          process.stdout.write(
            `\x1b[2m  ${preview.replace(/\n/g, '\n  ')}${result.content.length > 300 ? '...' : ''}\x1b[0m\n`,
          );
        }
      } else {
        process.stdout.write(`\x1b[31m✗ ${result?.error ?? 'Failed'}\x1b[0m\n`);
      }
      break;
    }

    case 'error':
      console.error(
        `\n\x1b[31mError:\x1b[0m ${(ev.error as { message?: string })?.message ?? ev.error}`,
      );
      break;

    case 'interrupted':
      console.log('\n\x1b[33m⏎ Interrupted.\x1b[0m');
      break;

    case 'done': {
      const usage = ev.totalUsage as { inputTokens: number; outputTokens: number } | undefined;
      if (usage?.inputTokens || usage?.outputTokens) {
        console.log(
          `\n\x1b[2m  [${ev.totalTurns} turns · ${usage.inputTokens}↓ ${usage.outputTokens}↑ tokens]\x1b[0m`,
        );
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Slash commands (readline mode)
// ---------------------------------------------------------------------------

interface CommandContext {
  rl: readline.Interface | null;
  contextAssembler: ContextAssembler;
  provider: {
    providerId: string;
    displayName: string;
    getModel(): string;
    dispose(): Promise<void>;
    getModelList(): ModelInfo[];
  };
  permissionManager: {
    addRule(r: { tool: string; action: 'allow' | 'ask' | 'approval'; scope: string }): void;
    getRules(): Array<{ tool: string; action: string; scope: string }>;
  };
  session: SessionManager;
  autoApprove: boolean;
  statsStore: UsageStore | null;
  planEngine?: PlanModeEngine;
  planModeState: PlanModeState;
}

async function handleSlashCommand(
  input: string,
  ctx: CommandContext,
): Promise<{ status: 'exit' | 'ok'; output?: string }> {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  switch (cmd) {
    case 'exit':
    case 'quit':
    case 'q':
      return { status: 'exit', output: 'Goodbye!' };

    case 'help': {
      const helpText = [
        'Available Commands:',
        '  /help              Show this help',
        '  /clear             Clear conversation history',
        '  /plan              Enter plan mode (read-only, LLM creates a plan)',
        '  /exit-plan         Approve the plan and re-enable tools',
        '  /plan-status       Show structured plan progress',
        '  /save              Save current session',
        '  /load <id>         Load a saved session',
        '  /sessions          List saved sessions',
        '  /permissions       Show permission rules',
        '  /allow <tool>      Allow a tool (session)',
        '  /approval <tool>   Require approval for a tool (session)',
        '  /stats [days]      Show model request stats (default 7 days)',
        '  /stats-recent <n>  Show the N most recent model requests',
        '  /exit, /quit       Exit',
        '',
        'Keyboard shortcuts:',
        '  Ctrl+E  Expand/Collapse last tool result',
        '  Ctrl+T  Toggle theme',
        '  Ctrl+L  Clear screen',
        '  Ctrl+C  Interrupt',
      ].join('\n');
      return { status: 'ok', output: helpText };
    }

    case 'stats': {
      if (!ctx.statsStore) {
        return {
          status: 'ok',
          output: 'Stats tracking is disabled (set stats.enabled=true in config).',
        };
      }
      const days = Math.min(365, Math.max(1, parseInt(args[0] ?? '7', 10) || 7));
      const to = Date.now();
      const from = to - days * 24 * 60 * 60 * 1000;
      const pricing = buildPricingMap(ctx.provider);
      const summary = getSummary(ctx.statsStore, from, to, pricing);
      const byModel = getByModel(ctx.statsStore, from, to, pricing);
      const byDay = getByDay(ctx.statsStore, from, to);
      return { status: 'ok', output: formatStatsText(summary, byModel, byDay, days) };
    }

    case 'stats-recent': {
      if (!ctx.statsStore) {
        return {
          status: 'ok',
          output: 'Stats tracking is disabled (set stats.enabled=true in config).',
        };
      }
      const limit = Math.min(100, Math.max(1, parseInt(args[0] ?? '10', 10) || 10));
      return { status: 'ok', output: formatRecentText(ctx.statsStore.getRecent(limit)) };
    }

    case 'plan': {
      ctx.planModeState.active = true;
      ctx.planEngine?.clearPlan();
      ctx.contextAssembler.setMode('plan');
      ctx.contextAssembler.removeSection('plan-execution');
      // Enable plan-only section
      ctx.contextAssembler.removeSection('plan');
      ctx.contextAssembler.addSection({
        name: 'plan',
        priority: 2,
        conditional: () => true,
        content: `## Plan Mode (READ-ONLY)
You are currently in PLAN MODE. In this mode:
1. You may inspect the project with the exposed read-only tools, but you MUST NOT cause side effects.
2. Analyze the request and create a detailed implementation plan with explicit dependencies and risks.
3. You MUST call submit_plan with the final structured plan before finishing your response.
4. Do not execute the plan until the user approves it with /exit-plan.
5. The plan should be comprehensive — break the task into logical phases with clear dependencies.
6. Do NOT ask the user questions — just output the best plan you can.

When the user is satisfied with the plan, they will use /exit-plan to leave plan mode, then you can execute it step by step using the available tools.`,
      });
      return {
        status: 'ok',
        output:
          '🔒 Plan mode activated. Describe your task and the agent will produce a detailed implementation plan.\n\nUse /exit-plan to leave plan mode and re-enable tools.',
      };
    }

    case 'exit-plan': {
      ctx.planModeState.active = false;
      ctx.contextAssembler.setMode('chat');
      const approvedPlan = ctx.planEngine?.approvePlan();
      ctx.contextAssembler.removeSection('plan');
      ctx.contextAssembler.addSection({
        name: 'plan',
        priority: 2,
        conditional: () => false,
        content: '',
      });
      ctx.contextAssembler.removeSection('plan-execution');
      if (approvedPlan) {
        ctx.contextAssembler.addSection({
          name: 'plan-execution',
          priority: 5,
          content: `## Approved Plan

${formatPlan(approvedPlan)}

Execute this plan in dependency order. Call update_plan_step before starting each step and again when it completes, fails, or is skipped.`,
        });
      }
      return {
        status: 'ok',
        output: approvedPlan
          ? `Plan approved. Tools are available for execution.\n\n${formatPlan(approvedPlan)}`
          : 'Plan mode exited without a submitted structured plan. Tools are now available.',
      };
    }

    case 'plan-status': {
      const plan = ctx.planEngine?.getPlan();
      return { status: 'ok', output: plan ? formatPlan(plan) : 'No active plan.' };
    }

    case 'clear':
      ctx.contextAssembler.clearHistory();
      ctx.session.clearMessages();
      return { status: 'ok', output: 'Conversation cleared.' };

    case 'save': {
      syncSessionMessages(ctx.session, ctx.contextAssembler);
      const id = await ctx.session.save();
      return { status: 'ok', output: `Session saved: ${id.slice(0, 8)}` };
    }

    case 'load': {
      const sessionId = args[0];
      if (!sessionId) {
        return { status: 'ok', output: 'Usage: /load <session-id>' };
      }
      ctx.contextAssembler.clearHistory();
      const restored = await ctx.session.restore(sessionId);
      if (restored) {
        for (const msg of ctx.session.getMessages()) {
          ctx.contextAssembler.addMessage(msg);
        }
        return {
          status: 'ok',
          output: `Session loaded: ${sessionId.slice(0, 8)} (${ctx.session.getMessages().length} messages)`,
        };
      } else {
        return { status: 'ok', output: `Session not found: ${sessionId.slice(0, 8)}` };
      }
    }

    case 'sessions': {
      const sessions = await ctx.session.listSessions();
      if (sessions.length === 0) {
        return { status: 'ok', output: 'No saved sessions.' };
      }
      const out: string[] = [`Saved Sessions (${sessions.length}):`];
      for (const s of sessions) {
        const age = timeAgo(s.updatedAt);
        out.push(
          `  ${s.id.slice(0, 8)}  ${s.model}  ${s.messageCount} msgs · ${s.turnCount} turns  ${age}`,
        );
      }
      return { status: 'ok', output: out.join('\n') };
    }

    case 'permissions': {
      const out: string[] = ['Permission Rules:'];
      for (const rule of ctx.permissionManager.getRules()) {
        const icon = rule.action === 'allow' ? '✓' : rule.action === 'approval' ? '!' : '?';
        out.push(`  ${icon} ${rule.tool}: ${rule.action} [${rule.scope}]`);
      }
      return { status: 'ok', output: out.join('\n') };
    }

    case 'allow':
      if (args[0]) {
        ctx.permissionManager.addRule({ tool: args[0], action: 'allow', scope: 'session' });
        return { status: 'ok', output: `Allowed: ${args[0]}` };
      }
      return { status: 'ok', output: 'Usage: /allow <tool>' };

    case 'approval':
      if (args[0]) {
        ctx.permissionManager.addRule({
          tool: args[0],
          action: 'approval',
          scope: 'session',
        });
        return { status: 'ok', output: `Approval required: ${args[0]}` };
      }
      return { status: 'ok', output: 'Usage: /approval <tool>' };

    default:
      return {
        status: 'ok',
        output: `Unknown command: /${cmd}. Type /help for available commands.`,
      };
  }

  return { status: 'ok' };
}

function formatPlan(plan: Plan): string {
  const progressCounts = {
    completed: plan.steps.filter((step) => step.status === 'completed').length,
    settled: plan.steps.filter((step) => ['completed', 'failed', 'skipped'].includes(step.status))
      .length,
  };
  const percentage =
    plan.steps.length === 0 ? 100 : Math.round((progressCounts.settled / plan.steps.length) * 100);
  const lines = [
    `${plan.title} [${plan.status}]`,
    plan.description,
    `Progress: ${progressCounts.completed}/${plan.steps.length} completed (${percentage}% settled)`,
  ].filter(Boolean);
  for (const step of plan.steps) {
    const marker =
      step.status === 'completed'
        ? 'x'
        : step.status === 'in_progress'
          ? '>'
          : step.status === 'failed'
            ? '!'
            : step.status === 'skipped'
              ? '-'
              : ' ';
    const dependencies =
      step.dependencies.length > 0 ? ` (after: ${step.dependencies.join(', ')})` : '';
    lines.push(`[${marker}] ${step.id}: ${step.title}${dependencies}`);
  }
  if (plan.metadata.risks.length > 0) {
    lines.push(`Risks: ${plan.metadata.risks.join('; ')}`);
  }
  return lines.join('\n');
}

function resolveCliContextWindow(provider: LLMProvider): number {
  return (
    provider.getModelList().find((model) => model.id === provider.getModel())?.contextWindow ??
    200_000
  );
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

program.parse();
