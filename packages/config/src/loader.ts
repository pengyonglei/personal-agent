import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { appConfigSchema, type AppConfig } from './schema';
import { DEFAULT_CONFIG } from './defaults';

export type { AppConfig } from './schema';
export { DEFAULT_CONFIG } from './defaults';
export { appConfigSchema } from './schema';

/**
 * Configuration loading priority (latter overrides former):
 * 1. Built-in defaults
 * 2. ~/.personal-agent/config.yaml   (global user config)
 * 3. ./.personal-agent/config.yaml    (project config)
 * 4. PERSONAL_AGENT_* env vars
 * 5. CLI flags (applied separately via mergeCliFlags)
 */
export interface ConfigLoadOptions {
  /** Explicit config file path (overrides auto-discovery) */
  configPath?: string;
  /** Working directory */
  cwd?: string;
}

/**
 * Load configuration from files, merging with defaults.
 */
export function loadConfig(options: ConfigLoadOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  let config = structuredClone(DEFAULT_CONFIG);

  // Layer 1: Global user config
  const globalPath = options.configPath
    ? undefined
    : resolve(homedir(), '.personal-agent', 'config.yaml');
  if (globalPath && existsSync(globalPath)) {
    config = mergeConfig(config, loadYamlFile(globalPath));
  }

  // Layer 2: Project config
  const projectPath = resolve(cwd, '.personal-agent', 'config.yaml');
  if (existsSync(projectPath)) {
    const projectConfig = loadYamlFile(projectPath) as Partial<AppConfig> & { vision?: unknown };
    // The visual model is intentionally global. A repository config must not
    // silently change the model used to process user-provided images.
    delete projectConfig.vision;
    config = mergeConfig(config, projectConfig);
  }

  // Layer 3: Explicit config path
  if (options.configPath && existsSync(options.configPath)) {
    config = mergeConfig(config, loadYamlFile(options.configPath));
  }

  // Layer 4: Environment variables
  config = mergeEnvVars(config);

  // Validate final config
  const result = appConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }

  return result.data;
}

function loadYamlFile(path: string): Partial<AppConfig> {
  const content = readFileSync(path, 'utf-8');
  return parseYaml(content) as Partial<AppConfig>;
}

/**
 * Deep merge of configuration objects.
 * Arrays are replaced (not merged).
 */
function mergeConfig(base: AppConfig, override: Partial<AppConfig>): AppConfig {
  const merged = structuredClone(base);
  deepMerge(merged, override);
  return merged;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      target[key] = srcVal;
    }
  }
}

/**
 * Apply environment variable overrides.
 * Supported vars:
 *   PERSONAL_AGENT_PROVIDER=anthropic
 *   PERSONAL_AGENT_MODEL=claude-sonnet-5-20251001
 *   PERSONAL_AGENT_ANTHROPIC_API_KEY=sk-...
 *   PERSONAL_AGENT_OPENAI_API_KEY=sk-...
 *   PERSONAL_AGENT_MAX_TURNS=100
 *   PERSONAL_AGENT_TEMPERATURE=0.5
 *   PERSONAL_AGENT_OLLAMA_BASE_URL=http://...
 */
function mergeEnvVars(config: AppConfig): AppConfig {
  const result = structuredClone(config);

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('PERSONAL_AGENT_') || value === undefined) continue;

    const path = key.slice('PERSONAL_AGENT_'.length).toLowerCase();

    if (path === 'anthropic_api_key') {
      result.providers.anthropic = {
        ...result.providers.anthropic,
        apiKey: value,
      };
    } else if (path === 'openai_api_key') {
      result.providers.openai = {
        ...result.providers.openai,
        apiKey: value,
      };
    } else if (path === 'ollama_base_url') {
      result.providers.ollama = {
        ...result.providers.ollama,
        baseURL: value,
      };
    } else if (path === 'deepseek_api_key') {
      result.providers.deepseek = result.providers.deepseek || {};
      result.providers.deepseek.apiKey = value;
      result.providers.deepseek.baseURL =
        result.providers.deepseek.baseURL || 'https://api.deepseek.com';
      result.providers.deepseek.defaultModel =
        result.providers.deepseek.defaultModel || 'deepseek-v4-flash';
      result.providers.deepseek.models = result.providers.deepseek.models || [
        'deepseek-v4-flash',
        'deepseek-v4-pro',
      ];
      result.providers.deepseek.thinkingEffort = result.providers.deepseek.thinkingEffort || 'high';
    } else if (path === 'volcano_api_key') {
      result.providers.volcano = result.providers.volcano || {};
      result.providers.volcano.apiKey = value;
      result.providers.volcano.baseURL =
        result.providers.volcano.baseURL || 'https://ark.cn-beijing.volces.com/api/v3';
      result.providers.volcano.defaultModel =
        result.providers.volcano.defaultModel || 'doubao-seed-1-6-250615';
      result.providers.volcano.models = result.providers.volcano.models || [
        'doubao-seed-1-6-250615',
        'doubao-seed-thinking-250615',
      ];
    } else if (path === 'model') {
      // Set as default on the active provider if not already set
      // The CLI layer picks which provider this applies to
    } else if (path === 'max_turns') {
      result.agent.maxTurns = parseInt(value, 10);
    } else if (path === 'temperature') {
      result.agent.temperature = parseFloat(value);
    } else if (path === 'max_tokens') {
      result.agent.maxTokens = parseInt(value, 10);
    }
  }

  return result;
}

/**
 * Merge CLI-provided flag overrides.
 */
export function mergeCliFlags(config: AppConfig, flags: Partial<CliFlags>): AppConfig {
  const result = structuredClone(config);

  if (flags.model) {
    // Will be used by provider selection
  }
  if (flags.provider) {
    // Will be used by provider selection
  }
  if (flags.maxTurns !== undefined) {
    result.agent.maxTurns = flags.maxTurns;
  }
  if (flags.temperature !== undefined) {
    result.agent.temperature = flags.temperature;
  }
  if (flags.maxTokens !== undefined) {
    result.agent.maxTokens = flags.maxTokens;
  }

  return result;
}

export interface CliFlags {
  model?: string;
  provider?: string;
  maxTurns?: number;
  temperature?: number;
  maxTokens?: number;
  configPath?: string;
  noTui?: boolean;
  debug?: boolean;
  prompt?: string;
}
