import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { UnifiedMessage, SessionState, SessionMetadata } from '@personal-agent/shared';
import { createLogger, generateId } from '@personal-agent/shared';

const log = createLogger('session');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_DIR = resolve(homedir(), '.personal-agent', 'sessions');
const SESSION_INDEX_FILE = '_index.json';
const persistenceQueues = new Map<string, Promise<void>>();

interface SessionIndexEntry {
  id: string;
  createdAt: string;
  updatedAt: string;
  workingDirectory: string;
  model: string;
  provider: string;
  turnCount: number;
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Session manager with filesystem persistence
// ---------------------------------------------------------------------------

export class SessionManager {
  private currentSession: SessionState;
  private sessionsDir: string;

  constructor(workingDirectory: string, model: string, provider: string, sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? SESSIONS_DIR;
    this.currentSession = {
      id: generateId(),
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      metadata: {
        workingDirectory,
        model,
        provider,
        totalTokensUsed: 0,
        totalCost: 0,
        turnCount: 0,
        tokensUsedByModel: {},
        lastInputTokens: 0,
        lastInputTokensByModel: {},
        lastCacheHitTokens: 0,
        lastCacheHitTokensByModel: {},
      },
    };
  }

  // -------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------

  /** Ensure the sessions directory exists. Call once before use. */
  async ensureDir(): Promise<void> {
    if (!existsSync(this.sessionsDir)) {
      await mkdir(this.sessionsDir, { recursive: true });
    }
  }

  // -------------------------------------------------------------------
  // Message management
  // -------------------------------------------------------------------

  addMessage(message: UnifiedMessage): void {
    this.currentSession.messages.push(message);
    this.currentSession.updatedAt = new Date();
  }

  getMessages(): UnifiedMessage[] {
    return [...this.currentSession.messages];
  }

  getLastMessages(count: number): UnifiedMessage[] {
    return this.currentSession.messages.slice(-count);
  }

  clearMessages(): void {
    this.currentSession.messages = [];
    this.currentSession.updatedAt = new Date();
  }

  replaceMessages(messages: UnifiedMessage[]): void {
    this.currentSession.messages = [...messages];
    this.currentSession.updatedAt = new Date();
  }

  // -------------------------------------------------------------------
  // Session metadata
  // -------------------------------------------------------------------

  getSession(): SessionState {
    return {
      ...this.currentSession,
      messages: [...this.currentSession.messages],
    };
  }

  getSessionId(): string {
    return this.currentSession.id;
  }

  updateProvider(model: string, provider: string): void {
    this.currentSession.metadata.model = model;
    this.currentSession.metadata.provider = provider;
    this.currentSession.updatedAt = new Date();
  }

  private modelKey(): string {
    return `${this.currentSession.metadata.provider}:${this.currentSession.metadata.model}`;
  }

  incrementTurnCount(by = 1): void {
    this.currentSession.metadata.turnCount += by;
    this.currentSession.updatedAt = new Date();
  }

  addTokensUsed(input: number, output: number): void {
    this.currentSession.metadata.totalTokensUsed += input + output;
    const key = this.modelKey();
    const entries = this.currentSession.metadata.tokensUsedByModel ?? {};
    const current = entries[key];
    this.currentSession.metadata.tokensUsedByModel = {
      ...entries,
      [key]: {
        inputTokens: (current?.inputTokens ?? 0) + input,
        outputTokens: (current?.outputTokens ?? 0) + output,
      },
    };
    this.currentSession.updatedAt = new Date();
  }

  /**
   * Total tokens used by a specific model (input + output) within this
   * session. Falls back to the legacy session-wide total when no per-model
   * records exist yet (sessions created before per-model tracking).
   */
  getTokensUsed(provider: string, model: string): number {
    const entry = this.currentSession.metadata.tokensUsedByModel?.[`${provider}:${model}`];
    if (entry) return entry.inputTokens + entry.outputTokens;
    const hasPerModelRecords = Object.keys(this.currentSession.metadata.tokensUsedByModel ?? {})
      .length > 0;
    return hasPerModelRecords ? 0 : this.currentSession.metadata.totalTokensUsed;
  }

