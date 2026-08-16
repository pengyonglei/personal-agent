import OpenAI from 'openai';
import type { ModelConfig } from '@personal-agent/config';
import {
  ProviderFeature,
  type ChatOptions,
  type ModelInfo,
  type ReasoningEffort,
  type StreamOptions,
  type UnifiedContentBlock,
  type UnifiedMessage,
  type UnifiedResponse,
  type UnifiedStreamEvent,
  type UnifiedToolDefinition,
} from '@personal-agent/shared';
import { BaseLLMProvider } from './interface';
import {
  buildOpenAIMessages,
  buildOpenAITools,
  createModelInfo,
  mapOpenAIStopReason,
  safeJsonParse,
} from './openai-compat';

// ---------------------------------------------------------------------------
// DeepSeek model definitions
// ---------------------------------------------------------------------------

const DEEPSEEK_MODELS: ModelInfo[] = [
  {
    id: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
      ProviderFeature.Thinking,
    ],
  },
  {
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
      ProviderFeature.Thinking,
    ],
  },
];

const MODEL_DEFAULTS = {
  contextWindow: 1_000_000,
  maxOutputTokens: 384_000,
  features: [
    ProviderFeature.Streaming,
    ProviderFeature.ToolCalling,
    ProviderFeature.ParallelToolCalls,
    ProviderFeature.Thinking,
  ],
} satisfies Omit<ModelInfo, 'id' | 'displayName' | 'provider'>;

