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

  /**
   * 初始化模型列表：显式配置了 models 时以配置为准，内置目录仅作为未配置时的
   * 兜底 —— 否则用户在设置页删除的模型仍会出现在模型选择器中。默认模型始终
   * 保证在列；纯 id 配置若命中内置目录，直接复用目录里的元数据（上下文窗口、
   * 特性、定价）。
   */
  protected initModelList(
    catalog: ModelInfo[],
    configuredModels: Array<string | ModelConfig>,
    createModel: (modelId: string, config?: ModelConfig) => ModelInfo,
  ): void {
    const catalogById = new Map(catalog.map((model) => [model.id, model]));
    const models: ModelInfo[] = [];
    const known = new Set<string>();
    const push = (modelId: string, config: ModelConfig | undefined): void => {
      const id = modelId.trim();
      if (!id || known.has(id)) return;
      models.push(config ? createModel(id, config) : (catalogById.get(id) ?? createModel(id)));
      known.add(id);
    };
    for (const entry of configuredModels) {
      if (typeof entry === 'string') push(entry, undefined);
      else push(entry.id, entry);
    }
    if (known.size === 0) {
      for (const model of catalog) push(model.id, undefined);
    }
    push(this.currentModel, undefined);
    this.models = models;
  }

  abstract initialize(): Promise<void>;
  abstract dispose(): Promise<void>;
}
