import { spawn } from 'node:child_process';
import type { ToolResult, ToolContext } from '../types';
import { BaseTool } from '../types';
import type { JSONSchema } from '@personal-agent/shared';

// ---------------------------------------------------------------------------
// bash — execute shell commands
// ---------------------------------------------------------------------------

export class BashTool extends BaseTool {
  readonly name = 'bash';
  readonly description = `Executes a bash command and returns its output.
- command: the shell command to execute
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

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = params.command as string;
    const timeout = (params.timeout as number) ?? 120000;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let killed = false;

      const proc = spawn('bash', ['-c', command], {
        cwd: context.workingDirectory,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, Math.min(timeout, 600000));

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);

        const output = stdout +
          (stderr ? `\n[stderr]\n${stderr}` : '') +
          (killed ? `\n\n[process killed after ${timeout}ms]` : '');

        const success = code === 0 && !killed;

        resolve({
          success,
          content: output || '(no output)',
          error: success ? undefined : (killed ? `Command timed out after ${timeout}ms` : `Exit code: ${code}`),
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
