import Anthropic from '@anthropic-ai/sdk';
import type { Message, MessageStreamEvent, Tool } from '@anthropic-ai/sdk/resources/messages';
import type { ModelConfig } from '@personal-agent/config';
import type {
  UnifiedMessage,
  UnifiedContentBlock,
  UnifiedToolDefinition,
  StreamOptions,
  ChatOptions,
  UnifiedResponse,
  UnifiedStreamEvent,
  ModelInfo,
} from '@personal-agent/shared';
import { ProviderFeature } from '@personal-agent/shared';
import { BaseLLMProvider } from './interface';

// ---------------------------------------------------------------------------
// Anthropic model definitions
// ---------------------------------------------------------------------------

const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-sonnet-5-20251001',
    displayName: 'Claude Sonnet 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    maxOutputTokens: 32768,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
      ProviderFeature.ImageInput,
      ProviderFeature.Thinking,
      ProviderFeature.PromptCaching,
    ],
    pricing: {
      inputPer1k: 0.003,
      outputPer1k: 0.015,
      cacheWritePer1k: 0.00375,
      cacheReadPer1k: 0.0003,
    },
  },
  {
    id: 'claude-opus-5-20251001',
    displayName: 'Claude Opus 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    maxOutputTokens: 32768,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
      ProviderFeature.ImageInput,
      ProviderFeature.Thinking,
      ProviderFeature.PromptCaching,
      ProviderFeature.ComputerUse,
    ],
    pricing: {
      inputPer1k: 0.015,
      outputPer1k: 0.075,
      cacheWritePer1k: 0.01875,
      cacheReadPer1k: 0.0015,
    },
  },
  {
    id: 'claude-fable-5-20251001',
    displayName: 'Claude Fable 5',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    maxOutputTokens: 32768,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
      ProviderFeature.ImageInput,
      ProviderFeature.PromptCaching,
    ],
    pricing: {
      inputPer1k: 0.001,
      outputPer1k: 0.005,
      cacheWritePer1k: 0.00125,
      cacheReadPer1k: 0.0001,
    },
  },
];

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AnthropicProvider extends BaseLLMProvider {
  readonly providerId = 'anthropic';
  readonly displayName = 'Anthropic (Claude)';

  private client: Anthropic | null = null;
  private apiKey: string;
  private baseURL: string | undefined;

  constructor(
    apiKey: string,
    defaultModel = 'claude-sonnet-5-20251001',
    baseURL?: string,
    configuredModels: Array<string | ModelConfig> = [],
  ) {
    super(defaultModel);
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.models = [...ANTHROPIC_MODELS];
    this.addConfiguredModels(configuredModels, (modelId, config) => ({
      id: modelId,
      displayName: modelId,
      provider: this.providerId,
      contextWindow: config?.contextWindow ?? 200_000,
      maxOutputTokens: config?.maxOutputTokens ?? 32_768,
      features: [
        ProviderFeature.Streaming,
        ProviderFeature.ToolCalling,
        ProviderFeature.ParallelToolCalls,
      ],
    }));
    this.addConfiguredModels([defaultModel], (modelId, config) => ({
      id: modelId,
      displayName: modelId,
      provider: this.providerId,
      contextWindow: config?.contextWindow ?? 200_000,
      maxOutputTokens: config?.maxOutputTokens ?? 32_768,
      features: [
        ProviderFeature.Streaming,
        ProviderFeature.ToolCalling,
        ProviderFeature.ParallelToolCalls,
      ],
    }));
  }

  async initialize(): Promise<void> {
    this.client = new Anthropic({ apiKey: this.apiKey, baseURL: this.baseURL });
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
    const { systemBlocks, conversationMessages } = this.buildMessages(
      messages,
      options.systemPrompt,
    );

    const anthropicTools = tools.map(
      (t) =>
        ({
          name: t.name,
          description: t.description,
          input_schema: {
            type: 'object' as const,
            properties: t.inputSchema.properties ?? {},
            required: t.inputSchema.required,
          },
        }) as Tool,
    );

    try {
      const stream = this.client.messages.stream({
        model,
        max_tokens: options.maxTokens ?? 16384,
        temperature: options.temperature,
        system: systemBlocks.length > 0 ? systemBlocks.join('\n\n') : undefined,
        messages: conversationMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      });

      let messageId = '';
      let currentToolId = '';
      let currentToolName = '';
      const toolArgsAcc = new Map<string, string>();

      stream.on('message', (msg: Message) => {
        if (!messageId) messageId = msg.id;
      });

      for await (const event of stream) {
        if (options.signal?.aborted) {
          stream.controller.abort();
          break;
        }

        const ev = event as MessageStreamEvent;
        switch (ev.type) {
          case 'message_start':
            messageId = ev.message.id;
            yield { type: 'message_start', messageId: ev.message.id, model: ev.message.model };
            break;

          case 'content_block_start': {
            const block = ev.content_block;
            if (block.type === 'tool_use') {
              currentToolId = block.id;
              currentToolName = block.name;
              toolArgsAcc.set(block.id, '');
              yield { type: 'tool_call_delta', toolCallDelta: { id: block.id, name: block.name } };
            }
            break;
          }

          case 'content_block_delta': {
            const delta = ev.delta;
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', textDelta: delta.text };
            } else if (delta.type === 'input_json_delta') {
              const prev = toolArgsAcc.get(currentToolId) ?? '';
              toolArgsAcc.set(currentToolId, prev + delta.partial_json);
              yield {
                type: 'tool_call_delta',
                toolCallDelta: { id: currentToolId, arguments: delta.partial_json },
              };
            } else if (delta.type === 'thinking_delta') {
              yield { type: 'thinking_delta', thinkingDelta: delta.thinking };
            }
            break;
          }

          case 'content_block_stop': {
            if (currentToolId && currentToolName) {
              const raw = toolArgsAcc.get(currentToolId) ?? '{}';
              const parsed = safeJsonParse(raw);
              if (parsed) {
                yield {
                  type: 'tool_call_end',
                  toolCallEnd: { id: currentToolId, name: currentToolName, arguments: parsed },
                };
              }
              currentToolId = '';
              currentToolName = '';
            }
            break;
          }
        }
      }

      const finalMsg = await stream.finalMessage();
      yield {
        type: 'message_end',
        stopReason: mapStopReason(finalMsg.stop_reason),
        usage: finalMsg.usage
          ? {
              inputTokens: finalMsg.usage.input_tokens,
              outputTokens: finalMsg.usage.output_tokens,
              cacheCreationInputTokens: finalMsg.usage.cache_creation_input_tokens ?? null,
              cacheReadInputTokens: finalMsg.usage.cache_read_input_tokens ?? null,
            }
          : null,
      };
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
    const { systemBlocks, conversationMessages } = this.buildMessages(
      messages,
      options?.systemPrompt,
    );

    const anthropicTools =
      tools && tools.length > 0
        ? tools.map(
            (t) =>
              ({
                name: t.name,
                description: t.description,
                input_schema: {
                  type: 'object' as const,
                  properties: t.inputSchema.properties ?? {},
                  required: t.inputSchema.required,
                },
              }) as Tool,
          )
        : undefined;

    const response = await this.client.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 16384,
      temperature: options?.temperature,
      system: systemBlocks.length > 0 ? systemBlocks.join('\n\n') : undefined,
      messages: conversationMessages,
      tools: anthropicTools,
    });

    return {
      id: response.id,
      model: response.model,
      content: extractAnthropicContent(response.content as RawBlock[]),
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
        cacheReadInputTokens: response.usage.cache_read_input_tokens,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Internal message construction
  // -----------------------------------------------------------------------

  private buildMessages(
    messages: UnifiedMessage[],
    extraSystem?: string,
  ): { systemBlocks: string[]; conversationMessages: Anthropic.MessageParam[] } {
    const systemBlocks: string[] = [];
    const conversationMessages: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemBlocks.push(typeof msg.content === 'string' ? msg.content : joinText(msg.content));
      } else {
        conversationMessages.push(buildAnthropicMessage(msg) as Anthropic.MessageParam);
      }
    }

    if (extraSystem) systemBlocks.push(extraSystem);
    return { systemBlocks, conversationMessages };
  }
}

