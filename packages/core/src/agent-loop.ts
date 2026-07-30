import type {
  UnifiedMessage,
  UnifiedContentBlock,
  UnifiedToolDefinition,
  UnifiedStreamEvent,
  StreamOptions,
  AgentEvent,
  UsageInfo,
  ToolResult,
} from '@personal-agent/shared';
import { createLogger, generateId } from '@personal-agent/shared';
import { ContextAssembler, TokenBudget, type AssemblerContext } from './context';
import type { LLMProvider } from '@personal-agent/provider';

const log = createLogger('agent-loop');

// ---------------------------------------------------------------------------
// Agent loop configuration
// ---------------------------------------------------------------------------

export interface AgentLoopConfig {
  provider: LLMProvider;
  contextAssembler: ContextAssembler;
  tokenBudget: TokenBudget;
  toolDefinitions: UnifiedToolDefinition[];
  maxTurns: number;
  /** Called to execute a tool */
  executeTool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
  /** Optional: override the tool definitions used for the LLM prompt (e.g., readonly subset) */
  exposedToolDefinitions?: UnifiedToolDefinition[];
  /** Optional: resolve tool definitions for every turn (e.g., when plan mode changes). */
  getExposedToolDefinitions?: () => UnifiedToolDefinition[];
  /** Optional: set of tool names that are blocked from execution */
  blockedTools?: Set<string>;
  /** Optional: dynamically decide whether a tool is blocked. */
  isToolBlocked?: (toolName: string) => boolean;
  /** Called to request user permission for a tool */
  requestPermission?: (toolName: string, params: Record<string, unknown>) => Promise<boolean>;
  /** Provider options applied to every model turn. */
  streamOptions?: Omit<StreamOptions, 'signal'>;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private config: AgentLoopConfig;
  private turnCount = 0;
  private totalUsage: UsageInfo = { inputTokens: 0, outputTokens: 0 };
  private aborted = false;
  private controller = new AbortController();

