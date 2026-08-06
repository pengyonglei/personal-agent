import { spawn } from 'node:child_process';
import type { ToolResult, ToolContext } from '../types';
import { BaseTool } from '../types';
import type { JSONSchema } from '@personal-agent/shared';
import { resolveShell, getDefaultShellPreference, type ShellPreference } from '../shell-resolver';

// ---------------------------------------------------------------------------
// bash — execute shell commands
// ---------------------------------------------------------------------------

export class BashTool extends BaseTool {
  readonly name = 'bash';
  readonly description = `Executes a shell command and returns its output.
- command: the shell command to execute (syntax follows the current shell, see the system prompt's Shell field)
- timeout: max execution time in ms (default: 120000, max: 600000)
- workingDirectory persists between calls but shell state does not.
- Use this for running git, npm, tests, and other CLI operations.`;
  readonly category = 'shell' as const;
  readonly requiresPermission = true;
  readonly isDangerous = true;
  readonly canBeUsedInSubAgent = true;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
      dangerouslyDisableSandbox: {
        type: 'boolean',
        description: 'Set to true to override sandbox restrictions',
      },
    },
    required: ['command'],
  };

  constructor(private readonly shellPreference: ShellPreference = 'auto') {
    super();
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = params.command as string;
    const timeout = (params.timeout as number) ?? 120000;

    let shell;
    try {
      // Falls back to the runtime-default preference (kept in sync with the
      // settings page) unless this tool instance was pinned to a value.
      shell = await resolveShell({ prefer: this.shellPreference ?? getDefaultShellPreference() });
    } catch (error) {
      return {
        success: false,
        content: '',
        error:
          error instanceof Error
            ? error.message
            : '未找到可用的 shell 执行环境。Windows 请安装 Git for Windows（自带 Git Bash）。',
      };
    }

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const proc = spawn(shell.command, shell.args(command), {
        cwd: shell.toWorkingDirectory(context.workingDirectory),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const timer = setTimeout(
        () => {
          killed = true;
          proc.kill('SIGKILL');
        },
        Math.min(timeout, 600000),
      );

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);

        const output =
          stdout +
          (stderr ? `\n[stderr]\n${stderr}` : '') +
          (killed ? `\n\n[process killed after ${timeout}ms]` : '');

        const success = code === 0 && !killed;

        resolve({
          success,
          content: output || '(no output)',
          error: success
            ? undefined
            : killed
              ? `Command timed out after ${timeout}ms`
              : `Exit code: ${code}`,
          metadata: {
            duration: timeout, // approximate
            truncated: output.length > 200000,
          },
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          content: '',
          error: `Failed to execute command: ${err.message}`,
        });
      });

      // Feed stdin if needed
      if (context.signal) {
        context.signal.addEventListener('abort', () => {
          proc.kill('SIGTERM');
        });
      }
    });
  }
}
