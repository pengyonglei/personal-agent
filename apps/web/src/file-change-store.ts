import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { StoredFileChangeBatch } from './protocol';

/** 单侧内容参与落盘的最大行数（与前端 MAX_DIFF_LINES 对齐，超出截断并标记）。 */
export const MAX_STORED_DIFF_LINES = 2000;

/** 修改记录批次落盘目录中最多保留的文件数（超出后按 mtime 删除最旧）。 */
const MAX_FILE_CHANGE_BATCHES = 200;

/**
 * 判定路径是否为一次性临时/测试脚本文件（不进入修改记录展示）。
 * 覆盖：`.tmp-*` 前缀（如 .tmp-e2e.mjs、.tmp-test-out.txt）、`tmp-`/`tmp_` 前缀、
 * `foo.tmp`/`foo.temp` 后缀、`~` 结尾的编辑器备份文件。
 */
export function isTemporaryFilePath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]/);
  if (segments.some((segment) => /^(\.tmp-|tmp-|tmp_)/i.test(segment))) return true;
  const base = basename(filePath);
  if (/\.(tmp|temp)$/i.test(base)) return true;
  if (base.endsWith('~')) return true;
  return false;
}

/** 批次 id → 安全文件名（仅保留 \w . -，防止路径穿越）。 */
function sanitizeBatchId(batchId: string): string {
  return batchId.replace(/[^\w.-]/g, '_');
}

function isValidBatch(value: unknown): value is StoredFileChangeBatch {
  if (!value || typeof value !== 'object') return false;
  const batch = value as Partial<StoredFileChangeBatch>;
  return (
    typeof batch.id === 'string' &&
    batch.id.length > 0 &&
    typeof batch.time === 'string' &&
    Array.isArray(batch.files) &&
    batch.files.every(
      (file) =>
        file &&
        typeof file === 'object' &&
        typeof (file as { path?: unknown }).path === 'string' &&
        typeof (file as { oldContent?: unknown }).oldContent === 'string' &&
        typeof (file as { newContent?: unknown }).newContent === 'string',
    )
  );
}

/** 截断超长内容（仅保留前 maxLines 行）。 */
function truncateContent(content: string, maxLines: number): { text: string; truncated: boolean } {
  let lineCount = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) lineCount += 1;
  }
  if (lineCount <= maxLines) return { text: content, truncated: false };
  const lines = content.split('\n');
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true };
}

/**
 * 修改文件记录批次存储：每批次一个 JSON 文件（<sanitizedId>.json），
 * 写入 ~/.personal-agent/file-changes（可由调用方指定目录）。原子替换写入，
 * 超出上限时按 mtime 删除最旧文件；单个文件损坏/解析失败时跳过。
 */
export class FileChangeStore {
  constructor(readonly directory: string) {}

  async save(batch: StoredFileChangeBatch): Promise<void> {
    // 一次性临时/测试脚本文件不进入修改记录
    const files = batch.files.filter((file) => !isTemporaryFilePath(file.path));
    if (files.length === 0) return;
    await mkdir(this.directory, { recursive: true });
    const filePath = join(this.directory, `${sanitizeBatchId(batch.id)}.json`);
    const payload: StoredFileChangeBatch = {
      ...batch,
      files: files.map((file) => {
        const oldTruncated = truncateContent(file.oldContent, MAX_STORED_DIFF_LINES);
        const newTruncated = truncateContent(file.newContent, MAX_STORED_DIFF_LINES);
        return {
          path: file.path,
          oldContent: oldTruncated.text,
          newContent: newTruncated.text,
          ...(oldTruncated.truncated || newTruncated.truncated ? { truncated: true } : {}),
        };
      }),
    };
    const tmpPath = join(
      this.directory,
      `${sanitizeBatchId(batch.id)}.json.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmpPath, JSON.stringify(payload), 'utf-8');
    try {
      await rename(tmpPath, filePath);
    } catch (error) {
      // Windows 上目标文件被占用等极端情况：删除后重试一次
      try {
        await unlink(filePath);
      } catch {
        // 目标不存在，忽略
      }
      await rename(tmpPath, filePath);
    }
    await this.pruneIfNeeded();
  }

  async list(): Promise<StoredFileChangeBatch[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch {
      // 目录不存在（从未保存过）→ 空列表
      return [];
    }
    const batches: StoredFileChangeBatch[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.directory, file), 'utf-8');
        const batch = JSON.parse(raw) as unknown;
        if (!isValidBatch(batch)) continue;
        // 展示时同样过滤历史批次中的临时文件；全部为临时文件的批次直接跳过
        const filteredFiles = batch.files.filter((entry) => !isTemporaryFilePath(entry.path));
        if (filteredFiles.length === 0) continue;
        batches.push({ ...batch, files: filteredFiles });
      } catch {
        // 单个文件损坏/解析失败：跳过，不阻断其余批次
      }
    }
    batches.sort((left, right) => right.time.localeCompare(left.time));
    return batches;
  }

  async delete(batchId: string): Promise<boolean> {
    try {
      await unlink(join(this.directory, `${sanitizeBatchId(batchId)}.json`));
      return true;
    } catch {
      return false;
    }
  }

  private async pruneIfNeeded(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch {
      return;
    }
    const jsonFiles = files.filter((file) => file.endsWith('.json'));
    if (jsonFiles.length <= MAX_FILE_CHANGE_BATCHES) return;
    const entries = await Promise.all(
      jsonFiles.map(async (file) => {
        try {
          const info = await stat(join(this.directory, file));
          return { file, mtimeMs: info.mtimeMs };
        } catch {
          return { file, mtimeMs: 0 };
        }
      }),
    );
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const entry of entries.slice(0, entries.length - MAX_FILE_CHANGE_BATCHES)) {
      try {
        await unlink(join(this.directory, entry.file));
      } catch {
        // 删除失败忽略
      }
    }
  }
}
