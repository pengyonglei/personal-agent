import type {
  UnifiedContentBlock,
  UnifiedMessage,
  UnifiedToolDefinition,
  StreamOptions,
} from '@personal-agent/shared';
import { countTotalTokens, createLogger } from '@personal-agent/shared';
import type { LLMProvider } from '@personal-agent/provider';

const log = createLogger('context');

// ---------------------------------------------------------------------------
// System prompt sections
// ---------------------------------------------------------------------------

export interface SystemPromptSection {
  name: string;
  content: string;
  priority: number;
  conditional?: (ctx: AssemblerContext) => boolean;
}

export interface AssemblerContext {
  workingDirectory: string;
  platform: string;
  /** Actual shell used by the bash tool (e.g. 'PowerShell (Windows)'). */
  shell?: string;
  model: string;
  provider: string;
  mode: 'chat' | 'plan';
}

// ---------------------------------------------------------------------------
// Context assembler
// ---------------------------------------------------------------------------

export class ContextAssembler {
  private sections: SystemPromptSection[] = [];
  private conversationHistory: UnifiedMessage[] = [];
  private injectedMemories: string[] = [];
  private extraInstructions: string[] = [];

  constructor(private ctx: AssemblerContext) {
    this.registerDefaultSections();
  }

  // -------------------------------------------------------------------
  // Default system prompt sections
  // -------------------------------------------------------------------

  private registerDefaultSections(): void {
    // Identity
    this.addSection({
      name: 'identity',
      priority: 1,
      content: `You are personal-agent, a powerful AI agent CLI tool. You help users with software engineering tasks by providing direct assistance, executing tools, and reasoning through complex problems.

You are operating in a terminal environment with access to the user's filesystem.
Use as few requests as possible for each task execution.
`,
    });

    // Safety
    this.addSection({
      name: 'safety',
      priority: 2,
      content: `IMPORTANT: Assist with authorized tasks only. Refuse destructive or malicious requests. When editing files, always show the user what you changed. Double check your work before declaring something done.`,
    });

    // Environment
    this.addSection({
      name: 'environment',
      priority: 3,
      content: `Current environment:
- Working directory: ${this.ctx.workingDirectory}
- Platform: ${this.ctx.platform}
- Shell: ${this.ctx.shell ?? 'bash (Unix)'}
- Model: ${this.ctx.model} (${this.ctx.provider})
- Date: ${new Date().toISOString().split('T')[0]}

Shell usage notes:
- When the Shell is PowerShell (Windows), write commands in PowerShell syntax (e.g. $env:VAR, Get-ChildItem, dir works too; PowerShell 7 supports && and ||). Git and npm commands work the same as in other shells.
- When the Shell is bash (Git Bash), use bash syntax with Windows-style paths (C:\...).
- When the Shell is bash (WSL), use bash syntax with Linux paths — Windows paths are exposed as /mnt/<drive>/... (e.g. D:\work maps to /mnt/d/work).`,
    });

    // Mode
    this.addSection({
      name: 'mode',
      priority: 4,
      conditional: (ctx) => ctx.mode === 'plan',
      content: `Plan mode is active. Inspect with the exposed read-only tools, produce a detailed structured plan, and submit it with submit_plan. Do not make edits, run side-effecting tools, or execute the plan until the user approves it with /exit-plan.`,
    });
  }

  // -------------------------------------------------------------------
  // Section management
  // -------------------------------------------------------------------

  addSection(section: SystemPromptSection): void {
    this.sections.push(section);
  }

  removeSection(name: string): void {
    this.sections = this.sections.filter((s) => s.name !== name);
  }

  injectMemory(content: string): void {
    this.injectedMemories.push(content);
  }

  addInstruction(instruction: string): void {
    this.extraInstructions.push(instruction);
  }

  // -------------------------------------------------------------------
  // Conversation history
  // -------------------------------------------------------------------

  addMessage(message: UnifiedMessage): void {
    this.conversationHistory.push(message);
  }

  getHistory(): UnifiedMessage[] {
    return [...this.conversationHistory];
  }

  replaceHistory(messages: UnifiedMessage[]): void {
    this.conversationHistory = [...messages];
  }

  clearHistory(): void {
    this.conversationHistory = [];
    this.injectedMemories = [];
    this.extraInstructions = [];
  }

  setMode(mode: AssemblerContext['mode']): void {
    this.ctx.mode = mode;
  }

  // -------------------------------------------------------------------
  // Assembly
  // -------------------------------------------------------------------

  assemble(
    toolDefinitions: UnifiedToolDefinition[],
    options?: StreamOptions,
  ): { systemPrompt: string; messages: UnifiedMessage[] } {
    // Build system prompt from sections
    const activeSections = this.sections
      .filter((s) => !s.conditional || s.conditional(this.ctx))
      .sort((a, b) => a.priority - b.priority);

    let systemPrompt = activeSections.map((s) => s.content).join('\n\n');

    // Append injected memories
    if (this.injectedMemories.length > 0) {
      systemPrompt += '\n\n## Remembered Context\n\n';
      systemPrompt += this.injectedMemories.map((m) => `- ${m}`).join('\n');
    }

    // Append extra instructions (from CLAUDE.md, project configs, etc.)
    if (this.extraInstructions.length > 0) {
      systemPrompt += '\n\n## Additional Instructions\n\n';
      systemPrompt += this.extraInstructions.join('\n\n');
    }

    // Append options.systemPrompt if provided
    if (options?.systemPrompt) {
      systemPrompt += '\n\n' + options.systemPrompt;
    }

    // Build tool instructions
    if (toolDefinitions.length > 0) {
      systemPrompt += '\n\n';
      systemPrompt += '## Available Tools\n\n';
      systemPrompt +=
        'You have access to the following tools. Use them by responding with a tool_use content block. Use read_memory to query past facts, and write_memory to persist important information.\n\n';
      for (const tool of toolDefinitions) {
        systemPrompt += `### ${tool.name}\n${tool.description}\n`;
      }
    }

    // Construct final messages array
    const messages: UnifiedMessage[] = [
      { role: 'system', content: systemPrompt },
      ...this.conversationHistory,
    ];

    return { systemPrompt, messages };
  }
}

