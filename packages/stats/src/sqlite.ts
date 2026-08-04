// ---------------------------------------------------------------------------
// node:sqlite compatibility loader
// ---------------------------------------------------------------------------
//
// `node:sqlite` is a built-in module available since Node 22.5 (flagged) and
// unflagged since 22.13 / 23.4. Instead of a top-level `import 'node:sqlite'`
// (which would crash the process on older runtimes), we load it lazily via
// `createRequire` and return `null` when unavailable so callers can degrade
// gracefully (stats tracking disabled, main flow unaffected).
//
// We also define minimal structural types instead of relying on the version of
// `@types/node` shipping `node:sqlite` declarations, keeping the package
// robust across toolchain versions.

import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Minimal structural types (subset of node:sqlite's DatabaseSync API)
// ---------------------------------------------------------------------------

export interface StatementSyncLike {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

export type DatabaseSyncCtor = new (path: string) => DatabaseSyncLike;

// ---------------------------------------------------------------------------
// Lazy loader
// ---------------------------------------------------------------------------

let cachedCtor: DatabaseSyncCtor | null | undefined;

/**
 * Load the `node:sqlite` DatabaseSync constructor, or return `null` when the
 * current runtime does not provide it (Node < 22.13 etc.). The result is
 * cached for the lifetime of the process.
 */
export function loadDatabaseSync(): DatabaseSyncCtor | null {
  if (cachedCtor !== undefined) return cachedCtor;
  try {
    // `import.meta.url` is only meaningful in ESM; bundlers may leave it as an
    // empty object in CJS output, so prefer `__filename` when it exists (CJS).
    const require =
      typeof __filename !== 'undefined'
        ? createRequire(__filename)
        : createRequire(import.meta.url);
    const mod = require('node:sqlite') as { DatabaseSync?: unknown };
    cachedCtor = (mod.DatabaseSync as DatabaseSyncCtor | undefined) ?? null;
  } catch {
    cachedCtor = null;
  }
  return cachedCtor;
}
