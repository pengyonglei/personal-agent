import OpenAI from 'openai';
import type { ModelConfig } from '@personal-agent/config';
import {
  ProviderFeature,
  type ModelInfo,
  type UnifiedContentBlock,
  type UnifiedMessage,
  type UnifiedToolDefinition,
} from '@personal-agent/shared';

// ---------------------------------------------------------------------------
// Shared helpers for OpenAI-compatible providers (OpenAI / DeepSeek)
// ---------------------------------------------------------------------------

/**
 * Convert a unified message to the OpenAI chat-completions wire format.
 *
 * @param includeReasoningContent When true, assistant `thinking` blocks are
 *   carried over as `reasoning_content` (DeepSeek requirement). OpenAI ignores
 *   the extra field, so the flag only controls whether it is emitted.
 */
export function toOpenAIMessage(
  msg: UnifiedMessage,
  includeReasoningContent = false,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (msg.role === 'assistant') {
    const textContent = typeof msg.content === 'string' ? msg.content : extractText(msg.content);

    const thinkingContent =
      typeof msg.content === 'string'
        ? ''
        : msg.content
            .filter((block) => block.type === 'thinking')
            .map((block) => (block as { thinking: string }).thinking)
            .join('\n');

    const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCalls.push({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        });
      }
    }

    const assistantMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam & {
      reasoning_content?: string;
    } = {
      role: 'assistant',
      content: textContent || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    };
    if (includeReasoningContent && thinkingContent) {
      assistantMessage.reasoning_content = thinkingContent;
    }
    return assistantMessage;
  }

  if (msg.role === 'tool') {
    const toolResult = extractToolResult(msg);
    // OpenAI 兼容协议（OpenAI / DeepSeek / Volcano）没有 is_error 字段，
    // 失败信号编码进 content 前缀；空输出兜底 '(no output)'（DeepSeek 等
    // 网关对空 content 行为不稳定）。
    const prefix = toolResult.isError ? '[tool error] ' : '';
    const text = toolResult.text || '(no output)';
    return {
      role: 'tool',
      tool_call_id: msg.toolCallId ?? '',
      content: prefix + text,
    };
  }

  // user
  if (typeof msg.content === 'string') {
    return { role: 'user', content: msg.content };
  }

  const parts: (
    OpenAI.Chat.ChatCompletionContentPartText | OpenAI.Chat.ChatCompletionContentPartImage
  )[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') {
      parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${b.source.mediaType};base64,${b.source.data}` },
      });
    }
  }

  return { role: 'user', content: parts };
}

/**
 * Build the full OpenAI message array: system prompt (collected from system
 * messages plus an explicit override) first, then the remaining messages.
 */
export function buildOpenAIMessages(
  messages: UnifiedMessage[],
  systemPrompt?: string,
  includeReasoningContent = false,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const systemMsg = messages.filter((m) => m.role === 'system');
  // 跳过损坏的 tool 消息（缺 toolCallId 的 tool 消息会被 OpenAI/DeepSeek
  // 网关拒绝，宁可丢弃也不发空 id）
  const nonSystem = messages.filter(
    (m) => !(m.role === 'tool' && !m.toolCallId) && m.role !== 'system',
  );

  const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = nonSystem.map((m) =>
    toOpenAIMessage(m, includeReasoningContent),
  );

  const systemContent = [
    ...systemMsg.map((m) => (typeof m.content === 'string' ? m.content : '')),
    systemPrompt ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');

  if (systemContent) {
    openaiMessages.unshift({ role: 'system', content: systemContent });
  }

  return openaiMessages;
}

/** Convert unified tool definitions to OpenAI function tools. */
export function buildOpenAITools(tools: UnifiedToolDefinition[]): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object' as const,
        properties: t.inputSchema.properties ?? {},
        required: t.inputSchema.required ?? [],
      },
    },
  }));
}

export function mapOpenAIStopReason(
  reason: string | null,
):
  'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'interrupted' | 'refusal' | 'unknown' {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'unknown';
  }
}

export function extractText(blocks: UnifiedContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool_result') {
      parts.push(typeof block.content === 'string' ? block.content : extractText(block.content));
    }
  }
  return parts.join('\n');
}

/**
 * 从 tool 消息中提取「文本内容 + 是否失败」。
 * 兼容两种历史形态：旧会话的纯字符串 content（靠 Error: 前缀识别失败），
 * 新会话的结构化 tool_result 块（靠 isError 字段）。
 */
export function extractToolResult(msg: UnifiedMessage): { text: string; isError: boolean } {
  if (typeof msg.content === 'string') {
    return { text: msg.content, isError: msg.content.startsWith('Error:') };
  }
  let text = '';
  let isError = false;
  for (const block of msg.content) {
    if (block.type !== 'tool_result') continue;
    text += typeof block.content === 'string' ? block.content : extractText(block.content);
    if (block.isError) isError = true;
  }
  return { text, isError };
}

export function safeJsonParse(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export interface ModelDefaults {
  contextWindow: number;
  maxOutputTokens: number;
  features: ProviderFeature[];
}

/**
 * Build a ModelInfo entry for a configured (possibly custom) model id.
 * Falls back to provider-specific defaults when no explicit config is given.
 */
export function createModelInfo(
  modelId: string,
  provider: string,
  defaults: ModelDefaults,
  config?: ModelConfig,
): ModelInfo {
  return {
    id: modelId,
    displayName: modelId,
    provider,
    contextWindow: config?.contextWindow ?? defaults.contextWindow,
    maxOutputTokens: config?.maxOutputTokens ?? defaults.maxOutputTokens,
    features: defaults.features,
  };
}
