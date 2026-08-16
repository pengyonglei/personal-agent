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
  UserAnswer,
} from '@personal-agent/shared';

export type PermissionMode = 'allow' | 'ask' | 'approval';

export const MAX_PROMPT_IMAGES = 4;
export const MAX_PROMPT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PROMPT_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024;

export interface PromptImageInput {
  name: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** 不含 data URL 前缀的 base64 数据。 */
  data: string;
}

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
  /** 最近一次模型请求中命中缓存的输入 token 数（仅 deepseek 等模型提供）。 */
  cacheHitTokens?: number | null;
}

export type ClientMessage =
  | { type: 'prompt'; text: string; images?: PromptImageInput[]; taskId?: string }
  | {
      /** 把消息「插入」到正在执行的任务循环内，作为用户的补充消息引导模型思考方向（任务空闲时等价于 prompt 直接执行）。 */
      type: 'inject_user_message';
      text: string;
      taskId?: string;
    }
  | { type: 'interrupt'; taskId?: string }
  | {
      type: 'permission_response';
      requestId: string;
      approved: boolean;
      remember?: boolean;
      taskId?: string;
    }
  | {
      type: 'ask_user_response';
      requestId: string;
      answer: UserAnswer;
      taskId?: string;
    }
  | { type: 'list_sessions' }
  | { type: 'load_session'; sessionId: string; taskId?: string }
  | { type: 'new_session'; taskId?: string }
  | { type: 'list_projects' }
  | { type: 'create_project'; name: string; rootPath: string }
  | { type: 'select_project'; projectId: string }
  | { type: 'archive_project'; projectId: string }
  | { type: 'restore_project'; projectId: string }
  | { type: 'delete_project'; projectId: string }
  | { type: 'rename_project'; projectId: string; name: string }
  | { type: 'set_project_pinned'; projectId: string; pinned: boolean }
  | { type: 'reorder_projects'; projectIds: string[]; pinned: boolean }
  | { type: 'create_task'; projectId: string; permissionMode?: PermissionMode }
  | { type: 'rename_task'; taskId: string; title: string }
  | { type: 'open_task'; taskId: string }
  | { type: 'archive_task'; taskId: string }
  | { type: 'set_permission_mode'; mode: PermissionMode; taskId?: string }
  | { type: 'set_plan_mode'; enabled: boolean; taskId?: string }
  | { type: 'approve_plan'; taskId?: string }
  | { type: 'compress_context'; taskId?: string }
  | {
      type: 'set_task_model';
      taskId: string;
      providerId: string;
      model: string;
      reasoningEffort?: ReasoningEffort;
    }
  | {
      type: 'set_task_rule';
      taskId: string;
      tool: string;
      action: 'allow' | 'ask' | 'approval';
    }
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
    imageInputSupported: boolean;
    reasoningEffort: ReasoningEffort;
    reasoningOptions: ReasoningEffort[];
  }>;
  reasoningSupported: boolean;
  reasoningEffort: ReasoningEffort;
  workingDirectory: string;
  toolCount: number;
  plugins: Array<{ name: string; version: string; skills: number; tools: number }>;
  standaloneSkills: number;
  mcpServers: Array<{ name: string; connected: boolean; toolCount: number }>;
  memoryEnabled: boolean;
  /** 全局视觉模型已启用、已选择且当前仍可用。 */
  visionReady: boolean;
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
  pinned: boolean;
  sortOrder: number;
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
  /** Whether this task's conversation is currently executing. */
  running: boolean;
  /** Active model of this task's conversation ('provider:model'), when known. */
  model?: string;
  /** 该任务当前生效的思考强度（任务模型默认档或任务级覆盖）。 */
  reasoningEffort?: ReasoningEffort;
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
  | { type: 'history'; sessionId: string; messages: UnifiedMessage[]; taskId?: string }
  | { type: 'session_list'; sessions: SessionSummary[] }
  | { type: 'session_changed'; sessionId: string; isNew: boolean }
  | { type: 'busy'; busy: boolean; taskId?: string }
  | { type: 'turn_start'; turnNumber: number; taskId?: string }
  | { type: 'llm_call_start'; call: ModelCallDebugStart; taskId?: string }
  | { type: 'llm_call_end'; call: ModelCallDebugEnd; taskId?: string }
  | { type: 'thinking_delta'; thinking: string; turnNumber: number; taskId?: string }
  | { type: 'assistant_delta'; text: string; turnNumber: number; taskId?: string }
  | {
      type: 'tool_start';
      toolName: string;
      toolCallId: string;
      arguments: Record<string, unknown>;
      turnNumber: number;
      taskId?: string;
    }
  | {
      type: 'tool_progress';
      toolCallId: string;
      content: string;
      turnNumber: number;
      taskId?: string;
    }
  | {
      type: 'permission_request';
      requestId: string;
      toolName: string;
      params: Record<string, unknown>;
      taskId: string;
    }
  | {
      type: 'ask_user_request';
      requestId: string;
      question: string;
      options: string[];
      multiSelect: boolean;
      allowCustom: boolean;
      taskId: string;
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      result: ToolResult;
      turnNumber: number;
      taskId?: string;
    }
  | { type: 'turn_end'; turnNumber: number; usage: UsageInfo | null; taskId?: string }
  | { type: 'context_compacting'; taskId?: string }
  | { type: 'context_compacted'; taskId?: string }
  | {
      type: 'done';
      totalTurns: number;
      totalUsage: UsageInfo;
      finishedAt?: string;
      ttftMs?: number;
      tokensPerSecond?: number;
      taskId?: string;
    }
  | {
      type: 'run_changes';
      /** 本批次落盘 id（服务端生成，客户端据此做确定性 change id，刷新后可恢复）。 */
      id?: string;
      /** 本次任务执行（一次用户请求）中修改的文件及前后内容。 */
      files: Array<{ path: string; oldContent: string; newContent: string }>;
      taskId?: string;
      /** 本次执行对应的轮次序号（该任务的第几次用户请求，1-based），刷新后客户端按此把卡片插到对应轮次回复下方。 */
      requestSeq?: number;
    }
  | {
      type: 'interrupted';
      finishedAt?: string;
      ttftMs?: number;
      tokensPerSecond?: number;
      taskId?: string;
    }
  | { type: 'permission_mode'; mode: PermissionMode; taskId?: string }
  | {
      type: 'plan';
      active: boolean;
      plan: Plan | null;
      progress: PlanProgress;
      taskId?: string;
      /** 服务端生成的计划 Markdown 文档（plan 非空时提供，前端直接展示同一份内容）。 */
      markdown?: string;
      /** 计划创建所属轮次序号（该任务的第几次用户请求，1-based），客户端刷新后按此定位卡片。 */
      requestSeq?: number;
    }
  | { type: 'context_usage'; usage: ContextUsage; taskId?: string }
  | { type: 'notice'; message: string; taskId?: string }
  | { type: 'error'; message: string; code?: string; taskId?: string }
  | { type: 'pong' };

