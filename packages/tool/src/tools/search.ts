import { stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ToolResult, ToolContext } from '../types';
import { BaseTool } from '../types';
import type { JSONSchema } from '@personal-agent/shared';
import fg from 'fast-glob';

// ---------------------------------------------------------------------------
// glob — find files by pattern
// ---------------------------------------------------------------------------

/** 生成的/重型目录与文件：glob 与 grep 默认跳过，避免遍历 node_modules、
 *  .git、构建产物等导致 CPU 打满或结果爆炸。 */
const COMMON_IGNORED_PATHS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.pnpm-store/**',
  '**/.turbo/**',
  '**/.next/**',
  '**/.cache/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/coverage/**',
  '**/release/**',
  '**/releases/**',
  '**/make/**',
  '**/*.tsbuildinfo',
];

/** glob 单次返回的最大条数：达到后立即停止遍历（防止宽泛模式全盘扫描）。 */
const MAX_GLOB_RESULTS = 1000;
/** glob 遍历超时：超时即中断并报错，避免长时间占用 CPU。 */
const GLOB_TIMEOUT_MS = 30_000;

export class GlobTool extends BaseTool {
  readonly name = 'glob';
  readonly description = `Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time (most recent first).
- pattern: the glob pattern to match files against
- path: the directory to search in (defaults to working directory)
Generated/heavy directories (node_modules, .git, dist, build, coverage, ...) are skipped automatically. At most ${MAX_GLOB_RESULTS} results are returned and traversal stops early — prefer narrow patterns (e.g. "src/**/*.ts") over broad ones ("**/*").`;
  readonly category = 'file' as const;
  readonly requiresPermission = false;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern to match files against' },
      path: { type: 'string', description: 'The directory to search in' },
    },
    required: ['pattern'],
  };

  constructor(private readonly limits?: { maxResults?: number; timeoutMs?: number }) {
    super();
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const searchPath = (params.path as string) ?? context.workingDirectory;
    const maxResults = this.limits?.maxResults ?? MAX_GLOB_RESULTS;
    const timeoutMs = this.limits?.timeoutMs ?? GLOB_TIMEOUT_MS;

    // fast-glob 的类型声明是 NodeJS.ReadableStream（最小接口，无 destroy），
    // 运行时实际是 stream.Readable —— 这里断言出 destroy 以支持提前终止遍历。
    const stream = fg.stream(pattern, {
      cwd: searchPath,
      absolute: false,
      dot: false,
      onlyFiles: true,
      stats: true,
      ignore: COMMON_IGNORED_PATHS,
      // 遇到无权限/损坏的条目跳过而不是中断整个遍历
      suppressErrors: true,
    }) as unknown as { destroy(): void } & AsyncIterable<fg.Entry>;

    // 流式收集：达到上限、超时或用户中断时 destroy() 立即停止底层遍历，
    // 避免在超大目录树（如 node_modules）上长时间空转 CPU。
    const entries: fg.Entry[] = [];
    let timedOut = false;
    let truncated = false;
    const destroy = (): void => stream.destroy();
    const timer = setTimeout(() => {
      timedOut = true;
      destroy();
    }, timeoutMs);
    const onAbort = (): void => destroy();
    context.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for await (const entry of stream) {
        entries.push(entry);
        if (entries.length >= maxResults) {
          truncated = true;
          destroy();
          break;
        }
      }
    } catch {
      // 提前 destroy（上限/超时/中断）会令迭代器抛错，这里按正常流程收尾
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }

    if (context.signal?.aborted) return interruptedSearchResult();
    if (timedOut) {
      return this.error(`Glob timed out after ${timeoutMs}ms (traversal aborted)`);
    }

    // Sort by modification time (most recent first)
    const sorted = entries.sort((a, b) => {
      const aTime = a.stats?.mtimeMs ?? 0;
      const bTime = b.stats?.mtimeMs ?? 0;
      return bTime - aTime;
    });

    if (sorted.length === 0) {
      return this.success('(no files matched)');
    }

    const content =
      sorted.map((f) => f.path).join('\n') +
      (truncated ? `\n... [truncated: stopped after ${maxResults} results]` : '');

    return this.success(content, {
      duration: 0,
      truncated,
    });
  }
}

