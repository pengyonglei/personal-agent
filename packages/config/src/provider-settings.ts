import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ReasoningEffort } from '@personal-agent/shared';
import type { ModelConfig } from './schema';

export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'ollama',
  'deepseek',
  'volcano',
  'lmstudio',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderSettingsUpdate {
  provider: ProviderId;
  activate?: boolean;
  apiKey?: string;
  baseURL?: string | null;
  defaultModel?: string | null;
  models?: Array<string | ModelConfig> | null;
  thinkingEffort?: ReasoningEffort | null;
}

export function resolveWritableConfigPath(configPath?: string): string {
  return configPath ? resolve(configPath) : resolve(homedir(), '.personal-agent', 'config.yaml');
}

/**
 * Persist only the provider fields managed by the Web UI. Existing unrelated
 * configuration is preserved, and an omitted API key is never copied from the
 * process environment into the config file.
 */
export async function saveProviderSettings(
  update: ProviderSettingsUpdate,
  configPath?: string,
): Promise<string> {
  const targetPath = resolveWritableConfigPath(configPath);
  let document: Record<string, unknown> = {};

  if (existsSync(targetPath)) {
    const parsed = parseYaml(await readFile(targetPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      document = parsed as Record<string, unknown>;
    }
  }

  const existingProviders =
    document.providers &&
    typeof document.providers === 'object' &&
    !Array.isArray(document.providers)
      ? (document.providers as Record<string, unknown>)
      : {};
  const existingProvider =
    existingProviders[update.provider] &&
    typeof existingProviders[update.provider] === 'object' &&
    !Array.isArray(existingProviders[update.provider])
      ? (existingProviders[update.provider] as Record<string, unknown>)
      : {};

  if (update.activate !== false) existingProviders.active = update.provider;
  if (update.apiKey !== undefined) existingProvider.apiKey = update.apiKey;
  setOptionalField(existingProvider, 'baseURL', update.baseURL);
  setOptionalField(existingProvider, 'defaultModel', update.defaultModel);
  setOptionalValue(existingProvider, 'models', update.models);
  setOptionalField(existingProvider, 'thinkingEffort', update.thinkingEffort);
  existingProviders[update.provider] = existingProvider;
  document.providers = existingProviders;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(document), 'utf8');
  return targetPath;
}

export async function removeProviderSettings(
  provider: ProviderId,
  activeProvider: ProviderId | undefined,
  configPath?: string,
): Promise<string> {
  const targetPath = resolveWritableConfigPath(configPath);
  let document: Record<string, unknown> = {};

  if (existsSync(targetPath)) {
    const parsed = parseYaml(await readFile(targetPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      document = parsed as Record<string, unknown>;
    }
  }

  const providers =
    document.providers &&
    typeof document.providers === 'object' &&
    !Array.isArray(document.providers)
      ? (document.providers as Record<string, unknown>)
      : {};
  delete providers[provider];
  if (activeProvider) providers.active = activeProvider;
  else delete providers.active;
  document.providers = providers;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(document), 'utf8');
  return targetPath;
}

function setOptionalField(
  target: Record<string, unknown>,
  key: string,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    delete target[key];
    return;
  }
  target[key] = value;
}

function setOptionalValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown[] | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    delete target[key];
    return;
  }
  target[key] = value;
}
