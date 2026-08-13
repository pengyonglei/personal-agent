import { ToolRegistry, PermissionManager, Sandbox, ToolExecutor } from './types';
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirectoryTool } from './tools/file';
import { BashTool } from './tools/shell';
import { GlobTool, GrepTool } from './tools/search';
import { WebFetchTool, WebSearchTool, TodoWriteTool, AskUserTool } from './tools/web';
import {
  BrowserActTool,
  BrowserCloseTool,
  BrowserOpenTool,
  BrowserScreenshotTool,
  BrowserSnapshotTool,
  FrontendValidateTool,
} from './tools/browser';
import type { ShellPreference } from './shell-resolver';

export const BROWSER_VALIDATION_TOOL_NAMES = [
  'browser_open',
  'browser_snapshot',
  'browser_act',
  'browser_screenshot',
  'browser_close',
  'frontend_validate',
] as const;

/** Add or remove the complete browser-validation tool set at runtime. */
export function setBrowserValidationToolsEnabled(registry: ToolRegistry, enabled: boolean): void {
  if (!enabled) {
    for (const name of BROWSER_VALIDATION_TOOL_NAMES) registry.unregister(name);
    return;
  }

  const tools = [
    new BrowserOpenTool(),
    new BrowserSnapshotTool(),
    new BrowserActTool(),
    new BrowserScreenshotTool(),
    new BrowserCloseTool(),
    new FrontendValidateTool(),
  ];
  for (const tool of tools) {
    if (!registry.get(tool.name)) registry.register(tool);
  }
}

/**
 * Register all built-in tools.
 * Returns the registry + executor ready for use.
 */
export function registerBuiltinTools(options?: {
  /** Shell preference for the bash tool (Windows: auto = PowerShell). */
  shellPreference?: ShellPreference;
  /** Browser validation is opt-in and disabled unless explicitly enabled. */
  browserValidationEnabled?: boolean;
}): {
  registry: ToolRegistry;
  executor: ToolExecutor;
  permissionManager: PermissionManager;
  sandbox: Sandbox;
} {
  const registry = new ToolRegistry();
  const permissionManager = new PermissionManager();
  const sandbox = new Sandbox();
  const executor = new ToolExecutor(registry, permissionManager, sandbox);

  // Register all built-in tools
  const tools = [
    // File tools
    new ReadFileTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new ListDirectoryTool(),
    // Search tools
    new GlobTool(),
    new GrepTool(),
    // Shell
    new BashTool(options?.shellPreference),
    // Web tools
    new WebFetchTool(),
    new WebSearchTool(),
    // Utility tools
    new TodoWriteTool(),
    new AskUserTool(),
  ];

  for (const tool of tools) {
    registry.register(tool);
  }
  setBrowserValidationToolsEnabled(registry, options?.browserValidationEnabled === true);

  return { registry, executor, permissionManager, sandbox };
}
