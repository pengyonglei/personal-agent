import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ProviderId } from './provider-settings';
import { resolveWritableConfigPath } from './provider-settings';

export interface VisionSettingsUpdate {
  enabled: boolean;
  provider?: ProviderId;
  model?: string;
}

/** Persist the global visual-model settings without touching unrelated config. */
export async function saveVisionSettings(
  update: VisionSettingsUpdate,
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

  document.vision = {
    enabled: update.enabled,
    ...(update.provider ? { provider: update.provider } : {}),
    ...(update.model ? { model: update.model } : {}),
  };

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(document), 'utf8');
  return targetPath;
}
