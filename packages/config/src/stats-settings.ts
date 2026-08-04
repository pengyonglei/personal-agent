import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveWritableConfigPath } from './provider-settings';

export interface StatsSettingsUpdate {
  recordPayloads?: boolean;
}

/**
 * Persist only the stats fields managed by the Web UI. Existing unrelated
 * configuration is preserved (same merge pattern as saveProviderSettings).
 */
export async function saveStatsSettings(
  update: StatsSettingsUpdate,
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

  const existingStats =
    document.stats && typeof document.stats === 'object' && !Array.isArray(document.stats)
      ? (document.stats as Record<string, unknown>)
      : {};
  if (update.recordPayloads !== undefined) existingStats.recordPayloads = update.recordPayloads;
  document.stats = existingStats;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(document), 'utf8');
  return targetPath;
}