/** 一次 run_changes 落盘批次（GET /api/file-changes 的返回项）。 */
export interface StoredFileChangeBatch {
  id: string;
  taskId?: string;
  time: string;
  /** 该批次所属轮次序号（该任务的第几次用户请求，1-based），客户端按此把卡片插到对应回复下方。 */
  requestSeq?: number;
  files: Array<{
    path: string;
    oldContent: string;
    newContent: string;
    /** 内容超过落盘上限行数时截断并标记（diff 可能不完整）。 */
    truncated?: boolean;
  }>;
}

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
      if (typeof message.text !== 'string') throw new Error('prompt.text 必须是字符串');
      const images = parsePromptImages(message.images);
      if (!message.text.trim() && images.length === 0) throw new Error('prompt 不能为空');
      return {
        type: 'prompt',
        text: message.text.trim(),
        ...(images.length > 0 ? { images } : {}),
        taskId: parseOptionalTaskId(message),
      };
    case 'inject_user_message':
      if (typeof message.text !== 'string' || !message.text.trim()) {
        throw new Error('inject_user_message.text 不能为空');
      }
      return {
        type: 'inject_user_message',
        text: message.text.trim(),
        taskId: parseOptionalTaskId(message),
      };
    case 'permission_response':
      if (typeof message.requestId !== 'string' || typeof message.approved !== 'boolean') {
        throw new Error('permission_response 格式无效');
      }
      return {
        type: 'permission_response',
        requestId: message.requestId,
        approved: message.approved,
        remember: message.remember === true,
        taskId: parseOptionalTaskId(message),
      };
    case 'ask_user_response': {
      if (typeof message.requestId !== 'string' || !message.requestId.trim()) {
        throw new Error('ask_user_response.requestId 不能为空');
      }
      const answer = message.answer as Partial<UserAnswer> | undefined;
      if (
        !answer ||
        typeof answer !== 'object' ||
        !Array.isArray(answer.selections) ||
        answer.selections.some((selection) => typeof selection !== 'string') ||
        (answer.custom !== undefined && typeof answer.custom !== 'string')
      ) {
        throw new Error('ask_user_response.answer 格式无效');
      }
      return {
        type: 'ask_user_response',
        requestId: message.requestId.trim(),
        answer: { selections: answer.selections, custom: answer.custom },
        taskId: parseOptionalTaskId(message),
      };
    }
    case 'load_session':
      if (typeof message.sessionId !== 'string' || !message.sessionId.trim()) {
        throw new Error('load_session.sessionId 不能为空');
      }
      return {
        type: 'load_session',
        sessionId: message.sessionId.trim(),
        taskId: parseOptionalTaskId(message),
      };
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
    case 'set_project_pinned':
      if (typeof message.projectId !== 'string' || !message.projectId.trim()) {
        throw new Error('set_project_pinned.projectId 不能为空');
      }
      if (typeof message.pinned !== 'boolean') {
        throw new Error('set_project_pinned.pinned 必须是布尔值');
      }
      return {
        type: 'set_project_pinned',
        projectId: message.projectId.trim(),
        pinned: message.pinned,
      };
    case 'reorder_projects': {
      if (
        !Array.isArray(message.projectIds) ||
        message.projectIds.some((projectId) => typeof projectId !== 'string' || !projectId.trim())
      ) {
        throw new Error('reorder_projects.projectIds 格式无效');
      }
      if (typeof message.pinned !== 'boolean') {
        throw new Error('reorder_projects.pinned 必须是布尔值');
      }
      const projectIds = message.projectIds.map((projectId) => projectId.trim());
      if (new Set(projectIds).size !== projectIds.length) {
        throw new Error('reorder_projects.projectIds 不能重复');
      }
      return { type: 'reorder_projects', projectIds, pinned: message.pinned };
    }
    case 'create_task':
      if (typeof message.projectId !== 'string' || !message.projectId.trim()) {
        throw new Error('create_task.projectId 不能为空');
      }
      if (message.parentTaskId !== undefined) {
        throw new Error('任务只能直接创建在项目下，不支持子任务');
      }
      if (
        message.permissionMode !== undefined &&
        message.permissionMode !== 'allow' &&
        message.permissionMode !== 'ask' &&
        message.permissionMode !== 'approval'
      ) {
        throw new Error('create_task.permissionMode 无效');
      }
      return {
        type: 'create_task',
        projectId: message.projectId.trim(),
        permissionMode: message.permissionMode,
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
      return {
        type: 'set_plan_mode',
        enabled: message.enabled,
        taskId: parseOptionalTaskId(message),
      };
    case 'set_permission_mode':
      if (message.mode !== 'allow' && message.mode !== 'ask' && message.mode !== 'approval') {
        throw new Error('set_permission_mode.mode 无效');
      }
      return {
        type: 'set_permission_mode',
        mode: message.mode,
        taskId: parseOptionalTaskId(message),
      };
    case 'set_task_model': {
      if (typeof message.taskId !== 'string' || !message.taskId.trim()) {
        throw new Error('set_task_model.taskId 不能为空');
      }
      if (typeof message.providerId !== 'string' || !message.providerId.trim()) {
        throw new Error('set_task_model.providerId 不能为空');
      }
      if (typeof message.model !== 'string' || !message.model.trim()) {
        throw new Error('set_task_model.model 不能为空');
      }
      return {
        type: 'set_task_model',
        taskId: message.taskId.trim(),
        providerId: message.providerId.trim(),
        model: message.model.trim(),
        reasoningEffort:
          message.reasoningEffort === undefined
            ? undefined
            : parseReasoningEffort(message.reasoningEffort),
      };
    }
    case 'set_task_rule': {
      if (typeof message.taskId !== 'string' || !message.taskId.trim()) {
        throw new Error('set_task_rule.taskId 不能为空');
      }
      if (typeof message.tool !== 'string' || !message.tool.trim()) {
        throw new Error('set_task_rule.tool 不能为空');
      }
      if (message.action !== 'allow' && message.action !== 'ask' && message.action !== 'approval') {
        throw new Error('set_task_rule.action 无效');
      }
      return {
        type: 'set_task_rule',
        taskId: message.taskId.trim(),
        tool: message.tool.trim(),
        action: message.action,
      };
    }
    case 'interrupt':
    case 'new_session':
    case 'approve_plan':
    case 'compress_context':
      return { type: message.type, taskId: parseOptionalTaskId(message) };
    case 'list_sessions':
    case 'list_projects':
    case 'ping':
      return { type: message.type };
    default:
      throw new Error(`不支持的消息类型: ${String(message.type)}`);
  }
}

