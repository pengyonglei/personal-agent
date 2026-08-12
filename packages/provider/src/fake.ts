import {
  ProviderFeature,
  generateId,
  type ChatOptions,
  type ModelInfo,
  type StreamOptions,
  type UnifiedMessage,
  type UnifiedResponse,
  type UnifiedStreamEvent,
  type UnifiedToolDefinition,
} from '@personal-agent/shared';
import { BaseLLMProvider } from './interface';

/** Deterministic, zero-cost provider used only by local validation servers. */
export class FakeValidationProvider extends BaseLLMProvider {
  readonly providerId = 'fake';
  readonly displayName = 'Fake Validation Provider';

  constructor() {
    super('fake-validation');
    this.models = [fakeModel()];
  }

  async *streamChat(
    _messages: UnifiedMessage[],
    _tools: UnifiedToolDefinition[],
    _options: StreamOptions,
  ): AsyncIterable<UnifiedStreamEvent> {
    const id = `fake-${generateId()}`;
    yield { type: 'message_start', messageId: id, model: this.currentModel };
    yield { type: 'text_delta', textDelta: 'Fake provider response — no model request was sent.' };
    yield {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  async chat(
    _messages: UnifiedMessage[],
    _tools: UnifiedToolDefinition[] = [],
    _options: ChatOptions = {},
  ): Promise<UnifiedResponse> {
    return {
      id: `fake-${generateId()}`,
      model: this.currentModel,
      content: [{ type: 'text', text: 'Fake provider response — no model request was sent.' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  supportsFeature(feature: ProviderFeature): boolean {
    return [ProviderFeature.Streaming, ProviderFeature.ToolCalling].includes(feature);
  }

  async initialize(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function fakeModel(): ModelInfo {
  return {
    id: 'fake-validation',
    displayName: 'Fake Validation',
    provider: 'fake',
    contextWindow: 32_000,
    maxOutputTokens: 2_000,
    features: [ProviderFeature.Streaming, ProviderFeature.ToolCalling],
  };
}
