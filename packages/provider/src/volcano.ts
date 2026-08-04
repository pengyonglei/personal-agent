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
// Volcano Ark (火山方舟) model definitions
// ---------------------------------------------------------------------------
// The platform is OpenAI-compatible (https://ark.cn-beijing.volces.com/api/v3).
// Models are referenced either by inference endpoint id (ep-xxxx) or by model
// name; both work interchangeably, so the list below is only a convenience —
// any custom id can be configured.

const VOLCANO_ARK_MODELS: ModelInfo[] = [
  {
    id: 'doubao-seed-1-6-250615',
    displayName: '豆包 Seed 1.6',
    provider: 'volcano',
    contextWindow: 256_000,
    maxOutputTokens: 16_384,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
    ],
  },
  {
    id: 'doubao-1-5-pro-32k-250115',
    displayName: '豆包 1.5 Pro 32K',
    provider: 'volcano',
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
    ],
  },
  {
    id: 'doubao-seed-thinking-250615',
    displayName: '豆包 Seed Thinking',
    provider: 'volcano',
    contextWindow: 256_000,
    maxOutputTokens: 16_384,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
      ProviderFeature.Thinking,
    ],
  },
  {
    id: 'deepseek-v3-250324',
    displayName: 'DeepSeek V3（火山方舟）',
    provider: 'volcano',
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
    ],
  },
  {
    id: 'deepseek-r1-250528',
    displayName: 'DeepSeek R1（火山方舟）',
    provider: 'volcano',
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
      ProviderFeature.Thinking,
    ],
  },
];

const MODEL_DEFAULTS = {
  contextWindow: 256_000,
  maxOutputTokens: 16_384,
  features: [
    ProviderFeature.Streaming,
    ProviderFeature.ToolCalling,
    ProviderFeature.ParallelToolCalls,
  ],
} satisfies Omit<ModelInfo, 'id' | 'displayName' | 'provider'>;

/** Volcano Ark extra request fields (OpenAI-compatible API). */
interface VolcanoThinkingOptions {
  thinking: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class VolcanoArkProvider extends BaseLLMProvider {
  readonly providerId = 'volcano';
  readonly displayName = '火山方舟';

  private client: OpenAI | null = null;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(
    apiKey: string,
    defaultModel = 'doubao-seed-1-6-250615',
    baseURL = 'https://ark.cn-beijing.volces.com/api/v3',
    configuredModels: Array<string | ModelConfig> = [],
  ) {
    super(defaultModel);
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.models = [...VOLCANO_ARK_MODELS];
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
    const thinking = getVolcanoThinkingOptions(options.reasoningEffort);

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
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming & VolcanoThinkingOptions);

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
          yield {
            type: 'message_end',
            stopReason: mapOpenAIStopReason(chunk.choices[0].finish_reason),
            usage: usage
              ? {
                  inputTokens: usage.prompt_tokens,
                  outputTokens: usage.completion_tokens,
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
    const thinking = getVolcanoThinkingOptions(options?.reasoningEffort);

    const openaiMessages = buildOpenAIMessages(messages, options?.systemPrompt, true);
    const openaiTools = tools && tools.length > 0 ? buildOpenAITools(tools) : undefined;

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: options?.maxTokens,
      temperature: thinking?.thinking.type === 'enabled' ? undefined : options?.temperature,
      messages: openaiMessages,
      tools: openaiTools,
      ...thinking,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & VolcanoThinkingOptions);

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

    return {
      id: response.id,
      model: response.model,
      content,
      stopReason: mapOpenAIStopReason(choice?.finish_reason ?? null),
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : { inputTokens: 0, outputTokens: 0 },
    };
  }
}

// -----------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------

/**
 * Volcano Ark thinking control. Unlike DeepSeek, ordinary Doubao models
 * reject the `thinking` parameter, so it is only sent when the caller
 * explicitly enables thinking; 'off' (or no effort) leaves the model's
 * default behavior untouched.
 *
 * Effort mapping: 'low' | 'medium' | 'high' pass through; 'max' is not
 * exposed by the API and maps to 'high'.
 */
function getVolcanoThinkingOptions(
  effort: ReasoningEffort | undefined,
): VolcanoThinkingOptions | undefined {
  if (!effort || effort === 'off') return undefined;
  return {
    thinking: { type: 'enabled' },
    reasoning_effort: effort === 'max' ? 'high' : effort,
  };
}