// ---------------------------------------------------------------------------
// grep — search file contents
// ---------------------------------------------------------------------------

export class GrepTool extends BaseTool {
  readonly name = 'grep';
  readonly description = `Fast regex-based content search across files.
- pattern: the regex pattern to search for
- path: file or directory to search in (defaults to working directory)
- glob: filter files by glob pattern (e.g. "*.ts")
- output_mode: "content" (matching lines), "files_with_matches" (default), or "count"`;
  readonly category = 'file' as const;
  readonly requiresPermission = false;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search in' },
      glob: { type: 'string', description: 'Filter files by glob pattern' },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output mode',
      },
      head_limit: { type: 'number', description: 'Limit output to first N entries' },
    },
    required: ['pattern'],
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const requestedPath = params.path as string | undefined;
    const searchPath = requestedPath
      ? resolve(context.workingDirectory, requestedPath)
      : context.workingDirectory;
    const fileGlob = params.glob as string | undefined;
    const outputMode = (params.output_mode as string) ?? 'files_with_matches';
    const requestedLimit = Number(params.head_limit ?? 250);
    const headLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), 10_000))
      : 250;

    try {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch (error) {
        return this.error(`Invalid regular expression: ${(error as Error).message}`);
      }

      if (context.signal?.aborted) return interruptedSearchResult();

      const pathInfo = await stat(searchPath);
      const searchRoot = pathInfo.isFile() ? dirname(searchPath) : searchPath;
      const searchPattern = pathInfo.isFile() ? basename(searchPath) : (fileGlob ?? '**/*');
      const allFiles = await fg(searchPattern, {
        cwd: searchRoot,
        absolute: false,
        dot: false,
        onlyFiles: true,
        stats: true,
        ignore: COMMON_IGNORED_PATHS,
      });
      if (context.signal?.aborted) return interruptedSearchResult();

      const results: string[] = [];
      const fileMatches: Map<string, number> = new Map();
      let truncated = false;

      for (const entry of allFiles) {
        if (context.signal?.aborted) return interruptedSearchResult();
        const currentEntries = outputMode === 'content' ? results.length : fileMatches.size;
        if (currentEntries >= headLimit) {
          truncated = true;
          break;
        }

        const file = entry.path;
        const fullPath = join(searchRoot, file);

        // Skip binary/large files
        if ((entry.stats?.size ?? 0) > 5 * 1024 * 1024) continue;

        const stream = createReadStream(fullPath, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        const stopReading = (): void => {
          rl.close();
          stream.destroy();
        };
        context.signal?.addEventListener('abort', stopReading, { once: true });
        try {
          let lineNum = 0;
          for await (const line of rl) {
            if (context.signal?.aborted) return interruptedSearchResult();
            lineNum++;
            if (regex.test(line)) {
              fileMatches.set(file, (fileMatches.get(file) ?? 0) + 1);

              if (outputMode === 'content') {
                results.push(`${file}:${lineNum}: ${line.slice(0, 500)}`);
              } else if (outputMode === 'files_with_matches') {
                break;
              }
            }

            if (outputMode === 'content' && results.length >= headLimit) {
              truncated = true;
              break;
            }
          }
        } catch {
          // skip unreadable files
        } finally {
          context.signal?.removeEventListener('abort', stopReading);
          stopReading();
        }
      }

      if (outputMode === 'count') {
        const content = Array.from(fileMatches.entries())
          .map(([file, count]) => `${file}: ${count} matches`)
          .join('\n');
        return this.success(content || '(no matches found)', { duration: 0, truncated });
      }

      if (outputMode === 'files_with_matches') {
        const content = Array.from(fileMatches.keys()).join('\n');
        return this.success(content || '(no matches found)', { duration: 0, truncated });
      }

      return this.success(results.length > 0 ? results.join('\n') : '(no matches found)', {
        duration: 0,
        truncated,
      });
    } catch (err) {
      if (context.signal?.aborted) return interruptedSearchResult();
      return this.error(`Grep failed: ${(err as Error).message}`);
    }
  }
}

function interruptedSearchResult(): ToolResult {
  return {
    success: false,
    content: '',
    error: 'Tool execution interrupted by user',
    metadata: { duration: 0, interrupted: true },
  };
}
