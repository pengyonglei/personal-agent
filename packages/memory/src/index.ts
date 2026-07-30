import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createLogger, generateId } from '@personal-agent/shared';
import Fuse from 'fuse.js';

const log = createLogger('memory');

// ---------------------------------------------------------------------------
// Memory types
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string;
  type: 'fact' | 'preference' | 'session_summary' | 'project_context' | 'decision';
  content: string;
  tags: string[];
  metadata: {
    createdAt: Date;
    updatedAt: Date;
    sourceSessionId?: string;
    importance: 1 | 2 | 3; // 1=critical, 2=important, 3=informational
    accessCount: number;
    lastAccessedAt: Date;
  };
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface SearchOptions {
  maxResults?: number;
  minImportance?: 1 | 2 | 3;
  type?: MemoryEntry['type'];
}

export interface FileSystemMemoryStoreOptions {
  baseDir?: string;
  maxEntries?: number;
}

// ---------------------------------------------------------------------------
// Memory store implementation
// ---------------------------------------------------------------------------

const MEMORY_DIR = resolve(homedir(), '.personal-agent', 'memory');
const INDEX_FILE = 'index.json';

export class FileSystemMemoryStore {
  private baseDir: string;
  private index: Map<string, MemoryEntry> = new Map();
  private fuse: Fuse<MemoryEntry> | null = null;
  private maxEntries: number;

  constructor(options?: string | FileSystemMemoryStoreOptions) {
    const normalized = typeof options === 'string' ? { baseDir: options } : (options ?? {});
    this.baseDir = normalized.baseDir ?? MEMORY_DIR;
    this.maxEntries = Math.max(1, normalized.maxEntries ?? 1000);
  }

