import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveWritableConfigPath } from './provider-settings';

export type ToolsShellPreference = 'auto' | 'powershell' | 'bash';

export interface ToolsSettingsUpdate {
  /** Windows 上 bash 工具使用的 shell：auto=PowerShell，bash=Git Bash/WSL。 */
  shell?: ToolsShellPreference;
}

/**
 * Persist only the tools fields managed by the Web UI. Existing unrelated
 * configuration is preserved (same merge pattern as saveAgentSettings).
 */
export async function saveToolsSettings(
  update: ToolsSettingsUpdate,
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

  const existingTools =
    document.tools && typeof document.tools === 'object' && !Array.isArray(document.tools)
      ? (document.tools as Record<string, unknown>)
      : {};
  if (update.shell !== undefined) existingTools.shell = update.shell;
  document.tools = existingTools;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(document), 'utf8');
  return targetPath;
}
