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

export class GlobTool extends BaseTool {
  readonly name = 'glob';
  readonly description = `Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.
- pattern: the glob pattern to match files against
- path: the directory to search in (defaults to working directory)`;
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

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const searchPath = (params.path as string) ?? context.workingDirectory;

    try {
      const files = await fg(pattern, {
        cwd: searchPath,
        absolute: false,
        dot: false,
        onlyFiles: true,
        stats: true,
      });

      // Sort by modification time (most recent first)
      const sorted = files.sort((a, b) => {
        const aTime = a.stats?.mtimeMs ?? 0;
        const bTime = b.stats?.mtimeMs ?? 0;
        return bTime - aTime;
      });

      if (sorted.length === 0) {
        return this.success('(no files matched)');
      }

      return this.success(sorted.map((f) => f.path).join('\n'), {
        duration: 0,
        truncated: sorted.length > 1000,
      });
    } catch (err) {
      return this.error(`Glob failed: ${(err as Error).message}`);
    }
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
        ignore: GREP_IGNORED_PATHS,
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

const GREP_IGNORED_PATHS = [
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

function interruptedSearchResult(): ToolResult {
  return {
    success: false,
    content: '',
    error: 'Tool execution interrupted by user',
    metadata: { duration: 0, interrupted: true },
  };
}