/** DeepSeek extra request fields (OpenAI-compatible API). */
interface DeepSeekThinkingOptions {
  thinking: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'high' | 'max' | 'low';
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class DeepSeekProvider extends BaseLLMProvider {
  readonly providerId = 'deepseek';
  readonly displayName = 'DeepSeek';

  private client: OpenAI | null = null;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(
    apiKey: string,
    defaultModel = 'deepseek-v4-flash',
    baseURL = 'https://api.deepseek.com',
    configuredModels: Array<string | ModelConfig> = [],
  ) {
    super(normalizeDeepSeekModel(defaultModel));
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.models = [...DEEPSEEK_MODELS];
    this.addConfiguredModels(configuredModels, (modelId, config) =>
      createModelInfo(modelId, this.providerId, MODEL_DEFAULTS, config),
    );
    this.addConfiguredModels([this.currentModel], (modelId, config) =>
      createModelInfo(modelId, this.providerId, MODEL_DEFAULTS, config),
    );
  }

  async initialize(): Promise<void> {
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseURL,
    });
  }

  async dispose(): Promise<void> {
    this.client = null;
  }

  supportsFeature(feature: ProviderFeature): boolean {
    const model = this.models.find((m) => m.id === this.currentModel);
    return model?.features.includes(feature) ?? false;
  }

  // -----------------------------------------------------------------------
  // Streaming
  // -----------------------------------------------------------------------

  async *streamChat(
    messages: UnifiedMessage[],
    tools: UnifiedToolDefinition[],
    options: StreamOptions,
  ): AsyncIterable<UnifiedStreamEvent> {
    if (!this.client) throw new Error('Provider not initialized. Call initialize() first.');

    const model = options.model ?? this.currentModel;
    const thinking = getDeepSeekThinkingOptions(options.reasoningEffort);

    const openaiMessages = buildOpenAIMessages(messages, options.systemPrompt, true);
    const openaiTools = buildOpenAITools(tools);

    try {
      const stream = await this.client.chat.completions.create({
        model,
        max_tokens: options.maxTokens,
        temperature: thinking?.thinking.type === 'enabled' ? undefined : options.temperature,
        messages: openaiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: true,
        stream_options: { include_usage: true },
        ...thinking,
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming & DeepSeekThinkingOptions);

      let accumulatedToolCalls: Map<number, { id: string; name: string; arguments: string }> =
        new Map();

      for await (const chunk of stream) {
        if (options.signal?.aborted) {
          stream.controller.abort();
          break;
        }

        const delta = chunk.choices[0]?.delta;
        const reasoningContent = (
          delta as (typeof delta & { reasoning_content?: string }) | undefined
        )?.reasoning_content;

        if (reasoningContent) {
          yield { type: 'thinking_delta', thinkingDelta: reasoningContent };
        }

        if (delta?.content) {
          yield { type: 'text_delta', textDelta: delta.content };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            const existing = accumulatedToolCalls.get(idx) ?? { id: '', name: '', arguments: '' };

            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.name = tc.function.name;
            if (tc.function?.arguments) existing.arguments += tc.function.arguments;

            accumulatedToolCalls.set(idx, existing);

            const isFirstChunk =
              !accumulatedToolCalls.get(idx) || !accumulatedToolCalls.get(idx)!.name;
            yield {
              type: 'tool_call_delta',
              toolCallDelta: {
                id: existing.id,
                name: isFirstChunk ? existing.name : undefined,
                arguments: tc.function?.arguments ?? '',
              },
            };
          }
        }

        // Check for finish
        if (chunk.choices[0]?.finish_reason) {
          // Emit tool_call_end for each completed tool call
          for (const [, tc] of accumulatedToolCalls) {
            const parsed = safeJsonParse(tc.arguments);
            if (parsed) {
              yield {
                type: 'tool_call_end',
                toolCallEnd: { id: tc.id, name: tc.name, arguments: parsed },
              };
            }
          }

          const usage = chunk.usage;
          // DeepSeek 扩展字段（OpenAI SDK 的 CompletionUsage 类型未包含）
          const deepseekUsage = usage as
            | (typeof usage & {
                prompt_cache_hit_tokens?: number;
              })
            | undefined;
          yield {
            type: 'message_end',
            stopReason: mapOpenAIStopReason(chunk.choices[0].finish_reason),
            usage: usage
              ? {
                  inputTokens: usage.prompt_tokens,
                  outputTokens: usage.completion_tokens,
                  cacheHitTokens: deepseekUsage?.prompt_cache_hit_tokens ?? null,
                }
              : null,
          };
        }
      }
    } catch (err) {
      if (options.signal?.aborted) {
        yield { type: 'message_end', stopReason: 'interrupted', usage: null };
        return;
      }
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  // -----------------------------------------------------------------------
  // Non-streaming
  // -----------------------------------------------------------------------

  async chat(
    messages: UnifiedMessage[],
    tools?: UnifiedToolDefinition[],
    options?: ChatOptions,
  ): Promise<UnifiedResponse> {
    if (!this.client) throw new Error('Provider not initialized. Call initialize() first.');

    const model = options?.model ?? this.currentModel;
    const thinking = getDeepSeekThinkingOptions(options?.reasoningEffort);

    const openaiMessages = buildOpenAIMessages(messages, options?.systemPrompt, true);
    const openaiTools = tools && tools.length > 0 ? buildOpenAITools(tools) : undefined;

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: options?.maxTokens,
      temperature: thinking?.thinking.type === 'enabled' ? undefined : options?.temperature,
      messages: openaiMessages,
      tools: openaiTools,
      ...thinking,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & DeepSeekThinkingOptions);

    const choice = response.choices[0];
    const content: UnifiedContentBlock[] = [];
    const toolCalls: UnifiedMessage['toolCalls'] = [];
    const reasoningContent = (
      choice?.message as (typeof choice.message & { reasoning_content?: string }) | undefined
    )?.reasoning_content;

    if (reasoningContent) {
      content.push({ type: 'thinking', thinking: reasoningContent });
    }

    if (choice?.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    if (choice?.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        const args = safeJsonParse(tc.function.arguments) ?? {};
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: args,
        });
        toolCalls.push({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        });
      }
    }

    // DeepSeek 扩展字段（OpenAI SDK 的 CompletionUsage 类型未包含）
    const deepseekUsage = response.usage as
      | (typeof response.usage & {
          prompt_cache_hit_tokens?: number;
        })
      | undefined;
    return {
      id: response.id,
      model: response.model,
      content,
      stopReason: mapOpenAIStopReason(choice?.finish_reason ?? null),
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            cacheHitTokens: deepseekUsage?.prompt_cache_hit_tokens ?? null,
          }
        : { inputTokens: 0, outputTokens: 0 },
    };
  }
}

// -----------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------

/**
 * Map legacy DeepSeek model ids to the current lineup. Unknown ids pass
 * through unchanged so custom models keep working.
 */
export function normalizeDeepSeekModel(model?: string): string {
  if (!model || model === 'deepseek-chat' || model === 'deepseek-reasoner') {
    return 'deepseek-v4-flash';
  }
  return model;
}

/**
 * DeepSeek thinking is a boolean toggle plus an effort hint. The API exposes
 * off / low / high / max; 'medium' is not supported and maps to 'low' (the
 * closest supported level). When thinking is enabled the temperature parameter
 * must be omitted (the API rejects the combination).
 */
function getDeepSeekThinkingOptions(
  effort: ReasoningEffort | undefined,
): DeepSeekThinkingOptions | undefined {
  if (effort === 'off') return { thinking: { type: 'disabled' } };
  return {
    thinking: { type: 'enabled' },
    reasoning_effort:
      effort === 'max' || effort === 'xhigh' ? 'max' : effort === 'high' ? 'high' : 'low',
  };
}
