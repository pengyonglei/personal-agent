import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveWritableConfigPath } from './provider-settings';

export interface MemorySettingsUpdate {
  enabled?: boolean;
  maxEntries?: number;
}

/**
 * Persist only the memory fields managed by the Web UI. Existing unrelated
 * configuration is preserved (same merge pattern as saveStatsSettings).
 */
export async function saveMemorySettings(
  update: MemorySettingsUpdate,
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

  const existingMemory =
    document.memory && typeof document.memory === 'object' && !Array.isArray(document.memory)
      ? (document.memory as Record<string, unknown>)
      : {};
  if (update.enabled !== undefined) existingMemory.enabled = update.enabled;
  if (update.maxEntries !== undefined) existingMemory.maxEntries = update.maxEntries;
  document.memory = existingMemory;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(document), 'utf8');
  return targetPath;
}
