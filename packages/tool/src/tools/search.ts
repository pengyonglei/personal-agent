import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
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

      return this.success(
        sorted.map((f) => f.path).join('\n'),
        { duration: 0, truncated: sorted.length > 1000 },
      );
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
  readonly description = `Content search built on ripgrep. Fast regex-based search across files.
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
    const searchPath = (params.path as string) ?? context.workingDirectory;
    const fileGlob = params.glob as string | undefined;
    const outputMode = (params.output_mode as string) ?? 'files_with_matches';
    const headLimit = (params.head_limit as number) ?? 250;

    try {
      // Get all files first
      const allFiles = await fg(fileGlob ? fileGlob : '**/*', {
        cwd: searchPath,
        absolute: false,
        dot: false,
        onlyFiles: true,
        ignore: ['node_modules/**', '.git/**', 'dist/**', '.turbo/**', '*.tsbuildinfo'],
      });

      const results: string[] = [];
      const fileMatches: Map<string, number> = new Map();
      let totalCount = 0;

      for (const file of allFiles) {
        if (results.length >= headLimit) break;

        const fullPath = join(searchPath, file);

        // Skip binary/large files
        try {
          const fileInfo = await stat(fullPath);
          if (fileInfo.size > 5 * 1024 * 1024) continue; // skip >5MB
        } catch {
          continue;
        }

        try {
          let lineNum = 0;
          const stream = createReadStream(fullPath, { encoding: 'utf-8' });
          const rl = createInterface({ input: stream, crlfDelay: Infinity });

          for await (const line of rl) {
            lineNum++;
            try {
              const regex = new RegExp(pattern, 'gi');
              if (regex.test(line)) {
                totalCount++;
                fileMatches.set(file, (fileMatches.get(file) ?? 0) + 1);

                if (outputMode === 'content') {
                  results.push(`${file}:${lineNum}: ${line.slice(0, 500)}`);
                }
              }
            } catch {
              // regex error on this line, skip
            }

            if (results.length >= headLimit) break;
          }
          rl.close();
        } catch {
          // skip unreadable files
        }
      }

      if (outputMode === 'count') {
        return this.success(Array.from(fileMatches.entries()).map(([f, c]) => `${f}: ${c} matches`).join('\n'));
      }

      if (outputMode === 'files_with_matches') {
        return this.success(Array.from(fileMatches.keys()).join('\n'));
      }

      return this.success(
        results.length > 0 ? results.join('\n') : '(no matches found)',
        { duration: 0, truncated: results.length >= headLimit },
      );
    } catch (err) {
      return this.error(`Grep failed: ${(err as Error).message}`);
    }
  }
}
