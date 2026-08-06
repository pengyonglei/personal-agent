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
   * 运行智能体循环，处理一次完整的用户输入。
   *
   * 该方法是一个异步生成器（async generator），会持续产出 AgentEvent 事件，
   * 供 TUI / CLI / Web 等前端界面消费，以实现：
   *   - 流式输出（打字机效果，逐字/逐块显示模型回复与思考过程）
   *   - 工具调用的实时状态展示（开始、结束、结果）
   *   - 轮次切换与最终汇总（总轮数、Token 用量）
   *
   * 整体执行流程如下：
   *   1. 重置本次运行的状态（轮次计数、Token 用量、中断标志等）
   *   2. 将用户输入作为 user 消息写入对话历史
   *   3. 进入主循环（受 maxTurns 最大轮数和中断标志控制），每一轮迭代：
   *      a. 检查 Token 预算，若历史消息超限则先进行压缩（compact）
   *      b. 组装上下文（系统提示 + 历史消息 + 暴露给模型的工具定义）
   *      c. 流式调用 LLM，逐事件处理输出（思考增量、文本增量、工具调用等）
   *      d. 若模型发起了工具调用，则逐个执行（含禁用检查、权限确认、结果回写）
   *      e. 若模型本轮没有工具调用，则本轮结束，产出 done 事件
   *   4. 达到最大轮数（maxTurns）或收到中断信号时结束
   *   5. 整个过程包在 try/catch 中，未中断的异常会以 error 事件产出
   *
   * @param userInput 用户的输入消息文本
   * @returns 异步可迭代的 AgentEvent 事件流（消费方通过 for await 逐事件处理）
   */
  async *run(userInput: string): AsyncIterable<AgentEvent> {
    // ---- 1. 重置本次运行的状态 ----
    // 确保同一 AgentLoop 实例可以安全地多次调用 run()，互不干扰
    this.turnCount = 0;
    this.totalUsage = { inputTokens: 0, outputTokens: 0 };
    this.lastUsage = null;
    this.aborted = false;
    // 新建 AbortController：本次运行所有异步操作（LLM 流、工具执行等）
    // 都挂载它的 signal，外部调用 interrupt() 即可随时中断整个循环
    this.controller = new AbortController();

    // ---- 2. 将用户消息写入对话历史 ----
    // 该消息会在后续的上下文组装中被一起发送给模型
    this.config.contextAssembler.addMessage({ role: 'user', content: userInput });

    log.info(`Starting agent loop for: "${userInput.slice(0, 100)}..."`);

    try {
      // ---- 3. 主循环：每一轮 = 一次「模型调用 + 可能的工具执行」 ----
      // 循环条件：未达到最大轮数，且未被中断
      while (this.turnCount < this.config.maxTurns && !this.aborted) {
        this.turnCount++;
        // 通知前端：新一轮开始（前端可据此刷新界面状态）
        yield { type: 'turn_start', turnNumber: this.turnCount };

        // ---- 3a. 检查 Token 预算，必要时压缩历史 ----
        const history = this.config.contextAssembler.getHistory();
        // 若当前历史消息估算的 Token 数超出预算阈值，则触发压缩
        if (this.config.tokenBudget.shouldCompact(history)) {
          log.info('Compacting conversation history');
          // 调用 TokenBudget 的压缩策略（如摘要总结、丢弃早期消息等）
          const compacted = await this.config.tokenBudget.compact(history);
          // 用压缩后的消息替换原有历史（MVP 实现：先清空再逐条写入）
          // system 消息（系统提示）不参与替换，保持其原始内容
          this.config.contextAssembler.clearHistory();
          for (const msg of compacted.filter((m) => m.role !== 'system')) {
            this.config.contextAssembler.addMessage(msg);
          }
        }

        // ---- 3b. 组装上下文 ----
        // 确定本次暴露给模型的工具列表：
        //   优先取 getExposedToolDefinitions()（支持每轮动态变化，如计划模式切换），
        //   其次取静态的 exposedToolDefinitions（只读子集），
        //   兜底使用完整的 toolDefinitions
        const effectiveTools =
          this.config.getExposedToolDefinitions?.() ??
          this.config.exposedToolDefinitions ??
          this.config.toolDefinitions;
        // assemble() 会把系统提示、历史消息、工具定义等拼装成
        // 发送给模型的完整消息列表（可附带中断 signal）
        const { messages } = this.config.contextAssembler.assemble(effectiveTools, {
          signal: this.controller.signal,
        });

        // ---- 3c. 流式调用 LLM ----
        const provider = this.config.provider;

        // 以下变量用于跨事件累积本次模型调用的输出：
        //   assistantText       —— 模型回复的纯文本（按 text_delta 增量拼接）
        //   assistantThinking   —— 模型的思考过程文本（按 thinking_delta 增量拼接）
        //   responseMessageId   —— 本次响应的消息 ID（message_start 时获取）
        //   responseModel       —— 实际使用的模型名
        //   stopReason          —— 停止原因（end_turn / tool_use 等）
        //   responseUsage       —— 本次调用的 Token 用量
        //   pendingToolCalls    —— 模型发起但尚未执行的工具调用（Map：id -> 调用信息）
        let assistantText = '';
        let assistantThinking = '';
        let responseMessageId: string | undefined;
        let responseModel: string | undefined;
        let stopReason: StopReason | undefined;
        let responseUsage: UsageInfo | null = null;
        const pendingToolCalls: Map<string, { name: string; arguments: Record<string, unknown> }> =
          new Map();

        // ---- 模型调用诊断钩子（onModelCallStart / onModelCallEnd）----
        // 用于观测每次模型请求的开始/结束，方便调试与统计。
        // finishModelCall 保证无论正常结束、报错还是被中断，
        // onModelCallEnd 钩子都只会被触发一次（callFinished 幂等保护）。
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

        // 发起请求前先通知诊断钩子（钩子内部异常已被 safe* 包装吞掉，不影响主流程）
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
          // 逐事件消费模型返回的流式事件
          for await (const event of provider.streamChat(messages, effectiveTools, {
            ...this.config.streamOptions,
            signal: this.controller.signal,
          })) {
            // 若在流式输出过程中收到中断信号，立即停止消费剩余事件
            if (this.aborted) break;

            switch (event.type) {
              // 流开始：记录响应消息 ID 与模型名（供后续钩子与消息构建使用）
              case 'message_start':
                responseMessageId = event.messageId;
                responseModel = event.model;
                break;

              // 思考增量：累积思考文本，并实时转发给前端展示（如推理过程）
              case 'thinking_delta':
                assistantThinking += event.thinkingDelta;
                yield {
                  type: 'assistant_thinking_delta',
                  thinkingDelta: event.thinkingDelta,
                  turnNumber: this.turnCount,
                };
                break;

              // 文本增量：累积回复文本，并实时转发给前端（打字机效果）
              case 'text_delta':
                assistantText += event.textDelta;
                yield {
                  type: 'assistant_text_delta',
                  textDelta: event.textDelta,
                  turnNumber: this.turnCount,
                };
                break;

              // 工具调用参数增量：暂不处理，等 tool_call_end 拿到完整参数后再统一记录
              case 'tool_call_delta':
                break;

              // 工具调用结束：模型已给出完整的工具名和参数，登记到待执行列表
              case 'tool_call_end':
                pendingToolCalls.set(event.toolCallEnd.id, {
                  name: event.toolCallEnd.name,
                  arguments: event.toolCallEnd.arguments,
                });
                // 通知前端：某个工具即将开始执行（附带完整参数，供前端展示命令等）
                yield {
                  type: 'tool_call_start',
                  toolName: event.toolCallEnd.name,
                  toolCallId: event.toolCallEnd.id,
                  arguments: event.toolCallEnd.arguments,
                  turnNumber: this.turnCount,
                };
                break;

              // 流结束：记录停止原因与 Token 用量，并累计总用量
              case 'message_end':
                stopReason = event.stopReason;
                responseUsage = event.usage;
                this.lastUsage = event.usage ? { ...event.usage } : null;
                if (event.usage) {
                  this.totalUsage.inputTokens += event.usage.inputTokens;
                  this.totalUsage.outputTokens += event.usage.outputTokens;
                }
                // 关键分支：若模型停止原因是不需要继续（end_turn）且没有任何工具调用，
                // 说明模型已给出最终答复，本轮即为最后一轮 —— 直接收尾并结束整个循环
                if (event.stopReason === 'end_turn' && pendingToolCalls.size === 0) {
                  // 通知诊断钩子：本次模型调用正常完成
                  finishModelCall('completed');
                  // 将模型回复（含思考过程）写入对话历史，保证历史完整
                  const assistantMsg: UnifiedMessage = {
                    role: 'assistant',
                    content: createAssistantContent(assistantText, assistantThinking),
                  };
                  this.config.contextAssembler.addMessage(assistantMsg);

                  yield { type: 'turn_end', turnNumber: this.turnCount, usage: event.usage };

                  // 全部完成：产出 done 事件（总轮数 + 总 Token 用量），结束生成器
                  yield {
                    type: 'done',
                    totalTurns: this.turnCount,
                    totalUsage: this.totalUsage,
                  };
                  return;
                }
                break;

              // 模型流内部报错：通知钩子并产出 error 事件，立即终止
              case 'error':
                finishModelCall('error', event.error.message);
                yield { type: 'error', error: event.error, turnNumber: this.turnCount };
                return;
            }
          }
          // 流正常结束（或中断提前 break）：按实际状态收尾钩子
          finishModelCall(this.aborted ? 'interrupted' : 'completed');
        } catch (error) {
          // 模型调用抛出异常：区分「用户中断」与「真实错误」并上报钩子
          finishModelCall(
            this.aborted ? 'interrupted' : 'error',
            this.aborted ? undefined : formatError(error),
          );
          // 重新抛出，交由外层 catch 统一产出 error 事件
          throw error;
        }

        // 流式调用结束后再次检查中断标志（中断可能发生在流结束后、工具执行前）
        if (this.aborted) {
          yield { type: 'interrupted' };
          return;
        }

        // ---- 3d. 若模型发起了工具调用，则逐个执行 ----
        if (pendingToolCalls.size > 0) {
          // 先构建包含「思考 + 文本 + 工具调用」的 assistant 消息，
          // 这是 OpenAI/Anthropic 等 API 所要求的格式（消息内容与 toolCalls 字段一一对应）
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

          // 将 assistant 消息写入历史（必须先于工具结果写入，保持消息顺序正确）
          const assistantMsg: UnifiedMessage = {
            role: 'assistant',
            content: contentBlocks,
            toolCalls,
          };
          this.config.contextAssembler.addMessage(assistantMsg);

          // 逐个执行工具调用。每次 await 都与中断 signal 进行竞速（awaitWithAbort），
          // 这样即使某个工具不配合或卡死，也无法阻塞整个对话循环
          const completedToolCalls = new Set<string>();
          try {
            for (const [id, tc] of pendingToolCalls) {
              // 执行前检查中断标志（中断可能发生在等待期间）
              if (this.aborted) throw new AgentInterruptedError();
              log.info(`Executing tool: ${tc.name}`);

              // 禁用工具检查（例如计划模式 plan mode 下只读、不允许执行工具）：
              // 优先取动态判断函数 isToolBlocked，其次查静态集合 blockedTools
              const isBlocked =
                this.config.isToolBlocked?.(tc.name) ??
                this.config.blockedTools?.has(tc.name) ??
                false;
              if (isBlocked) {
                // 被禁用的工具：不执行，直接以失败结果回写历史并通知前端
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

              // 权限检查：若配置了 requestPermission，则执行前先征求用户同意
              if (this.config.requestPermission) {
                const approved = await awaitWithAbort(
                  this.config.requestPermission(tc.name, tc.arguments, this.controller.signal),
                  this.controller.signal,
                );
                // 等待授权期间可能收到中断信号
                if (this.aborted) throw new AgentInterruptedError();
                if (!approved) {
                  // 用户拒绝：不执行工具，以「权限被拒」结果回写历史并通知前端
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

              // 正式执行工具（与中断 signal 竞速，防止工具卡死）
              const result = await awaitWithAbort(
                this.config.executeTool(tc.name, tc.arguments, this.controller.signal),
                this.controller.signal,
              );
              if (this.aborted) throw new AgentInterruptedError();

              // 先写回历史、再产出事件：这样即使中途被中断，
              // 已完成的工具调用也必然带有对应的结果消息，保证 provider 历史合法
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
            // 工具执行阶段被中断（AgentInterruptedError）或抛出其他异常
            // 若非中断且未处于 aborted 状态，则属于真实错误，向上抛出
            if (!(error instanceof AgentInterruptedError) && !this.aborted) throw error;

            // 中断场景：为所有尚未完成的工具调用补发「已中断」结果。
            // 这样既能保持 provider 历史消息完整合法，也能让前端清理所有进行中的工具
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

          // 工具全部执行完毕后再次确认中断标志
          if (this.aborted) {
            yield { type: 'interrupted' };
            return;
          }

          // 本轮结束（工具结果已写入历史），continue 进入下一轮——
          // 下一轮模型会看到工具结果，并决定是继续调用工具还是给出最终答复
          yield { type: 'turn_end', turnNumber: this.turnCount, usage: null };
          continue;
        }

        // ---- 3e. 没有工具调用，收尾本轮 ----
        // 将模型的最终回复（含思考过程）写入对话历史
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

      // ---- 4. 达到最大轮数（maxTurns）仍未完成：直接产出 done 事件结束 ----
      yield {
        type: 'done',
        totalTurns: this.turnCount,
        totalUsage: this.totalUsage,
      };
    } catch (err) {
      // ---- 5. 兜底异常处理 ----
      // 仅当不是用户主动中断时才产出 error 事件；
      // 若已中断（aborted），中断相关事件（interrupted）已在上面产出，无需重复
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
