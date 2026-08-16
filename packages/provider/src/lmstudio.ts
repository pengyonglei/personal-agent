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
  mapOpenAIStopReason,
  safeJsonParse,
  type ModelDefaults,
} from './openai-compat';

// ---------------------------------------------------------------------------
// LM Studio (OpenAI-compatible local server)
// ---------------------------------------------------------------------------

/** LM Studio's default OpenAI-compatible endpoint. */
export const DEFAULT_LMSTUDIO_BASE_URL = 'http://localhost:1234/v1';

/** Placeholder model id shown until the user fills in their loaded model key. */
export const DEFAULT_LMSTUDIO_MODEL = 'qwen3.8-27b-a3b-thinking';

const MODEL_DEFAULTS = {
  contextWindow: 32_768,
  maxOutputTokens: 8_192,
  features: [
    ProviderFeature.Streaming,
    ProviderFeature.ToolCalling,
    ProviderFeature.ParallelToolCalls,
    ProviderFeature.Thinking,
  ],
} satisfies Omit<ModelInfo, 'id' | 'displayName' | 'provider'>;

/**
 * LM Studio reasoning_effort values accepted by its OpenAI-compatible
 * /v1/chat/completions endpoint (superset of the OpenAI vocabulary).
 * Qwen3-class GGUF models typically expose `xhigh` (default), `medium` and
 * `low`; `none` disables thinking entirely.
 */
type LMStudioReasoningEffort = 'none' | 'low' | 'medium' | 'xhigh';

interface LMStudioRequestOptions {
  reasoning_effort?: LMStudioReasoningEffort;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class LMStudioProvider extends BaseLLMProvider {
  readonly providerId = 'lmstudio';
  readonly displayName = 'LM Studio';

  private client: OpenAI | null = null;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(
    apiKey = 'lm-studio',
    defaultModel = DEFAULT_LMSTUDIO_MODEL,
    baseURL = DEFAULT_LMSTUDIO_BASE_URL,
    configuredModels: Array<string | ModelConfig> = [],
  ) {
    super(defaultModel);
    this.apiKey = apiKey;
    this.baseURL = baseURL.replace(/\/+$/, '');
    // LM Studio models are fully user-defined (any GGUF key), so there is no
    // built-in model table — only the configured list plus the default model.
    this.models = [];
    this.addConfiguredModels(configuredModels, (modelId, config) =>
      createLMStudioModelInfo(modelId, this.providerId, MODEL_DEFAULTS, config),
    );
    this.addConfiguredModels([this.currentModel], (modelId, config) =>
      createLMStudioModelInfo(modelId, this.providerId, MODEL_DEFAULTS, config),
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
    const reasoning = getLMStudioReasoningOptions(options.reasoningEffort);

    const openaiMessages = buildOpenAIMessages(messages, options.systemPrompt, true);
    const openaiTools = buildOpenAITools(tools);

    try {
      const stream = await this.client.chat.completions.create({
        model,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        messages: openaiMessages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
        stream: true,
        stream_options: { include_usage: true },
        ...reasoning,
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming & LMStudioRequestOptions);

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
    const reasoning = getLMStudioReasoningOptions(options?.reasoningEffort);

    const openaiMessages = buildOpenAIMessages(messages, options?.systemPrompt, true);
    const openaiTools = tools && tools.length > 0 ? buildOpenAITools(tools) : undefined;

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
      messages: openaiMessages,
      tools: openaiTools,
      ...reasoning,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & LMStudioRequestOptions);

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
 * Map the project's reasoning-effort vocabulary onto LM Studio's
 * reasoning_effort values. Qwen3-class GGUF models expose `xhigh` (default),
 * `medium` and `low`; there is no plain `high` tier, so `high`/`max` both
 * resolve to `xhigh` (the strongest supported level) and `off` disables
 * thinking via `none`. When no effort is given the field is omitted so LM
 * Studio falls back to the model's own default.
 */
function getLMStudioReasoningOptions(effort: ReasoningEffort | undefined): LMStudioRequestOptions {
  switch (effort) {
    case 'off':
      return { reasoning_effort: 'none' };
    case 'low':
      return { reasoning_effort: 'low' };
    case 'medium':
      return { reasoning_effort: 'medium' };
    case 'high':
    case 'max':
    case 'xhigh':
      return { reasoning_effort: 'xhigh' };
    default:
      return {};
  }
}

function createLMStudioModelInfo(
  modelId: string,
  provider: string,
  defaults: ModelDefaults,
  config?: ModelConfig,
): ModelInfo {
  const features = [...defaults.features];
  if (config?.imageInput) features.push(ProviderFeature.ImageInput);
  return {
    id: modelId,
    displayName: modelId,
    provider,
    contextWindow: config?.contextWindow ?? defaults.contextWindow,
    maxOutputTokens: config?.maxOutputTokens ?? defaults.maxOutputTokens,
    features,
  };
}
