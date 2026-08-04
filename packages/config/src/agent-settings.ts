import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveWritableConfigPath } from './provider-settings';

export interface AgentSettingsUpdate {
  maxTurns?: number;
}

/**
 * Persist only the agent fields managed by the Web UI. Existing unrelated
 * configuration is preserved (same merge pattern as saveStatsSettings).
 */
export async function saveAgentSettings(
  update: AgentSettingsUpdate,
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

  const existingAgent =
    document.agent && typeof document.agent === 'object' && !Array.isArray(document.agent)
      ? (document.agent as Record<string, unknown>)
      : {};
  if (update.maxTurns !== undefined) existingAgent.maxTurns = update.maxTurns;
  document.agent = existingAgent;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(document), 'utf8');
  return targetPath;
}
