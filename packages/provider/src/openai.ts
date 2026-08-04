import OpenAI from 'openai';
import type { ModelConfig } from '@personal-agent/config';
import type {
  UnifiedMessage,
  UnifiedToolDefinition,
  StreamOptions,
  ChatOptions,
  UnifiedResponse,
  UnifiedStreamEvent,
  UnifiedContentBlock,
  ModelInfo,
  ReasoningEffort,
} from '@personal-agent/shared';
import { ProviderFeature, countTotalTokens } from '@personal-agent/shared';
import { BaseLLMProvider } from './interface';

// ---------------------------------------------------------------------------
// OpenAI model definitions
// ---------------------------------------------------------------------------

const OPENAI_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
      ProviderFeature.ImageInput,
    ],
    pricing: { inputPer1k: 0.0025, outputPer1k: 0.01 },
  },
  {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
    ],
    pricing: { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  },
  {
    id: 'gpt-5',
    displayName: 'GPT-5',
    provider: 'openai',
    contextWindow: 256000,
    maxOutputTokens: 32768,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
      ProviderFeature.ImageInput,
    ],
    pricing: { inputPer1k: 0.00375, outputPer1k: 0.015 },
  },
  {
    id: 'o4-mini',
    displayName: 'o4 Mini',
    provider: 'openai',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
    ],
    pricing: { inputPer1k: 0.0011, outputPer1k: 0.0044 },
  },
];

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

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenAIProvider extends BaseLLMProvider {
  readonly providerId: string;
  readonly displayName: string;

  private client: OpenAI | null = null;
  private apiKey: string;
  private baseURL: string | undefined;

  constructor(
    apiKey: string,
    defaultModel = 'gpt-4o',
    baseURL?: string,
    /** For Ollama via OpenAI-compat: set this to 'ollama' */
    providerIdOverride?: string,
    configuredModels: Array<string | ModelConfig> = [],
  ) {
    super(defaultModel);
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.providerId = providerIdOverride ?? 'openai';
    if (providerIdOverride && providerIdOverride !== 'ollama') {
      this.displayName = providerIdOverride.charAt(0).toUpperCase() + providerIdOverride.slice(1);
    } else {
      this.displayName = providerIdOverride === 'ollama' ? 'Ollama (Local)' : 'OpenAI (GPT)';
    }
    this.models =
      providerIdOverride === 'ollama'
        ? []
        : providerIdOverride === 'deepseek'
          ? [...DEEPSEEK_MODELS]
          : [...OPENAI_MODELS];
    this.addConfiguredModels(configuredModels, (modelId, config) =>
      createCompatibleModelInfo(modelId, this.providerId, config),
    );
    this.addConfiguredModels([defaultModel], (modelId, config) =>
      createCompatibleModelInfo(modelId, this.providerId, config),
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
    // Ollama models may not support all features
    if (this.providerId === 'ollama') {
      return feature === ProviderFeature.Streaming;
    }
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

    // Build OpenAI message array
    const systemMsg = messages.filter((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = nonSystem.map((m) =>
      this.toOpenAIMessage(m),
    );

    // Inject system prompt
    const systemContent = [
      ...systemMsg.map((m) => (typeof m.content === 'string' ? m.content : '')),
      options.systemPrompt ?? '',
    ]
      .filter(Boolean)
      .join('\n\n');

    if (systemContent) {
      openaiMessages.unshift({ role: 'system', content: systemContent });
    }

    const openaiTools: OpenAI.Chat.ChatCompletionTool[] =
      tools.length > 0
        ? tools.map((t) => ({
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
          }))
        : [];

    try {
      const thinking = this.getDeepSeekThinkingOptions(options.reasoningEffort);
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

      const messageId = `openai-${Date.now()}`;
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

    const systemMsg = messages.filter((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = nonSystem.map((m) =>
      this.toOpenAIMessage(m),
    );

    const systemContent = [
      ...systemMsg.map((m) => (typeof m.content === 'string' ? m.content : '')),
      options?.systemPrompt ?? '',
    ]
      .filter(Boolean)
      .join('\n\n');

    if (systemContent) {
      openaiMessages.unshift({ role: 'system', content: systemContent });
    }

    const openaiTools: OpenAI.Chat.ChatCompletionTool[] | undefined =
      tools && tools.length > 0
        ? tools.map((t) => ({
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
          }))
        : undefined;

    const thinking = this.getDeepSeekThinkingOptions(options?.reasoningEffort);
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

  // -----------------------------------------------------------------------
  // Conversion helpers
  // -----------------------------------------------------------------------

  private toOpenAIMessage(msg: UnifiedMessage): OpenAI.Chat.ChatCompletionMessageParam {
    if (msg.role === 'assistant') {
      const textContent =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((b) => b.type === 'text')
              .map((b) => (b as { text: string }).text)
              .join('\n');
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
      if (this.providerId === 'deepseek' && thinkingContent) {
        assistantMessage.reasoning_content = thinkingContent;
      }
      return assistantMessage;
    }

    if (msg.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: msg.toolCallId ?? '',
        content: typeof msg.content === 'string' ? msg.content : extractText(msg.content),
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

  private getDeepSeekThinkingOptions(
    effort: ReasoningEffort | undefined,
  ): DeepSeekThinkingOptions | undefined {
    if (this.providerId !== 'deepseek') return undefined;
    if (effort === 'off') return { thinking: { type: 'disabled' } };
    return {
      thinking: { type: 'enabled' },
      reasoning_effort: effort === 'max' ? 'max' : 'high',
    };
  }
}

// -----------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------

function extractText(blocks: UnifiedContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n');
}

function mapOpenAIStopReason(
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

function safeJsonParse(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

interface DeepSeekThinkingOptions {
  thinking: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'high' | 'max';
}

function createCompatibleModelInfo(
  modelId: string,
  provider: string,
  config?: ModelConfig,
): ModelInfo {
  const isDeepSeek = provider === 'deepseek';
  return {
    id: modelId,
    displayName: modelId,
    provider,
    contextWindow: config?.contextWindow ?? (isDeepSeek ? 1_000_000 : 128_000),
    maxOutputTokens: config?.maxOutputTokens ?? (isDeepSeek ? 384_000 : 32_768),
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
      ...(isDeepSeek ? [ProviderFeature.Thinking] : []),
    ],
  };
}
