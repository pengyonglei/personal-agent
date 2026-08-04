import type {
  UnifiedMessage,
  UnifiedContentBlock,
  UnifiedToolDefinition,
  UnifiedStreamEvent,
  StreamOptions,
  AgentEvent,
  UsageInfo,
  ToolResult,
  StopReason,
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
  executeTool: (
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ToolResult>;
  /** Optional: override the tool definitions used for the LLM prompt (e.g., readonly subset) */
  exposedToolDefinitions?: UnifiedToolDefinition[];
  /** Optional: resolve tool definitions for every turn (e.g., when plan mode changes). */
  getExposedToolDefinitions?: () => UnifiedToolDefinition[];
  /** Optional: set of tool names that are blocked from execution */
  blockedTools?: Set<string>;
  /** Optional: dynamically decide whether a tool is blocked. */
  isToolBlocked?: (toolName: string) => boolean;
  /** Called to request user permission for a tool */
  requestPermission?: (
    toolName: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<boolean>;
  /** Provider options applied to every model turn. */
  streamOptions?: Omit<StreamOptions, 'signal'>;
  /** Optional diagnostics hook fired immediately before every provider request. */
  onModelCallStart?: (call: ModelCallDebugStart) => void;
  /** Optional diagnostics hook fired when a provider request finishes. */
  onModelCallEnd?: (call: ModelCallDebugEnd) => void;
}

export interface ModelCallDebugStart {
  callId: string;
  turnNumber: number;
  provider: string;
  model: string;
  startedAt: string;
  request: {
    messages: UnifiedMessage[];
    tools: UnifiedToolDefinition[];
    options: Omit<StreamOptions, 'signal'>;
  };
}

export interface ModelCallDebugEnd {
  callId: string;
  finishedAt: string;
  durationMs: number;
  status: 'completed' | 'error' | 'interrupted';
  response: {
    messageId?: string;
    model?: string;
    text: string;
    thinking: string;
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    stopReason?: StopReason;
    usage: UsageInfo | null;
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export class AgentLoop {
  private config: AgentLoopConfig;
  private turnCount = 0;
  private totalUsage: UsageInfo = { inputTokens: 0, outputTokens: 0 };
  private lastUsage: UsageInfo | null = null;
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
    this.lastUsage = null;
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
          const compacted = await this.config.tokenBudget.compact(history);
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
        let responseMessageId: string | undefined;
        let responseModel: string | undefined;
        let stopReason: StopReason | undefined;
        let responseUsage: UsageInfo | null = null;
        const pendingToolCalls: Map<string, { name: string; arguments: Record<string, unknown> }> =
          new Map();
        const callId = generateId();
        const callStartedAt = Date.now();
        let callFinished = false;
        const finishModelCall = (status: ModelCallDebugEnd['status'], error?: string): void => {
          if (callFinished) return;
          callFinished = true;
          this.safeNotifyModelCallEnd({
            callId,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - callStartedAt,
            status,
            response: {
              messageId: responseMessageId,
              model: responseModel,
              text: assistantText,
              thinking: assistantThinking,
              toolCalls: Array.from(pendingToolCalls, ([id, toolCall]) => ({
                id,
                name: toolCall.name,
                arguments: toolCall.arguments,
              })),
              stopReason,
              usage: responseUsage,
            },
            error,
          });
        };

        this.safeNotifyModelCallStart({
          callId,
          turnNumber: this.turnCount,
          provider: provider.providerId,
          model: provider.getModel(),
          startedAt: new Date(callStartedAt).toISOString(),
          request: {
            messages,
            tools: effectiveTools,
            options: { ...this.config.streamOptions },
          },
        });

        try {
          for await (const event of provider.streamChat(messages, effectiveTools, {
            ...this.config.streamOptions,
            signal: this.controller.signal,
          })) {
            if (this.aborted) break;

            switch (event.type) {
              case 'message_start':
                responseMessageId = event.messageId;
                responseModel = event.model;
                break;

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
                stopReason = event.stopReason;
                responseUsage = event.usage;
                this.lastUsage = event.usage ? { ...event.usage } : null;
                if (event.usage) {
                  this.totalUsage.inputTokens += event.usage.inputTokens;
                  this.totalUsage.outputTokens += event.usage.outputTokens;
                }
                // If stop reason is 'end_turn' and no tool calls, we're done
                if (event.stopReason === 'end_turn' && pendingToolCalls.size === 0) {
                  finishModelCall('completed');
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
                finishModelCall('error', event.error.message);
                yield { type: 'error', error: event.error, turnNumber: this.turnCount };
                return;
            }
          }
          finishModelCall(this.aborted ? 'interrupted' : 'completed');
        } catch (error) {
          finishModelCall(
            this.aborted ? 'interrupted' : 'error',
            this.aborted ? undefined : formatError(error),
          );
          throw error;
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

          // Execute each tool call. Waiting is raced against the agent signal so a
          // non-cooperative or stuck tool cannot keep the whole conversation busy.
          const completedToolCalls = new Set<string>();
          try {
            for (const [id, tc] of pendingToolCalls) {
              if (this.aborted) throw new AgentInterruptedError();
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
                this.config.contextAssembler.addMessage({
                  role: 'tool',
                  toolCallId: id,
                  content: `Tool '${tc.name}' is not available in plan mode. Use /exit-plan to unlock.`,
                });
                completedToolCalls.add(id);
                yield {
                  type: 'tool_call_end',
                  toolCallId: id,
                  result: blockedResult,
                  turnNumber: this.turnCount,
                };
                continue;
              }

              // Permission check
              if (this.config.requestPermission) {
                const approved = await awaitWithAbort(
                  this.config.requestPermission(tc.name, tc.arguments, this.controller.signal),
                  this.controller.signal,
                );
                if (this.aborted) throw new AgentInterruptedError();
                if (!approved) {
                  const deniedResult: ToolResult = {
                    success: false,
                    content: '',
                    error: 'User denied permission',
                  };
                  this.config.contextAssembler.addMessage({
                    role: 'tool',
                    toolCallId: id,
                    content: `Permission denied: ${tc.name}`,
                  });
                  completedToolCalls.add(id);
                  yield {
                    type: 'tool_call_end',
                    toolCallId: id,
                    result: deniedResult,
                    turnNumber: this.turnCount,
                  };
                  continue;
                }
              }

              const result = await awaitWithAbort(
                this.config.executeTool(tc.name, tc.arguments, this.controller.signal),
                this.controller.signal,
              );
              if (this.aborted) throw new AgentInterruptedError();

              // Add tool result to history before yielding so interruption cannot
              // leave a completed tool call without its matching result message.
              this.config.contextAssembler.addMessage({
                role: 'tool',
                toolCallId: id,
                content: result.success ? result.content : `Error: ${result.error}`,
              });
              completedToolCalls.add(id);
              yield {
                type: 'tool_call_end',
                toolCallId: id,
                result,
                turnNumber: this.turnCount,
              };
            }
          } catch (error) {
            if (!(error instanceof AgentInterruptedError) && !this.aborted) throw error;

            // Complete every outstanding tool call with an interrupted result. This
            // keeps provider history valid and lets the UI clear all running tools.
            for (const [id] of pendingToolCalls) {
              if (completedToolCalls.has(id)) continue;
              const interruptedResult = createInterruptedToolResult();
              this.config.contextAssembler.addMessage({
                role: 'tool',
                toolCallId: id,
                content: `Error: ${interruptedResult.error}`,
              });
              yield {
                type: 'tool_call_end',
                toolCallId: id,
                result: interruptedResult,
                turnNumber: this.turnCount,
              };
            }
            yield { type: 'interrupted' };
            return;
          }

          if (this.aborted) {
            yield { type: 'interrupted' };
            return;
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

  /**
   * Usage of the most recent model request (null if none completed yet).
   * The input token count reflects the exact context size the last request
   * was sent with.
   */
  getLastUsage(): UsageInfo | null {
    return this.lastUsage ? { ...this.lastUsage } : null;
  }

  private safeNotifyModelCallStart(call: ModelCallDebugStart): void {
    try {
      this.config.onModelCallStart?.(call);
    } catch (error) {
      log.warn(`Model call start hook failed: ${formatError(error)}`);
    }
  }

  private safeNotifyModelCallEnd(call: ModelCallDebugEnd): void {
    try {
      this.config.onModelCallEnd?.(call);
    } catch (error) {
      log.warn(`Model call end hook failed: ${formatError(error)}`);
    }
  }
}

function createAssistantContent(text: string, thinking: string): string | UnifiedContentBlock[] {
  if (!thinking) return text;
  const content: UnifiedContentBlock[] = [{ type: 'thinking', thinking }];
  if (text) content.push({ type: 'text', text });
  return content;
}

class AgentInterruptedError extends Error {
  constructor() {
    super('Agent execution interrupted');
    this.name = 'AgentInterruptedError';
  }
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AgentInterruptedError());

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(new AgentInterruptedError());
    };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);

    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function createInterruptedToolResult(): ToolResult {
  return {
    success: false,
    content: '',
    error: 'Tool execution interrupted by user',
    metadata: { duration: 0, interrupted: true },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
