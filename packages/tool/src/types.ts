import type {
  ToolResult as SharedToolResult,
  JSONSchema,
  UnifiedToolDefinition,
} from '@personal-agent/shared';
import { isAbsolute, relative, resolve } from 'node:path';

// Re-export for convenience
export type ToolResult = SharedToolResult;

// ---------------------------------------------------------------------------
// Core tool types
// ---------------------------------------------------------------------------

export type ToolCategory =
  'file' | 'shell' | 'web' | 'agent' | 'memory' | 'mcp' | 'plan' | 'utility';

export interface ToolContext {
  sessionId: string;
  workingDirectory: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
  readonly category: ToolCategory;
  /** Does this tool require permission before execution? */
  readonly requiresPermission: boolean;
  /** Is this a dangerous tool that needs explicit approval from the user? */
  readonly isDangerous: boolean;
  /** Can this tool be used by sub-agents? */
  readonly canBeUsedInSubAgent: boolean;

  /** Validate parameters against the schema */
  validateParams(params: Record<string, unknown>): ValidationResult;

  /** Execute the tool */
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

export abstract class BaseTool implements Tool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: JSONSchema;
  abstract readonly category: ToolCategory;

  readonly requiresPermission: boolean = false;
  readonly isDangerous: boolean = false;
  readonly canBeUsedInSubAgent: boolean = true;