const PROMPT_IMAGE_MEDIA_TYPES = new Set<PromptImageInput['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function parsePromptImages(value: unknown): PromptImageInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('prompt.images 必须是数组');
  if (value.length > MAX_PROMPT_IMAGES) {
    throw new Error(`一次最多上传 ${MAX_PROMPT_IMAGES} 张图片`);
  }

  let totalBytes = 0;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`prompt.images[${index}] 格式无效`);
    }
    const image = entry as Record<string, unknown>;
    const name = typeof image.name === 'string' ? image.name.trim() : '';
    const mediaType = typeof image.mediaType === 'string' ? image.mediaType.toLowerCase() : '';
    const data = typeof image.data === 'string' ? image.data : '';
    if (!name || name.length > 255) throw new Error(`prompt.images[${index}].name 无效`);
    if (!PROMPT_IMAGE_MEDIA_TYPES.has(mediaType as PromptImageInput['mediaType'])) {
      throw new Error(`prompt.images[${index}] 不是支持的图片格式`);
    }
    if (
      !data ||
      data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) {
      throw new Error(`prompt.images[${index}].data 不是有效的 base64`);
    }
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    const bytes = (data.length / 4) * 3 - padding;
    if (bytes > MAX_PROMPT_IMAGE_BYTES) {
      throw new Error(`图片 ${name} 超过 5 MB 限制`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
      throw new Error('图片总大小超过 10 MB 限制');
    }
    return {
      name,
      mediaType: mediaType as PromptImageInput['mediaType'],
      data,
    };
  });
}

function parseOptionalTaskId(message: Record<string, unknown>): string | undefined {
  const taskId = message.taskId;
  if (taskId === undefined || taskId === null) return undefined;
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw new Error('taskId 格式无效');
  }
  return taskId.trim();
}

function parseReasoningEffort(value: unknown): ReasoningEffort {
  if (
    value !== 'off' &&
    value !== 'low' &&
    value !== 'medium' &&
    value !== 'high' &&
    value !== 'max' &&
    value !== 'xhigh'
  ) {
    throw new Error('reasoningEffort 格式无效');
  }
  return value;
}
