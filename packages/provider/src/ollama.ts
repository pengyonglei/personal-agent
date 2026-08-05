import type { ModelConfig } from '@personal-agent/config';
import {
  ProviderFeature,
  generateId,
  type ChatOptions,
  type ModelInfo,
  type StreamOptions,
  type UnifiedContentBlock,
  type UnifiedMessage,
  type UnifiedResponse,
  type UnifiedStreamEvent,
  type UnifiedToolDefinition,
} from '@personal-agent/shared';
import { BaseLLMProvider } from './interface';

interface OllamaChatResponse {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

export class OllamaProvider extends BaseLLMProvider {
  readonly providerId = 'ollama';
  readonly displayName = 'Ollama';

  private readonly baseURL: string;
  private readonly fetchFn: typeof fetch;
  private controller: AbortController | null = null;

  constructor(
    defaultModel = 'llama3.1',
    baseURL = 'http://localhost:11434',
    fetchFn: typeof fetch = fetch,
    configuredModels: Array<string | ModelConfig> = [],
  ) {
    super(defaultModel);
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.fetchFn = fetchFn;
    this.models = [createModelInfo(defaultModel)];
    this.addConfiguredModels(configuredModels, createModelInfo);
  }

  async initialize(): Promise<void> {
    // 模型列表只包含用户在供应商配置中显式配置的模型（defaultModel + models），
    // 不再自动合并 Ollama 本机 /api/tags 发现的所有模型 —— 否则输入框/设置页会
    // 出现大量未配置的模型，用户只能切换自己配置过的模型。
  }

  async *streamChat(
    messages: UnifiedMessage[],
    tools: UnifiedToolDefinition[],
    options: StreamOptions,
  ): AsyncIterable<UnifiedStreamEvent> {
    this.controller = new AbortController();
    const signal = combineSignals(options.signal, this.controller.signal);
    const response = await this.fetchFn(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model ?? this.currentModel,
        messages: messages.map(toOllamaMessage),
        tools: tools.length > 0 ? tools.map(toOllamaTool) : undefined,
        stream: true,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens,
        },
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(await formatOllamaError(response));
    }

    const messageId = `ollama-${generateId()}`;
    yield {
      type: 'message_start',
      messageId,
      model: options.model ?? this.currentModel,
    };

    let buffer = '';
    let toolCount = 0;
    let usage = { inputTokens: 0, outputTokens: 0 };
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as OllamaChatResponse;
        if (event.message?.content) {
          yield { type: 'text_delta', textDelta: event.message.content };
        }
        for (const toolCall of event.message?.tool_calls ?? []) {
          const name = toolCall.function?.name;
          if (!name) continue;
          toolCount += 1;
          yield {
            type: 'tool_call_end',
            toolCallEnd: {
              id: toolCall.id ?? `${messageId}-tool-${toolCount}`,
              name,
              arguments: parseToolArguments(toolCall.function?.arguments),
            },
          };
        }
        if (event.done) {
          usage = {
            inputTokens: event.prompt_eval_count ?? 0,
            outputTokens: event.eval_count ?? 0,
          };
          yield {
            type: 'message_end',
            stopReason: toolCount > 0 ? 'tool_use' : mapStopReason(event.done_reason),
            usage,
          };
        }
      }
    }

    if (buffer.trim()) {
      const event = JSON.parse(buffer) as OllamaChatResponse;
      if (event.message?.content) {
        yield { type: 'text_delta', textDelta: event.message.content };
      }
      if (event.done) {
        yield {
          type: 'message_end',
          stopReason: toolCount > 0 ? 'tool_use' : mapStopReason(event.done_reason),
          usage: {
            inputTokens: event.prompt_eval_count ?? usage.inputTokens,
            outputTokens: event.eval_count ?? usage.outputTokens,
          },
        };
      }
    }
  }

  async chat(
    messages: UnifiedMessage[],
    tools: UnifiedToolDefinition[] = [],
    options: ChatOptions = {},
  ): Promise<UnifiedResponse> {
    const response = await this.fetchFn(`${this.baseURL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: options.model ?? this.currentModel,
        messages: messages.map(toOllamaMessage),
        tools: tools.length > 0 ? tools.map(toOllamaTool) : undefined,
        stream: false,
        format: options.jsonMode ? 'json' : undefined,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens,
        },
      }),
      signal: options.signal,
    });
    if (!response.ok) throw new Error(await formatOllamaError(response));
    const result = (await response.json()) as OllamaChatResponse;
    const content: UnifiedContentBlock[] = [];
    if (result.message?.content) {
      content.push({ type: 'text', text: result.message.content });
    }
    for (const [index, call] of (result.message?.tool_calls ?? []).entries()) {
      if (!call.function?.name) continue;
      content.push({
        type: 'tool_use',
        id: call.id ?? `ollama-${generateId()}-tool-${index + 1}`,
        name: call.function.name,
        input: parseToolArguments(call.function.arguments),
      });
    }
    return {
      id: `ollama-${generateId()}`,
      model: result.model ?? options.model ?? this.currentModel,
      content,
      stopReason: result.message?.tool_calls?.length
        ? 'tool_use'
        : mapStopReason(result.done_reason),
      usage: {
        inputTokens: result.prompt_eval_count ?? 0,
        outputTokens: result.eval_count ?? 0,
      },
    };
  }

  supportsFeature(feature: ProviderFeature): boolean {
    return [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
    ].includes(feature);
  }

  async dispose(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
  }
}

function toOllamaMessage(message: UnifiedMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content:
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n'),
  };
  if (message.name) result.tool_name = message.name;
  if (message.toolCalls?.length) {
    result.tool_calls = message.toolCalls.map((call) => ({
      function: {
        name: call.function.name,
        arguments: parseToolArguments(call.function.arguments),
      },
    }));
  }
  return result;
}

function toOllamaTool(tool: UnifiedToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function createModelInfo(name: string, config?: ModelConfig): ModelInfo {
  return {
    id: name,
    displayName: name,
    provider: 'ollama',
    contextWindow: config?.contextWindow ?? 128_000,
    maxOutputTokens: config?.maxOutputTokens ?? 32_768,
    features: [
      ProviderFeature.Streaming,
      ProviderFeature.ToolCalling,
      ProviderFeature.ParallelToolCalls,
    ],
  };
}

function mapStopReason(reason: string | undefined): UnifiedResponse['stopReason'] {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'stop' || reason === undefined) return 'end_turn';
  return 'unknown';
}

function combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  const signals = [first, second].filter((signal): signal is AbortSignal => Boolean(signal));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

async function formatOllamaError(response: Response): Promise<string> {
  let detail = '';
  try {
    const payload = (await response.json()) as { error?: string };
    detail = payload.error ? `: ${payload.error}` : '';
  } catch {
    // Ignore non-JSON error bodies.
  }
  return `Ollama request failed (${response.status} ${response.statusText})${detail}`;
}
