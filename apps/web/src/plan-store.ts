import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanDoc } from './plan-doc';

/** 计划文档落盘目录中最多保留的文件数（超出后按 mtime 删除最旧）。 */
const MAX_PLAN_DOCS = 200;

/** planId → 安全文件名（仅保留 \w . -，防止路径穿越）。 */
function sanitizePlanId(planId: string): string {
  return planId.replace(/[^\w.-]/g, '_');
}

function isValidPlanDoc(value: unknown): value is PlanDoc {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<PlanDoc>;
  return (
    typeof doc.id === 'string' &&
    doc.id.length > 0 &&
    typeof doc.title === 'string' &&
    typeof doc.markdown === 'string' &&
    typeof doc.plan === 'object' &&
    doc.plan !== null &&
    typeof (doc.plan as { status?: unknown }).status === 'string' &&
    typeof doc.createdAt === 'number' &&
    Number.isFinite(doc.createdAt) &&
    typeof doc.updatedAt === 'number' &&
    Number.isFinite(doc.updatedAt)
  );
}

/**
 * 计划文档文件存储：每个文档一个 JSON 文件（<sanitizedId>.json），
 * 写入 ~/.personal-agent/plans（可由调用方指定目录）。原子替换写入，
 * 保留首次创建的 createdAt，超出上限时按 mtime 删除最旧文件。
 */
export class PlanStore {
  constructor(readonly directory: string) {}

  async save(doc: PlanDoc): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const filePath = join(this.directory, `${sanitizePlanId(doc.id)}.json`);
    const payload: PlanDoc = {
      ...doc,
      createdAt: await this.readCreatedAt(filePath, doc.createdAt),
      updatedAt: Date.now(),
      // requestSeq 三态：文件已有值 → 保留（更新不覆盖创建时轮次）；
      // 文件已存在但无值（旧数据）→ 保持缺失，避免把创建轮次错误标记成更新时的轮次；
      // 文件不存在 → 首次创建，写入本次计算的轮次。
      requestSeq: await this.readRequestSeq(filePath, doc.requestSeq),
    };
    const tmpPath = join(
      this.directory,
      `${sanitizePlanId(doc.id)}.json.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  async list(): Promise<PlanDoc[]> {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch {
      // 目录不存在（从未保存过）→ 空列表
      return [];
    }
    const docs: PlanDoc[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(this.directory, file), 'utf-8');
        const doc = JSON.parse(raw) as unknown;
        if (!isValidPlanDoc(doc)) continue;
        docs.push(doc);
      } catch {
        // 单个文件损坏/解析失败：跳过，不阻断其余文档
      }
    }
    docs.sort((left, right) => right.updatedAt - left.updatedAt);
    return docs;
  }

  /** 读取已有文件的 createdAt（首次保存时用传入值），保证多次更新不重置创建时间。 */
  private async readCreatedAt(filePath: string, fallback: number): Promise<number> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const existing = JSON.parse(raw) as Partial<PlanDoc>;
      if (typeof existing.createdAt === 'number' && Number.isFinite(existing.createdAt)) {
        return existing.createdAt;
      }
    } catch {
      // 文件不存在或损坏：使用 fallback
    }
    return fallback;
  }

  /**
   * 读取已有文件的 requestSeq：
   * - 文件已有合法值 → 返回该值（更新时保留创建时轮次）；
   * - 文件已存在但无该字段（旧数据）→ 返回 undefined（保持缺失，不覆盖成当前轮次）；
   * - 文件不存在/损坏 → 返回 fallback（首次创建，使用调用方计算的轮次）。
   */
  private async readRequestSeq(
    filePath: string,
    fallback: number | undefined,
  ): Promise<number | undefined> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const existing = JSON.parse(raw) as Partial<PlanDoc>;
      if (typeof existing.requestSeq === 'number' && Number.isFinite(existing.requestSeq)) {
        return existing.requestSeq;
      }
      return undefined;
    } catch {
      return fallback;
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
    if (jsonFiles.length <= MAX_PLAN_DOCS) return;
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
    for (const entry of entries.slice(0, entries.length - MAX_PLAN_DOCS)) {
      try {
        await unlink(join(this.directory, entry.file));
      } catch {
        // 删除失败忽略
      }
    }
  }
}
