import type {
  ModelCallDebugEnd,
  ModelCallDebugStart,
  Plan,
  PlanProgress,
} from '@personal-agent/core';
import type {
  ReasoningEffort,
  ToolResult,
  UnifiedMessage,
  UsageInfo,
} from '@personal-agent/shared';

export type PermissionMode = 'allow' | 'ask' | 'approval';

/**
 * Token usage of the current conversation relative to the active model's
 * total context window.
 */
export interface ContextUsage {
  /** Cumulative tokens consumed by this session (API input + output). */
  usedTokens: number;
  /** Total context window length of the active model. */
  totalTokens: number;
  /** Tokens reserved for model output (not available for context). */
  reservedOutputTokens: number;
  /** Used percentage of the total context window (0-100). */
  percentage: number;
}

export type ClientMessage =
  | { type: 'prompt'; text: string }
  | { type: 'interrupt' }
  | {
      type: 'permission_response';
      requestId: string;
      approved: boolean;
      remember?: boolean;
    }
  | { type: 'list_sessions' }
  | { type: 'load_session'; sessionId: string }
  | { type: 'new_session' }
  | { type: 'list_projects' }
  | { type: 'create_project'; name: string; rootPath: string }
  | { type: 'select_project'; projectId: string }
  | { type: 'archive_project'; projectId: string }
  | { type: 'restore_project'; projectId: string }
  | { type: 'delete_project'; projectId: string }
  | { type: 'rename_project'; projectId: string; name: string }
  | { type: 'create_task'; projectId: string }
  | { type: 'rename_task'; taskId: string; title: string }
  | { type: 'open_task'; taskId: string }
  | { type: 'archive_task'; taskId: string }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  | { type: 'set_plan_mode'; enabled: boolean }
  | { type: 'approve_plan' }
  | { type: 'compress_context' }
  | { type: 'ping' };

