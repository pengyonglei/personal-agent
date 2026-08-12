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
  /** Whether this model accepts image content blocks. */
  imageInput: z.boolean().optional(),
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

type PermissionRuleTarget = 'all' | `task:${string}` | `project:${string}`;

const permissionTargetSchema = z.custom<PermissionRuleTarget>(
  (value) =>
    value === 'all' ||
    (typeof value === 'string' && (value.startsWith('task:') || value.startsWith('project:'))),
  { message: 'target must be all, task:<id> or project:<id>' },
);

const permissionRuleSchema = z.object({
  tool: z.string(),
  pattern: z.string().optional(),
  action: z.enum(['allow', 'ask', 'approval']),
  scope: z.enum(['session', 'project', 'global']),
  // Optional rule scope target: 'all' (default) or a specific task/project.
  // Task/project-targeted rules only apply to the matching task's execution
  // and take priority over the shared global baseline.
  target: permissionTargetSchema.optional(),
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

/** Web UI 外观配置：主题模式与主色，由 Web 设置面板持久化到 config.yaml。 */
const webConfigSchema = z.object({
  /** 主题模式：light 浅色 / dark 深色 */
  theme: z.enum(['light', 'dark']).default('light'),
  /** 浅色模式主色（#rrggbb） */
  accentLight: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'accentLight 必须是 #rrggbb 格式')
    .default('#1677ff'),
  /** 深色模式主色（#rrggbb） */
  accentDark: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'accentDark 必须是 #rrggbb 格式')
    .default('#91caff'),
});

const statsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** SQLite database file path. Defaults to ~/.personal-agent/stats/model-requests.db */
  dbPath: z.string().optional(),
  /**
   * Whether to persist full request payloads (messages / tools / options) as
   * JSON. Default false — payloads can be large. Only affects NEW requests.
   */
  recordPayloads: z.boolean().default(false),
  /** Delete records older than this many days. 0 = keep everything. */
  retentionDays: z.number().int().min(0).default(90),
});

export const DEFAULT_VISION_PROMPT =
  '检查布局错位、文本裁切、元素重叠、关键操作不可见和主题异常。';

/** 全局视觉审查模型配置，由 Web 设置面板管理。 */
const visionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(['anthropic', 'openai', 'ollama', 'deepseek', 'volcano']).optional(),
  model: z.string().min(1).max(256).optional(),
  prompt: z.string().min(1).max(4000).default(DEFAULT_VISION_PROMPT),
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
      /** Windows 上 bash 工具使用的 shell：auto=PowerShell，bash=Git Bash/WSL。 */
      shell: z.enum(['auto', 'powershell', 'bash']).default('auto'),
    })
    .default({}),
  mcp: z
    .object({
      servers: z.array(mcpServerConfigSchema).default([]),
    })
    .default({}),
  tui: tuiConfigSchema.default({}),
  web: webConfigSchema.default({}),
  stats: statsConfigSchema.default({}),
  vision: visionConfigSchema.default({}),
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
  skills: z
    .object({
      enabled: z.boolean().default(true),
      paths: z.array(z.string()).default([]),
    })
    .default({}),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type WebConfig = z.infer<typeof webConfigSchema>;
export type ToolSandboxConfig = z.infer<typeof sandboxSchema>;
export type StatsConfig = z.infer<typeof statsConfigSchema>;
export type VisionConfig = z.infer<typeof visionConfigSchema>;
export type PermissionRuleConfig = z.infer<typeof permissionRuleSchema>;
export type MCPServerConfig = z.infer<typeof mcpServerConfigSchema>;
