import type { ToolResult, ToolContext } from '../types';
import { BaseTool } from '../types';
import type { JSONSchema } from '@personal-agent/shared';

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
          'User-Agent': 'personal-agent/0.1.0',
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
          'User-Agent': 'personal-agent/0.1.0',
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
// ask_user — ask the user a question
// ---------------------------------------------------------------------------

export class AskUserTool extends BaseTool {
  readonly name = 'ask_user';
  readonly description = `Ask the user a question to resolve ambiguity or get a decision.
Use this when you're blocked on something only the user can decide.`;
  readonly category = 'utility' as const;
  readonly requiresPermission = false;

  readonly inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      options: {
        type: 'array',
        description: 'Available options for the user',
        items: { type: 'string' },
      },
    },
    required: ['question'],
  };

  async execute(params: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const question = params.question as string;
    const options = params.options as string[] | undefined;

    let output = `[QUESTION] ${question}`;
    if (options && options.length > 0) {
      output += '\n\nOptions:\n' + options.map((o, i) => `  ${i + 1}. ${o}`).join('\n');
    }

    return this.success(output);
  }
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