  // -------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (!existsSync(this.baseDir)) {
      await mkdir(this.baseDir, { recursive: true });
    }

    this.index.clear();
    await this.loadIndex();
    await this.pruneToLimit();
    await this.saveIndex();
    this.rebuildFuse();
    log.info(`Memory store initialized: ${this.index.size} entries`);
  }

  private async loadIndex(): Promise<void> {
    const indexPath = join(this.baseDir, INDEX_FILE);
    if (!existsSync(indexPath)) return;

    try {
      const raw = JSON.parse(await readFile(indexPath, 'utf-8'));
      for (const [id, entry] of Object.entries(raw)) {
        const e = entry as MemoryEntry;
        // Parse date strings back to Date objects
        e.metadata.createdAt = new Date(e.metadata.createdAt);
        e.metadata.updatedAt = new Date(e.metadata.updatedAt);
        e.metadata.lastAccessedAt = new Date(e.metadata.lastAccessedAt);
        this.index.set(id, e);
      }
    } catch (err) {
      log.warn(`Failed to load index: ${(err as Error).message}`);
    }
  }

  private async saveIndex(): Promise<void> {
    const obj: Record<string, MemoryEntry> = {};
    for (const [id, entry] of this.index) {
      obj[id] = entry;
    }
    await writeFile(join(this.baseDir, INDEX_FILE), JSON.stringify(obj, null, 2), 'utf-8');
  }

  private rebuildFuse(): void {
    this.fuse = new Fuse(Array.from(this.index.values()), {
      keys: ['content', 'tags'],
      threshold: 0.4,
      includeScore: true,
    });
  }

  // -------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------

  async create(
    entry: Omit<MemoryEntry, 'id' | 'metadata'> & { metadata?: Partial<MemoryEntry['metadata']> },
  ): Promise<MemoryEntry> {
    if (!entry.content.trim()) throw new Error('Memory content cannot be empty');
    const id = generateId();
    const now = new Date();

    const full: MemoryEntry = {
      id,
      type: entry.type,
      content: entry.content,
      tags: entry.tags ?? [],
      metadata: {
        createdAt: now,
        updatedAt: now,
        sourceSessionId: entry.metadata?.sourceSessionId,
        importance: entry.metadata?.importance ?? 2,
        accessCount: 0,
        lastAccessedAt: now,
      },
    };

    await this.pruneToLimit(this.maxEntries - 1);
    this.index.set(id, full);

    // Persist as markdown file
    const markdown = toMarkdown(full);
    await writeFile(join(this.baseDir, `${id}.md`), markdown, 'utf-8');

    await this.saveIndex();
    this.rebuildFuse();
    return cloneEntry(full);
  }

  async read(id: string): Promise<MemoryEntry | null> {
    const entry = this.index.get(id);
    if (!entry) return null;

    entry.metadata.accessCount++;
    entry.metadata.lastAccessedAt = new Date();
    await this.saveIndex();
    return cloneEntry(entry);
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryEntry, 'content' | 'tags' | 'type'>>,
  ): Promise<MemoryEntry> {
    const entry = this.index.get(id);
    if (!entry) throw new Error(`Memory entry not found: ${id}`);

    Object.assign(entry, updates);
    entry.metadata.updatedAt = new Date();

    const markdown = toMarkdown(entry);
    await writeFile(join(this.baseDir, `${id}.md`), markdown, 'utf-8');

    await this.saveIndex();
    this.rebuildFuse();
    return cloneEntry(entry);
  }

  async delete(id: string): Promise<void> {
    this.index.delete(id);
    try {
      await unlink(join(this.baseDir, `${id}.md`));
    } catch {
      // File may not exist
    }
    await this.saveIndex();
    this.rebuildFuse();
  }

  // -------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------

  async search(query: string, options: SearchOptions = {}): Promise<MemorySearchResult[]> {
    const { maxResults = 10, minImportance, type } = options;

    if (!this.fuse || !query.trim()) {
      // No query: return all entries, filtered
      return this.filterEntries(null, maxResults, minImportance, type).map((e) => ({
        entry: e,
        score: 0,
      }));
    }

    let results = this.fuse.search(query);
    if (results.length === 0) {
      const byId = new Map<string, (typeof results)[number]>();
      const terms = query
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter((term) => term.length > 2);
      for (const term of terms) {
        for (const result of this.fuse.search(term)) {
          const existing = byId.get(result.item.id);
          if (!existing || (result.score ?? 1) < (existing.score ?? 1)) {
            byId.set(result.item.id, result);
          }
        }
      }
      results = [...byId.values()].sort((a, b) => (a.score ?? 1) - (b.score ?? 1));
    }

    return results
      .map((r) => ({ entry: cloneEntry(r.item), score: 1 - (r.score ?? 0) }))
      .filter((r) => {
        if (minImportance && r.entry.metadata.importance > minImportance) return false;
        if (type && r.entry.type !== type) return false;
        return true;
      })
      .slice(0, maxResults);
  }

  async searchByTags(tags: string[]): Promise<MemoryEntry[]> {
    return Array.from(this.index.values())
      .filter((e) => tags.some((t) => e.tags.includes(t)))
      .map(cloneEntry);
  }

  // -------------------------------------------------------------------
  // Management
  // -------------------------------------------------------------------

  async list(options?: {
    type?: MemoryEntry['type'];
    maxResults?: number;
  }): Promise<MemoryEntry[]> {
    return this.filterEntries(null, options?.maxResults ?? 100, undefined, options?.type).map(
      cloneEntry,
    );
  }

  /**
   * Get relevant context for injection into the system prompt.
   * Returns the top-N most important + recently accessed entries.
   */
  async getRelevantContext(query: string, maxTokens: number): Promise<string> {
    const results = await this.search(query, { maxResults: 10, minImportance: undefined });
    if (results.length === 0) return '';

    const snippets: string[] = [];
    let totalChars = 0;
    const maxChars = maxTokens * 3; // Rough char estimate

    for (const { entry } of results) {
      const snippet = `[${entry.type}] ${entry.content}`;
      if (totalChars + snippet.length > maxChars) break;
      snippets.push(snippet);
      totalChars += snippet.length;

      // Update access count
      entry.metadata.accessCount++;
      entry.metadata.lastAccessedAt = new Date();
      const stored = this.index.get(entry.id);
      if (stored) {
        stored.metadata.accessCount = entry.metadata.accessCount;
        stored.metadata.lastAccessedAt = entry.metadata.lastAccessedAt;
      }
    }

    await this.saveIndex();
    return snippets.join('\n');
  }

  async getStats(): Promise<{ totalEntries: number; byType: Record<string, number> }> {
    const byType: Record<string, number> = {};
    for (const entry of this.index.values()) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
    }
    return { totalEntries: this.index.size, byType };
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private filterEntries(
    query: string | null,
    maxResults: number,
    minImportance?: number,
    type?: MemoryEntry['type'],
  ): MemoryEntry[] {
    let entries = Array.from(this.index.values());

    if (minImportance) {
      entries = entries.filter((e) => e.metadata.importance <= minImportance);
    }
    if (type) {
      entries = entries.filter((e) => e.type === type);
    }

    // Sort by importance (asc), then by last accessed (desc)
    entries.sort((a, b) => {
      if (a.metadata.importance !== b.metadata.importance) {
        return a.metadata.importance - b.metadata.importance;
      }
      return b.metadata.lastAccessedAt.getTime() - a.metadata.lastAccessedAt.getTime();
    });

    return entries.slice(0, maxResults);
  }

  private async pruneToLimit(limit = this.maxEntries): Promise<void> {
    if (this.index.size <= limit) return;
    const candidates = Array.from(this.index.values()).sort((a, b) => {
      if (a.metadata.importance !== b.metadata.importance) {
        return b.metadata.importance - a.metadata.importance;
      }
      return a.metadata.lastAccessedAt.getTime() - b.metadata.lastAccessedAt.getTime();
    });
    while (this.index.size > limit) {
      const entry = candidates.shift();
      if (!entry) break;
      this.index.delete(entry.id);
      try {
        await unlink(join(this.baseDir, `${entry.id}.md`));
      } catch {
        // The index is authoritative; a missing markdown mirror is harmless.
      }
    }
  }
}

// -------------------------------------------------------------------
// Markdown serialization
// -------------------------------------------------------------------

function toMarkdown(entry: MemoryEntry): string {
  const lines = [
    '---',
    `id: "${entry.id}"`,
    `type: ${entry.type}`,
    `importance: ${entry.metadata.importance}`,
    `createdAt: "${entry.metadata.createdAt.toISOString()}"`,
    `updatedAt: "${entry.metadata.updatedAt.toISOString()}"`,
    `accessCount: ${entry.metadata.accessCount}`,
    `lastAccessedAt: "${entry.metadata.lastAccessedAt.toISOString()}"`,
    `tags: [${entry.tags.join(', ')}]`,
  ];
  if (entry.metadata.sourceSessionId) {
    lines.push(`sourceSessionId: "${entry.metadata.sourceSessionId}"`);
  }
  lines.push('---', '', entry.content);
  return lines.join('\n');
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
  return {
    ...entry,
    tags: [...entry.tags],
    metadata: {
      ...entry.metadata,
      createdAt: new Date(entry.metadata.createdAt),
      updatedAt: new Date(entry.metadata.updatedAt),
      lastAccessedAt: new Date(entry.metadata.lastAccessedAt),
    },
  };
}