  /** Record the input token count of the most recent model request. */
  setLastInputTokens(input: number): void {
    const key = this.modelKey();
    this.currentSession.metadata.lastInputTokens = input;
    this.currentSession.metadata.lastInputTokensByModel = {
      ...(this.currentSession.metadata.lastInputTokensByModel ?? {}),
      [key]: input,
    };
    this.currentSession.updatedAt = new Date();
  }

  /**
   * Input tokens of the most recent model request (0 if none yet).
   * 按当前模型返回：任务在会话中切换模型后，各自模型的已用上下文互不影响。
   */
  getLastInputTokens(): number {
    const key = this.modelKey();
    return (
      this.currentSession.metadata.lastInputTokensByModel?.[key] ??
      this.currentSession.metadata.lastInputTokens ??
      0
    );
  }

  /** Record the cache-hit input token count of the most recent model request. */
  setLastCacheHitTokens(input: number): void {
    const key = this.modelKey();
    this.currentSession.metadata.lastCacheHitTokens = input;
    this.currentSession.metadata.lastCacheHitTokensByModel = {
      ...(this.currentSession.metadata.lastCacheHitTokensByModel ?? {}),
      [key]: input,
    };
    this.currentSession.updatedAt = new Date();
  }

  /**
   * Cache-hit input tokens of the most recent model request (0 if none yet).
   * 与 lastInputTokens 口径一致：按当前模型返回，刷新/重启后恢复各自的值。
   */
  getLastCacheHitTokens(): number {
    const key = this.modelKey();
    return (
      this.currentSession.metadata.lastCacheHitTokensByModel?.[key] ??
      this.currentSession.metadata.lastCacheHitTokens ??
      0
    );
  }

  // -------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------

  /**
   * Save the current session to disk.
   */
  async save(): Promise<string> {
    await this.ensureDir();

    const s = this.currentSession;
    const path = join(this.sessionsDir, `${s.id}.json`);
    const updatedAt = new Date();
    s.updatedAt = updatedAt;
    const snapshot: SessionState = {
      ...s,
      updatedAt,
      messages: [...s.messages],
      metadata: { ...s.metadata },
    };
    const data = {
      id: snapshot.id,
      createdAt: snapshot.createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      messages: snapshot.messages,
      metadata: {
        ...snapshot.metadata,
        totalTokensUsed: snapshot.metadata.totalTokensUsed,
        totalCost: snapshot.metadata.totalCost,
        tokensUsedByModel: snapshot.metadata.tokensUsedByModel ?? {},
        lastInputTokens: snapshot.metadata.lastInputTokens ?? 0,
        lastInputTokensByModel: snapshot.metadata.lastInputTokensByModel ?? {},
        lastCacheHitTokens: snapshot.metadata.lastCacheHitTokens ?? 0,
        lastCacheHitTokensByModel: snapshot.metadata.lastCacheHitTokensByModel ?? {},
      },
    };

    await enqueuePersistence(path, () => atomicWriteFile(path, JSON.stringify(data, null, 2)));
    await this.updateIndex(snapshot);
    log.info(
      `Session saved: ${s.id} (${s.messages.length} messages, ${s.metadata.turnCount} turns)`,
    );

    return s.id;
  }

