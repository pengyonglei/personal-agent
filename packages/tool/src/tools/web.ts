import type { ToolResult, ToolContext, ValidationResult } from '../types';
import { BaseTool } from '../types';
import type { JSONSchema, UserAnswer, UserQuestion } from '@personal-agent/shared';
import { USER_AGENT, generateId } from '@personal-agent/shared';

// ---------------------------------------------------------------------------
// web_fetch — fetch and parse a URL
// ---------------------------------------------------------------------------

export class WebFetchTool extends BaseTool {
  readonly name = 'web_fetch';
  readonly description = `Fetches a URL and returns its content as text.
- url: the URL to fetch (http will be upgraded to https)
- prompt: optional prompt to run against the content (not yet implemented)`;
  readonly category = 'web' as const;
  readonly requiresPermission = true;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
    },
    required: ['url'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const url = params.url as string;

    try {
      const fetchUrl = url.startsWith('http://') ? url.replace('http://', 'https://') : url;
      if (!fetchUrl.startsWith('https://')) {
        return this.error('Only HTTP/HTTPS URLs are supported');
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(fetchUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,text/plain,application/json',
        },
      });

      clearTimeout(timer);

      if (!response.ok) {
        return this.error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      const text = await response.text();

      // Simple HTML to text conversion
      let processed = text;
      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        processed = stripHtml(text);
      }

      const truncated = processed.length > 100000;
      const output = processed.slice(0, 100000) + (truncated ? '\n... [content truncated]' : '');

      return this.success(output, { duration: 0, truncated });
    } catch (err) {
      return this.error(`Failed to fetch URL: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// web_search — search the web
// ---------------------------------------------------------------------------

export class WebSearchTool extends BaseTool {
  readonly name = 'web_search';
  readonly description = `Search the web for information.
- query: the search query
- Returns search result titles and URLs.`;
  readonly category = 'web' as const;
  readonly requiresPermission = true;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
    },
    required: ['query'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const query = params.query as string;

    // Placeholder: DuckDuckGo HTML search (no API key needed)
    try {
      const encoded = encodeURIComponent(query);
      const url = `https://lite.duckduckgo.com/lite/?q=${encoded}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return this.error(`Search failed: HTTP ${response.status}`);
      }

      const html = await response.text();
      const results = parseDuckDuckGoLite(html);

      if (results.length === 0) {
        return this.success('(no results found)');
      }

      return this.success(
        results
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
          .join('\n\n'),
      );
    } catch (err) {
      return this.error(`Search failed: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// todo_write — structured task management
// ---------------------------------------------------------------------------

export class TodoWriteTool extends BaseTool {
  readonly name = 'todo_write';
  readonly description = `Creates and manages a structured task list for your current coding session.
- Use this to track progress, organize complex tasks, and demonstrate thoroughness.
- Create tasks with subject, description, and optional dependencies.`;
  readonly category = 'utility' as const;
  readonly requiresPermission = false;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'Tasks to create or update',
        items: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Task title' },
            description: { type: 'string', description: 'Task description' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'deleted'],
              description: 'Task status',
            },
          },
        },
      },
    },
    required: ['tasks'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const tasks = params.tasks as Array<Record<string, unknown>>;
    const lines = tasks.map((t) => {
      const status = t.status ?? 'pending';
      const icons: Record<string, string> = {
        pending: '  ',
        in_progress: '▶ ',
        completed: '✓ ',
        deleted: '✗ ',
      };
      return `${icons[status as string] ?? '  '}[${status}] ${t.subject}`;
    });

    return this.success(lines.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// ask_user — ask the user a question with an interactive single/multi select
// ---------------------------------------------------------------------------

/** Maximum number of model-recommended options per question. */
export const ASK_USER_MAX_OPTIONS = 4;

export class AskUserTool extends BaseTool {
  readonly name = 'ask_user';
  readonly description = `Ask the user a question to resolve ambiguity or get a decision.
Use this when you're blocked on something only the user can decide.
- Provide at most ${ASK_USER_MAX_OPTIONS} recommended options; the UI renders them as a selectable list (single or multi select).
- A "custom answer" option is automatically appended, so users who dislike all options can type their own answer.
- Set multi_select=true when multiple options can be chosen at once.`;
  readonly category = 'utility' as const;
  readonly requiresPermission = false;
  /** Interactive only — sub-agents have no UI to answer. */
  readonly canBeUsedInSubAgent = false;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      options: {
        type: 'array',
        description: `Recommended answers (at most ${ASK_USER_MAX_OPTIONS})`,
        items: { type: 'string' },
      },
      multi_select: {
        type: 'boolean',
        description: 'Allow multiple selections (default false = single select)',
      },
      allow_custom: {
        type: 'boolean',
        description: 'Append a custom answer option (default true)',
      },
    },
    required: ['question'],
  };

  validateParams(params: Record<string, unknown>): ValidationResult {
    const base = super.validateParams(params);
    if (!base.valid) return base;
    const options = params.options;
    if (options !== undefined) {
      if (!Array.isArray(options)) {
        return { valid: false, errors: ['options must be an array'] };
      }
      if (options.length > ASK_USER_MAX_OPTIONS) {
        return {
          valid: false,
          errors: [`options must contain at most ${ASK_USER_MAX_OPTIONS} items`],
        };
      }
      for (const option of options) {
        if (typeof option !== 'string' || !option.trim()) {
          return { valid: false, errors: ['every option must be a non-empty string'] };
        }
      }
    }
    return { valid: true, errors: [] };
  }

  async execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const question = String(params.question ?? '').trim();
    const rawOptions = Array.isArray(params.options) ? params.options : [];
    const options: string[] = [];
    for (const option of rawOptions.slice(0, ASK_USER_MAX_OPTIONS)) {
      const text = String(option).trim();
      if (text && !options.includes(text)) options.push(text);
    }
    const multiSelect = params.multi_select === true;
    const allowCustom = params.allow_custom !== false;

    // Interactive path: the host UI renders the question and waits for the answer.
    if (context.askUser) {
      try {
        const answer = await context.askUser(
          { id: generateId(), question, options, multiSelect, allowCustom },
          context.signal,
        );
        return this.success(formatUserAnswer(answer));
      } catch (err) {
        if (context.signal?.aborted) {
          return {
            success: false,
            content: '',
            error: 'Question interrupted by user',
            metadata: { duration: 0, interrupted: true },
          };
        }
        return this.error(`Failed to get user answer: ${(err as Error).message}`);
      }
    }

    // Fallback (non-interactive): describe the question so the model can
    // surface it in the chat, but make clear no answer was collected.
    let output = `[QUESTION] ${question}`;
    if (options.length > 0) {
      output += '\n\nOptions:\n' + options.map((o, i) => `  ${i + 1}. ${o}`).join('\n');
    }
    output += '\n\n(no interactive input available — ask the user in the chat instead)';
    return this.success(output);
  }
}

function formatUserAnswer(answer: UserAnswer): string {
  const lines: string[] = [];
  if (answer.custom !== undefined && answer.custom.trim()) {
    lines.push(`User answered (custom): ${answer.custom.trim()}`);
  }
  if (answer.selections.length > 0) {
    lines.push(`User selected: ${answer.selections.join(', ')}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'User did not select any option.';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  // Remove scripts and styles
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Replace block elements with newlines
  text = text.replace(/<\/(div|p|h[1-6]|li|tr|section|article|header|footer)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode HTML entities
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
  return text;
}

function parseDuckDuckGoLite(html: string): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // Parse the lite edition table rows
  const rowRegex = /<tr[^>]*class="result-snippet"[^>]*>[\s\S]*?<\/tr>/gi;
  const matches = html.match(rowRegex) ?? [];

  // Simpler approach: extract links and their surrounding text
  const linkRegex = /<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1];
    const title = stripHtml(match[2]).trim();
    if (url.startsWith('//') || url.startsWith('http')) {
      const fullUrl = url.startsWith('//') ? 'https:' + url : url;
      if (!fullUrl.includes('duckduckgo.com') && title.length > 5) {
        results.push({ title, url: fullUrl, snippet: '' });
      }
    }
  }

  // Extract snippets
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>(.*?)<\/td>/gi;
  let sMatch;
  let i = 0;
  while ((sMatch = snippetRegex.exec(html)) !== null && i < results.length) {
    results[i].snippet = stripHtml(sMatch[1]).slice(0, 300);
    i++;
  }

  return results.slice(0, 10);
}