  constructor(config: AgentLoopConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------
  // Main entry point
  // -------------------------------------------------------------------

  /**
   * Run the agent loop for a single user input.
   * Returns an async generator of AgentEvent for the TUI/CLI to consume.
   */
  async *run(userInput: string): AsyncIterable<AgentEvent> {
    this.turnCount = 0;
    this.totalUsage = { inputTokens: 0, outputTokens: 0 };
    this.aborted = false;
    this.controller = new AbortController();

    // Add user message to history
    this.config.contextAssembler.addMessage({ role: 'user', content: userInput });

    log.info(`Starting agent loop for: "${userInput.slice(0, 100)}..."`);

    try {
      while (this.turnCount < this.config.maxTurns && !this.aborted) {
        this.turnCount++;
        yield { type: 'turn_start', turnNumber: this.turnCount };

        // 1. Check token budget and compact if needed
        const history = this.config.contextAssembler.getHistory();
        if (this.config.tokenBudget.shouldCompact(history)) {
          log.info('Compacting conversation history');
          const compacted = this.config.tokenBudget.compact(history);
          // Replace history (ugly but works for MVP)
          this.config.contextAssembler.clearHistory();
          for (const msg of compacted.filter((m) => m.role !== 'system')) {
            this.config.contextAssembler.addMessage(msg);
          }
        }

        // 2. Assemble context
        const effectiveTools =
          this.config.getExposedToolDefinitions?.() ??
          this.config.exposedToolDefinitions ??
          this.config.toolDefinitions;
        const { messages } = this.config.contextAssembler.assemble(effectiveTools, {
          signal: this.controller.signal,
        });

        // 3. Stream LLM response — use exposedToolDefinitions so LLM only sees allowed tools
        const provider = this.config.provider;

        // Blocked tools: skip execution and return an error
        let assistantText = '';
        let assistantThinking = '';
        const pendingToolCalls: Map<string, { name: string; arguments: Record<string, unknown> }> =
          new Map();
        for await (const event of provider.streamChat(messages, effectiveTools, {
          ...this.config.streamOptions,
          signal: this.controller.signal,
        })) {
          if (this.aborted) break;

          switch (event.type) {
            case 'thinking_delta':
              assistantThinking += event.thinkingDelta;
              yield {
                type: 'assistant_thinking_delta',
                thinkingDelta: event.thinkingDelta,
                turnNumber: this.turnCount,
              };
              break;

            case 'text_delta':
              assistantText += event.textDelta;
              yield {
                type: 'assistant_text_delta',
                textDelta: event.textDelta,
                turnNumber: this.turnCount,
              };
              break;

            case 'tool_call_delta':
              break;

            case 'tool_call_end':
              pendingToolCalls.set(event.toolCallEnd.id, {
                name: event.toolCallEnd.name,
                arguments: event.toolCallEnd.arguments,
              });
              yield {
                type: 'tool_call_start',
                toolName: event.toolCallEnd.name,
                toolCallId: event.toolCallEnd.id,
                turnNumber: this.turnCount,
              };
              break;

            case 'message_end':
              if (event.usage) {
                this.totalUsage.inputTokens += event.usage.inputTokens;
                this.totalUsage.outputTokens += event.usage.outputTokens;
              }
              // If stop reason is 'end_turn' and no tool calls, we're done
              if (event.stopReason === 'end_turn' && pendingToolCalls.size === 0) {
                // Finalize this turn
                const assistantMsg: UnifiedMessage = {
                  role: 'assistant',
                  content: createAssistantContent(assistantText, assistantThinking),
                };
                this.config.contextAssembler.addMessage(assistantMsg);

                yield { type: 'turn_end', turnNumber: this.turnCount, usage: event.usage };

                // All done — nothing more to do
                yield {
                  type: 'done',
                  totalTurns: this.turnCount,
                  totalUsage: this.totalUsage,
                };
                return;
              }
              break;

            case 'error':
              yield { type: 'error', error: event.error, turnNumber: this.turnCount };
              return;
          }
        }

        if (this.aborted) {
          yield { type: 'interrupted' };
          return;
        }

        // 4. If we have tool calls, execute them
        if (pendingToolCalls.size > 0) {
          // Build assistant message with tool calls
          const contentBlocks: UnifiedContentBlock[] = [];
          if (assistantThinking) {
            contentBlocks.push({ type: 'thinking', thinking: assistantThinking });
          }
          if (assistantText) {
            contentBlocks.push({ type: 'text', text: assistantText });
          }

          const toolCalls: UnifiedMessage['toolCalls'] = [];
          for (const [id, tc] of pendingToolCalls) {
            contentBlocks.push({
              type: 'tool_use',
              id,
              name: tc.name,
              input: tc.arguments,
            });
            toolCalls.push({
              id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            });
          }

          const assistantMsg: UnifiedMessage = {
            role: 'assistant',
            content: contentBlocks,
            toolCalls,
          };
          this.config.contextAssembler.addMessage(assistantMsg);

          // Execute each tool call
          for (const [id, tc] of pendingToolCalls) {
            log.info(`Executing tool: ${tc.name}`);

            // Blocked tool check (e.g., plan mode)
            const isBlocked =
              this.config.isToolBlocked?.(tc.name) ??
              this.config.blockedTools?.has(tc.name) ??
              false;
            if (isBlocked) {
              const blockedResult: ToolResult = {
                success: false,
                content: '',
                error: `Tool '${tc.name}' is not available in plan mode. Use /exit-plan to leave plan mode and unlock tools.`,
              };
              yield {
                type: 'tool_call_end',
                toolCallId: id,
                result: blockedResult,
                turnNumber: this.turnCount,
              };
              this.config.contextAssembler.addMessage({
                role: 'tool',
                toolCallId: id,
                content: `Tool '${tc.name}' is not available in plan mode. Use /exit-plan to unlock.`,
              });
              continue;
            }

            // Permission check
            if (this.config.requestPermission) {
              const approved = await this.config.requestPermission(tc.name, tc.arguments);
              if (!approved) {
                const deniedResult: ToolResult = {
                  success: false,
                  content: '',
                  error: 'User denied permission',
                };
                yield {
                  type: 'tool_call_end',
                  toolCallId: id,
                  result: deniedResult,
                  turnNumber: this.turnCount,
                };
                this.config.contextAssembler.addMessage({
                  role: 'tool',
                  toolCallId: id,
                  content: `Permission denied: ${tc.name}`,
                });
                continue;
              }
            }

            const result = await this.config.executeTool(tc.name, tc.arguments);
            yield {
              type: 'tool_call_end',
              toolCallId: id,
              result,
              turnNumber: this.turnCount,
            };

            // Add tool result to history
            this.config.contextAssembler.addMessage({
              role: 'tool',
              toolCallId: id,
              content: result.success ? result.content : `Error: ${result.error}`,
            });
          }

          // Continue loop — LLM will process tool results
          yield { type: 'turn_end', turnNumber: this.turnCount, usage: null };
          continue;
        }

        // 5. No tool calls, finalize
        const finalAssistantMsg: UnifiedMessage = {
          role: 'assistant',
          content: createAssistantContent(assistantText, assistantThinking),
        };
        this.config.contextAssembler.addMessage(finalAssistantMsg);

        yield { type: 'turn_end', turnNumber: this.turnCount, usage: null };
        yield {
          type: 'done',
          totalTurns: this.turnCount,
          totalUsage: this.totalUsage,
        };
        return;
      }

      // Max turns reached
      yield {
        type: 'done',
        totalTurns: this.turnCount,
        totalUsage: this.totalUsage,
      };
    } catch (err) {
      if (!this.aborted) {
        const error = err instanceof Error ? err : new Error(String(err));
        yield { type: 'error', error, turnNumber: this.turnCount };
      }
    }
  }

  // -------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------

  interrupt(): void {
    log.info('Agent loop interrupted');
    this.aborted = true;
    this.controller.abort();
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  getTotalUsage(): UsageInfo {
    return { ...this.totalUsage };
  }
}

function createAssistantContent(
  text: string,
  thinking: string,
): string | UnifiedContentBlock[] {
  if (!thinking) return text;
  const content: UnifiedContentBlock[] = [{ type: 'thinking', thinking }];
  if (text) content.push({ type: 'text', text });
  return content;
}
