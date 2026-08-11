import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import AdmZip from 'adm-zip';

/** 上传 zip 的最大体积（字节） */
export const MAX_ZIP_SIZE = 10 * 1024 * 1024;
/** 解压后所有文件的总大小上限（字节） */
export const MAX_TOTAL_EXTRACTED_SIZE = 50 * 1024 * 1024;
/** 单个文件大小上限（字节） */
export const MAX_SINGLE_FILE_SIZE = 10 * 1024 * 1024;
/** zip 内条目数量上限 */
export const MAX_ENTRY_COUNT = 500;

export type SkillUploadErrorCode =
  | 'invalid_zip'
  | 'no_skill_md'
  | 'multiple_skills'
  | 'zip_slip'
  | 'too_large'
  | 'exists';

export class SkillUploadError extends Error {
  constructor(
    public readonly code: SkillUploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SkillUploadError';
  }
}

export interface InstalledSkill {
  name: string;
  path: string;
  fileCount: number;
}

function normalizeEntryName(entryName: string): string[] {
  // adm-zip 使用 '/' 分隔；同时防御反斜杠与盘符形式
  return entryName.replaceAll('\\', '/').split('/').filter((part) => part.length > 0);
}

function isSafeEntry(parts: string[]): boolean {
  if (parts.some((part) => part === '..' || part === '.')) return false;
  if (/^[a-zA-Z]:/.test(parts[0] ?? '')) return false;
  return true;
}

function sanitizeSkillName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return cleaned || 'skill';
}

/**
 * 从 zip 压缩包安装一个标准技能（Claude Code / Codex 格式）。
 *
 * 技能目录名取自 zip 文件名（去除 .zip 后缀）；zip 内为单个技能的
 * 根目录（含 SKILL.md，允许附带 scripts/、references/、assets/ 等资源），
 * 该根目录名与 zip 文件名可以不一致，安装时会被剥离。
 *
 * @param zipBuffer    zip 内容
 * @param targetRoot   技能安装目录（默认 ~/.personal-agent/skills）
 * @param fallbackName zip 文件名（不含 .zip），用作技能目录名
 */
export async function installSkillFromZip(
  zipBuffer: Buffer,
  targetRoot: string,
  fallbackName = 'skill',
): Promise<InstalledSkill> {
  if (zipBuffer.length > MAX_ZIP_SIZE) {
    throw new SkillUploadError('too_large', `压缩包超过大小限制（${MAX_ZIP_SIZE / 1024 / 1024}MB）`);
  }

  let entries: AdmZip.IZipEntry[];
  try {
    const zip = new AdmZip(zipBuffer);
    entries = zip.getEntries();
  } catch {
    throw new SkillUploadError('invalid_zip', '无法解析 zip 压缩包，请确认文件未损坏');
  }

  if (entries.length === 0) {
    throw new SkillUploadError('invalid_zip', '压缩包为空');
  }
  if (entries.length > MAX_ENTRY_COUNT) {
    throw new SkillUploadError('too_large', `压缩包内条目过多（超过 ${MAX_ENTRY_COUNT} 个）`);
  }

  // 校验路径安全与大小
  let totalSize = 0;
  for (const entry of entries) {
    const parts = normalizeEntryName(entry.entryName);
    if (!isSafeEntry(parts)) {
      throw new SkillUploadError('zip_slip', `压缩包包含不安全路径：${entry.entryName}`);
    }
    totalSize += entry.header.size;
    if (totalSize > MAX_TOTAL_EXTRACTED_SIZE) {
      throw new SkillUploadError(
        'too_large',
        `解压后总大小超过限制（${MAX_TOTAL_EXTRACTED_SIZE / 1024 / 1024}MB）`,
      );
    }
    if (!entry.isDirectory && entry.header.size > MAX_SINGLE_FILE_SIZE) {
      throw new SkillUploadError(
        'too_large',
        `单个文件超过大小限制：${entry.entryName}（${MAX_SINGLE_FILE_SIZE / 1024 / 1024}MB）`,
      );
    }
  }

  // 分析顶层结构：所有条目应位于唯一根目录下，或 SKILL.md 位于 zip 根
  const topLevels = new Set<string>();
  for (const entry of entries) {
    const parts = normalizeEntryName(entry.entryName);
    if (parts.length > 0) topLevels.add(parts[0]);
  }

  const skillMdEntries = entries.filter(
    (entry) => !entry.isDirectory && normalizeEntryName(entry.entryName).at(-1) === 'SKILL.md',
  );
  if (skillMdEntries.length === 0) {
    throw new SkillUploadError('no_skill_md', '压缩包内未找到 SKILL.md 文件');
  }
  if (skillMdEntries.length > 1) {
    throw new SkillUploadError(
      'multiple_skills',
      '压缩包内包含多个 SKILL.md，一次只能上传一个技能',
    );
  }

  const skillMdParts = normalizeEntryName(skillMdEntries[0].entryName);
  const hasSingleRoot =
    topLevels.size === 1 && skillMdParts.length > 1 && skillMdParts[0] === [...topLevels][0];
  // 技能目录名 = zip 文件名（去 .zip），与 zip 内部根目录名无关
  const skillName = sanitizeSkillName(fallbackName || 'skill');

  const targetDir = resolve(targetRoot, skillName);
  const resolvedRoot = resolve(targetRoot);
  if (!targetDir.startsWith(resolvedRoot + sep) && targetDir !== resolvedRoot) {
    throw new SkillUploadError('zip_slip', '技能目录越界');
  }

  const { existsSync } = await import('node:fs');
  if (existsSync(targetDir)) {
    throw new SkillUploadError(
      'exists',
      `技能「${skillName}」已存在（${targetDir}），请先删除旧技能或更换技能名称`,
    );
  }

  // 落盘：目录条目建目录，文件条目写文件
  await mkdir(targetDir, { recursive: true });
  let fileCount = 0;
  for (const entry of entries) {
    const parts = normalizeEntryName(entry.entryName);
    // 去掉公共根目录前缀（zip 根目录本身），其余条目原样保留
    const relativeParts = hasSingleRoot ? parts.slice(1) : parts;
    if (relativeParts.length === 0) continue;
    const outPath = resolve(targetDir, ...relativeParts);
    if (!outPath.startsWith(targetDir + sep) && outPath !== targetDir) {
      throw new SkillUploadError('zip_slip', `解压路径越界：${entry.entryName}`);
    }
    if (entry.isDirectory) {
      await mkdir(outPath, { recursive: true });
    } else {
      await mkdir(join(outPath, '..'), { recursive: true });
      await writeFile(outPath, entry.getData());
      fileCount += 1;
    }
  }

  return { name: skillName, path: targetDir, fileCount };
}
