import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * 系统内置提示词覆盖配置（built-in-prompt.yaml）。
 *
 * 独立于 config.yaml 存储，文件内容为「提示词 key → 自定义内容」的键值对，
 * 只包含用户改过的提示词；未覆盖的提示词由消费方回退到代码内置默认。
 * 保存时逐 key 写入或删除（null 表示删除），其余 key 原样保留。
 */

/** 提示词配置文件固定文件名 */
export const PROMPT_SETTINGS_FILE = 'built-in-prompt.yaml';

/** 显式 configPath 时返回其同目录下的 built-in-prompt.yaml，否则全局用户路径 */
export function resolvePromptConfigPath(configPath?: string): string {
  return configPath
    ? resolve(dirname(configPath), PROMPT_SETTINGS_FILE)
    : resolve(homedir(), '.personal-agent', PROMPT_SETTINGS_FILE);
}

/**
 * 读取提示词覆盖配置。文件不存在或内容非法时返回空对象（全部使用内置默认）。
 */
export function loadPromptSettings(configPath?: string): Record<string, string> {
  const targetPath = resolvePromptConfigPath(configPath);
  if (!existsSync(targetPath)) return {};
  try {
    const parsed = parseYaml(readFileSync(targetPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') result[key] = value;
      }
      return result;
    }
  } catch {
    // 配置文件损坏时回退为空，不阻断启动
  }
  return {};
}

/**
 * 保存提示词覆盖配置：value 为字符串则写入/覆盖，为 null 则删除该 key。
 * 返回写入的文件路径。
 */
export async function savePromptSettings(
  update: Record<string, string | null>,
  configPath?: string,
): Promise<string> {
  const targetPath = resolvePromptConfigPath(configPath);
  const current = loadPromptSettings(configPath);

  for (const [key, value] of Object.entries(update)) {
    if (value === null || value === '') {
      delete current[key];
    } else {
      current[key] = value;
    }
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, stringifyYaml(current), 'utf8');
  return targetPath;
}
