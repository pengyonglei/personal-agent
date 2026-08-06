// Tool system
export {
  BaseTool,
  ToolRegistry,
  PermissionManager,
  ToolExecutor,
  Sandbox,
  DEFAULT_SANDBOX,
} from './types';
export type {
  Tool,
  ToolContext,
  ToolResult,
  ToolCategory,
  ValidationResult,
  PermissionRule,
  SandboxConstraints,
} from './types';

// Built-in tools
export { ReadFileTool, WriteFileTool, EditFileTool, ListDirectoryTool } from './tools/file';
export { BashTool } from './tools/shell';
export {
  resolveShell,
  describeShell,
  resetShellCache,
  setDefaultShellPreference,
  getDefaultShellPreference,
  toWslPath,
  toWindowsPathLike,
  type ShellKind,
  type ShellPreference,
  type ResolvedShell,
} from './shell-resolver';
export { GlobTool, GrepTool } from './tools/search';
export { WebFetchTool, WebSearchTool, TodoWriteTool, AskUserTool } from './tools/web';
export { registerBuiltinTools } from './register';
