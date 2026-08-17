// ---------------------------------------------------------------------------
// Provider-neutral message types
// ---------------------------------------------------------------------------

/** Standard message roles in a conversation */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single message in the conversation history */
export interface UnifiedMessage {
  role: MessageRole;
  content: string | UnifiedContentBlock[];
  /**
   * 原始用户输入，仅用于界面回放。当不支持图片的模型需要先经过视觉模型转写时，
   * content 保存真正发送给文本模型的内容，displayContent 保留用户输入的文字和图片。
   */
  displayContent?: string | UnifiedContentBlock[];
  name?: string; // for tool-role messages: which tool produced this
  toolCallId?: string; // for tool-role messages: which tool_call is this the result for
  toolCalls?: UnifiedToolCall[]; // for assistant messages: tool calls the assistant requested
  /** 该条 assistant 回复的总耗时（ms）。由 AgentLoop 在任务结束时写入，随会话持久化；前端刷新后从 history 恢复展示。 */
  durationMs?: number;
  /** 该条 assistant 回复所属任务结束时间（ISO 字符串）。由 AgentLoop 在任务结束时写入，随会话持久化。 */
  finishedAt?: string;
  /** 该条 assistant 回复的首 token 时间（TTFT，ms），取本次任务中首个模型调用的首个内容 token 到达时间。 */
  ttftMs?: number;
  /** 该条 assistant 回复的模型输出 token 速度（token/秒）= 总输出 token 数 / 模型总耗时。 */
  tokensPerSecond?: number;
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export type UnifiedContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ImageContentBlock
  | ThinkingContentBlock;

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  toolUseId: string;
  /**
   * 工具输出。支持多块（如 text + image），兼容旧的纯字符串形式。
   * 注意：传给模型的文本由 Provider 序列化层提取，此处保留结构化内容。
   */
  content: string | UnifiedContentBlock[];
  /** true = 工具执行失败（与 Anthropic wire 的 is_error 对应） */
  isError?: boolean;
  /** 结构化错误消息（区别于展示文本 content） */
  error?: string;
  /** 对模型有决策价值的元数据（展示用元数据如 duration 不进上下文） */
  metadata?: {
    truncated?: boolean;
    fileModified?: string[];
    tasks?: Array<{ status: string; subject: string }>;
    interrupted?: boolean;
  };
}

export interface ImageContentBlock {
  type: 'image';
  /** 原始附件名，仅用于界面展示，Provider 会忽略该字段。 */
  name?: string;
  source: {
    data: string; // base64
    mediaType: string;
  };
}

export interface ThinkingContentBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

// ---------------------------------------------------------------------------
// Tool call type (used on assistant messages)
// ---------------------------------------------------------------------------

export interface UnifiedToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON-encoded string
  };
}

// ---------------------------------------------------------------------------
// Tool definitions (provider-neutral)
// ---------------------------------------------------------------------------

export interface UnifiedToolDefinition {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JSONSchema;
  enum?: string[];
  description?: string;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: JSONSchema;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
}

// ---------------------------------------------------------------------------
// Streaming event types (provider-neutral)
// ---------------------------------------------------------------------------

export type UnifiedStreamEvent =
  | { type: 'message_start'; messageId: string; model: string }
  | { type: 'text_delta'; textDelta: string }
  | { type: 'tool_call_delta'; toolCallDelta: ToolCallDelta }
  | { type: 'tool_call_end'; toolCallEnd: ToolCallEnd }
  | { type: 'thinking_delta'; thinkingDelta: string }
  | { type: 'message_end'; stopReason: StopReason; usage: UsageInfo | null }
  | { type: 'error'; error: Error };

export interface ToolCallDelta {
  id: string;
  name?: string; // present on first delta
  arguments?: string; // incremental JSON fragment
}

export interface ToolCallEnd {
  id: string;
  name: string;
  arguments: Record<string, unknown>; // fully parsed
}

export type StopReason =
  'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'interrupted' | 'refusal' | 'unknown';

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  /** 命中缓存的输入 token 数（如 DeepSeek 的 prompt_cache_hit_tokens）。其他模型不提供该字段。 */
  cacheHitTokens?: number | null;
}

// ---------------------------------------------------------------------------
// Streaming options
// ---------------------------------------------------------------------------

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max' | 'xhigh';

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ChatOptions extends StreamOptions {
  jsonMode?: boolean;
}

// ---------------------------------------------------------------------------
// Unified response (non-streaming)
// ---------------------------------------------------------------------------

export interface UnifiedResponse {
  id: string;
  model: string;
  content: UnifiedContentBlock[];
  stopReason: StopReason;
  usage: UsageInfo;
}

// ---------------------------------------------------------------------------
// Tool execution types
// ---------------------------------------------------------------------------

export interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
  metadata?: {
    duration: number;
    tokensUsed?: number;
    fileModified?: string[];
    truncated?: boolean;
    interrupted?: boolean;
    /** Structured tasks from todo_write, so UIs can render icons instead of plain text. */
    tasks?: Array<{ status: string; subject: string }>;
  };
}

