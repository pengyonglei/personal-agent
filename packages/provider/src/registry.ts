import type { AppConfig } from '@personal-agent/config';
import { type LLMProvider, type BaseLLMProvider } from './interface';
import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { OllamaProvider } from './ollama';
import { createLogger } from '@personal-agent/shared';

const log = createLogger('provider-registry');

// ---------------------------------------------------------------------------
// Provider Registry
// ---------------------------------------------------------------------------

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private activeProviderId: string | null = null;

  /**
   * Auto-detect providers from environment and config.
   */
  static async fromConfig(config: AppConfig): Promise<ProviderRegistry> {
    const registry = new ProviderRegistry();
    const providers = config.providers;

    // Anthropic
    if (providers.anthropic?.apiKey) {
      log.info('Registering Anthropic provider');
      const provider = new AnthropicProvider(
        providers.anthropic.apiKey,
        providers.anthropic.defaultModel,
        providers.anthropic.baseURL,
        providers.anthropic.models,
      );
      await provider.initialize();
      registry.register(provider);
    }

    // OpenAI
    if (providers.openai?.apiKey) {
      log.info('Registering OpenAI provider');
      const provider = new OpenAIProvider(
        providers.openai.apiKey,
        providers.openai.defaultModel,
        providers.openai.baseURL,
        undefined,
        providers.openai.models,
      );
      await provider.initialize();
      registry.register(provider);
    }

    // Ollama native API
    if (providers.ollama) {
      log.info('Registering Ollama provider');
      const provider = new OllamaProvider(
        providers.ollama.defaultModel ?? 'llama3.1',
        providers.ollama.baseURL,
        undefined,
        providers.ollama.models,
      );
      await provider.initialize();
      registry.register(provider);
    }

    if (providers.deepseek) {
      log.info('Registering DeepSeek provider');
      const provider = new OpenAIProvider(
        providers.deepseek.apiKey ?? 'deepseek',
        normalizeDeepSeekModel(providers.deepseek.defaultModel),
        providers.deepseek.baseURL,
        'deepseek',
        providers.deepseek.models?.map(normalizeDeepSeekModel),
      );
      await provider.initialize();
      registry.register(provider);
    }

    // Prefer the explicitly selected provider, then fall back to the first available.
    const preferred = providers.active ? registry.get(providers.active) : undefined;
    const active = preferred ?? registry.listAll()[0];
    if (active) {
      registry.setActive(active.providerId);
    }

    return registry;
  }

  register(provider: LLMProvider): void {
    if (this.providers.has(provider.providerId)) {
      log.warn(`Provider '${provider.providerId}' already registered, replacing`);
    }
    this.providers.set(provider.providerId, provider);
  }

  setActive(providerId: string): void {
    if (!this.providers.has(providerId)) {
      throw new Error(`Provider '${providerId}' not registered`);
    }
    this.activeProviderId = providerId;
  }

  getActive(): LLMProvider {
    if (!this.activeProviderId) {
      throw new Error('No active provider selected');
    }
    const provider = this.providers.get(this.activeProviderId);
    if (!provider) {
      throw new Error(`Active provider '${this.activeProviderId}' not found`);
    }
    return provider;
  }

  get(providerId: string): LLMProvider | undefined {
    return this.providers.get(providerId);
  }

  listAll(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  getActiveProviderId(): string | null {
    return this.activeProviderId;
  }

  async disposeAll(): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.dispose();
    }
    this.providers.clear();
  }
}

function normalizeDeepSeekModel(model?: string): string {
  if (!model || model === 'deepseek-chat' || model === 'deepseek-reasoner') {
    return 'deepseek-v4-flash';
  }
  return model;
}
