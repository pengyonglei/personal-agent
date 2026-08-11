import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveWritableConfigPath } from './provider-settings';

export interface WebSettingsUpdate {
  theme?: 'light' | 'dark';
  accentLight?: string;
  accentDark?: string;
}

/**
 * Persist only the Web UI appearance fields (theme mode + accent colors)
 * managed by the Web UI. Existing unrelated configuration is preserved
 * (same merge pattern as saveAgentSettings).
 */
export async function saveWebSettings(
  update: WebSettingsUpdate,
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

  const existingWeb =
    document.web && typeof document.web === 'object' && !Array.isArray(document.web)
      ? (document.web as Record<string, unknown>)
      : {};
  if (update.theme !== undefined) existingWeb.theme = update.theme;
  if (update.accentLight !== undefined) existingWeb.accentLight = update.accentLight;
  if (update.accentDark !== undefined) existingWeb.accentDark = update.accentDark;
  document.web = existingWeb;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(document), 'utf8');
  return targetPath;
}
