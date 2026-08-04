import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas for validating the configuration
// ---------------------------------------------------------------------------

/**
 * A model entry in the provider config. Either a plain model id (uses the
 * provider's built-in defaults for context/max output limits) or an object
 * with explicit context window and max output token counts.
 */
export const modelConfigSchema = z.object({
  id: z.string().min(1).max(256),
  /** Total context window length in tokens. */
  contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
  /** Maximum output (completion) length in tokens. */
  maxOutputTokens: z.number().int().min(1).max(10_000_000).optional(),
});

const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  defaultModel: z.string().optional(),
  models: z
    .array(z.union([z.string().min(1).max(256), modelConfigSchema]))
    .max(100)
    .optional(),
  thinkingEffort: z.enum(['off', 'low', 'medium', 'high', 'max']).optional(),
});

const planModeSchema = z.object({
  enabled: z.boolean().default(true),
  autoApprove: z.boolean().default(false),
});

const sandboxSchema = z.object({
  restrictPaths: z.boolean().default(true),
  allowedPaths: z.array(z.string()).default([]),
  deniedCommands: z.array(z.string()).default([]),
});

const permissionRuleSchema = z.object({
  tool: z.string(),
  pattern: z.string().optional(),
  action: z.enum(['allow', 'ask', 'approval']),
  scope: z.enum(['session', 'project', 'global']),
});

const mcpServerConfigSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'sse', 'streamable-http']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  env: z.record(z.string()).optional(),
  headers: z.record(z.string()).optional(),
  autoApprove: z.array(z.string()).optional(),
});

const tuiConfigSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  showTokenCounter: z.boolean().default(true),
  showCostEstimates: z.boolean().default(true),
  enableMouse: z.boolean().default(false),
});

export const appConfigSchema = z.object({
  providers: z
    .object({
      active: z.enum(['anthropic', 'openai', 'ollama', 'deepseek', 'volcano']).optional(),
      anthropic: providerConfigSchema.optional(),
      openai: providerConfigSchema.optional(),
      ollama: providerConfigSchema
        .extend({
          baseURL: z.string().default('http://localhost:11434'),
        })
        .optional(),
      deepseek: providerConfigSchema.optional(),
      volcano: providerConfigSchema.optional(),
    })
    .default({}),
  agent: z
    .object({
      maxTurns: z.number().min(1).max(500).default(100),
      maxTokens: z.number().optional(),
      temperature: z.number().min(0).max(2).default(0),
      systemPromptAppend: z.string().optional(),
      planMode: planModeSchema.default({}),
    })
    .default({}),
  tools: z
    .object({
      sandbox: sandboxSchema.default({}),
      permissions: z.array(permissionRuleSchema).default([]),
      shellTimeout: z.number().default(120000),
      webFetchTimeout: z.number().default(30000),
    })
    .default({}),
  mcp: z
    .object({
      servers: z.array(mcpServerConfigSchema).default([]),
    })
    .default({}),
  tui: tuiConfigSchema.default({}),
  memory: z
    .object({
      enabled: z.boolean().default(true),
      store: z.enum(['filesystem', 'sqlite']).default('filesystem'),
      maxEntries: z.number().default(1000),
    })
    .default({}),
  plugins: z
    .object({
      enabled: z.boolean().default(true),
      paths: z.array(z.string()).default([]),
      disabled: z.array(z.string()).default([]),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type ToolSandboxConfig = z.infer<typeof sandboxSchema>;
export type PermissionRuleConfig = z.infer<typeof permissionRuleSchema>;
export type MCPServerConfig = z.infer<typeof mcpServerConfigSchema>;