// ---------------------------------------------------------------------------
// Context summarizer
// ---------------------------------------------------------------------------

export type ContextSummarizer = (messages: UnifiedMessage[]) => Promise<string>;

const CONTEXT_SUMMARIZE_PROMPT = `You are summarizing a conversation for an AI coding assistant so it can continue helping the user without losing important context.

Produce a concise but information-dense summary that preserves:
- The user's goals and the current task
- Key decisions and their rationale
- Facts, constraints, and user preferences
- What has been completed and what remains to be done
- Important tool outputs or results
- Open questions or unresolved issues

Write the summary in the same language as the conversation. Output only the summary text, without any preamble.`;

/**
 * Create a context summarizer backed by an LLM provider.
 * The summary call uses low max tokens, zero temperature and reasoning off so
 * it stays cheap and deterministic. On any provider error the caller falls
 * back to the statistical summary.
 */
export function createLlmContextSummarizer(provider: LLMProvider): ContextSummarizer {
  return async (messages) => {
    const transcript = messages
      .map((message) => `${message.role}: ${extractText(message)}`)
      .join('\n\n');
    const response = await provider.chat(
      [
        {
          role: 'user',
          content: `${CONTEXT_SUMMARIZE_PROMPT}\n\n<conversation>\n${transcript}\n</conversation>`,
        },
      ],
      undefined,
      { maxTokens: 600, temperature: 0, reasoningEffort: 'off' },
    );
    const summary = extractResponseText(response.content);
    if (!summary) throw new Error('LLM summarizer returned an empty summary');
    return summary;
  };
}

function extractResponseText(blocks: UnifiedContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Token budget manager
// ---------------------------------------------------------------------------

export class TokenBudget {
  private maxTokens: number;
  private reservedForOutput: number;
  private summarizer?: ContextSummarizer;

  constructor(maxTokens: number, reservedForOutput = 8192, summarizer?: ContextSummarizer) {
    this.maxTokens = maxTokens;
    this.reservedForOutput = reservedForOutput;
    this.summarizer = summarizer;
  }

  getMaxContextTokens(): number {
    return this.maxTokens - this.reservedForOutput;
  }

  checkUsage(messages: UnifiedMessage[]): { used: number; limit: number; percentage: number } {
    const used = countTotalTokens(messages);
    const limit = this.getMaxContextTokens();
    return { used, limit, percentage: Math.round((used / limit) * 100) };
  }

  /**
   * Check if we need to compact the conversation.
   */
  shouldCompact(messages: UnifiedMessage[]): boolean {
    const { used, limit } = this.checkUsage(messages);
    return used > limit * 0.75; // 75% threshold
  }

  /**
   * Compacts conversation by summarizing early messages.
   * Preserves the last `keepRecent` turns intact.
   * In a real implementation, this would call a smaller/faster model to summarize.
   */
  async compact(messages: UnifiedMessage[], keepRecent = 6): Promise<UnifiedMessage[]> {
    // Skip system messages
    const systemMsgs = messages.filter((m) => m.role === 'system');
    const nonSystem = messages.filter((m) => m.role !== 'system');

    if (nonSystem.length <= keepRecent) {
      return messages; // Nothing to compact
    }

    // Split: early messages to summarize, recent messages to keep
    const toSummarize = nonSystem.slice(0, nonSystem.length - keepRecent);
    const recentMessages = nonSystem.slice(nonSystem.length - keepRecent);

    // Summarize the early messages (LLM-backed when available)
    const summary = await this.generateSummary(toSummarize);

    const compactedMessage: UnifiedMessage = {
      role: 'user',
      content: `[Earlier conversation summary]\n${summary}\n[End summary. Continue with the recent conversation below.]`,
    };

    return [...systemMsgs, compactedMessage, ...recentMessages];
  }

  /**
   * Generate a summary of the messages that are about to be dropped.
   * Uses the injected LLM summarizer when available; falls back to a simple
   * statistical summary so compaction never blocks the conversation.
   */
  private async generateSummary(messages: UnifiedMessage[]): Promise<string> {
    if (this.summarizer) {
      try {
        return await this.summarizer(messages);
      } catch (error) {
        log.warn(
          `LLM context summarization failed, falling back to statistical summary: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const userMessages = messages.filter((m) => m.role === 'user').map(extractText);
    const assistantResponses = messages.filter((m) => m.role === 'assistant').map(extractText);
    const toolCalls = messages.filter(
      (m) => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0,
    ).length;

    const parts: string[] = [];
    parts.push(`- ${userMessages.length} user messages`);
    parts.push(`- ${assistantResponses.length} assistant responses`);
    parts.push(`- ${toolCalls} tool call requests`);
    parts.push('- Topics: ' + userMessages.slice(0, 3).join('; ').slice(0, 200));

    return parts.join('\n');
  }

  updateMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(msg: UnifiedMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}