  validateParams(params: Record<string, unknown>): ValidationResult {
    const errors: string[] = [];
    const schema = this.inputSchema;

    // Check required params
    if (schema.required) {
      for (const key of schema.required) {
        if (params[key] === undefined || params[key] === null) {
          errors.push(`Missing required parameter: ${key}`);
        }
      }
    }

    // Check types if properties are defined
    if (schema.properties && params) {
      for (const [key, value] of Object.entries(params)) {
        const propSchema = schema.properties[key];
        if (!propSchema) continue;

        if (propSchema.type === 'string' && typeof value !== 'string') {
          errors.push(`Expected string for '${key}', got ${typeof value}`);
        } else if (propSchema.type === 'number' && typeof value !== 'number') {
          errors.push(`Expected number for '${key}', got ${typeof value}`);
        } else if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
          errors.push(`Expected boolean for '${key}', got ${typeof value}`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  abstract execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /** Helper: success result */
  protected success(content: string, metadata?: ToolResult['metadata']): ToolResult {
    return { success: true, content, metadata };
  }

  /** Helper: error result */
  protected error(message: string): ToolResult {
    return { success: false, content: '', error: message };
  }
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private mcpTools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Get the readonly tools (no write, shell, web) — used for plan mode */
  getReadonlyDefinitions(): UnifiedToolDefinition[] {
    const readonly: UnifiedToolDefinition[] = [];
    for (const tool of this.tools.values()) {
      if (
        tool.category === 'file' &&
        !['read_file', 'list_directory', 'glob', 'grep'].includes(tool.name)
      ) {
        continue;
      }
      if (tool.category === 'shell' || tool.category === 'web') continue;
      readonly.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    for (const tool of this.mcpTools.values()) {
      readonly.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    return readonly;
  }

  registerMCP(tool: Tool): void {
    this.mcpTools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.mcpTools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name) ?? this.mcpTools.get(name);
  }

  listAll(includeMCP = true): Tool[] {
    const builtin = Array.from(this.tools.values());
    return includeMCP ? [...builtin, ...Array.from(this.mcpTools.values())] : builtin;
  }

  listByCategory(category: ToolCategory): Tool[] {
    return this.listAll().filter((t) => t.category === category);
  }

  /** Get tool definitions formatted for LLM provider consumption */
  listDefinitions(): UnifiedToolDefinition[] {
    return this.listAll().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}

// ---------------------------------------------------------------------------
// Permission manager
// ---------------------------------------------------------------------------

export interface PermissionRule {
  tool: string;
  pattern?: string; // match against params (e.g., file path pattern)
  action: 'allow' | 'ask' | 'approval';
  scope: 'session' | 'project' | 'global';
}

export class PermissionManager {
  private rules: PermissionRule[] = [];

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  removeRule(tool: string, scope: 'session' | 'project' | 'global'): void {
    this.rules = this.rules.filter((r) => !(r.tool === tool && r.scope === scope));
  }

  check(toolName: string, params?: Record<string, unknown>): 'allow' | 'ask' | 'approval' {
    // Check specific rules first, then wildcard
    for (const rule of this.rules) {
      const toolMatches =
        rule.tool === toolName ||
        rule.tool === '*' ||
        (rule.tool.endsWith('*') && toolName.startsWith(rule.tool.slice(0, -1)));
      if (toolMatches) {
        if (rule.pattern && params && !this.matchPattern(rule.pattern, params)) {
          continue;
        }
        return rule.action;
      }
    }
    // Default "ask" mode: only tools marked as risky require approval.
    return 'ask';
  }

  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  private matchPattern(pattern: string, params: Record<string, unknown>): boolean {
    // Simple pattern matching for file paths
    if ('path' in params && typeof params.path === 'string') {
      return params.path.includes(pattern) || new RegExp(pattern).test(params.path);
    }
    if ('command' in params && typeof params.command === 'string') {
      return params.command.includes(pattern);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface SandboxConstraints {
  restrictPaths: boolean;
  allowedPaths: string[];
  deniedPaths: string[];
  deniedCommands: string[];
  maxFileSize: number; // max bytes for read operations
  shellTimeout: number; // ms
  webFetchTimeout: number; // ms
}

export const DEFAULT_SANDBOX: SandboxConstraints = {
  restrictPaths: true,
  allowedPaths: [],
  deniedPaths: [],
  deniedCommands: ['rm -rf /', 'format', 'shutdown', 'reboot', ':(){ :|:& };:'],
  maxFileSize: 10 * 1024 * 1024, // 10MB
  shellTimeout: 120000,
  webFetchTimeout: 30000,
};

export class Sandbox {
  constructor(private constraints: SandboxConstraints = DEFAULT_SANDBOX) {}

  /**
   * Check if a file path is allowed to be accessed.
   */
  isPathAllowed(targetPath: string, workingDirectory: string): boolean {
    if (!this.constraints.restrictPaths) return true;

    const absolutePath = isAbsolute(targetPath)
      ? resolve(targetPath)
      : resolve(workingDirectory, targetPath);
    const workspacePath = resolve(workingDirectory);

    if (this.constraints.deniedPaths.some((path) => isWithin(absolutePath, resolve(path)))) {
      return false;
    }

    if (isWithin(absolutePath, workspacePath)) return true;

    if (this.constraints.allowedPaths.some((path) => isWithin(absolutePath, resolve(path)))) {
      return true;
    }

    return false;
  }

  /**
   * Check if a shell command is allowed.
   */
  isCommandAllowed(command: string): boolean {
    const normalized = command.trim().toLowerCase();
    for (const denied of this.constraints.deniedCommands) {
      if (normalized.includes(denied.toLowerCase())) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if a file is within size limits.
   */
  isSizeAllowed(sizeBytes: number): boolean {
    return sizeBytes <= this.constraints.maxFileSize;
  }

  getConstraints(): SandboxConstraints {
    return { ...this.constraints };
  }

  updateConstraints(update: Partial<SandboxConstraints>): void {
    Object.assign(this.constraints, update);
  }
}

function isWithin(candidate: string, parent: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private permissionManager: PermissionManager,
    private sandbox: Sandbox = new Sandbox(),
  ) {}

  /**
   * Full tool execution lifecycle:
   * 1. Lookup tool
   * 2. Validate params
   * 3. Check sandbox
   * 4. Check permissions (allow/ask/approval)
   * 5. Execute with timeout
   * 6. Post-process (truncate, redact)
   */
  async execute(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext,
    permissionGranted = false,
  ): Promise<ToolResult> {
    const startTime = Date.now();

    if (context.signal?.aborted) {
      return interruptedToolResult(0);
    }

    // 1. Lookup
    const tool = this.registry.get(name);
    if (!tool) {
      return {
        success: false,
        content: '',
        error: `Tool '${name}' not found. Available tools: ${this.registry
          .listAll()
          .map((t) => t.name)
          .join(', ')}`,
      };
    }

    // 2. Validate params
    const validation = tool.validateParams(params);
    if (!validation.valid) {
      return {
        success: false,
        content: '',
        error: `Invalid parameters: ${validation.errors.join(', ')}`,
      };
    }

    // 3. Sandbox check
    if (tool.category === 'file') {
      const filePath =
        (params as { path?: string; file_path?: string }).path ??
        (params as { file_path?: string }).file_path;
      if (filePath) {
        const allowed = this.sandbox.isPathAllowed(filePath, context.workingDirectory);
        if (!allowed) {
          return {
            success: false,
            content: '',
            error: `Access denied: '${filePath}' is outside the allowed paths`,
          };
        }
      }
    }

    if (tool.category === 'shell') {
      const command = (params as { command?: string }).command;
      if (command && !this.sandbox.isCommandAllowed(command)) {
        return {
          success: false,
          content: '',
          error: `Command denied by sandbox policy`,
        };
      }
    }

    // 4. Permission check
    if (!permissionGranted) {
      const decision = this.permissionManager.check(name, params);
      const needsPermission =
        decision === 'approval' ||
        (decision === 'ask' && (tool.requiresPermission || tool.isDangerous));
      if (needsPermission) {
        return {
          success: false,
          content: '',
          error: `[NEEDS_PERMISSION] ${name}`,
        };
      }
    }

    // 5. Execute
    if (context.signal?.aborted) {
      return interruptedToolResult(Date.now() - startTime);
    }
    try {
      const result = await tool.execute(params, context);
      const duration = Date.now() - startTime;

      // 6. Post-process
      return this.postProcess(result, duration);
    } catch (err) {
      const duration = Date.now() - startTime;
      if (context.signal?.aborted) return interruptedToolResult(duration);
      return {
        success: false,
        content: '',
        error: err instanceof Error ? err.message : String(err),
        metadata: { duration },
      };
    }
  }

  async executeWithPermission(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext,
    approved: boolean,
  ): Promise<ToolResult> {
    if (!approved) {
      return {
        success: false,
        content: '',
        error: `User denied permission for tool '${name}'`,
      };
    }

    return this.execute(name, params, context, true);
  }

  private postProcess(result: ToolResult, duration: number): ToolResult {
    // Truncate large outputs
    const MAX_OUTPUT = 200_000; // ~50K tokens worth
    let content = result.content;
    let truncated = false;

    if (content.length > MAX_OUTPUT) {
      content =
        content.slice(0, MAX_OUTPUT) +
        `\n\n... [output truncated: ${content.length - MAX_OUTPUT} more characters]`;
      truncated = true;
    }

    return {
      ...result,
      content,
      metadata: {
        ...result.metadata,
        duration,
        truncated,
      },
    };
  }
}

function interruptedToolResult(duration: number): ToolResult {
  return {
    success: false,
    content: '',
    error: 'Tool execution interrupted by user',
    metadata: { duration, interrupted: true },
  };
}
