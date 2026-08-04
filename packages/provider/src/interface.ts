import type { ModelConfig } from '@personal-agent/config';
import type {
  ModelInfo,
  UnifiedMessage,
  UnifiedToolDefinition,
  StreamOptions,
  ChatOptions,
  UnifiedResponse,
  UnifiedStreamEvent,
} from '@personal-agent/shared';
import { ProviderFeature } from '@personal-agent/shared';

// ---------------------------------------------------------------------------
// LLM Provider interface
// ---------------------------------------------------------------------------

/**
 * Unified interface that all LLM providers must implement.
 * This is the only type the core engine depends on.
 */
export interface LLMProvider {
  /** Unique provider identifier (e.g. 'anthropic', 'openai', 'ollama') */
  readonly providerId: string;
  /** Human-readable display name */
  readonly displayName: string;

  /** Core streaming chat method — primary code path */
  streamChat(
    messages: UnifiedMessage[],
    tools: UnifiedToolDefinition[],
    options: StreamOptions,
  ): AsyncIterable<UnifiedStreamEvent>;

  /** Non-streaming chat — for quick calls, summaries, etc. */
  chat(
    messages: UnifiedMessage[],
    tools?: UnifiedToolDefinition[],
    options?: ChatOptions,
  ): Promise<UnifiedResponse>;

  /** Query the set of features this provider+model supports */
  supportsFeature(feature: ProviderFeature): boolean;

  /** List available models for this provider */
  getModelList(): ModelInfo[];

  /** Estimate token count for messages (without making an API call) */
  countTokens(messages: UnifiedMessage[]): number;

  /** Set the active model */
  setModel(model: string): void;

  /** Get the currently active model */
  getModel(): string;

  /** One-time initialization */
  initialize(): Promise<void>;

  /** Cleanup (cancel pending requests, etc.) */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Abstract base with common logic
// ---------------------------------------------------------------------------

export abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly providerId: string;
  abstract readonly displayName: string;

  protected currentModel: string;
  protected models: ModelInfo[] = [];

  constructor(defaultModel: string) {
    this.currentModel = defaultModel;
  }

  abstract streamChat(
    messages: UnifiedMessage[],
    tools: UnifiedToolDefinition[],
    options: StreamOptions,
  ): AsyncIterable<UnifiedStreamEvent>;

  abstract chat(
    messages: UnifiedMessage[],
    tools?: UnifiedToolDefinition[],
    options?: ChatOptions,
  ): Promise<UnifiedResponse>;

  abstract supportsFeature(feature: ProviderFeature): boolean;

  getModelList(): ModelInfo[] {
    return this.models;
  }

  countTokens(messages: UnifiedMessage[]): number {
    // Fallback: character-based estimation
    // Subclasses should override with model-specific tokenizers when possible
    const { countTotalTokens } = require('@personal-agent/shared');
    return countTotalTokens(messages);
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  getModel(): string {
    return this.currentModel;
  }

  protected addConfiguredModels(
    modelIds: Array<string | ModelConfig>,
    createModel: (modelId: string, config?: ModelConfig) => ModelInfo,
  ): void {
    const known = new Set(this.models.map((model) => model.id));
    for (const entry of modelIds) {
      const config = typeof entry === 'string' ? undefined : entry;
      const modelId = (typeof entry === 'string' ? entry : entry.id).trim();
      if (!modelId || known.has(modelId)) continue;
      this.models.push(createModel(modelId, config));
      known.add(modelId);
    }
  }

  abstract initialize(): Promise<void>;
  abstract dispose(): Promise<void>;
}
