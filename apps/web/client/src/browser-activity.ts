import type { ToolResult } from '@personal-agent/shared';

/**
 * 侧边栏「浏览器」Tab 的活动追踪：从 agent 的 tool_start/tool_end 事件流中
 * 提取浏览器相关工具（browser_open / browser_act / browser_snapshot /
 * browser_screenshot / browser_close / frontend_validate）的实时动作。
 * 本模块保持纯函数，便于单元测试。
 */

/** 浏览器 Tab 追踪的工具名集合。 */
export const BROWSER_TOOL_NAMES = new Set([
  'browser_open',
  'browser_act',
  'browser_snapshot',
  'browser_screenshot',
  'browser_close',
  'frontend_validate',
]);

export function isBrowserTool(toolName: string): boolean {
  return BROWSER_TOOL_NAMES.has(toolName);
}

/** 一条浏览器动作记录（由 tool_start 创建、tool_end 补全结果）。 */
export interface BrowserActivityItem {
  /** 使用 toolCallId，保证与时间线工具卡片一一对应。 */
  id: string;
  toolName: string;
  status: 'running' | 'success' | 'failed' | 'interrupted';
  /** 展示用时间（HH:MM:SS）。 */
  time: string;
  /** 人类可读的动作描述，如 `点击 role=button "登录"`。 */
  summary: string;
  /** 动作完成后的当前页面 URL（browser_open/act/snapshot 结果快照中提取）。 */
  url?: string;
  /** 页面标题。 */
  title?: string;
  /** 页面可见文本（截断至上限）。 */
  text?: string;
  /** 截图工件引用（browser_screenshot / frontend_validate 的 metadata 中提取）。 */
  screenshot?: {
    projectHash: string;
    runId: string;
    artifactId: string;
    name: string;
  };
  duration?: number;
  error?: string;
}

/** 单任务活动列表上限，防止长时间运行内存膨胀。 */
const MAX_ACTIVITY_ITEMS = 200;

/** 快照页面文本截断上限。 */
const MAX_PAGE_TEXT = 4000;

/** browser_snapshot 结果 JSON 中提取出的页面信息。 */
export interface BrowserPageInfo {
  url?: string;
  title?: string;
  text?: string;
}

/** 浏览器会话当前状态（打开/关闭 + 当前 URL）。 */
export interface BrowserSessionState {
  open: boolean;
  url?: string;
}

/**
 * The live conversation id can briefly be absent while task view state is restored.
 * The persisted task session is the same browser-host key and keeps the native view
 * addressable during that transition.
 */
export function resolveBrowserSessionId(
  conversationSessionId?: string,
  taskSessionId?: string,
): string | undefined {
  return conversationSessionId?.trim() || taskSessionId?.trim() || undefined;
}

/** 从浏览器工具结果内容中解析页面快照（browser_open/act/snapshot 返回 JSON 快照）。 */
export function parseBrowserSnapshot(content: string): BrowserPageInfo | null {
  if (!content.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.url !== 'string') return null;
    return {
      url: parsed.url,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      text:
        typeof parsed.text === 'string' ? parsed.text.slice(0, MAX_PAGE_TEXT) : undefined,
    };
  } catch {
    return null;
  }
}

/** 从工具结果 metadata 中提取截图工件引用（需要 validation.runId/projectHash）。 */
export function screenshotFromResult(
  result: ToolResult,
): BrowserActivityItem['screenshot'] | undefined {
  const artifact = result.metadata?.artifacts?.find((entry) => entry.kind === 'screenshot');
  const validation = result.metadata?.validation;
  if (!artifact || !validation?.runId || !validation.projectHash) return undefined;
  return {
    projectHash: validation.projectHash,
    runId: validation.runId,
    artifactId: artifact.id,
    name: artifact.name,
  };
}

/** 定位器的人类可读描述（browser_act 参数）。 */
function describeLocator(args: Record<string, unknown>): string {
  if (typeof args.testId === 'string' && args.testId) {
    return `[data-testid="${args.testId}"]`;
  }
  if (typeof args.role === 'string' && args.role) {
    const name = typeof args.name === 'string' && args.name ? ` "${args.name}"` : '';
    return `role=${args.role}${name}`;
  }
  if (typeof args.text === 'string' && args.text) return `文本 "${args.text}"`;
  if (typeof args.selector === 'string' && args.selector) return args.selector;
  return '未知定位器';
}

/** 生成浏览器动作的人类可读描述。 */
export function describeBrowserAction(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'browser_open': {
      const url = typeof args.url === 'string' && args.url ? `：${args.url}` : '';
      return `打开浏览器${url}`;
    }
    case 'browser_act': {
      const locator = describeLocator(args);
      switch (args.action) {
        case 'click':
          return `点击 ${locator}`;
        case 'fill':
          return `输入 ${JSON.stringify(typeof args.value === 'string' ? args.value : '')} 到 ${locator}`;
        case 'press':
          return `在 ${locator} 按键 ${typeof args.key === 'string' ? args.key : 'Enter'}`;
        case 'check':
          return `勾选 ${locator}`;
        case 'uncheck':
          return `取消勾选 ${locator}`;
        case 'select':
          return `在 ${locator} 选择 ${JSON.stringify(typeof args.value === 'string' ? args.value : '')}`;
        case 'wait':
          return `等待 ${typeof args.timeoutMs === 'number' ? args.timeoutMs : 500} ms`;
        default:
          return `执行 ${String(args.action ?? '未知动作')} ${locator}`;
      }
    }
    case 'browser_snapshot':
      return '获取页面快照';
    case 'browser_screenshot': {
      const name = typeof args.name === 'string' && args.name ? `：${args.name}.png` : '';
      return `截图${name}`;
    }
    case 'browser_close':
      return '关闭浏览器';
    case 'frontend_validate': {
      const profile = args.profile === 'full' ? 'full' : 'quick';
      return `前端验证（${profile}）`;
    }
    default:
      return toolName;
  }
}

/** 根据活动列表推导浏览器会话当前状态（open 事件开启、close 关闭，其余动作更新 URL）。 */
export function browserSessionState(activity: BrowserActivityItem[]): BrowserSessionState {
  let open = false;
  let url: string | undefined;
  for (const item of activity) {
    if (item.status !== 'success') continue;
    switch (item.toolName) {
      case 'browser_open':
        open = true;
        url = item.url ?? url;
        break;
      case 'browser_close':
        open = false;
        url = undefined;
        break;
      default:
        if (item.url) url = item.url;
        break;
    }
  }
  return { open, url };
}

/** 追加一条活动并裁剪到上限。 */
export function appendBrowserActivity(
  list: BrowserActivityItem[],
  item: BrowserActivityItem,
): BrowserActivityItem[] {
  const next = [...list, item];
  return next.length > MAX_ACTIVITY_ITEMS ? next.slice(-MAX_ACTIVITY_ITEMS) : next;
}

/** 按 id 更新一条活动（tool_end 补全状态与结果）。 */
export function updateBrowserActivity(
  list: BrowserActivityItem[],
  id: string,
  patch: Partial<BrowserActivityItem>,
): BrowserActivityItem[] {
  return list.map((item) => (item.id === id ? { ...item, ...patch } : item));
}
