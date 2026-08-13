import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveWritableConfigPath } from './provider-settings';

export interface BrowserValidationSettingsUpdate {
  enabled: boolean;
}

/** Persist the global browser-validation switch without touching unrelated config. */
export async function saveBrowserValidationSettings(
  update: BrowserValidationSettingsUpdate,
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

  const existingValidation =
    document.validation &&
    typeof document.validation === 'object' &&
    !Array.isArray(document.validation)
      ? (document.validation as Record<string, unknown>)
      : {};
  existingValidation.enabled = update.enabled;
  document.validation = existingValidation;

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(document), 'utf8');
  return targetPath;
}
