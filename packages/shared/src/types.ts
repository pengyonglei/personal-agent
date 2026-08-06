// ---------------------------------------------------------------------------
// Provider-neutral message types
// ---------------------------------------------------------------------------

/** Standard message roles in a conversation */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single message in the conversation history */
export interface UnifiedMessage {
  role: MessageRole;
  content: string | UnifiedContentBlock[];
  name?: string; // for tool-role messages: which tool produced this
  toolCallId?: string; // for tool-role messages: which tool_call is this the result for
  toolCalls?: UnifiedToolCall[]; // for assistant messages: tool calls the assistant requested
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
  content: string;
  isError?: boolean;
}

export interface ImageContentBlock {
  type: 'image';
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
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'interrupted'
  | 'refusal'
  | 'unknown';

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
}

// ---------------------------------------------------------------------------
// Streaming options
// ---------------------------------------------------------------------------

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

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
  };
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
  | { type: 'assistant_thinking_delta'; thinkingDelta: string; turnNumber: number }
  | { type: 'assistant_text_delta'; textDelta: string; turnNumber: number }
  | { type: 'tool_call_start'; toolName: string; toolCallId: string; arguments: Record<string, unknown>; turnNumber: number }
  | { type: 'tool_call_progress'; toolCallId: string; content: string; turnNumber: number }
  | { type: 'tool_call_end'; toolCallId: string; result: ToolResult; turnNumber: number }
  | { type: 'permission_request'; toolName: string; params: Record<string, unknown> }
  | { type: 'turn_end'; turnNumber: number; usage: UsageInfo | null }
  | { type: 'error'; error: Error; turnNumber: number }
  | { type: 'interrupted' }
  | { type: 'done'; totalTurns: number; totalUsage: UsageInfo };

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
}