  /**
   * Restore a session from disk, replacing the current in-memory state.
   */
  async restore(sessionId: string): Promise<boolean> {
    await this.ensureDir();

    const path = join(this.sessionsDir, `${sessionId}.json`);
    if (!existsSync(path)) {
      log.warn(`Session not found: ${sessionId}`);
      return false;
    }

    try {
      const raw = JSON.parse(await readFile(path, 'utf-8'));

      this.currentSession = {
        id: raw.id,
        createdAt: new Date(raw.createdAt),
        updatedAt: new Date(raw.updatedAt),
        messages: raw.messages ?? [],
        metadata: {
          workingDirectory: raw.metadata.workingDirectory ?? process.cwd(),
          model: raw.metadata.model ?? '',
          provider: raw.metadata.provider ?? '',
          totalTokensUsed: raw.metadata.totalTokensUsed ?? 0,
          totalCost: raw.metadata.totalCost ?? 0,
          turnCount: raw.metadata.turnCount ?? 0,
          tokensUsedByModel: raw.metadata.tokensUsedByModel ?? {},
          lastInputTokens: raw.metadata.lastInputTokens ?? 0,
          lastInputTokensByModel: raw.metadata.lastInputTokensByModel ?? {},
          lastCacheHitTokens: raw.metadata.lastCacheHitTokens ?? 0,
          lastCacheHitTokensByModel: raw.metadata.lastCacheHitTokensByModel ?? {},
        },
      };

      log.info(`Session restored: ${sessionId} (${this.currentSession.messages.length} messages)`);
      return true;
    } catch (err) {
      log.error(`Failed to restore session ${sessionId}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Delete a session from disk.
   */
  async delete(sessionId: string): Promise<boolean> {
    await this.ensureDir();

    const path = join(this.sessionsDir, `${sessionId}.json`);
    if (!existsSync(path)) return false;

    await unlink(path);
    await this.removeFromIndex(sessionId);
    log.info(`Session deleted: ${sessionId}`);
    return true;
  }

  /**
   * List all saved sessions, sorted by last updated (newest first).
   */
  async listSessions(): Promise<
    Array<{
      id: string;
      createdAt: Date;
      updatedAt: Date;
      workingDirectory: string;
      model: string;
      provider: string;
      turnCount: number;
      messageCount: number;
    }>
  > {
    await this.ensureDir();

    const indexPath = join(this.sessionsDir, SESSION_INDEX_FILE);

    if (!existsSync(indexPath)) return [];

    try {
      const entries: SessionIndexEntry[] = JSON.parse(await readFile(indexPath, 'utf-8'));
      return entries
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .map((e) => ({
          id: e.id,
          createdAt: new Date(e.createdAt),
          updatedAt: new Date(e.updatedAt),
          workingDirectory: e.workingDirectory,
          model: e.model,
          provider: e.provider,
          turnCount: e.turnCount,
          messageCount: e.messageCount,
        }));
    } catch {
      return [];
    }
  }

  /**
   * Get the most recently saved session id, or null if none.
   */
  async getLastSessionId(): Promise<string | null> {
    const sessions = await this.listSessions();
    return sessions.length > 0 ? sessions[0].id : null;
  }

  // -------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------

  getSummary(): string {
    const s = this.currentSession;
    return `Session ${s.id.slice(0, 8)}: ${s.messages.length} messages, ${s.metadata.turnCount} turns, ${s.metadata.totalTokensUsed} tokens`;
  }

  dispose(): void {
    // Don't auto-save on dispose — caller controls save timing
  }

  // -------------------------------------------------------------------
  // Index management
  // -------------------------------------------------------------------

  private async updateIndex(state: SessionState): Promise<void> {
    const indexPath = join(this.sessionsDir, SESSION_INDEX_FILE);
    const entry: SessionIndexEntry = {
      id: state.id,
      createdAt: state.createdAt.toISOString(),
      updatedAt: state.updatedAt.toISOString(),
      workingDirectory: state.metadata.workingDirectory,
      model: state.metadata.model,
      provider: state.metadata.provider,
      turnCount: state.metadata.turnCount,
      messageCount: state.messages.length,
    };

    await enqueuePersistence(indexPath, async () => {
      let entries: SessionIndexEntry[] = [];
      if (existsSync(indexPath)) {
        try {
          entries = JSON.parse(await readFile(indexPath, 'utf-8'));
        } catch {
          entries = [];
        }
      }
      const existing = entries.findIndex((candidate) => candidate.id === state.id);
      if (existing >= 0) entries[existing] = entry;
      else entries.push(entry);
      await atomicWriteFile(indexPath, JSON.stringify(entries, null, 2));
    });
  }

  private async removeFromIndex(sessionId: string): Promise<void> {
    const indexPath = join(this.sessionsDir, SESSION_INDEX_FILE);
    if (!existsSync(indexPath)) return;

    await enqueuePersistence(indexPath, async () => {
      try {
        let entries: SessionIndexEntry[] = JSON.parse(await readFile(indexPath, 'utf-8'));
        entries = entries.filter((e) => e.id !== sessionId);
        await atomicWriteFile(indexPath, JSON.stringify(entries, null, 2));
      } catch {
        // Ignore index corruption — worst case we rebuild
      }
    });
  }
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${generateId()}.tmp`;
  try {
    await writeFile(temporaryPath, content, 'utf-8');
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function enqueuePersistence(path: string, operation: () => Promise<void>): Promise<void> {
  const previous = persistenceQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  persistenceQueues.set(path, current);
  try {
    await current;
  } finally {
    if (persistenceQueues.get(path) === current) persistenceQueues.delete(path);
  }
}