export interface RuntimeInfo {
  configured: boolean;
  initializationError?: string;
  provider?: string;
  providerName?: string;
  model?: string;
  models: Array<{
    id: string;
    displayName: string;
    provider: string;
    providerName: string;
    reasoningSupported: boolean;
    reasoningEffort: ReasoningEffort;
    reasoningOptions: ReasoningEffort[];
  }>;
  reasoningSupported: boolean;
  reasoningEffort: ReasoningEffort;
  workingDirectory: string;
  toolCount: number;
  plugins: Array<{ name: string; version: string; skills: number; tools: number }>;
  mcpServers: Array<{ name: string; connected: boolean; toolCount: number }>;
  memoryEnabled: boolean;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  workingDirectory: string;
  model: string;
  provider: string;
  turnCount: number;
  messageCount: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSummary {
  id: string;
  projectId: string;
  title: string;
  sessionId?: string;
  permissionMode: PermissionMode;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export type ServerMessage =
  | {
      type: 'ready';
      version: string;
      sessionId?: string;
      activeProjectId?: string;
      activeTaskId?: string;
      runtime: RuntimeInfo;
    }
  | { type: 'runtime_updated'; runtime: RuntimeInfo }
  | {
      type: 'project_list';
      projects: ProjectSummary[];
      activeProjectId?: string;
    }
  | {
      type: 'task_list';
      tasks: TaskSummary[];
      activeTaskId?: string;
    }
  | { type: 'project_changed'; project: ProjectSummary }
  | { type: 'project_archived'; project: ProjectSummary }
  | { type: 'project_deleted'; projectId: string }
  | { type: 'task_changed'; task: TaskSummary }
  | { type: 'task_renamed'; task: TaskSummary }
  | { type: 'history'; sessionId: string; messages: UnifiedMessage[] }
  | { type: 'session_list'; sessions: SessionSummary[] }
  | { type: 'session_changed'; sessionId: string; isNew: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'turn_start'; turnNumber: number }
  | { type: 'llm_call_start'; call: ModelCallDebugStart }
  | { type: 'llm_call_end'; call: ModelCallDebugEnd }
  | { type: 'thinking_delta'; thinking: string; turnNumber: number }
  | { type: 'assistant_delta'; text: string; turnNumber: number }
  | { type: 'tool_start'; toolName: string; toolCallId: string; turnNumber: number }
  | { type: 'tool_progress'; toolCallId: string; content: string; turnNumber: number }
  | {
      type: 'permission_request';
      requestId: string;
      toolName: string;
      params: Record<string, unknown>;
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      result: ToolResult;
      turnNumber: number;
    }
  | { type: 'turn_end'; turnNumber: number; usage: UsageInfo | null }
  | { type: 'done'; totalTurns: number; totalUsage: UsageInfo }
  | { type: 'interrupted' }
  | { type: 'permission_mode'; mode: PermissionMode }
  | { type: 'plan'; active: boolean; plan: Plan | null; progress: PlanProgress }
  | { type: 'context_usage'; usage: ContextUsage }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'pong' };

export function parseClientMessage(raw: string): ClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('消息必须是有效的 JSON');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as { type?: unknown }).type !== 'string'
  ) {
    throw new Error('消息缺少 type 字段');
  }

  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'prompt':
      if (typeof message.text !== 'string' || !message.text.trim()) {
        throw new Error('prompt.text 不能为空');
      }
      return { type: 'prompt', text: message.text.trim() };
    case 'permission_response':
      if (typeof message.requestId !== 'string' || typeof message.approved !== 'boolean') {
        throw new Error('permission_response 格式无效');
      }
      return {
        type: 'permission_response',
        requestId: message.requestId,
        approved: message.approved,
        remember: message.remember === true,
      };
    case 'load_session':
      if (typeof message.sessionId !== 'string' || !message.sessionId.trim()) {
        throw new Error('load_session.sessionId 不能为空');
      }
      return { type: 'load_session', sessionId: message.sessionId.trim() };
    case 'create_project':
      if (
        typeof message.name !== 'string' ||
        !message.name.trim() ||
        typeof message.rootPath !== 'string' ||
        !message.rootPath.trim()
      ) {
        throw new Error('create_project 需要 name 和 rootPath');
      }
      return {
        type: 'create_project',
        name: message.name.trim(),
        rootPath: message.rootPath.trim(),
      };
    case 'select_project':
      if (typeof message.projectId !== 'string' || !message.projectId.trim()) {
        throw new Error('select_project.projectId 不能为空');
      }
      return { type: 'select_project', projectId: message.projectId.trim() };
    case 'archive_project':
    case 'restore_project':
    case 'delete_project':
      if (typeof message.projectId !== 'string' || !message.projectId.trim()) {
        throw new Error(`${message.type}.projectId 不能为空`);
      }
      return { type: message.type, projectId: message.projectId.trim() };
    case 'rename_project':
      if (
        typeof message.projectId !== 'string' ||
        !message.projectId.trim() ||
        typeof message.name !== 'string' ||
        !message.name.trim()
      ) {
        throw new Error('rename_project 需要 projectId 和 name');
      }
      return {
        type: 'rename_project',
        projectId: message.projectId.trim(),
        name: message.name.trim(),
      };
    case 'create_task':
      if (typeof message.projectId !== 'string' || !message.projectId.trim()) {
        throw new Error('create_task.projectId 不能为空');
      }
      if (message.parentTaskId !== undefined) {
        throw new Error('任务只能直接创建在项目下，不支持子任务');
      }
      return {
        type: 'create_task',
        projectId: message.projectId.trim(),
      };
    case 'rename_task':
      if (
        typeof message.taskId !== 'string' ||
        !message.taskId.trim() ||
        typeof message.title !== 'string' ||
        !message.title.trim()
      ) {
        throw new Error('rename_task 需要 taskId 和 title');
      }
      return {
        type: 'rename_task',
        taskId: message.taskId.trim(),
        title: message.title.trim(),
      };
    case 'open_task':
    case 'archive_task':
      if (typeof message.taskId !== 'string' || !message.taskId.trim()) {
        throw new Error(`${message.type}.taskId 不能为空`);
      }
      return { type: message.type, taskId: message.taskId.trim() };
    case 'set_plan_mode':
      if (typeof message.enabled !== 'boolean') {
        throw new Error('set_plan_mode.enabled 必须是布尔值');
      }
      return { type: 'set_plan_mode', enabled: message.enabled };
    case 'set_permission_mode':
      if (message.mode !== 'allow' && message.mode !== 'ask' && message.mode !== 'approval') {
        throw new Error('set_permission_mode.mode 无效');
      }
      return { type: 'set_permission_mode', mode: message.mode };
    case 'interrupt':
    case 'list_sessions':
    case 'list_projects':
    case 'new_session':
    case 'approve_plan':
    case 'compress_context':
    case 'ping':
      return { type: message.type };
    default:
      throw new Error(`不支持的消息类型: ${String(message.type)}`);
  }
}