// ---------------------------------------------------------------------------
// Type helpers for raw ContentBlock (avoids SDK type conflicts)
// ---------------------------------------------------------------------------

interface RawTextBlock {
  type: 'text';
  text: string;
}

interface RawToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface RawThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

type RawBlock = RawTextBlock | RawToolUseBlock | RawThinkingBlock;

function joinText(blocks: UnifiedContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function buildAnthropicMessage(msg: UnifiedMessage): unknown {
  if (msg.role === 'assistant') {
    const blocks: unknown[] = [];

    if (typeof msg.content === 'string') {
      blocks.push({ type: 'text', text: msg.content });
    } else {
      for (const b of msg.content) {
        if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use')
          blocks.push({
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input: b.input as Record<string, unknown>,
          });
        else if (b.type === 'thinking')
          blocks.push({ type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' });
      }
    }

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: safeJsonParse(tc.function.arguments) ?? {},
        });
      }
    }

    return {
      role: 'assistant',
      content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }],
    };
  }

  if (msg.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: msg.toolCallId ?? '',
          content: typeof msg.content === 'string' ? msg.content : joinText(msg.content),
        },
      ],
    };
  }

  // user
  if (typeof msg.content === 'string') {
    return { role: 'user', content: [{ type: 'text', text: msg.content }] };
  }

  return {
    role: 'user',
    content: msg.content.map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'image')
        return {
          type: 'image',
          source: { type: 'base64', data: b.source.data, media_type: b.source.mediaType },
        };
      return { type: 'text', text: '' };
    }),
  };
}

function extractAnthropicContent(blocks: RawBlock[]): UnifiedContentBlock[] {
  return blocks.map((b): UnifiedContentBlock => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'tool_use':
        return {
          type: 'tool_use',
          id: b.id,
          name: b.name,
          input: b.input as Record<string, unknown>,
        };
      case 'thinking':
        return { type: 'thinking', thinking: b.thinking, signature: b.signature };
      default:
        return { type: 'text', text: '' };
    }
  });
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function mapStopReason(
  reason: string | null | undefined,
):
  'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'interrupted' | 'refusal' | 'unknown' {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
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
