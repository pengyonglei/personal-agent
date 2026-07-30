import { readFile, writeFile, stat, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join, isAbsolute, relative } from 'node:path';
import type { ToolResult, ToolContext } from '../types';
import { BaseTool } from '../types';
import type { JSONSchema } from '@personal-agent/shared';

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export class ReadFileTool extends BaseTool {
  readonly name = 'read_file';
  readonly description = `Reads a file from the local filesystem.
- file_path must be an absolute path.
- Reads up to 2000 lines by default.
- You can optionally specify a line offset and limit.
- Results are returned using cat -n format, with line numbers starting at 1`;
  readonly category = 'file' as const;
  readonly requiresPermission = false;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to read' },
      offset: { type: 'number', description: 'Line number to start reading from' },
      limit: { type: 'number', description: 'Maximum number of lines to read' },
    },
    required: ['file_path'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const filePath = params.file_path as string;
    const offset = (params.offset as number) ?? 0;
    const limit = (params.limit as number) ?? 2000;

    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      const start = Math.max(0, offset);
      const end = limit ? start + limit : lines.length;
      const selectedLines = lines.slice(start, end);

      // Format with line numbers (cat -n style)
      const formatted = selectedLines
        .map((line, i) => `${(start + i + 1).toString().padStart(6, ' ')}\t${line}`)
        .join('\n');

      const display = formatted.length > 0 ? formatted : '(file is empty)';

      return this.success(display, {
        duration: 0,
        fileModified: [filePath],
        truncated: end < lines.length,
      });
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return this.error(`File not found: ${filePath}`);
      }
      if (error.code === 'EACCES') {
        return this.error(`Permission denied: ${filePath}`);
      }
      return this.error(`Failed to read file: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export class WriteFileTool extends BaseTool {
  readonly name = 'write_file';
  readonly description = `Writes a file to the local filesystem, overwriting if one exists.
- file_path must be an absolute path.
- content is the text to write to the file.
- Creates parent directories if they don't exist.`;
  readonly category = 'file' as const;
  readonly requiresPermission = true;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to write the file to' },
      content: { type: 'string', description: 'The content to write' },
    },
    required: ['file_path', 'content'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const filePath = params.file_path as string;
    const content = params.content as string;

    try {
      // Create parent directories
      const dir = dirname(filePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      await writeFile(filePath, content, 'utf-8');
      return this.success(`File written successfully: ${filePath}`, {
        duration: 0,
        fileModified: [filePath],
      });
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      return this.error(`Failed to write file: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export class EditFileTool extends BaseTool {
  readonly name = 'edit_file';
  readonly description = `Performs exact string replacement in a file.
- file_path must be an absolute path.
- old_string must match the file contents exactly (including indentation).
- new_string is the text to replace it with.
- replace_all: true to replace every occurrence.`;
  readonly category = 'file' as const;
  readonly requiresPermission = true;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The absolute path to the file to edit' },
      old_string: { type: 'string', description: 'The text to replace' },
      new_string: { type: 'string', description: 'The text to replace it with' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const filePath = params.file_path as string;
    const oldStr = params.old_string as string;
    const newStr = params.new_string as string;
    const replaceAll = (params.replace_all as boolean) ?? false;

    try {
      const content = await readFile(filePath, 'utf-8');

      // Check uniqueness for single replacement
      if (!replaceAll) {
        const count = content.split(oldStr).length - 1;
        if (count === 0) {
          return this.error(`old_string not found in file: ${filePath}`);
        }
        if (count > 1) {
          return this.error(
            `old_string found ${count} times in file. Use replace_all: true to replace all, or make old_string more specific.`,
          );
        }
      }

      const newContent = replaceAll
        ? content.split(oldStr).join(newStr)
        : content.replace(oldStr, newStr);

      if (newContent === content) {
        return this.success('No changes made (old_string not found).');
      }

      await writeFile(filePath, newContent, 'utf-8');
      return this.success(`File edited successfully: ${filePath}`, {
        duration: 0,
        fileModified: [filePath],
      });
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return this.error(`File not found: ${filePath}`);
      }
      return this.error(`Failed to edit file: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

export class ListDirectoryTool extends BaseTool {
  readonly name = 'list_directory';
  readonly description = `Lists files and directories in a given path.
- path: directory to list (defaults to working directory)
- recursive: whether to list recursively`;
  readonly category = 'file' as const;
  readonly requiresPermission = false;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to list (absolute or relative)' },
      recursive: { type: 'boolean', description: 'List recursively' },
    },
    required: [],
  };

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const targetPath = (params.path as string) ?? context.workingDirectory;
    const recursive = (params.recursive as boolean) ?? false;

    try {
      const entries = await readdir(targetPath, { withFileTypes: true });
      const lines: string[] = [];

      for (const entry of entries) {
        const type = entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : '?';
        lines.push(`${type} ${entry.name}`);
      }

      if (recursive) {
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subPath = join(targetPath, entry.name);
            try {
              const subEntries = await readdir(subPath, { withFileTypes: true });
              for (const sub of subEntries) {
                const subType = sub.isDirectory() ? 'd' : sub.isFile() ? 'f' : '?';
                lines.push(`  ${subType} ${entry.name}/${sub.name}`);
              }
            } catch {
              lines.push(`  ? ${entry.name}/ (access denied)`);
            }
          }
        }
      }

      return this.success(
        lines.length > 0 ? lines.join('\n') : '(empty directory)',
      );
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ENOENT') {
        return this.error(`Directory not found: ${targetPath}`);
      }
      return this.error(`Failed to list directory: ${error.message}`);
    }
  }
}