// ---------------------------------------------------------------------------
// Interactive user questions (ask_user)
// ---------------------------------------------------------------------------

/**
 * A question posed to the user through the ask_user tool. The UI renders it
 * as a single-select (radio) or multi-select (checkbox) list, capped at 4
 * model-recommended options, plus a built-in "custom answer" option.
 */
export interface UserQuestion {
  id: string;
  /** The question text shown to the user */
  question: string;
  /** Model-recommended answers (at most 4) */
  options: string[];
  /** true = multi-select (checkbox), false = single-select (radio) */
  multiSelect: boolean;
  /** Whether to include the "custom answer" option (default true) */
  allowCustom: boolean;
}

/** The user's answer to a UserQuestion. */
export interface UserAnswer {
  /** Selected recommended options (empty when a custom answer is given) */
  selections: string[];
  /** Custom free-text answer; present when the user chose "custom answer" */
  custom?: string;
}

// ---------------------------------------------------------------------------
// Provider feature flags
// ---------------------------------------------------------------------------

export enum ProviderFeature {
  Streaming = 'streaming',
  ToolCalling = 'tool_calling',
  ParallelToolCalls = 'parallel_tool_calls',
  ImageInput = 'image_input',
  Thinking = 'thinking',
  PromptCaching = 'prompt_caching',
  ComputerUse = 'computer_use',
}

// ---------------------------------------------------------------------------
// Model info
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  features: ProviderFeature[];
  /**
   * 该模型可选的思考强度档位（6 档中任选的子集）。仅当模型显式配置了
   * reasoningOptions 时存在；未配置 = 不支持/不开启思考。
   */
  reasoningOptions?: ReasoningEffort[];
  pricing?: {
    inputPer1k: number;
    outputPer1k: number;
    cacheWritePer1k?: number;
    cacheReadPer1k?: number;
  };
}

// ---------------------------------------------------------------------------
// Agent loop events (emitted by core for TUI / CLI to consume)
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'turn_start'; turnNumber: number }
  /**
   * 执行期间注入的用户消息已被吸取并写入对话历史，模型将在当前/下一轮
   * 开始回应它。前端可据此开启新的一轮回复展示（而不是合并进上一轮回复）。
   */
  | { type: 'inject_user_message_applied'; turnNumber: number }
  | { type: 'assistant_thinking_delta'; thinkingDelta: string; turnNumber: number }
  | { type: 'assistant_text_delta'; textDelta: string; turnNumber: number }
  | {
      type: 'tool_call_start';
      toolName: string;
      toolCallId: string;
      arguments: Record<string, unknown>;
      turnNumber: number;
    }
  | { type: 'tool_call_progress'; toolCallId: string; content: string; turnNumber: number }
  | { type: 'tool_call_end'; toolCallId: string; result: ToolResult; turnNumber: number }
  | { type: 'permission_request'; toolName: string; params: Record<string, unknown> }
  | { type: 'turn_end'; turnNumber: number; usage: UsageInfo | null }
  | { type: 'context_compacting' }
  | { type: 'context_compacted' }
  | { type: 'error'; error: Error; turnNumber: number }
  | {
      type: 'interrupted';
      finishedAt?: string;
      ttftMs?: number;
      tokensPerSecond?: number;
    }
  | {
      type: 'done';
      totalTurns: number;
      totalUsage: UsageInfo;
      finishedAt?: string;
      ttftMs?: number;
      tokensPerSecond?: number;
    };

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

export interface SessionState {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  messages: UnifiedMessage[];
  summary?: string;
  metadata: SessionMetadata;
}

export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SessionMetadata {
  workingDirectory: string;
  model: string;
  provider: string;
  totalTokensUsed: number;
  totalCost: number;
  turnCount: number;
  /**
   * Token usage tracked per model, keyed by `${provider}:${model}`.
   * Lets each model used within a session be counted independently and
   * persisted across restarts.
   */
  tokensUsedByModel?: Record<string, ModelTokenUsage>;
  /**
   * Input tokens of the most recent model request within this session.
   * Used as the "used context" indicator (persisted so it survives restarts).
   */
  lastInputTokens?: number;
  /**
   * 每个模型最近一次请求的输入 tokens，keyed by `${provider}:${model}`。
   * 任务在会话中切换模型后，仪表盘按当前模型显示各自的已用上下文；
   * 刷新/重启后按当前模型恢复，而不是显示别的模型的值或 0。
   */
  lastInputTokensByModel?: Record<string, number>;
  /**
   * 最近一次模型请求中命中缓存的输入 tokens（仅 deepseek 等模型提供），
   * 与 lastInputTokens 一同持久化，刷新/重启后上下文仪表盘的缓存命中占比不丢失。
   */
  lastCacheHitTokens?: number;
  /**
   * 每个模型最近一次请求的缓存命中 tokens，keyed by `${provider}:${model}`，
   * 与 lastInputTokensByModel 对称：切换模型后按当前模型恢复各自的值。
   */
  lastCacheHitTokensByModel?: Record<string, number>;
}
