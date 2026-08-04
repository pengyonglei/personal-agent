import { AgentLoop } from './agent-loop';
import { ContextAssembler, TokenBudget, createLlmContextSummarizer } from './context';
import type { AssemblerContext } from './context';
import type { LLMProvider } from '@personal-agent/provider';
import type {
  UnifiedToolDefinition,
  ToolResult,
  AgentEvent,
  UsageInfo,
  UnifiedMessage,
} from '@personal-agent/shared';
import { createLogger, generateId } from '@personal-agent/shared';

const log = createLogger('sub-agent');

// ---------------------------------------------------------------------------
// Sub-agent configuration
// ---------------------------------------------------------------------------

export interface SubAgentConfig {
  /** Description shown in tool status — what this sub-agent is doing */
  description: string;
  /** The task prompt for the sub-agent */
  prompt: string;
  /** Tool names the sub-agent is allowed to use */
  allowedTools: string[];
  /** Tool definitions (filtered subset) */
  toolDefinitions: UnifiedToolDefinition[];
  /** Provider to use */
  provider: LLMProvider;
  /** Maximum turns for this sub-agent */
  maxTurns?: number;
  /** Token budget for context */
  contextTokens?: number;
  /** Working directory inherited from the parent runtime. */
  workingDirectory?: string;
  /** Callback when sub-agent produces streaming text */
  onProgress?: (text: string) => void;
}

export interface SubAgentResult {
  success: boolean;
  summary: string;
  fullOutput: string;
  toolCallsMade: number;
  turnsTaken: number;
  tokensUsed: number;
  error?: string;
}

export interface SubAgentHandle {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  progress?: string;
  /** Resolve with SubAgentResult when done */
  result: Promise<SubAgentResult>;
  cancel(): void;
}

// ---------------------------------------------------------------------------
// Sub-agent manager
// ---------------------------------------------------------------------------

export class SubAgentManager {
  private activeAgents = new Map<string, SubAgentHandle>();
  private globalToolExecutor: (
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  private maxConcurrent: number;

  constructor(
    toolExecutor: (
      name: string,
      input: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<ToolResult>,
    options: { maxConcurrent?: number } = {},
  ) {
    this.globalToolExecutor = toolExecutor;
    this.maxConcurrent = options.maxConcurrent ?? 4;
  }

  /**
   * Spawn a sub-agent with isolated context.
   * Returns a handle that can be used to monitor/cancel.
   */
  spawn(config: SubAgentConfig): SubAgentHandle {
    if (this.activeAgents.size >= this.maxConcurrent) {
      throw new Error(`Sub-agent concurrency limit reached (${this.maxConcurrent})`);
    }

    const id = `sub-${generateId()}`;
    let cancelled = false;
    let agentLoop: AgentLoop | null = null;

    const resultPromise = this.runSubAgent(
      id,
      config,
      () => cancelled,
      (loop) => {
        agentLoop = loop;
      },
    );

    const handle: SubAgentHandle = {
      id,
      status: 'running',
      result: resultPromise,
      cancel() {
        cancelled = true;
        agentLoop?.interrupt();
      },
    };

    this.activeAgents.set(id, handle);

    // Clean up after completion
    resultPromise
      .then((result) => {
        const h = this.activeAgents.get(id);
        if (h) {
          h.status = result.success
            ? 'completed'
            : result.error === 'Cancelled'
              ? 'cancelled'
              : 'failed';
          this.activeAgents.delete(id);
        }
      })
      .catch(() => {
        const h = this.activeAgents.get(id);
        if (h) {
          h.status = 'failed';
          this.activeAgents.delete(id);
        }
      });

    return handle;
  }

  async cancelAll(): Promise<void> {
    const handles = [...this.activeAgents.values()];
    for (const handle of handles) {
      handle.cancel();
    }
    await Promise.allSettled(handles.map((handle) => handle.result));
  }

  getActiveAgents(): SubAgentHandle[] {
    return Array.from(this.activeAgents.values());
  }

  // -------------------------------------------------------------------
  // Internal: run a sub-agent
  // -------------------------------------------------------------------

  private async runSubAgent(
    id: string,
    config: SubAgentConfig,
    isCancelled: () => boolean,
    onLoopReady: (loop: AgentLoop) => void,
  ): Promise<SubAgentResult> {
    const startTime = Date.now();
    let toolCallsMade = 0;
    let tokensUsed = 0;
    const allOutput: string[] = [];

    try {
      // Create a fresh, minimal context assembler
      const contextAssembler = new ContextAssembler({
        workingDirectory: config.workingDirectory ?? process.cwd(),
        platform: `${process.platform} ${process.arch}`,
        model: config.provider.getModel(),
        provider: config.provider.providerId,
        mode: 'chat',
      });

      // Override with sub-agent specific instructions
      contextAssembler.addSection({
        name: 'sub-agent',
        priority: 1,
        content: `You are a sub-agent with a specific task. Complete it efficiently and return only the result.
Your task: ${config.description}
Do not spawn further sub-agents. Focus on using the allowed tools to complete your task.`,
      });

      const tokenBudget = new TokenBudget(
        config.contextTokens ?? 100000,
        8192,
        createLlmContextSummarizer(config.provider),
      );
      const maxTurns = config.maxTurns ?? 50;

      // Create agent loop with filtered tools
      const allowedTools = new Set(config.allowedTools);
      const toolDefinitions = config.toolDefinitions.filter((tool) => allowedTools.has(tool.name));
      const agentLoop = new AgentLoop({
        provider: config.provider,
        contextAssembler,
        tokenBudget,
        toolDefinitions,
        maxTurns,
        executeTool: async (name, input, signal) => {
          if (!allowedTools.has(name)) {
            return {
              success: false,
              content: '',
              error: `Tool '${name}' is not allowed for this sub-agent`,
            };
          }
          toolCallsMade++;
          return this.globalToolExecutor(name, input, signal);
        },
      });
      onLoopReady(agentLoop);

      // Run the sub-agent
      for await (const event of agentLoop.run(config.prompt)) {
        if (isCancelled()) {
          return {
            success: false,
            summary: 'Cancelled by user',
            fullOutput: allOutput.join(''),
            toolCallsMade,
            turnsTaken: agentLoop.getTurnCount(),
            tokensUsed,
            error: 'Cancelled',
          };
        }

        switch (event.type) {
          case 'assistant_text_delta':
            allOutput.push(event.textDelta);
            if (config.onProgress) {
              config.onProgress(event.textDelta);
            }
            break;

          case 'done': {
            const usage = event.totalUsage as UsageInfo;
            if (usage) {
              tokensUsed = usage.inputTokens + usage.outputTokens;
            }
            break;
          }

          case 'error':
            return {
              success: false,
              summary: `Error: ${(event.error as Error).message}`,
              fullOutput: allOutput.join(''),
              toolCallsMade,
              turnsTaken: agentLoop.getTurnCount(),
              tokensUsed,
              error: (event.error as Error).message,
            };
        }
      }

      const fullText = allOutput.join('');
      const summary = fullText.slice(0, 2000) + (fullText.length > 2000 ? '...' : '');

      return {
        success: true,
        summary,
        fullOutput: fullText,
        toolCallsMade,
        turnsTaken: agentLoop.getTurnCount(),
        tokensUsed,
      };
    } catch (err) {
      return {
        success: false,
        summary: '',
        fullOutput: allOutput.join(''),
        toolCallsMade,
        turnsTaken: 0,
        tokensUsed,
        error: (err as Error).message,
      };
    }
  }
}
