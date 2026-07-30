// ---------------------------------------------------------------------------
// Token counting utilities
// ---------------------------------------------------------------------------

import type { UnifiedMessage, UnifiedContentBlock } from './types';

/**
 * Approximate token count using character-based estimation.
 * This is a rough estimator that works without loading a tokenizer.
 * For Anthropic: ~3.0 chars/token (English text)
 * For OpenAI:   ~3.0 chars/token (English text, cl100k_base)
 */
const CHARS_PER_TOKEN = 3.0;

/**
 * Count string tokens using character-based estimation.
 */
export function countStringTokens(str: string): number {
  return Math.ceil(str.length / CHARS_PER_TOKEN);
}

/**
 * Count tokens in a content block.
 */
function countContentBlockTokens(block: UnifiedContentBlock): number {
  switch (block.type) {
    case 'text':
      return countStringTokens(block.text);
    case 'tool_use':
      return countStringTokens(JSON.stringify(block.input)) + countStringTokens(block.name);
    case 'tool_result':
      return countStringTokens(block.content);
    case 'image':
      // Rough estimate: images cost ~85 tokens each for Anthropic, ~85 for OpenAI
      return 85;
    case 'thinking':
      return countStringTokens(block.thinking);
    default:
      return 0;
  }
}

/**
 * Count tokens in a unified message.
 */
export function countMessageTokens(message: UnifiedMessage): number {
  let count = 4; // role overhead

  if (typeof message.content === 'string') {
    count += countStringTokens(message.content);
  } else {
    for (const block of message.content) {
      count += countContentBlockTokens(block);
    }
  }

  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      count += countStringTokens(tc.function.name) + countStringTokens(tc.function.arguments);
    }
  }

  return count;
}

/**
 * Count total tokens across all messages.
 */
export function countTotalTokens(messages: UnifiedMessage[]): number {
  return messages.reduce((sum, m) => sum + countMessageTokens(m), 0);
}

// ---------------------------------------------------------------------------
// Logging utilities
// ---------------------------------------------------------------------------

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  Silent = 4,
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

let currentLogLevel = LogLevel.Info;

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function createLogger(name: string): Logger {
  const prefix = `[${name}]`;

  return {
    debug(...args: unknown[]) {
      if (currentLogLevel <= LogLevel.Debug) console.debug(prefix, ...args);
    },
    info(...args: unknown[]) {
      if (currentLogLevel <= LogLevel.Info) console.info(prefix, ...args);
    },
    warn(...args: unknown[]) {
      if (currentLogLevel <= LogLevel.Warn) console.warn(prefix, ...args);
    },
    error(...args: unknown[]) {
      if (currentLogLevel <= LogLevel.Error) console.error(prefix, ...args);
    },
  };
}

// ---------------------------------------------------------------------------
// UUID generation (without crypto dependency)
// ---------------------------------------------------------------------------

export function generateId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const segments = [8, 4, 4, 4, 12];
  return segments
    .map((len) =>
      Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join(''),
    )
    .join('-');
}

// ---------------------------------------------------------------------------
// Async utilities
// ---------------------------------------------------------------------------

/**
 * Execute a promise with a timeout.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out',
): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(errorMessage)), timeoutMs),
  );
  return Promise.race([promise, timeout]);
}

/**
 * Retry a function with exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: Error) => boolean;
  } = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30000, shouldRetry = () => true } = options;

  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === maxRetries || !shouldRetry(lastError)) throw lastError;
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
