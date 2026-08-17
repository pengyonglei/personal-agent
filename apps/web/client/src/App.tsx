import {
  App as AntApp,
  Alert,
  AutoComplete,
  Avatar,
  Badge,
  Button,
  Card,
  Checkbox,
  Collapse,
  ColorPicker,
  ConfigProvider,
  Divider,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Grid,
  Image,
  Input,
  InputNumber,
  Layout,
  List,
  Menu,
  Modal,
  Progress,
  Radio,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Tree,
  Typography,
  Upload,
  theme as antdTheme,
} from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import {
  AppstoreOutlined,
  BarChartOutlined,
  BoldOutlined,
  BugOutlined,
  BulbOutlined,
  CaretRightOutlined,
  CheckCircleFilled,
  CheckCircleOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CloseCircleFilled,
  CloseOutlined,
  CodeOutlined,
  CommentOutlined,
  CompressOutlined,
  CopyOutlined,
  DashboardOutlined,
  DeleteOutlined,
  DiffOutlined,
  DownOutlined,
  EditOutlined,
  ExperimentOutlined,
  EyeOutlined,
  FileTextOutlined,
  FontSizeOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  HolderOutlined,
  InboxOutlined,
  InfoCircleOutlined,
  ItalicOutlined,
  LeftOutlined,
  LinkOutlined,
  LoadingOutlined,
  MenuUnfoldOutlined,
  MinusCircleOutlined,
  MinusOutlined,
  MoonOutlined,
  MoreOutlined,
  OrderedListOutlined,
  PlayCircleOutlined,
  PictureOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  SunOutlined,
  TableOutlined,
  ToolOutlined,
  UnorderedListOutlined,
  UserOutlined,
  UpOutlined,
} from '@ant-design/icons';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  ReasoningEffort,
  ToolResult,
  UnifiedMessage,
  UserAnswer,
} from '@personal-agent/shared';
import { VERSION } from '@personal-agent/shared';
import type {
  ClientMessage,
  ContextUsage,
  PermissionMode,
  ProjectSummary,
  RuntimeInfo,
  ServerMessage,
  StoredFileChangeBatch,
  TaskSummary,
} from '../../src/protocol';
import {
  MAX_PROMPT_IMAGES,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_TOTAL_BYTES,
  type PromptImageInput,
} from '../../src/protocol';
import { assistantResponseId } from './timeline';
import {
  addTaskMarker,
  addUnreadTask,
  removeTaskMarker,
  removeUnreadTask,
  retainTaskMarkers,
  retainUnreadTasks,
} from './task-unread';
import { nextProjectTaskCount, paginateProjectTasks } from './project-task-pagination';
import type { PlanDoc } from './plan-doc';
import { planStatusLabel, planToMarkdown } from './plan-doc';
import {
  MAX_DIFF_LINES,
  collapseDiffContext,
  computeLineDiff,
  toUnifiedDiffText,
} from './file-diff';

const { Header, Content, Sider } = Layout;
const { Text, Title } = Typography;
const { TextArea } = Input;

type ColorMode = 'light' | 'dark';
type ConnectionState = 'connecting' | 'online' | 'offline';
type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'ollama' | 'volcano' | 'lmstudio';
type PlanMessage = Extract<ServerMessage, { type: 'plan' }>;
type PermissionRequest = Extract<ServerMessage, { type: 'permission_request' }>;
type AskUserRequest = Extract<ServerMessage, { type: 'ask_user_request' }>;
type ModelCallStart = Extract<ServerMessage, { type: 'llm_call_start' }>['call'];
type ModelCallEnd = Extract<ServerMessage, { type: 'llm_call_end' }>['call'];

interface WorkspaceState {
  connection: ConnectionState;
  connected: boolean;
  configured: boolean;
  busy: boolean;
  sessionId?: string;
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  activeProjectId?: string;
  activeTaskId?: string;
  runtime?: RuntimeInfo;
  permissionMode: PermissionMode;
  planActive: boolean;
  plan: PlanMessage['plan'];
  planProgress: PlanMessage['progress'];
  pendingPermission?: PermissionRequest;
  pendingQuestion?: AskUserRequest;
  contextUsage?: ContextUsage;
  creatingProject: boolean;
  creatingTask: boolean;
  switchingRuntime: boolean;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
}

interface MessageTimelineItem {
  id: string;
  kind: 'message';
  role: 'user' | 'assistant' | 'system';
  text: string;
  images?: Array<{ name: string; src: string }>;
  time: string;
  streaming?: boolean;
  error?: boolean;
  turnNumber?: number;
  thinking?: string;
  tools?: ToolTimelineItem[];
  /** 一轮回复中每次 LLM 调用（turn）的分组内容：思考/文本/工具按调用分隔。 */
  turns?: AssistantTurn[];
  /** 本轮回复首次创建消息的时间戳（ms），用于任务完成后计算耗时。 */
  startedAt?: number;
  /** 任务完成/中断时计算的总耗时（ms），存在则展示在消息内容底部。 */
  durationMs?: number;
  /** 任务结束时间（ISO 字符串），由服务端在任务结束时写入，刷新后可恢复。 */
  finishedAt?: string;
  /** 首 token 时间（TTFT，ms）。 */
  ttftMs?: number;
  /** 模型输出 token 速度（token/秒）。 */
  tokensPerSecond?: number;
}

/** 一次 LLM 调用（turn）的内容分组。 */
interface AssistantTurn {
  turnNumber: number;
  thinking: string;
  text: string;
  tools: ToolTimelineItem[];
}

interface ToolTimelineItem {
  id: string;
  kind: 'tool';
  toolCallId: string;
  name: string;
  arguments?: Record<string, unknown>;
  status: 'running' | 'success' | 'failed' | 'interrupted';
  output: string;
  duration?: number;
  metadata?: ToolResult['metadata'];
  restored?: boolean;
}

type TimelineItem =
  MessageTimelineItem | ToolTimelineItem | PlanDocTimelineItem | RunChangesTimelineItem;

/** 计划文档卡片：对话时间线中可点击打开侧边栏文档 Tab 的条目。 */
interface PlanDocTimelineItem {
  id: string;
  kind: 'plan-doc';
  docId: string;
  title: string;
  time: string;
  /** 所属轮次序号（该任务的第几次用户请求，1-based），刷新重放时按此定位插入位置。 */
  requestSeq?: number;
}

/** 运行修改卡片：一次任务执行中修改的文件列表（点击文件打开侧边栏 diff Tab）。 */
interface RunChangesTimelineItem {
  id: string;
  kind: 'run-changes';
  changeIds: string[];
  time: string;
  /** 所属轮次序号（该任务的第几次用户请求，1-based），刷新重放时按此定位插入位置。 */
  requestSeq?: number;
}

/** 一次文件修改（执行前后内容，用于展示 git 风格 diff）。 */
interface FileChange {
  id: string;
  taskId?: string;
  path: string;
  oldContent: string;
  newContent: string;
  time: string;
  /** 服务端落盘时内容超过上限被截断（diff 可能不完整）。 */
  truncated?: boolean;
}

/** 任务执行期间排队等待的消息（展示在输入框上方浮窗中，支持删除/插入当前执行）。 */
interface QueuedMessage {
  id: string;
  text: string;
  time: string;
}

/** 右侧侧边栏的 Tab：概要固定不可删除，其余为可关闭的计划文档/文件差异 Tab。 */
type InspectorTab =
  | { key: string; title: string; kind: 'overview' }
  | { key: string; title: string; kind: 'plan-doc'; docId: string }
  | { key: string; title: string; kind: 'file-diff'; changeId: string };

/** 计划文档卡片/头部 Tag 的颜色映射（按计划状态）。 */
const PLAN_STATUS_TAG_COLORS: Record<string, string> = {
  draft: 'gold',
  approved: 'blue',
  in_progress: 'processing',
  completed: 'success',
};

interface ModelCallTrace {
  callId: string;
  kind?: 'agent' | 'vision';
  label?: string;
  turnNumber: number;
  provider: string;
  model: string;
  startedAt: string;
  request: ModelCallStart['request'];
  status: 'running' | ModelCallEnd['status'];
  finishedAt?: string;
  durationMs?: number;
  ttftMs?: number;
  response?: ModelCallEnd['response'];
  error?: string;
}

interface TaskViewSnapshot {
  timeline: TimelineItem[];
  modelCalls: ModelCallTrace[];
  busy: boolean;
  contextUsage?: ContextUsage;
  planActive: boolean;
  plan: PlanMessage['plan'];
  planProgress: PlanMessage['progress'];
  permissionMode: PermissionMode;
  sessionId?: string;
  pendingPermission?: PermissionRequest;
  pendingQuestion?: AskUserRequest;
  responseSeq: number;
}

interface ProviderModelRow {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  imageInput?: boolean;
  /** Ollama 专属：该模型可选的思考强度档位（未配置 = 不开启思考）。 */
  reasoningOptions?: ReasoningEffort[];
  thinkingEffort?: ReasoningEffort;
}

interface ProviderFormValues {
  provider: ProviderId;
  apiKey?: string;
  baseURL: string;
  defaultModel: string;
  models: ProviderModelRow[];
  thinkingEffort: ReasoningEffort;
}

interface ProjectFormValues {
  name: string;
  rootPath: string;
}

interface ProviderSettingsInfo {
  active?: ProviderId;
  configPath: string;
  providers: Record<
    ProviderId,
    {
      configured: boolean;
      hasApiKey: boolean;
      requiresApiKey: boolean;
      baseURL: string;
      defaultModel: string;
      models: Array<string | ProviderModelRow>;
      thinkingEffort: ReasoningEffort;
      reasoningSupported: boolean;
    }
  >;
}

interface VisionSettingsInfo {
  enabled: boolean;
  provider?: ProviderId;
  model?: string;
  configPath: string;
  models: Array<{
    provider: ProviderId;
    providerName: string;
    model: string;
    displayName: string;
  }>;
}

interface DirectoryEntryInfo {
  name: string;
  path: string;
  hasChildren: boolean;
}

interface DirectoryListResponse {
  currentPath?: string;
  parentPath?: string;
  entries: DirectoryEntryInfo[];
}

interface DirectoryTreeNode {
  title: string;
  key: string;
  isLeaf?: boolean;
  children?: DirectoryTreeNode[];
}

interface RuntimeModelOption {
  value: string;
  label: string;
  title: string;
}

interface RuntimeModelGroup {
  label: string;
  options: RuntimeModelOption[];
}

const initialState: WorkspaceState = {
  connection: 'connecting',
  connected: false,
  configured: false,
  busy: false,
  projects: [],
  tasks: [],
  permissionMode: 'ask',
  planActive: false,
  plan: null,
  planProgress: {
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    current: 0,
    percentage: 0,
  },
  contextUsage: undefined,
  pendingQuestion: undefined,
  creatingProject: false,
  creatingTask: false,
  switchingRuntime: false,
  sidebarOpen: false,
  inspectorOpen: false,
};

const starterPrompts = [
  {
    title: '项目分析',
    description: '理解架构与改进机会',
    prompt: '分析这个项目的架构，并指出最值得优先改进的三处',
  },
  {
    title: '修复测试',
    description: '定位失败并验证修复',
    prompt: '运行测试并修复当前失败的用例',
  },
  {
    title: '代码审查',
    description: '发现缺陷与回归风险',
    prompt: '帮我审查最近的代码改动，重点关注潜在缺陷',
  },
];

type StarterPrompt = (typeof starterPrompts)[number];

/**
 * 解析 starter-prompts 自定义内容（格式与内置一致：
 * 每条为「N. 标题（描述）：」+ 下一行缩进的提示词）。
 */
function parseStarterPrompts(content: string): StarterPrompt[] {
  const result: StarterPrompt[] = [];
  let current: StarterPrompt | null = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const match = line.match(/^\d+\.\s*(.+?)(?:[（(]([^）)]+)[）)])?\s*[：:]\s*$/);
    if (match) {
      if (current && current.title && current.prompt) result.push(current);
      current = { title: match[1].trim(), description: (match[2] ?? '').trim(), prompt: '' };
      continue;
    }
    if (current) current.prompt = (current.prompt ? current.prompt + '\n' : '') + line;
  }
  if (current && current.title && current.prompt) result.push(current);
  return result.length > 0 ? result : starterPrompts;
}

const permissionOptions = [
  {
    value: 'allow',
    label: 'allow · 完全访问',
    title: '自动批准所有工具调用',
  },
  {
    value: 'ask',
    label: 'ask · 替我审批',
    title: '仅检测到风险操作时请求审批',
  },
  {
    value: 'approval',
    label: 'Approval · 请求审批',
    title: '所有工具调用都请求审批',
  },
];

const reasoningOptions = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
  { value: 'xhigh', label: 'xHigh' },
];

const providerLabels: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  ollama: 'Ollama（本地）',
  volcano: '火山方舟',
  lmstudio: 'LM Studio（本地）',
};

/** Brand icons for providers, keyed by provider id (see public/icons). */
const providerIcons: Partial<Record<ProviderId, string>> = {
  anthropic: '/icons/anthropic.svg',
  openai: '/icons/openai.svg',
  deepseek: '/icons/deepseek-color.svg',
  ollama: '/icons/ollama.svg',
  volcano: '/icons/volcengine-color.svg',
  lmstudio: '/icons/lmstudio.svg',
};

function getInitialColorMode(): ColorMode {
  return localStorage.getItem('personal-agent-theme') === 'dark' ? 'dark' : 'light';
}

const INSPECTOR_WIDTH_MIN = 280;
const INSPECTOR_WIDTH_MAX = 720;
const INSPECTOR_WIDTH_DEFAULT = 380;

/** 读取持久化的右侧侧边栏宽度（默认 380，clamp 280–720）。 */
function getInitialInspectorWidth(): number {
  try {
    const raw = localStorage.getItem('personal-agent-inspector-width');
    const parsed = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(parsed)) return INSPECTOR_WIDTH_DEFAULT;
    return Math.min(INSPECTOR_WIDTH_MAX, Math.max(INSPECTOR_WIDTH_MIN, Math.round(parsed)));
  } catch {
    return INSPECTOR_WIDTH_DEFAULT;
  }
}

interface AccentColors {
  light: string;
  dark: string;
}

/** 内置默认主色（与原始主题一致） */
const DEFAULT_ACCENT: AccentColors = { light: '#1677ff', dark: '#91caff' };

/** 预设色板：每组提供浅色/深色模式下的主色 */
const ACCENT_PRESETS: AccentColors[] = [
  { light: '#1677ff', dark: '#91caff' }, // 蓝（默认）
  { light: '#52c41a', dark: '#b7eb8f' }, // 绿
  { light: '#722ed1', dark: '#d3adf7' }, // 紫
  { light: '#fa8c16', dark: '#ffd591' }, // 橙
  { light: '#13c2c2', dark: '#87e8de' }, // 青
  { light: '#f5222d', dark: '#ffa39e' }, // 玫红
];

function getInitialAccent(): AccentColors {
  try {
    const raw = localStorage.getItem('personal-agent-accent');
    if (!raw) return DEFAULT_ACCENT;
    const parsed = JSON.parse(raw) as Partial<AccentColors>;
    if (typeof parsed.light !== 'string' || typeof parsed.dark !== 'string') {
      return DEFAULT_ACCENT;
    }
    return { light: parsed.light, dark: parsed.dark };
  } catch {
    return DEFAULT_ACCENT;
  }
}

/** 将 #rgb / #rrggbb 转为 rgba 字符串（用于 AntD token 等 CSS 变量无法覆盖的场景） */
function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((char) => char + char)
          .join('')
      : normalized;
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) return `rgba(0, 0, 0, ${alpha})`;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** /api/web-config 返回的外观配置（来自 config.yaml 的 web 段） */
interface WebConfigPayload {
  theme: ColorMode;
  accentLight: string;
  accentDark: string;
}

export default function PersonalAgentApp() {
  return (
    <AntApp>
      <AppearanceHost />
    </AntApp>
  );
}

/**
 * Web UI 外观宿主：持有主题模式与主色状态。
 * 启动时从 /api/web-config（config.yaml）加载最新配置并覆盖本地缓存；
 * 修改后防抖 400ms 写回 config.yaml，保存失败回滚为服务端当前值。
 * localStorage 仅作为首帧渲染前的快速兜底缓存。
 */
function AppearanceHost() {
  const { message: messageApi } = AntApp.useApp();
  const [colorMode, setColorMode] = useState<ColorMode>(getInitialColorMode);
  const [accentColors, setAccentColors] = useState<AccentColors>(getInitialAccent);
  const [themeLoaded, setThemeLoaded] = useState(false);
  const lastSavedRef = useRef<{ theme: ColorMode; light: string; dark: string } | null>(null);
  const accent = accentColors[colorMode];

  // 启动：从 config.yaml 读取最新主题配置（localStorage 仅作首帧兜底）
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/web-config')
      .then((response) => (response.ok ? (response.json() as Promise<WebConfigPayload>) : null))
      .then((payload) => {
        if (cancelled || !payload) return;
        setColorMode(payload.theme);
        setAccentColors({ light: payload.accentLight, dark: payload.accentDark });
        lastSavedRef.current = {
          theme: payload.theme,
          light: payload.accentLight,
          dark: payload.accentDark,
        };
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setThemeLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = colorMode;
    localStorage.setItem('personal-agent-theme', colorMode);
  }, [colorMode]);

  useEffect(() => {
    // 覆盖 :root 中定义的默认主色，--pa-accent-soft 等派生变量自动跟随
    document.documentElement.style.setProperty('--pa-accent', accent);
    localStorage.setItem('personal-agent-accent', JSON.stringify(accentColors));
  }, [accent, accentColors]);

  // 主题/主色变化后防抖持久化到 config.yaml
  useEffect(() => {
    if (!themeLoaded) return;
    const snapshot = { theme: colorMode, light: accentColors.light, dark: accentColors.dark };
    const last = lastSavedRef.current;
    if (
      last &&
      last.theme === snapshot.theme &&
      last.light === snapshot.light &&
      last.dark === snapshot.dark
    ) {
      return;
    }
    const timer = setTimeout(() => {
      void persistAppearance(snapshot);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorMode, accentColors, themeLoaded]);

  async function persistAppearance(snapshot: { theme: ColorMode; light: string; dark: string }) {
    try {
      const response = await apiFetch('/api/web-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          theme: snapshot.theme,
          accentLight: snapshot.light,
          accentDark: snapshot.dark,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败 (${response.status})`);
      }
      lastSavedRef.current = snapshot;
    } catch (err) {
      messageApi.error(`保存主题配置失败: ${err instanceof Error ? err.message : String(err)}`);
      // 保存失败时回滚为服务端当前值
      try {
        const response = await apiFetch('/api/web-config');
        if (!response.ok) return;
        const payload = (await response.json()) as WebConfigPayload;
        setColorMode(payload.theme);
        setAccentColors({ light: payload.accentLight, dark: payload.accentDark });
        lastSavedRef.current = {
          theme: payload.theme,
          light: payload.accentLight,
          dark: payload.accentDark,
        };
      } catch {
        // 回滚失败时保持本地值
      }
    }
  }

  const themeConfig = useMemo(
    () => ({
      algorithm: colorMode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: accent,
        colorInfo: accent,
        borderRadius: 10,
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      },
      components: {
        Layout: {
          // 顶部栏与中间对话区保持一致（白色面板），侧边栏/内容区使用统一灰色背景变量
          headerBg: 'var(--pa-panel)',
          siderBg: 'var(--pa-bg-gray)',
          bodyBg: 'var(--pa-bg-gray)',
        },
        Button: {
          controlHeight: 34,
        },
        Input: {
          activeShadow: `0 0 0 2px ${hexToRgba(accent, 0.12)}`,
        },
      },
    }),
    [colorMode, accent],
  );

  return (
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      <AgentWorkspace
        colorMode={colorMode}
        onToggleColorMode={() =>
          setColorMode((current) => (current === 'light' ? 'dark' : 'light'))
        }
        accentColors={accentColors}
        onAccentColorsChange={setAccentColors}
        onResetAccent={() => setAccentColors(DEFAULT_ACCENT)}
      />
    </ConfigProvider>
  );
}

function AgentWorkspace({
  colorMode,
  onToggleColorMode,
  accentColors,
  onAccentColorsChange,
  onResetAccent,
}: {
  colorMode: ColorMode;
  onToggleColorMode: () => void;
  accentColors: AccentColors;
  onAccentColorsChange: (colors: AccentColors) => void;
  onResetAccent: () => void;
}) {
  const { message: messageApi, modal } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const desktop = Boolean(screens.md);
  const desktopShell = Boolean(window.personalAgentDesktop);
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const sequenceRef = useRef(0);
  const responseSequenceRef = useRef(0);
  const activeResponseSequenceRef = useRef(0);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const timelineRef = useRef(timeline);
  // 排队消息（per-task）：busy 时 Enter 入队，任务结束后自动按序执行，
  // 也可手动「插入」到当前执行循环内作为补充消息引导模型思考方向。
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const queuedByTaskRef = useRef<Record<string, QueuedMessage[]>>({});
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const userMessageEls = useRef(new Map<string, HTMLElement>());
  const followOutputRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string>();
  const [turnNavLeft, setTurnNavLeft] = useState(30);
  const [prompt, setPrompt] = useState('');
  const [promptImages, setPromptImages] = useState<PromptImageInput[]>([]);
  const [starterItems, setStarterItems] = useState<StarterPrompt[]>(starterPrompts);

  // 右侧侧边栏：宽度（可拖拽调宽，持久化到 localStorage）
  const [inspectorWidth, setInspectorWidth] = useState(getInitialInspectorWidth);
  const inspectorWidthRef = useRef(inspectorWidth);
  useEffect(() => {
    inspectorWidthRef.current = inspectorWidth;
    localStorage.setItem('personal-agent-inspector-width', String(inspectorWidth));
  }, [inspectorWidth]);
  // 侧边栏 Tab：「概要」固定不可删除，其余为可关闭的计划文档或文件差异 Tab。
  const [inspectorTabs, setInspectorTabs] = useState<InspectorTab[]>([
    { key: 'overview', title: '概要', kind: 'overview' },
  ]);
  const inspectorTabsRef = useRef(inspectorTabs);
  useEffect(() => {
    inspectorTabsRef.current = inspectorTabs;
  }, [inspectorTabs]);
  const [activeInspectorTab, setActiveInspectorTab] = useState('overview');
  const activeInspectorTabRef = useRef(activeInspectorTab);
  useEffect(() => {
    activeInspectorTabRef.current = activeInspectorTab;
  }, [activeInspectorTab]);
  // 计划文档（全局 map：跨任务保留，任务切换/历史恢复时按 taskId 重放卡片）
  const [planDocs, setPlanDocs] = useState<Record<string, PlanDoc>>({});
  const planDocsRef = useRef(planDocs);
  useEffect(() => {
    planDocsRef.current = planDocs;
  }, [planDocs]);
  // 文件修改记录（全局 map：本次会话中任务执行修改的文件，供 diff Tab 查看）
  const [fileChanges, setFileChanges] = useState<Record<string, FileChange>>({});
  const fileChangesRef = useRef(fileChanges);
  useEffect(() => {
    fileChangesRef.current = fileChanges;
  }, [fileChanges]);
  // 服务端落盘的修改文件批次（唯一事实源：实时 run_changes 事件 + seed 拉取
  // 幂等合并登记），history 重放 / seed 拉取 / 实时事件三路径共用
  // insertRunChangesCards 按 requestSeq 把卡片插到对应轮次回复下方（按卡片 id 去重），
  // 消除「seed 先到被 history 整体替换冲掉 / history 先到 seed 后补」两种竞态。
  const fileChangeBatchesRef = useRef<StoredFileChangeBatch[]>([]);

  /** 从服务端拉取 starter-prompts 自定义内容并更新首页示例（保存后也会被调用） */
  const reloadStarterPrompts = useCallback(async () => {
    try {
      const response = await apiFetch('/api/prompts');
      if (!response.ok) return;
      const payload = (await response.json()) as { prompts: BuiltinPromptItem[] };
      const starter = payload.prompts.find((item) => item.key === 'starter-prompts');
      setStarterItems(starter?.customized ? parseStarterPrompts(starter.content) : starterPrompts);
    } catch {
      // 拉取失败时保持内置示例
    }
  }, []);

  useEffect(() => {
    void reloadStarterPrompts();
  }, [reloadStarterPrompts]);
  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/skills')
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { skills: SkillInfo[] } | null) => {
        if (!cancelled && payload) setAvailableSkills(payload.skills);
      })
      .catch(() => {
        // 技能列表加载失败不影响主流程
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const [draftTaskProjectId, setDraftTaskProjectId] = useState<string>();
  const pendingTaskDraftRef = useRef<{
    projectId: string;
    prompt?: string;
    images?: PromptImageInput[];
    permissionMode?: PermissionMode;
    taskModel?: { provider: string; model: string };
    reasoningEffort?: ReasoningEffort;
    planMode?: boolean;
  }>();
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryPickerLoading, setDirectoryPickerLoading] = useState(false);
  const [directoryTreeData, setDirectoryTreeData] = useState<DirectoryTreeNode[]>([]);
  const [selectedDirectory, setSelectedDirectory] = useState<string>();
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'providers' | 'general' | 'prompts' | 'skills'>(
    'general',
  );
  const [providerView, setProviderView] = useState<'list' | 'form'>('list');
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerDeleting, setProviderDeleting] = useState<ProviderId>();
  const [compressing, setCompressing] = useState(false);
  /** 自动触发上下文压缩时（Token 超 75% 阈值），对话区显示「正在压缩上下文...」提示。 */
  const [contextCompacting, setContextCompacting] = useState(false);
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsInfo | null>(null);
  const [appVersion, setAppVersion] = useState(VERSION);
  const [debugModalOpen, setDebugModalOpen] = useState(false);
  const [statsModalOpen, setStatsModalOpen] = useState(false);
  const [modelCalls, setModelCalls] = useState<ModelCallTrace[]>([]);
  const modelCallsRef = useRef<ModelCallTrace[]>([]);
  const [selectedModelCallId, setSelectedModelCallId] = useState<string>();
  const [rememberPermission, setRememberPermission] = useState(false);
  const [renamingTaskId, setRenamingTaskId] = useState<string>();
  const [renameTitle, setRenameTitle] = useState('');
  const [renamingProjectId, setRenamingProjectId] = useState<string>();
  const [renameProjectName, setRenameProjectName] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // 点击侧边栏「刷新项目和任务」按钮后的加载状态（收到 project_list 后复位）
  const [refreshingProjects, setRefreshingProjects] = useState(false);
  const refreshSeqRef = useRef(0);
  /** 「刷新项目和任务」的前后快照：用于在收到列表后对比数量并给出成功/无变化反馈。 */
  const refreshSnapshotRef = useRef<{
    seq: number;
    beforeProjects: number;
    beforeTasks: number;
    afterProjects?: number;
    afterTasks?: number;
    taskCompared: boolean;
    notified: boolean;
  }>();
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() =>
    loadStoredIds('pa-collapsed-projects'),
  );
  useEffect(() => {
    saveStoredIds('pa-collapsed-projects', collapsedProjects);
  }, [collapsedProjects]);
  const [unreadTaskIds, setUnreadTaskIds] = useState<Set<string>>(() =>
    loadStoredIds('pa-unread-tasks'),
  );
  const unreadTaskIdsRef = useRef(unreadTaskIds);
  const [waitingActionTaskIds, setWaitingActionTaskIds] = useState<Set<string>>(() => new Set());
  const waitingActionTaskIdsRef = useRef(waitingActionTaskIds);

  const [projectForm] = Form.useForm<ProjectFormValues>();
  const [providerForm] = Form.useForm<ProviderFormValues>();
  const selectedProvider = Form.useWatch('provider', providerForm);
  const providerModels = Form.useWatch('models', providerForm) ?? ([] as ProviderModelRow[]);

  const patchState = useCallback(
    (patch: Partial<WorkspaceState> | ((current: WorkspaceState) => Partial<WorkspaceState>)) => {
      const partial = typeof patch === 'function' ? patch(stateRef.current) : patch;
      const next = { ...stateRef.current, ...partial };
      stateRef.current = next;
      setState(next);
    },
    [],
  );

  const replaceTimeline = useCallback((items: TimelineItem[]) => {
    timelineRef.current = items;
    setTimeline(items);
  }, []);

  const updateTimeline = useCallback((updater: (items: TimelineItem[]) => TimelineItem[]) => {
    const next = updater(timelineRef.current);
    timelineRef.current = next;
    setTimeline(next);
  }, []);

  const emptyTaskSnapshot = (): TaskViewSnapshot => ({
    timeline: [],
    modelCalls: [],
    busy: false,
    contextUsage: undefined,
    planActive: false,
    plan: null,
    planProgress: {
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      current: 0,
      percentage: 0,
    },
    permissionMode: 'ask',
    sessionId: undefined,
    pendingPermission: undefined,
    pendingQuestion: undefined,
    responseSeq: 0,
  });
  /** Per-task view snapshots, preserved while switching tasks. */
  const taskDataRef = useRef<Record<string, TaskViewSnapshot>>({});
  const snapshotTaskView = useCallback((taskId: string) => {
    taskDataRef.current[taskId] = {
      timeline: timelineRef.current,
      modelCalls: modelCallsRef.current,
      busy: stateRef.current.busy,
      contextUsage: stateRef.current.contextUsage,
      planActive: stateRef.current.planActive,
      plan: stateRef.current.plan,
      planProgress: stateRef.current.planProgress,
      permissionMode: stateRef.current.permissionMode,
      sessionId: stateRef.current.sessionId,
      pendingPermission: stateRef.current.pendingPermission,
      pendingQuestion: stateRef.current.pendingQuestion,
      responseSeq: activeResponseSequenceRef.current,
    };
  }, []);
  const applyTaskView = useCallback(
    (taskId: string | undefined) => {
      if (!taskId) {
        // No target task (e.g. new-task draft): show an empty view while
        // keeping the previous task's snapshot for later switching.
        const empty = emptyTaskSnapshot();
        timelineRef.current = [];
        setTimeline([]);
        setModelCalls([]);
        modelCallsRef.current = [];
        setSelectedModelCallId(undefined);
        setQueuedMessages([]);
        activeResponseSequenceRef.current = 0;
        patchState({
          busy: false,
          contextUsage: undefined,
          planActive: false,
          plan: null,
          planProgress: empty.planProgress,
          permissionMode: 'ask',
          sessionId: undefined,
          pendingPermission: undefined,
          pendingQuestion: undefined,
        });
        return;
      }
      const data = taskDataRef.current[taskId] ?? emptyTaskSnapshot();
      const hasSnapshot = Boolean(taskDataRef.current[taskId]);
      timelineRef.current = data.timeline;
      setTimeline(data.timeline);
      setModelCalls(data.modelCalls);
      modelCallsRef.current = data.modelCalls;
      setSelectedModelCallId(undefined);
      // 队列随任务切换：展示目标任务自己的排队消息
      setQueuedMessages(queuedByTaskRef.current[taskId] ?? []);
      activeResponseSequenceRef.current = data.responseSeq;
      patchState({
        busy: data.busy,
        // 无快照的任务（首次打开/刷新后重开）：保留已收到的实时
        // context_usage，避免把服务端恢复的值（如刷新前的已用 tokens）
        // 重置成 undefined/0。
        contextUsage: hasSnapshot ? data.contextUsage : stateRef.current.contextUsage,
        planActive: data.planActive,
        plan: data.plan,
        planProgress: data.planProgress,
        permissionMode: data.permissionMode,
        sessionId: data.sessionId,
        pendingPermission: data.pendingPermission,
        pendingQuestion: data.pendingQuestion,
      });
    },
    [patchState],
  );
  /**
   * Preserve a task's view (default: the currently active task), then load
   * another task's snapshot. Pass saveTaskId explicitly when the active task
   * id does not match the view currently being rendered.
   */
  const switchTaskView = useCallback(
    (newTaskId: string | undefined, saveTaskId?: string) => {
      const source = saveTaskId ?? stateRef.current.activeTaskId;
      if (source) snapshotTaskView(source);
      applyTaskView(newTaskId);
    },
    [snapshotTaskView, applyTaskView],
  );

  /**
   * 将 plan 消息中的计划生成为 Markdown 文档：同 plan.id 已存在（批准/步骤状态
   * 更新后的重推）时仅刷新 markdown/plan/updatedAt，不重复加卡片；不存在时创建
   * 文档并返回（调用方负责追加时间线卡片）。
   * markdown 优先使用服务端生成的同一份文档（已落盘），缺失时回退本地生成。
   */
  const upsertPlanDoc = useCallback(
    (
      plan: PlanMessage['plan'],
      taskId?: string,
      markdown?: string,
      requestSeq?: number,
    ): PlanDoc | null => {
      if (!plan) return null;
      const content = markdown ?? planToMarkdown(plan);
      const existing = planDocsRef.current[plan.id];
      if (existing) {
        const updated: PlanDoc = {
          ...existing,
          markdown: content,
          plan,
          updatedAt: Date.now(),
        };
        planDocsRef.current[plan.id] = updated;
        setPlanDocs({ ...planDocsRef.current });
        return null;
      }
      const doc: PlanDoc = {
        id: plan.id,
        taskId,
        title: plan.title,
        markdown: content,
        plan,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        requestSeq,
      };
      planDocsRef.current[plan.id] = doc;
      setPlanDocs({ ...planDocsRef.current });
      return doc;
    },
    [],
  );

  /** 打开（或激活）侧边栏中的计划文档 Tab，并展开侧边栏。 */
  const openPlanDocTab = useCallback(
    (docId: string) => {
      const doc = planDocsRef.current[docId];
      if (!doc) return;
      const existing = inspectorTabsRef.current.find(
        (tab) => tab.kind === 'plan-doc' && tab.docId === docId,
      );
      if (existing) {
        setActiveInspectorTab(existing.key);
      } else {
        const tab: InspectorTab = {
          key: `doc-${docId}`,
          title: doc.title,
          kind: 'plan-doc',
          docId,
        };
        setInspectorTabs((current) => [...current, tab]);
        setActiveInspectorTab(tab.key);
      }
      patchState({ inspectorOpen: true });
    },
    [patchState],
  );

  /** 打开（或激活）侧边栏中的文件差异 Tab，并展开侧边栏。 */
  const openFileDiffTab = useCallback(
    (changeId: string) => {
      const change = fileChangesRef.current[changeId];
      if (!change) return;
      const existing = inspectorTabsRef.current.find(
        (tab) => tab.kind === 'file-diff' && tab.changeId === changeId,
      );
      if (existing) {
        setActiveInspectorTab(existing.key);
      } else {
        const tab: InspectorTab = {
          key: `diff-${changeId}`,
          title: lastPathSegment(change.path) ?? change.path,
          kind: 'file-diff',
          changeId,
        };
        setInspectorTabs((current) => [...current, tab]);
        setActiveInspectorTab(tab.key);
      }
      patchState({ inspectorOpen: true });
    },
    [patchState],
  );

  /** 关闭侧边栏 Tab；关闭激活 Tab 后切回「概要」。 */
  const removeInspectorTab = useCallback((key: string) => {
    setInspectorTabs((current) => current.filter((tab) => tab.key !== key));
    if (activeInspectorTabRef.current === key) setActiveInspectorTab('overview');
  }, []);

  /** 拖拽右侧侧边栏左缘调整宽度（clamp 280–720），拖拽期间禁止文本选择。 */
  const startResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = inspectorWidthRef.current;
    const onMove = (moveEvent: PointerEvent) => {
      const next = startWidth + startX - moveEvent.clientX;
      setInspectorWidth(
        Math.min(INSPECTOR_WIDTH_MAX, Math.max(INSPECTOR_WIDTH_MIN, Math.round(next))),
      );
    };
    const onUp = () => {
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  /** 挂载时从服务端拉取已落盘的计划文档并补齐缺失的时间线卡片。 */
  const seedPlanDocs = useCallback(async () => {
    try {
      const response = await apiFetch('/api/plans');
      if (!response.ok) return;
      const payload = (await response.json()) as { plans: PlanDoc[] };
      const docs: Record<string, PlanDoc> = {};
      for (const doc of payload.plans) docs[doc.id] = normalizeStoredPlanDoc(doc);
      planDocsRef.current = docs;
      setPlanDocs(docs);
      // plans 接口可能晚于 history 到达：主动补齐当前时间线与各任务快照缺失的卡片
      //（plan 与 run-changes 两类卡片统一按轮次插入，任一来源先到后到都安全）
      updateTimeline((items) =>
        insertReplayCards(items, docs, fileChangeBatchesRef.current, stateRef.current.activeTaskId),
      );
      for (const [taskId, data] of Object.entries(taskDataRef.current)) {
        data.timeline = insertReplayCards(
          data.timeline,
          docs,
          fileChangeBatchesRef.current,
          taskId,
        );
      }
    } catch {
      // 服务端不可用时保持当前内存态（不阻断页面）
    }
  }, [updateTimeline]);

  useEffect(() => {
    void seedPlanDocs();
  }, [seedPlanDocs]);

  /** 挂载时从服务端拉取已落盘的修改文件记录批次，填入 fileChanges map 并补齐时间线卡片。 */
  const seedFileChanges = useCallback(async () => {
    try {
      const response = await apiFetch('/api/file-changes');
      if (!response.ok) return;
      const payload = (await response.json()) as { batches: StoredFileChangeBatch[] };
      const changes: Record<string, FileChange> = {};
      for (const batch of payload.batches) {
        batch.files.forEach((file, index) => {
          changes[`file-change-${batch.id}-${index}`] = {
            id: `file-change-${batch.id}-${index}`,
            taskId: batch.taskId,
            path: file.path,
            oldContent: file.oldContent,
            newContent: file.newContent,
            time: batch.time,
            truncated: file.truncated,
          };
        });
      }
      fileChangesRef.current = changes;
      setFileChanges(changes);
      // 合并登记批次（可能已有实时 run_changes 登记的条目；insertRunChangesCards 按卡片 id 去重）
      fileChangeBatchesRef.current = [...fileChangeBatchesRef.current, ...payload.batches];
      // 接口可能晚于 history 到达：主动补齐当前时间线与各任务快照缺失的卡片
      //（plan 与 run-changes 两类卡片统一按轮次插入，任一来源先到后到都安全）
      updateTimeline((items) =>
        insertReplayCards(
          items,
          planDocsRef.current,
          fileChangeBatchesRef.current,
          stateRef.current.activeTaskId,
        ),
      );
      for (const [taskId, data] of Object.entries(taskDataRef.current)) {
        data.timeline = insertReplayCards(
          data.timeline,
          planDocsRef.current,
          fileChangeBatchesRef.current,
          taskId,
        );
      }
    } catch {
      // 服务端不可用时保持当前内存态（不阻断页面）
    }
  }, [updateTimeline]);

  useEffect(() => {
    void seedFileChanges();
  }, [seedFileChanges]);

  const userTurns = useMemo(
    () =>
      timeline.filter(
        (item): item is MessageTimelineItem & { role: 'user' } =>
          item.kind === 'message' && item.role === 'user',
      ),
    [timeline],
  );

  /**
   * plan / run-changes 卡片 → 所属 assistant 消息的吸附映射：卡片渲染进该消息的
   * .pa-message-content 内部末尾（同一轮内计划文档在前、修改文件列表在后）。
   * 吸附范围为「assistant/system 消息之后、下一轮 user 消息之前」的卡片；
   * 无归属 assistant 的卡片（异常数据）由主循环独立渲染兜底。
   */
  const { assistantCards, attachedCardIds } = useMemo(() => {
    const cards = new Map<string, TimelineItem[]>();
    let ownerId: string | undefined;
    for (const item of timeline) {
      if (item.kind === 'message') {
        if (item.role === 'assistant' || item.role === 'system') {
          ownerId = item.id;
          cards.set(ownerId, []);
        } else {
          ownerId = undefined;
        }
      } else if ((item.kind === 'plan-doc' || item.kind === 'run-changes') && ownerId) {
        cards.get(ownerId)?.push(item);
      }
    }
    const attached = new Set([...cards.values()].flat().map((card) => card.id));
    return { assistantCards: cards, attachedCardIds: attached };
  }, [timeline]);

  const registerMessageElement = useCallback((id: string, element: HTMLElement | null) => {
    if (element) userMessageEls.current.set(id, element);
    else userMessageEls.current.delete(id);
  }, []);

  const updateActiveTurnId = useCallback(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    const threshold = transcript.getBoundingClientRect().top + transcript.clientHeight * 0.4;
    let found: string | undefined;
    for (const item of timelineRef.current) {
      if (item.kind !== 'message' || item.role !== 'user') continue;
      const element = userMessageEls.current.get(item.id);
      if (!element) continue;
      if (element.getBoundingClientRect().top <= threshold) found = item.id;
      else break;
    }
    setActiveTurnId(found);
  }, []);

  const scrollToTurn = useCallback((turnId: string) => {
    const element = userMessageEls.current.get(turnId);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const nextId = useCallback((prefix: string) => {
    sequenceRef.current += 1;
    return `${prefix}-${sequenceRef.current}`;
  }, []);

  const appendMessage = useCallback(
    (
      role: MessageTimelineItem['role'],
      text: string,
      options: Pick<MessageTimelineItem, 'streaming' | 'error' | 'images'> = {},
    ) => {
      const item: MessageTimelineItem = {
        id: nextId(role),
        kind: 'message',
        role,
        text,
        time: currentTime(),
        ...options,
      };
      updateTimeline((items) => [...items, item]);
      return item.id;
    },
    [nextId, updateTimeline],
  );

  const send = useCallback(
    (outgoing: ClientMessage): boolean => {
      if (socketRef.current?.readyState !== WebSocket.OPEN) {
        messageApi.error('服务尚未连接');
        return false;
      }
      socketRef.current.send(JSON.stringify(outgoing));
      return true;
    },
    [messageApi],
  );

  /** 刷新项目和任务：请求服务端从磁盘重新加载并下发最新列表。 */
  const refreshProjectsAndTasks = useCallback(() => {
    if (!send({ type: 'list_projects' })) return;
    const seq = ++refreshSeqRef.current;
    setRefreshingProjects(true);
    // 记录刷新前的列表快照，收到新列表后对比数量，给出「已刷新/无变化」反馈。
    refreshSnapshotRef.current = {
      seq,
      beforeProjects: stateRef.current.projects.length,
      beforeTasks: stateRef.current.tasks.length,
      taskCompared: false,
      notified: false,
    };
    // 兜底：若服务端长时间无响应（如连接中断），超时后复位加载状态。
    window.setTimeout(() => {
      if (refreshSeqRef.current === seq) setRefreshingProjects(false);
    }, 8000);
  }, [send]);

  const updateUnreadTasks = useCallback((updater: (current: Set<string>) => Set<string>) => {
    const current = unreadTaskIdsRef.current;
    const next = updater(current);
    if (next === current) return;
    unreadTaskIdsRef.current = next;
    setUnreadTaskIds(next);
    saveStoredIds('pa-unread-tasks', next);
  }, []);

  const updateWaitingActionTasks = useCallback((updater: (current: Set<string>) => Set<string>) => {
    const current = waitingActionTaskIdsRef.current;
    const next = updater(current);
    if (next === current) return;
    waitingActionTaskIdsRef.current = next;
    setWaitingActionTaskIds(next);
  }, []);

  const openTask = useCallback(
    (taskId: string) => {
      pendingTaskDraftRef.current = undefined;
      setDraftTaskProjectId(undefined);
      if (!send({ type: 'open_task', taskId })) return;
      updateUnreadTasks((current) => removeUnreadTask(current, taskId));
      patchState({ creatingTask: false, sidebarOpen: false });
    },
    [patchState, send, updateUnreadTasks],
  );

  useEffect(() => {
    const taskId = state.activeTaskId;
    if (taskId) updateUnreadTasks((current) => removeUnreadTask(current, taskId));
  }, [state.activeTaskId, updateUnreadTasks]);

  useEffect(() => {
    return window.personalAgentDesktop?.onOpenTaskRequested(openTask);
  }, [openTask]);

  /** 任务执行中把消息加入当前任务的排队队列（busy→false 后自动按序执行）。 */
  const enqueueQueuedMessage = useCallback(
    (text: string) => {
      const taskId = stateRef.current.activeTaskId;
      if (!taskId) return;
      const item: QueuedMessage = { id: nextId('queued'), text, time: currentTime() };
      const next = [...(queuedByTaskRef.current[taskId] ?? []), item];
      queuedByTaskRef.current[taskId] = next;
      if (stateRef.current.activeTaskId === taskId) setQueuedMessages(next);
      setPrompt('');
    },
    [nextId],
  );

  /**
   * 冲刷目标任务（默认当前任务）的排队消息：任务空闲且队列非空时，把队首消息
   * 作为正常 prompt 发送（写入该任务自己的时间线），下一条由下一次 busy→false
   * 事件链式触发。用于「当前任务执行结束后自动理解并执行排队的指令」。
   */
  const flushQueuedMessages = useCallback(
    (taskId?: string) => {
      const target = taskId ?? stateRef.current.activeTaskId;
      if (!target) return;
      const queue = queuedByTaskRef.current[target];
      if (!queue || queue.length === 0) return;
      if (stateRef.current.creatingTask || stateRef.current.pendingQuestion) return;
      // 目标任务是否空闲：活动任务查全局 busy，非活动任务查视图快照
      const taskBusy =
        target === stateRef.current.activeTaskId
          ? stateRef.current.busy
          : (taskDataRef.current[target]?.busy ?? false);
      if (taskBusy) return;
      const [first, ...rest] = queue;
      queuedByTaskRef.current[target] = rest;
      if (target === stateRef.current.activeTaskId) setQueuedMessages(rest);
      // 写入正确任务的时间线：活动任务更新全局 timeline，非活动任务更新快照
      if (target === stateRef.current.activeTaskId) {
        followOutputRef.current = true;
        appendMessage('user', first.text);
      } else {
        const data = taskDataRef.current[target] ?? emptyTaskSnapshot();
        data.timeline = [
          ...data.timeline,
          {
            id: nextId('user'),
            kind: 'message',
            role: 'user',
            text: first.text,
            time: currentTime(),
          },
        ];
        taskDataRef.current[target] = data;
      }
      send({ type: 'prompt', text: first.text, taskId: target });
    },
    [appendMessage, nextId, send],
  );

  /** 删除一条排队消息。 */
  const removeQueuedMessage = useCallback((id: string) => {
    const taskId = stateRef.current.activeTaskId;
    if (!taskId) return;
    const next = (queuedByTaskRef.current[taskId] ?? []).filter((item) => item.id !== id);
    queuedByTaskRef.current[taskId] = next;
    setQueuedMessages(next);
  }, []);

  /**
   * 把一条排队消息「插入」到当前正在执行的任务循环内，作为用户的补充消息引导
   * 模型思考方向（服务端 busy 时由 AgentLoop 下一轮吸取；空闲时等价于正常执行）。
   * 乐观更新：先移除队列并追加到时间线；发送失败（连接断开等）时恢复队列条目。
   */
  const injectQueuedMessage = useCallback(
    (id: string) => {
      const taskId = stateRef.current.activeTaskId;
      if (!taskId) return;
      const item = (queuedByTaskRef.current[taskId] ?? []).find((queued) => queued.id === id);
      if (!item) return;
      const rest = (queuedByTaskRef.current[taskId] ?? []).filter((queued) => queued.id !== id);
      queuedByTaskRef.current[taskId] = rest;
      setQueuedMessages(rest);
      followOutputRef.current = true;
      appendMessage('user', item.text);
      if (!send({ type: 'inject_user_message', text: item.text, taskId })) {
        queuedByTaskRef.current[taskId] = [item, ...rest];
        setQueuedMessages([item, ...rest]);
        messageApi.error('插入失败：服务连接已断开，消息已放回队列');
      }
    },
    [appendMessage, messageApi, send],
  );

  const handleServerMessage = useCallback(
    (incoming: ServerMessage) => {
      switch (incoming.type) {
        case 'ready':
          patchState({
            runtime: incoming.runtime,
            configured: incoming.runtime.configured,
            sessionId: incoming.sessionId,
            activeProjectId: pendingTaskDraftRef.current?.projectId ?? incoming.activeProjectId,
            activeTaskId: pendingTaskDraftRef.current ? undefined : incoming.activeTaskId,
          });
          setAppVersion(incoming.version);
          if (!pendingTaskDraftRef.current) rememberActiveTask(incoming.activeTaskId);
          break;
        case 'runtime_updated': {
          const becameConfigured = !stateRef.current.configured && incoming.runtime.configured;
          patchState({
            runtime: incoming.runtime,
            configured: incoming.runtime.configured,
          });
          // 供应商配置变更（含模型列表增删）：刷新任务列表，同步任务模型的
          // 自动切换结果（被移除的模型已从选项列表消失，任务自动选中可用模型）。
          send({ type: 'list_projects' });
          if (becameConfigured && stateRef.current.activeTaskId) {
            send({ type: 'open_task', taskId: stateRef.current.activeTaskId });
          }
          break;
        }
        case 'history': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          const viewingTask = stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== viewingTask) {
            switchTaskView(eventTaskId, viewingTask);
          }
          if (pendingTaskDraftRef.current) {
            if (eventTaskId && eventTaskId !== viewingTask && viewingTask) {
              switchTaskView(viewingTask, eventTaskId);
            }
            break;
          }
          setCompressing(false);
          setModelCalls([]);
          modelCallsRef.current = [];
          setSelectedModelCallId(undefined);
          let restored: TimelineItem[] = [];
          const restoredToolOwners = new Map<string, number>();
          // 当前组（一次用户请求）：所有 assistant 消息合并为一条消息，
          // 每个 assistant 消息（一次 LLM 调用）作为独立的 turn 分组。
          let groupAssistantIndex = -1;
          let groupTurnSeq = 0;
          for (const historyMessage of incoming.messages) {
            if (historyMessage.role === 'system') continue;
            const text = extractMessageText(historyMessage);
            const images = extractMessageImages(historyMessage);
            const thinking = extractMessageThinking(historyMessage);
            if (historyMessage.role === 'user') {
              restored.push({
                id: nextId('history-user'),
                kind: 'message',
                role: 'user',
                text,
                images,
                time: currentTime(),
              });
              groupAssistantIndex = -1;
              groupTurnSeq = 0;
            } else if (historyMessage.role === 'assistant') {
              const tools = extractAssistantTools(historyMessage);
              if (!text && !thinking && tools.length === 0) continue;
              if (groupAssistantIndex === -1) {
                // 新一轮的第一个助手消息：创建合并消息并放入第一个 turn
                const itemIndex = restored.length;
                restored.push({
                  id: nextId('history-assistant'),
                  kind: 'message',
                  role: 'assistant',
                  text: '',
                  turns: [{ turnNumber: (groupTurnSeq += 1), thinking, text, tools }],
                  time: currentTime(),
                  // 服务端持久化的本次任务耗时与各指标（刷新后恢复展示）
                  durationMs: historyMessage.durationMs,
                  finishedAt: historyMessage.finishedAt,
                  ttftMs: historyMessage.ttftMs,
                  tokensPerSecond: historyMessage.tokensPerSecond,
                });
                groupAssistantIndex = itemIndex;
              } else {
                // 同一轮内的后续调用：追加为新的 turn 分组
                const current = restored[groupAssistantIndex];
                if (current.kind === 'message') {
                  restored[groupAssistantIndex] = {
                    ...current,
                    // 一次任务可能因工具调用产生多条 assistant 历史消息；
                    // 服务端把任务总耗时写在最后一条上，合并回放时需同步到整条回复。
                    durationMs: historyMessage.durationMs ?? current.durationMs,
                    finishedAt: historyMessage.finishedAt ?? current.finishedAt,
                    ttftMs: historyMessage.ttftMs ?? current.ttftMs,
                    tokensPerSecond: historyMessage.tokensPerSecond ?? current.tokensPerSecond,
                    turns: [
                      ...(current.turns ?? []),
                      { turnNumber: (groupTurnSeq += 1), thinking, text, tools },
                    ],
                  };
                }
              }
              for (const tool of tools) {
                restoredToolOwners.set(tool.toolCallId, groupAssistantIndex);
              }
            } else if (historyMessage.role === 'tool') {
              const toolCallId = historyMessage.toolCallId ?? nextId('tool-call');
              const ownerIndex = restoredToolOwners.get(toolCallId);
              const owner = ownerIndex === undefined ? undefined : restored[ownerIndex];
              if (ownerIndex !== undefined && owner?.kind === 'message') {
                const status = getRestoredToolStatus(text, historyMessage);
                const output = text || '(无输出)';
                restored[ownerIndex] = {
                  ...owner,
                  turns: (owner.turns ?? []).map((turn) => ({
                    ...turn,
                    tools: turn.tools.map((tool) =>
                      tool.toolCallId === toolCallId ? { ...tool, status, output } : tool,
                    ),
                  })),
                };
              } else {
                restored.push({
                  id: nextId('history-tool'),
                  kind: 'tool',
                  toolCallId,
                  name: historyMessage.name ?? '历史工具结果',
                  status: getRestoredToolStatus(text, historyMessage),
                  output: text || '(无输出)',
                  restored: true,
                });
              }
            }
          }
          followOutputRef.current = true;
          // 重放 plan 与 run-changes 两类卡片（切任务/重连/刷新后保持可见，与
          // seedPlanDocs / seedFileChanges 幂等，按卡片 id 去重）：按 requestSeq
          // 插到对应轮次回复下方（同一轮内 plan 在前、文件列表在后），避免刷新后
          // 全部堆在对话末尾；同时兜底 seed 先完成、历史后到达被 replaceTimeline
          // 整体替换的竞态（desktop 重启等场景），保证卡片不丢失。
          restored = insertReplayCards(
            restored,
            planDocsRef.current,
            fileChangeBatchesRef.current,
            eventTaskId,
          );
          replaceTimeline(restored);
          patchState({ sessionId: incoming.sessionId });
          if (eventTaskId && eventTaskId !== viewingTask && viewingTask) {
            switchTaskView(viewingTask, eventTaskId);
          }
          break;
        }
        case 'project_list': {
          setRefreshingProjects(false);
          const snapshot = refreshSnapshotRef.current;
          if (snapshot && snapshot.seq === refreshSeqRef.current) {
            snapshot.afterProjects = incoming.projects.length;
            // task_list 由服务端紧随 project_list 下发；留一个短窗口等待它到达，
            // 以便在一条提示里同时反馈项目与任务的变化。无 activeProjectId 时服务端
            // 不下发 task_list，超时后仅按项目数量变化提示。
            window.setTimeout(() => {
              if (snapshot.notified) return;
              if (snapshot.taskCompared) return;
              snapshot.notified = true;
              const projectChanged =
                snapshot.afterProjects !== undefined &&
                snapshot.afterProjects !== snapshot.beforeProjects;
              const taskChanged =
                snapshot.afterTasks !== undefined && snapshot.afterTasks !== snapshot.beforeTasks;
              if (projectChanged || taskChanged) {
                const parts: string[] = [];
                if (projectChanged) {
                  parts.push(`项目 ${snapshot.beforeProjects} → ${snapshot.afterProjects} 个`);
                }
                if (taskChanged) {
                  parts.push(`任务 ${snapshot.beforeTasks} → ${snapshot.afterTasks} 个`);
                }
                messageApi.success(`已刷新：${parts.join('、')}`);
              } else {
                messageApi.info('已刷新，项目与任务列表无变化');
              }
            }, 300);
          }
          patchState((current) => ({
            projects: incoming.projects,
            activeProjectId:
              pendingTaskDraftRef.current?.projectId ??
              incoming.activeProjectId ??
              current.activeProjectId,
          }));
          break;
        }
        case 'task_list': {
          const snapshot = refreshSnapshotRef.current;
          if (snapshot && snapshot.seq === refreshSeqRef.current && !snapshot.notified) {
            snapshot.afterTasks = incoming.tasks.length;
            snapshot.taskCompared = true;
            snapshot.notified = true;
            const projectChanged =
              snapshot.afterProjects !== undefined &&
              snapshot.afterProjects !== snapshot.beforeProjects;
            const taskChanged = snapshot.afterTasks !== snapshot.beforeTasks;
            if (projectChanged || taskChanged) {
              const parts: string[] = [];
              if (projectChanged) {
                parts.push(`项目 ${snapshot.beforeProjects} → ${snapshot.afterProjects} 个`);
              }
              if (taskChanged) {
                parts.push(`任务 ${snapshot.beforeTasks} → ${snapshot.afterTasks} 个`);
              }
              messageApi.success(`已刷新：${parts.join('、')}`);
            } else {
              messageApi.info('已刷新，项目与任务列表无变化');
            }
          }
          const nextActive = pendingTaskDraftRef.current
            ? undefined
            : (incoming.activeTaskId ?? stateRef.current.activeTaskId);
          if (nextActive !== stateRef.current.activeTaskId) switchTaskView(nextActive);
          const existingTaskIds = new Set(incoming.tasks.map((task) => task.id));
          updateUnreadTasks((current) => retainUnreadTasks(current, existingTaskIds));
          updateWaitingActionTasks((current) => retainTaskMarkers(current, existingTaskIds));
          patchState((current) => ({
            tasks: incoming.tasks,
            activeTaskId: pendingTaskDraftRef.current
              ? undefined
              : (incoming.activeTaskId ?? current.activeTaskId),
            permissionMode: pendingTaskDraftRef.current
              ? current.permissionMode
              : (incoming.tasks.find(
                  (task) => task.id === (incoming.activeTaskId ?? current.activeTaskId),
                )?.permissionMode ?? current.permissionMode),
          }));
          break;
        }
        case 'project_changed':
          // Keep activeTaskId: server always follows this event with
          // task_changed, and clearing the id here would make the follow-up
          // switchTaskView lose the source task's view snapshot.
          patchState((current) => ({
            projects: upsertById(current.projects, incoming.project),
            activeProjectId: incoming.project.id,
            creatingProject: false,
          }));
          setProjectModalOpen(false);
          break;
        case 'project_archived':
          patchState((current) => ({
            projects: upsertById(current.projects, incoming.project),
            activeTaskId:
              current.activeProjectId === incoming.project.id ? undefined : current.activeTaskId,
          }));
          break;
        case 'project_deleted':
          // 清理该项目下任务的排队消息（任务已不存在，队列不可再执行）
          for (const task of stateRef.current.tasks) {
            if (task.projectId === incoming.projectId) {
              delete queuedByTaskRef.current[task.id];
            }
          }
          patchState((current) => ({
            projects: current.projects.filter((project) => project.id !== incoming.projectId),
            tasks: current.tasks.filter((task) => task.projectId !== incoming.projectId),
            activeTaskId:
              current.activeProjectId === incoming.projectId ? undefined : current.activeTaskId,
          }));
          // 同步当前展示的队列（删除的项目若包含当前任务，队列已清空）
          setQueuedMessages(queuedByTaskRef.current[stateRef.current.activeTaskId ?? ''] ?? []);
          break;
        case 'task_changed':
          switchTaskView(incoming.task.id);
          patchState((current) => ({
            activeProjectId: incoming.task.projectId,
            activeTaskId: incoming.task.id,
            tasks: upsertById(current.tasks, incoming.task),
            permissionMode: incoming.task.permissionMode,
            creatingTask: false,
            sidebarOpen: false,
          }));
          rememberActiveTask(incoming.task.id);
          if (
            (pendingTaskDraftRef.current?.prompt || pendingTaskDraftRef.current?.images?.length) &&
            pendingTaskDraftRef.current.projectId === incoming.task.projectId
          ) {
            const initialPrompt = pendingTaskDraftRef.current.prompt ?? '';
            const initialImages = pendingTaskDraftRef.current.images ?? [];
            const draftTaskModel = pendingTaskDraftRef.current.taskModel;
            const draftReasoningEffort = pendingTaskDraftRef.current.reasoningEffort;
            const draftPlanMode = pendingTaskDraftRef.current.planMode;
            pendingTaskDraftRef.current = undefined;
            setDraftTaskProjectId(undefined);
            followOutputRef.current = true;
            // 草稿中的任务模型/思考强度/计划模式：先应用（任务空闲），再发 prompt。
            if (draftTaskModel) {
              send({
                type: 'set_task_model',
                taskId: incoming.task.id,
                providerId: draftTaskModel.provider,
                model: draftTaskModel.model,
                reasoningEffort: draftReasoningEffort,
              });
            }
            if (draftPlanMode) {
              send({ type: 'set_plan_mode', enabled: true, taskId: incoming.task.id });
            }
            appendMessage('user', initialPrompt, {
              images: promptImagesForTimeline(initialImages),
            });
            if (
              send({
                type: 'prompt',
                text: initialPrompt,
                images: initialImages,
                taskId: incoming.task.id,
              })
            ) {
              setPrompt('');
              setPromptImages([]);
            }
          }
          requestAnimationFrame(() =>
            document.querySelector<HTMLTextAreaElement>('#prompt-input')?.focus(),
          );
          // 切换到空闲任务且存在排队消息（如切换前该任务已执行完）：立即冲刷
          flushQueuedMessages(incoming.task.id);
          break;
        case 'task_renamed':
          patchState((current) => ({
            tasks: upsertById(current.tasks, incoming.task),
          }));
          setRenamingTaskId(undefined);
          break;
        case 'session_list':
          break;
        case 'session_changed':
          patchState({ sessionId: incoming.sessionId });
          break;
        case 'busy': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (!incoming.busy && eventTaskId) {
            updateWaitingActionTasks((current) => removeTaskMarker(current, eventTaskId));
          }
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            if (incoming.busy) data.responseSeq += 1;
            data.busy = incoming.busy;
            taskDataRef.current[eventTaskId] = data;
            // 非活动任务执行结束：自动冲刷该任务的排队消息
            if (!incoming.busy) flushQueuedMessages(eventTaskId);
            break;
          }
          if (incoming.busy && !stateRef.current.busy) {
            responseSequenceRef.current += 1;
            activeResponseSequenceRef.current = responseSequenceRef.current;
          }
          patchState({ busy: incoming.busy });
          if (!incoming.busy) {
            // 当前任务执行结束：自动按序执行排队消息
            flushQueuedMessages(eventTaskId);
            // 兜底清除压缩提示（正常情况下 context_compacted 已先到达并清除）
            setContextCompacting(false);
            updateTimeline((items) =>
              items.map((item) =>
                item.kind === 'message' && item.streaming ? { ...item, streaming: false } : item,
              ),
            );
          }
          break;
        }
        case 'turn_start':
          break;
        case 'inject_user_message_applied': {
          // 任务执行中注入的用户消息已被服务端写入历史、模型即将回应它。
          // 递增 response sequence，让后续 thinking_delta / assistant_delta /
          // tool_start 等事件定位到新的一轮回复气泡（而不是合并进上一轮回复），
          // 与刷新后 history 重放（注入 user 消息后的 assistant 回复为独立消息）保持一致。
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.responseSeq += 1;
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          responseSequenceRef.current += 1;
          activeResponseSequenceRef.current = responseSequenceRef.current;
          break;
        }
        case 'context_compacting': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (!eventTaskId || eventTaskId === stateRef.current.activeTaskId) {
            setContextCompacting(true);
          }
          break;
        }
        case 'context_compacted': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (!eventTaskId || eventTaskId === stateRef.current.activeTaskId) {
            setContextCompacting(false);
          }
          break;
        }
        case 'llm_call_start': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.modelCalls = [...data.modelCalls, { ...incoming.call, status: 'running' }];
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          setModelCalls((current) => {
            const next: ModelCallTrace[] = [
              ...current,
              { ...incoming.call, status: 'running' as const },
            ];
            modelCallsRef.current = next;
            return next;
          });
          setSelectedModelCallId(incoming.call.callId);
          break;
        }
        case 'llm_call_end': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.modelCalls = data.modelCalls.map((call) =>
              call.callId === incoming.call.callId ? { ...call, ...incoming.call } : call,
            );
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          setModelCalls((current) => {
            const next: ModelCallTrace[] = current.map((call) =>
              call.callId === incoming.call.callId ? { ...call, ...incoming.call } : call,
            );
            modelCallsRef.current = next;
            return next;
          });
          break;
        }
        case 'thinking_delta': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.timeline = updateAssistantTurn(
              data.timeline,
              data.responseSeq,
              incoming.turnNumber,
              (turn) => ({
                ...turn,
                thinking: `${turn.thinking}${incoming.thinking}`,
              }),
            );
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          updateTimeline((items) =>
            updateAssistantTurn(
              items,
              activeResponseSequenceRef.current,
              incoming.turnNumber,
              (turn) => ({
                ...turn,
                thinking: `${turn.thinking}${incoming.thinking}`,
              }),
            ),
          );
          break;
        }
        case 'assistant_delta': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.timeline = updateAssistantTurn(
              data.timeline,
              data.responseSeq,
              incoming.turnNumber,
              (turn) => ({
                ...turn,
                text: `${turn.text}${incoming.text}`,
              }),
            );
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          updateTimeline((items) =>
            updateAssistantTurn(
              items,
              activeResponseSequenceRef.current,
              incoming.turnNumber,
              (turn) => ({
                ...turn,
                text: `${turn.text}${incoming.text}`,
              }),
            ),
          );
          break;
        }
        case 'tool_start': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.timeline = updateAssistantTurn(
              data.timeline,
              data.responseSeq,
              incoming.turnNumber,
              (turn) => ({
                ...turn,
                tools: upsertTurnTool(turn.tools, {
                  id: `tool-${incoming.toolCallId}`,
                  kind: 'tool',
                  toolCallId: incoming.toolCallId,
                  name: incoming.toolName,
                  arguments: incoming.arguments,
                  status: 'running',
                  output: '等待工具返回…',
                }),
              }),
            );
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          updateTimeline((items) =>
            updateAssistantTurn(
              items,
              activeResponseSequenceRef.current,
              incoming.turnNumber,
              (turn) => ({
                ...turn,
                tools: upsertTurnTool(turn.tools, {
                  id: `tool-${incoming.toolCallId}`,
                  kind: 'tool',
                  toolCallId: incoming.toolCallId,
                  name: incoming.toolName,
                  arguments: incoming.arguments,
                  status: 'running',
                  output: '等待工具返回…',
                }),
              }),
            ),
          );
          break;
        }
        case 'tool_progress': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.timeline = updateAssistantTurn(
              data.timeline,
              data.responseSeq,
              incoming.turnNumber,
              (turn) => ({
                ...turn,
                tools: updateTurnTool(turn.tools, incoming.toolCallId, (tool) => ({
                  ...tool,
                  output: incoming.content,
                })),
              }),
            );
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          updateTimeline((items) =>
            updateAssistantTurn(
              items,
              activeResponseSequenceRef.current,
              incoming.turnNumber,
              (turn) => ({
                ...turn,
                tools: updateTurnTool(turn.tools, incoming.toolCallId, (tool) => ({
                  ...tool,
                  output: incoming.content,
                })),
              }),
            ),
          );
          break;
        }
        case 'tool_end': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.timeline = updateAssistantTurn(
              data.timeline,
              data.responseSeq,
              incoming.turnNumber,
              (turn) => ({
                ...turn,
                tools: updateTurnTool(turn.tools, incoming.toolCallId, (tool) => ({
                  ...tool,
                  status: incoming.result.metadata?.interrupted
                    ? 'interrupted'
                    : incoming.result.success
                      ? 'success'
                      : 'failed',
                  output: (() => {
                    // 失败时也要展示工具的实际输出（如 bash 的 stderr），
                    // 而不是只显示 "Exit code: 1" 这类错误摘要。
                    const c = incoming.result.content || '';
                    const e = incoming.result.error || '';
                    if (c && e) return `${c}\n\n[error] ${e}`;
                    return c || e || '(无输出)';
                  })(),
                  duration: incoming.result.metadata?.duration,
                  metadata: incoming.result.metadata,
                })),
              }),
            );
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          updateTimeline((items) =>
            updateAssistantTurn(
              items,
              activeResponseSequenceRef.current,
              incoming.turnNumber,
              (turn) => ({
                ...turn,
                tools: updateTurnTool(turn.tools, incoming.toolCallId, (tool) => ({
                  ...tool,
                  status: incoming.result.metadata?.interrupted
                    ? 'interrupted'
                    : incoming.result.success
                      ? 'success'
                      : 'failed',
                  output: (() => {
                    // 失败时也要展示工具的实际输出（如 bash 的 stderr），
                    // 而不是只显示 "Exit code: 1" 这类错误摘要。
                    const c = incoming.result.content || '';
                    const e = incoming.result.error || '';
                    if (c && e) return `${c}\n\n[error] ${e}`;
                    return c || e || '(无输出)';
                  })(),
                  duration: incoming.result.metadata?.duration,
                  metadata: incoming.result.metadata,
                })),
              }),
            ),
          );
          break;
        }
        case 'permission_request': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId) {
            updateWaitingActionTasks((current) => addTaskMarker(current, eventTaskId));
            const taskTitle =
              stateRef.current.tasks.find((task) => task.id === eventTaskId)?.title ?? '当前任务';
            const notification = window.personalAgentDesktop?.showPermissionRequestNotification?.({
              taskId: eventTaskId,
              title: taskTitle,
              toolName: incoming.toolName,
            });
            void notification?.catch((error) =>
              console.warn('[desktop] permission notification failed:', error),
            );
          }
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.pendingPermission = incoming;
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          setRememberPermission(false);
          patchState({ pendingPermission: incoming });
          break;
        }
        case 'ask_user_request': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId) {
            updateWaitingActionTasks((current) => addTaskMarker(current, eventTaskId));
            const taskTitle =
              stateRef.current.tasks.find((task) => task.id === eventTaskId)?.title ?? '当前任务';
            const notification = window.personalAgentDesktop?.showQuestionRequestNotification?.({
              taskId: eventTaskId,
              title: taskTitle,
            });
            void notification?.catch((error) =>
              console.warn('[desktop] question notification failed:', error),
            );
          }
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.pendingQuestion = incoming;
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          patchState({ pendingQuestion: incoming });
          break;
        }
        case 'turn_end': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.timeline = data.timeline.map((item) =>
              item.id === assistantResponseId(data.responseSeq) && item.kind === 'message'
                ? { ...item, streaming: false }
                : item,
            );
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          updateTimeline((items) =>
            items.map((item) =>
              item.id === assistantResponseId(activeResponseSequenceRef.current) &&
              item.kind === 'message'
                ? { ...item, streaming: false }
                : item,
            ),
          );
          break;
        }
        case 'done': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            updateUnreadTasks((current) =>
              addUnreadTask(current, eventTaskId, stateRef.current.activeTaskId),
            );
            const taskTitle =
              stateRef.current.tasks.find((task) => task.id === eventTaskId)?.title ?? '后台任务';
            void window.personalAgentDesktop
              ?.showTaskCompletionNotification({ taskId: eventTaskId, title: taskTitle })
              .catch((error) => console.warn('[desktop] task notification failed:', error));
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            // 按消息 id 定位当前回复：turn_end 已把 streaming 置 false，
            // 不能依赖 streaming 判断（否则耗时永远写不进去）。
            data.timeline = data.timeline.map((item) =>
              item.kind === 'message' && item.id === assistantResponseId(data.responseSeq)
                ? {
                    ...item,
                    streaming: false,
                    durationMs: completedDurationMs(item) ?? item.durationMs,
                    finishedAt: incoming.finishedAt,
                    ttftMs: incoming.ttftMs,
                    tokensPerSecond: incoming.tokensPerSecond,
                  }
                : item,
            );
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          updateTimeline((items) =>
            items.map((item) =>
              item.kind === 'message' &&
              item.id === assistantResponseId(activeResponseSequenceRef.current)
                ? {
                    ...item,
                    streaming: false,
                    durationMs: completedDurationMs(item) ?? item.durationMs,
                    finishedAt: incoming.finishedAt,
                    ttftMs: incoming.ttftMs,
                    tokensPerSecond: incoming.tokensPerSecond,
                  }
                : item,
            ),
          );
          break;
        }
        case 'run_changes': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (incoming.files.length === 0) break;
          // 服务端批次 id：存在时用确定性 change/card id（刷新恢复后 diff Tab 可命中），
          // 不存在（旧服务端）退回本地唯一 id。
          const batchId = incoming.id ?? nextId('local-batch');
          const batch: StoredFileChangeBatch = {
            id: batchId,
            taskId: eventTaskId,
            time: new Date().toISOString(),
            requestSeq: incoming.requestSeq,
            files: incoming.files.map((file) => ({ ...file })),
          };
          // 登记到唯一批次事实源（fileChangeBatchesRef）：后续 history 重放
          // （切换任务/压缩上下文等）时用同一份数据恢复卡片。
          // 旧服务端无批次 id 时仅本地使用（不登记），重放后无法恢复属预期降级。
          if (incoming.id) {
            fileChangeBatchesRef.current = [
              ...fileChangeBatchesRef.current.filter((existing) => existing.id !== batchId),
              batch,
            ];
          }
          const next = { ...fileChangesRef.current };
          const seenPaths = new Set<string>();
          let fileIndex = 0;
          for (const file of incoming.files) {
            // 同批次内按路径去重（服务端已去重，此处兜底兼容旧服务端）；
            // change id 与卡片内 insertRunChangesCards 派生的 id 保持一致
            if (seenPaths.has(file.path)) continue;
            seenPaths.add(file.path);
            const id = `file-change-${batchId}-${fileIndex}`;
            fileIndex += 1;
            next[id] = {
              id,
              taskId: eventTaskId,
              path: file.path,
              oldContent: file.oldContent,
              newContent: file.newContent,
              time: currentTime(),
            };
          }
          fileChangesRef.current = next;
          setFileChanges(next);
          // 与 history 重放 / seed 拉取共用同一个插入函数（实时时该轮回复位于
          // 末尾，插入即追加到对应轮次回复下方）
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.timeline = insertRunChangesCards(data.timeline, [batch], eventTaskId);
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          updateTimeline((items) => insertRunChangesCards(items, [batch], eventTaskId));
          break;
        }
        case 'interrupted': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId) {
            updateWaitingActionTasks((current) => removeTaskMarker(current, eventTaskId));
          }
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.pendingPermission = undefined;
            data.pendingQuestion = undefined;
            data.timeline = data.timeline.map((item) => {
              if (item.kind === 'tool') {
                return item.status === 'running' ? { ...item, status: 'interrupted' } : item;
              }
              if (item.kind === 'message') {
                return {
                  ...item,
                  streaming: false,
                  durationMs: completedDurationMs(item) ?? item.durationMs,
                  finishedAt: incoming.finishedAt,
                  ttftMs: incoming.ttftMs,
                  tokensPerSecond: incoming.tokensPerSecond,
                  tools: item.tools?.map((tool) =>
                    tool.status === 'running' ? { ...tool, status: 'interrupted' } : tool,
                  ),
                  turns: item.turns?.map((turn) => ({
                    ...turn,
                    tools: turn.tools.map((tool) =>
                      tool.status === 'running' ? { ...tool, status: 'interrupted' } : tool,
                    ),
                  })),
                };
              }
              return item;
            });
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          messageApi.info('已停止生成');
          patchState({ pendingPermission: undefined, pendingQuestion: undefined });
          updateTimeline((items) =>
            items.map((item) => {
              if (item.kind === 'tool') {
                return item.status === 'running' ? { ...item, status: 'interrupted' } : item;
              }
              if (item.kind === 'message') {
                return {
                  ...item,
                  streaming: false,
                  durationMs: completedDurationMs(item) ?? item.durationMs,
                  finishedAt: incoming.finishedAt,
                  ttftMs: incoming.ttftMs,
                  tokensPerSecond: incoming.tokensPerSecond,
                  tools: item.tools?.map((tool) =>
                    tool.status === 'running' ? { ...tool, status: 'interrupted' } : tool,
                  ),
                  turns: item.turns?.map((turn) => ({
                    ...turn,
                    tools: turn.tools.map((tool) =>
                      tool.status === 'running' ? { ...tool, status: 'interrupted' } : tool,
                    ),
                  })),
                };
              }
              return item;
            }),
          );
          break;
        }
        case 'permission_mode': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.permissionMode = incoming.mode;
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          patchState({ permissionMode: incoming.mode });
          break;
        }
        case 'plan': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          const newDoc = upsertPlanDoc(
            incoming.plan,
            eventTaskId,
            incoming.markdown,
            incoming.requestSeq,
          );
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.planActive = incoming.active;
            data.plan = incoming.plan;
            data.planProgress = incoming.progress;
            if (newDoc) data.timeline = [...data.timeline, planDocCardItem(newDoc)];
            taskDataRef.current[eventTaskId] = data;
            // 初始化/刷新重连阶段（activeTaskId 尚未就绪）：plan 事件来自服务端
            // 当前激活的任务（服务端在 ready 之前推送），直接同步到全局状态，
            // 避免刷新后计划模式开关停留在 false（此后 task_list 不再触发切任务回放）。
            if (!stateRef.current.activeTaskId) {
              patchState({
                planActive: incoming.active,
                plan: incoming.plan,
                planProgress: incoming.progress,
              });
            }
            break;
          }
          patchState({
            planActive: incoming.active,
            plan: incoming.plan,
            planProgress: incoming.progress,
          });
          if (newDoc) updateTimeline((items) => [...items, planDocCardItem(newDoc)]);
          break;
        }
        case 'context_usage': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.contextUsage = incoming.usage;
            taskDataRef.current[eventTaskId] = data;
            // 初始化/刷新重连阶段（activeTaskId 尚未就绪）：事件来自服务端
            // 当前激活的任务，直接同步到全局状态，避免刷新后已使用的上下文
            // 用量停留在 0/undefined（此后没有其他事件会再纠正它）。
            if (!stateRef.current.activeTaskId) {
              patchState({ contextUsage: incoming.usage });
            }
            break;
          }
          patchState({ contextUsage: incoming.usage });
          break;
        }
        case 'notice':
          messageApi.info(incoming.message);
          break;
        case 'error': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          setCompressing(false);
          setContextCompacting(false);
          messageApi.error(incoming.message);
          if (
            incoming.code === 'AGENT_ERROR' &&
            (!eventTaskId || eventTaskId === stateRef.current.activeTaskId)
          ) {
            appendMessage('system', incoming.message, { error: true });
          }
          patchState({
            creatingProject: false,
            creatingTask: false,
          });
          break;
        }
        case 'pong':
          break;
      }
    },
    [
      appendMessage,
      flushQueuedMessages,
      messageApi,
      nextId,
      patchState,
      replaceTimeline,
      send,
      updateTimeline,
      upsertPlanDoc,
      switchTaskView,
      updateUnreadTasks,
      updateWaitingActionTasks,
    ],
  );

  // Keep the latest handler in a ref so the connect effect never re-runs
  // when the handler identity changes (would close/reopen the socket).
  const handleServerMessageRef = useRef(handleServerMessage);
  handleServerMessageRef.current = handleServerMessage;

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (disposed) return;
      patchState({ connection: 'connecting' });
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const pageParams = new URLSearchParams(location.search);
      const token =
        pageParams.get('token') ?? sessionStorage.getItem('personal-agent-token') ?? undefined;
      if (token) {
        sessionStorage.setItem('personal-agent-token', token);
        if (pageParams.has('token')) {
          history.replaceState(null, '', `${location.pathname}${location.hash}`);
        }
      }
      const socketParams = new URLSearchParams();
      if (token) socketParams.set('token', token);
      const preferredTask = localStorage.getItem('personal-agent-active-task');
      if (preferredTask) socketParams.set('task', preferredTask);
      const query = socketParams.size ? `?${socketParams}` : '';
      const socket = new WebSocket(`${protocol}//${location.host}/ws${query}`);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        reconnectAttemptsRef.current = 0;
        patchState({
          connected: true,
          connection: 'online',
        });
      });
      socket.addEventListener('message', (event) => {
        try {
          handleServerMessageRef.current(JSON.parse(String(event.data)) as ServerMessage);
        } catch (error) {
          messageApi.error(
            `无法处理服务端消息：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
      socket.addEventListener('close', () => {
        if (socketRef.current === socket) socketRef.current = null;
        patchState({
          connected: false,
          connection: 'offline',
          busy: false,
          pendingPermission: undefined,
          pendingQuestion: undefined,
          creatingProject: false,
          creatingTask: false,
        });
        if (disposed) return;
        const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 12_000);
        reconnectAttemptsRef.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      });
      socket.addEventListener('error', () => {
        patchState({ connection: 'offline' });
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [messageApi, patchState]);

  useLayoutEffect(() => {
    if (!followOutputRef.current) return;
    const element = transcriptRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    setShowScrollButton(false);
  }, [timeline]);

  useEffect(() => {
    updateActiveTurnId();
  }, [timeline, updateActiveTurnId]);

  // 导航悬浮位置：left 是相对 .pa-content 的偏移，而 content 左缘紧贴侧边栏右缘，
  // 因此动态测量「content 左缘 − 侧边栏右缘」的间距，再叠加约 30px 贴近菜单栏。
  useLayoutEffect(() => {
    const sidebar = document.querySelector<HTMLElement>('.pa-sidebar');
    const content = document.querySelector<HTMLElement>('.pa-content');
    if (!sidebar || !content) return;
    const gap = content.getBoundingClientRect().left - sidebar.getBoundingClientRect().right;
    setTurnNavLeft(Math.round(gap) + 30);
  }, [desktop]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        createNewTask();
      }
      if (event.key === 'Escape' && stateRef.current.inspectorOpen) {
        patchState({ inspectorOpen: false });
      }
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  });

  const activeProject = state.projects.find((project) => project.id === state.activeProjectId);
  const activeTask = state.tasks.find((task) => task.id === state.activeTaskId);
  const rootPath = activeProject?.rootPath ?? state.runtime?.workingDirectory ?? '当前工作区';
  const workspaceTitle = draftTaskProjectId
    ? '新任务'
    : (activeTask?.title ?? activeProject?.name ?? lastPathSegment(rootPath) ?? 'personal-agent');
  const composerEnabled = state.connected && state.configured;
  const runtimeDisabled =
    !composerEnabled || state.busy || state.creatingTask || state.switchingRuntime;
  const activeRuntimeModel = findRuntimeModel(
    state.runtime,
    state.runtime?.provider,
    state.runtime?.model,
  );
  const runtimeModelValue =
    state.runtime?.provider && state.runtime.model
      ? runtimeModelSelectValue(state.runtime.provider, state.runtime.model)
      : undefined;
  /** Active model of the current task ('provider:model'), undefined = inherit global. */
  const activeTaskModel = state.tasks.find((task) => task.id === state.activeTaskId)?.model;
  /** Task model as a dropdown option value (JSON '[provider,model]'). Falls back to the global default. */
  const taskModelOptionValue = (() => {
    // 新建任务草稿：优先显示草稿中已选的模型（任务创建后再应用）。
    const draftModel = pendingTaskDraftRef.current?.taskModel;
    if (draftModel) {
      return runtimeModelSelectValue(draftModel.provider, draftModel.model);
    }
    if (activeTaskModel) {
      const separator = activeTaskModel.indexOf(':');
      if (separator > 0) {
        return runtimeModelSelectValue(
          activeTaskModel.slice(0, separator),
          activeTaskModel.slice(separator + 1),
        );
      }
    }
    // No per-task override: show the global default model.
    if (state.runtime?.provider && state.runtime.model) {
      return runtimeModelSelectValue(state.runtime.provider, state.runtime.model);
    }
    return '';
  })();
  const runtimeModels = buildRuntimeModelGroups(state.runtime);
  const runtimeReasoningOptions: ReasoningEffort[] =
    activeRuntimeModel?.reasoningOptions ??
    (state.runtime?.reasoningSupported ? ['off', 'low', 'high', 'max'] : ['off']);

  function createNewTask(projectId?: string) {
    if (stateRef.current.creatingTask) return;
    const targetProjectId = projectId ?? stateRef.current.activeProjectId;
    if (!targetProjectId) {
      messageApi.error('请先创建一个项目');
      return;
    }
    pendingTaskDraftRef.current = { projectId: targetProjectId };
    setDraftTaskProjectId(targetProjectId);
    setPrompt('');
    // Preserve the current task's view and show an empty draft view.
    switchTaskView(undefined);
    setShowScrollButton(false);
    patchState({
      activeProjectId: targetProjectId,
      activeTaskId: undefined,
      creatingTask: false,
      sidebarOpen: false,
    });
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('#prompt-input')?.focus(),
    );
  }

  function changeTaskModel(value: string) {
    const selection = parseRuntimeModelSelectValue(value);
    if (!selection) return;
    const draft = pendingTaskDraftRef.current;
    if (draft) {
      // 新建任务草稿：任务还不存在，先记住模型选择，任务创建后随 prompt 应用。
      // 换了模型后清掉草稿中旧的思考强度（档位跟随新模型默认档）。
      pendingTaskDraftRef.current = { ...draft, taskModel: selection, reasoningEffort: undefined };
      patchState({});
      return;
    }
    const taskId = stateRef.current.activeTaskId;
    if (!taskId) return;
    send({
      type: 'set_task_model',
      taskId,
      providerId: selection.provider,
      model: selection.model,
    });
  }

  function submitPrompt(value = prompt.trim(), images = promptImages) {
    const text = value.trim();
    const hasDraft = Boolean(pendingTaskDraftRef.current);
    if (
      (!text && images.length === 0) ||
      !stateRef.current.connected ||
      !stateRef.current.configured ||
      stateRef.current.creatingTask
    ) {
      return;
    }
    if (images.length > 0) {
      const selectedModel = parseRuntimeModelSelectValue(taskModelOptionValue);
      const modelInfo = findRuntimeModel(
        stateRef.current.runtime,
        selectedModel?.provider,
        selectedModel?.model,
      );
      if (!modelInfo?.imageInputSupported && !stateRef.current.runtime?.visionReady) {
        messageApi.warning(
          '当前模型不支持图片输入，请先在“设置 → 通用 → 视觉模型”中启用并配置视觉模型。',
        );
        return;
      }
    }
    // 任务执行中：不直接发送，消息进入排队队列（当前任务结束后自动按序执行，
    // 也可在输入框上方的队列浮窗中手动「插入」到当前执行循环）。
    if (!hasDraft && stateRef.current.busy) {
      if (images.length > 0) {
        messageApi.warning('任务执行中暂不支持图片排队，请等待当前任务完成后再发送。');
        return;
      }
      enqueueQueuedMessage(text);
      return;
    }
    setModelCalls([]);
    setSelectedModelCallId(undefined);
    const pendingTaskDraft = pendingTaskDraftRef.current;
    if (pendingTaskDraft) {
      pendingTaskDraftRef.current = { ...pendingTaskDraft, prompt: text, images };
      patchState({ creatingTask: true });
      if (
        !send({
          type: 'create_task',
          projectId: pendingTaskDraft.projectId,
          permissionMode: pendingTaskDraft.permissionMode,
        })
      ) {
        pendingTaskDraftRef.current = pendingTaskDraft;
        patchState({ creatingTask: false });
      }
      return;
    }
    followOutputRef.current = true;
    appendMessage('user', text, { images: promptImagesForTimeline(images) });
    if (send({ type: 'prompt', text, images, taskId: stateRef.current.activeTaskId })) {
      setPrompt('');
      setPromptImages([]);
    }
  }

  function discardTaskDraft() {
    pendingTaskDraftRef.current = undefined;
    setDraftTaskProjectId(undefined);
    patchState({ creatingTask: false });
  }

  function answerPermission(approved: boolean) {
    const pending = stateRef.current.pendingPermission;
    if (!pending) return;
    const taskId = pending.taskId ?? stateRef.current.activeTaskId;
    if (
      !send({
        type: 'permission_response',
        requestId: pending.requestId,
        approved,
        remember: rememberPermission,
        taskId,
      })
    ) {
      return;
    }
    if (taskId) {
      updateWaitingActionTasks((current) => removeTaskMarker(current, taskId));
    }
    patchState({ pendingPermission: undefined });
    setRememberPermission(false);
  }

  function answerQuestion(answer: UserAnswer) {
    const pending = stateRef.current.pendingQuestion;
    if (!pending) return;
    const taskId = pending.taskId ?? stateRef.current.activeTaskId;
    if (
      !send({
        type: 'ask_user_response',
        requestId: pending.requestId,
        answer,
        taskId,
      })
    ) {
      return;
    }
    if (taskId) {
      updateWaitingActionTasks((current) => removeTaskMarker(current, taskId));
    }
    patchState({ pendingQuestion: undefined });
  }

  function startTaskRename(task: TaskSummary) {
    setRenamingTaskId(task.id);
    setRenameTitle(task.title);
  }

  function saveTaskRename(taskId: string) {
    const title = renameTitle.trim();
    if (!title) return;
    send({ type: 'rename_task', taskId, title });
  }

  function archiveTask(task: TaskSummary) {
    modal.confirm({
      title: '归档任务',
      content: `确定归档“${task.title}”吗？会话文件不会被删除。`,
      okText: '归档',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => {
        send({ type: 'archive_task', taskId: task.id });
      },
    });
  }

  function archiveProject(project: ProjectSummary) {
    modal.confirm({
      title: '归档项目',
      content: `确定归档“${project.name}”吗？项目及其任务会保留，可随时恢复。`,
      okText: '归档',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => {
        send({ type: 'archive_project', projectId: project.id });
      },
    });
  }

  function deleteProject(project: ProjectSummary) {
    modal.confirm({
      title: '删除项目',
      content: `确定彻底删除“${project.name}”吗？该项目的所有任务记录会被一并删除，且无法恢复。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => {
        send({ type: 'delete_project', projectId: project.id });
      },
    });
  }

  function startProjectRename(project: ProjectSummary) {
    setRenamingProjectId(project.id);
    setRenameProjectName(project.name);
  }

  function saveProjectRename(projectId: string) {
    const name = renameProjectName.trim();
    if (!name) return;
    send({ type: 'rename_project', projectId, name });
    setRenamingProjectId(undefined);
  }

  async function openProviderSettings(tab: 'providers' | 'general' = 'general') {
    // 防御：React onClick 可能把 MouseEvent 误传为 tab，非法值回退到通用
    const targetTab: 'providers' | 'general' = tab === 'providers' ? 'providers' : 'general';
    setProviderModalOpen(true);
    setSettingsTab(targetTab);
    setProviderLoading(true);
    try {
      const response = await apiFetch('/api/provider-settings');
      const data = (await response.json()) as ProviderSettingsInfo & {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || '读取 Provider 配置失败');
      setProviderSettings(data);
      const configuredProviders = getConfiguredProviders(data);
      if (configuredProviders.length) {
        setProviderView('list');
        hydrateProviderForm(data.active ?? configuredProviders[0], data);
      } else {
        setProviderView('form');
        hydrateProviderForm('openai', data);
      }
    } catch (error) {
      messageApi.error(formatError(error));
    } finally {
      setProviderLoading(false);
    }
  }

  function hydrateProviderForm(provider: ProviderId, settings = providerSettings) {
    const values = settings?.providers[provider];
    if (!values) return;
    providerForm.setFieldsValue({
      provider,
      apiKey: '',
      baseURL: values.baseURL,
      defaultModel: values.defaultModel,
      models: modelConfigListToRows(values.models),
      thinkingEffort: values.thinkingEffort,
    });
  }

  async function saveProvider(values: ProviderFormValues) {
    if (providerSaving) return;
    setProviderSaving(true);
    try {
      const response = await apiFetch('/api/provider-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          activate: false,
          apiKey: values.apiKey ?? '',
          models: parseModelRows(values.models),
        }),
      });
      const data = (await response.json()) as {
        runtime: RuntimeInfo;
        settings: ProviderSettingsInfo;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || '保存 Provider 配置失败');
      setProviderSettings(data.settings);
      setProviderView('list');
      patchState({
        runtime: data.runtime,
        configured: data.runtime.configured,
      });
      messageApi.success(`${providerLabels[values.provider]} 配置已保存`);
    } catch (error) {
      messageApi.error(formatError(error));
    } finally {
      setProviderSaving(false);
    }
  }

  function editProvider(provider: ProviderId) {
    hydrateProviderForm(provider, providerSettings);
    setProviderView('form');
  }

  function addProvider() {
    const provider =
      (Object.keys(providerLabels) as ProviderId[]).find(
        (id) => !providerSettings?.providers[id].configured,
      ) ?? 'openai';
    hydrateProviderForm(provider, providerSettings);
    setProviderView('form');
  }

  function deleteProvider(provider: ProviderId) {
    modal.confirm({
      title: `删除 ${providerLabels[provider]} 配置`,
      content: '确定删除这个模型供应商吗？本机配置中的密钥和模型信息也会被移除。',
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setProviderDeleting(provider);
        try {
          const response = await apiFetch(`/api/provider-settings/${provider}`, {
            method: 'DELETE',
          });
          const data = (await response.json()) as {
            runtime: RuntimeInfo;
            settings: ProviderSettingsInfo;
            error?: string;
          };
          if (!response.ok) throw new Error(data.error || '删除模型供应商失败');
          setProviderSettings(data.settings);
          patchState({ runtime: data.runtime, configured: data.runtime.configured });
          if (!getConfiguredProviders(data.settings).length) {
            setProviderView('form');
            hydrateProviderForm('openai', data.settings);
          }
          messageApi.success(`${providerLabels[provider]} 配置已删除`);
        } catch (error) {
          messageApi.error(formatError(error));
          throw error;
        } finally {
          setProviderDeleting(undefined);
        }
      },
    });
  }

  function confirmCompressContext() {
    modal.confirm({
      title: '压缩上下文',
      content:
        '将把早期对话替换为 LLM 生成的语义摘要，保留最近 6 轮消息。压缩不可撤销，确定继续吗？',
      okText: '压缩',
      cancelText: '取消',
      onOk: () => {
        setCompressing(true);
        send({ type: 'compress_context', taskId: stateRef.current.activeTaskId });
      },
    });
  }

  async function saveRuntimeSelection(
    provider: string,
    model: string,
    reasoningEffort: ReasoningEffort,
  ) {
    if (stateRef.current.switchingRuntime || !stateRef.current.runtime) return;
    patchState({ switchingRuntime: true });
    try {
      const response = await apiFetch('/api/runtime/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model, reasoningEffort }),
      });
      const data = (await response.json()) as {
        runtime: RuntimeInfo;
        error?: string;
      };
      if (!response.ok) throw new Error(data.error || '切换模型失败');
      patchState({ runtime: data.runtime, configured: data.runtime.configured });
      messageApi.success(
        `已切换至 ${data.runtime.model}${
          data.runtime.reasoningSupported ? ` · 思考 ${data.runtime.reasoningEffort}` : ''
        }`,
      );
    } catch (error) {
      messageApi.error(formatError(error));
    } finally {
      patchState({ switchingRuntime: false });
    }
  }

  async function createProject(values: ProjectFormValues) {
    patchState({ creatingProject: true });
    if (
      !send({
        type: 'create_project',
        name: values.name.trim(),
        rootPath: values.rootPath.trim(),
      })
    ) {
      patchState({ creatingProject: false });
    }
  }

  async function openDirectoryPicker() {
    const initialDirectory = projectForm.getFieldValue('rootPath')?.trim() || undefined;
    const desktopApi = window.personalAgentDesktop;
    if (desktopApi && typeof desktopApi.selectDirectory === 'function') {
      try {
        const directory = await desktopApi.selectDirectory(initialDirectory);
        // 诊断日志：确认桌面端选择器实际返回的内容
        console.log('[directory-picker] desktop returned:', typeof directory, directory);
        if (typeof directory === 'string' && directory.trim()) {
          projectForm.setFieldValue('rootPath', directory);
          await projectForm.validateFields(['rootPath']);
          return;
        }
        // 未返回有效路径（取消/异常）：提示并回退到 Web 目录树，避免静默失败
        messageApi.info(`未获得有效目录（返回类型 ${typeof directory}），已打开目录树选择器`);
      } catch (error) {
        messageApi.error(`目录选择失败：${formatError(error)}，已改用目录树选择`);
      }
      setDirectoryPickerOpen(true);
      setSelectedDirectory(initialDirectory);
      if (directoryTreeData.length === 0) {
        await loadDirectoryChildren();
      }
      return;
    }

    if (desktopApi === undefined) {
      // 诊断日志：确认桌面 preload 是否注入
      console.log('[directory-picker] personalAgentDesktop unavailable, using tree picker');
    }
    setDirectoryPickerOpen(true);
    setSelectedDirectory(initialDirectory);
    if (directoryTreeData.length === 0) {
      await loadDirectoryChildren();
    }
  }

  async function loadDirectoryChildren(path?: string): Promise<void> {
    setDirectoryPickerLoading(path === undefined);
    try {
      const response = await fetchDirectoryChildren(path);
      const children = response.entries.map(directoryEntryToNode);
      if (path) {
        setDirectoryTreeData((nodes) => updateDirectoryTreeChildren(nodes, path, children));
      } else {
        setDirectoryTreeData(children);
      }
    } catch (error) {
      messageApi.error(formatError(error));
    } finally {
      setDirectoryPickerLoading(false);
    }
  }

  function selectDirectory(path: string) {
    setSelectedDirectory(path);
  }

  function applyDirectorySelection() {
    if (!selectedDirectory) return;
    projectForm.setFieldValue('rootPath', selectedDirectory);
    void projectForm.validateFields(['rootPath']);
    setDirectoryPickerOpen(false);
  }

  function scrollToLatest() {
    followOutputRef.current = true;
    const element = transcriptRef.current;
    element?.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    setShowScrollButton(false);
  }

  const sidebarContent = (
    <SidebarContent
      projects={state.projects}
      tasks={state.tasks}
      activeProjectId={state.activeProjectId}
      activeTaskId={state.activeTaskId}
      unreadTaskIds={unreadTaskIds}
      waitingActionTaskIds={waitingActionTaskIds}
      busy={state.creatingTask}
      creatingTask={state.creatingTask}
      renamingTaskId={renamingTaskId}
      renameTitle={renameTitle}
      renamingProjectId={renamingProjectId}
      renameProjectName={renameProjectName}
      showArchived={showArchived}
      onToggleArchived={() => setShowArchived((current) => !current)}
      collapsedProjects={collapsedProjects}
      onToggleProjectCollapse={(projectId) =>
        setCollapsedProjects((current) => toggleId(current, projectId))
      }
      onProjectChange={(projectId) => {
        discardTaskDraft();
        // 切换到项目时自动展开其任务
        setCollapsedProjects((current) => {
          const next = new Set(current);
          next.delete(projectId);
          return next;
        });
        send({ type: 'select_project', projectId });
      }}
      onCreateProject={() => {
        discardTaskDraft();
        setSelectedDirectory(undefined);
        setProjectModalOpen(true);
      }}
      onCreateTask={createNewTask}
      onRefresh={refreshProjectsAndTasks}
      refreshing={refreshingProjects}
      onOpenTask={openTask}
      onStartRename={startTaskRename}
      onRenameTitleChange={setRenameTitle}
      onSaveRename={saveTaskRename}
      onCancelRename={() => setRenamingTaskId(undefined)}
      onArchiveTask={archiveTask}
      onStartProjectRename={startProjectRename}
      onRenameProjectNameChange={setRenameProjectName}
      onSaveProjectRename={saveProjectRename}
      onCancelProjectRename={() => setRenamingProjectId(undefined)}
      onArchiveProject={archiveProject}
      onRestoreProject={(projectId) => send({ type: 'restore_project', projectId })}
      onDeleteProject={deleteProject}
      onSetProjectPinned={(projectId, pinned) =>
        send({ type: 'set_project_pinned', projectId, pinned })
      }
      onReorderProjects={(projectIds, pinned) =>
        send({ type: 'reorder_projects', projectIds, pinned })
      }
      onOpenSettings={openProviderSettings}
      version={appVersion}
    />
  );

  const selectedProviderSettings =
    selectedProvider && providerSettings ? providerSettings.providers[selectedProvider] : undefined;
  const providerModelOptions = providerModels
    .map((row) => row?.id?.trim())
    .filter(Boolean)
    .map((model) => ({ value: model as string }));
  const configuredProviders = getConfiguredProviders(providerSettings);
  const availableProviders = (Object.keys(providerLabels) as ProviderId[]).filter(
    (provider) => !providerSettings?.providers[provider].configured,
  );
  /** 右侧侧边栏面板：「概要」固定，其余为可关闭的计划文档或文件差异 Tab。 */
  const inspectorPanel = (
    <div className="pa-right-sidebar-panel">
      <Tabs
        type="editable-card"
        hideAdd
        size="small"
        activeKey={activeInspectorTab}
        onChange={setActiveInspectorTab}
        onEdit={(key, action) => {
          if (action === 'remove' && typeof key === 'string') removeInspectorTab(key);
        }}
        items={inspectorTabs.map((tab) => ({
          key: tab.key,
          closable: tab.kind !== 'overview',
          label:
            tab.kind === 'overview' ? (
              '概要'
            ) : (
              <span className="pa-doc-tab-label" title={tab.title}>
                {tab.kind === 'plan-doc' ? <FileTextOutlined /> : <DiffOutlined />}
                <span>{tab.title}</span>
              </span>
            ),
          children:
            tab.kind === 'overview' ? (
              <Inspector
                state={state}
                activeProject={activeProject}
                activeTask={activeTask}
                rootPath={rootPath}
                onApprovePlan={() =>
                  send({ type: 'approve_plan', taskId: stateRef.current.activeTaskId })
                }
              />
            ) : tab.kind === 'plan-doc' ? (
              <PlanDocViewer doc={planDocs[tab.docId]} />
            ) : (
              <FileDiffViewer change={fileChanges[tab.changeId]} />
            ),
        }))}
      />
    </div>
  );

  return (
    <Layout className="pa-shell" data-testid="personal-agent-app">
      {desktop ? (
        <Sider width={280} className="pa-sidebar">
          {sidebarContent}
        </Sider>
      ) : (
        <Drawer
          placement="left"
          size={280}
          open={state.sidebarOpen}
          onClose={() => patchState({ sidebarOpen: false })}
          closeIcon={false}
          className="pa-mobile-sidebar"
        >
          {sidebarContent}
        </Drawer>
      )}

      <Layout className="pa-workspace">
        <Header className="pa-header">
          <Space size={10} className="pa-header-title">
            {!desktop && (
              <Button
                type="text"
                icon={<MenuUnfoldOutlined />}
                aria-label="打开任务侧栏"
                onClick={() => patchState({ sidebarOpen: true })}
              />
            )}
            <div>
              <span className="pa-eyebrow">WORKSPACE</span>
              <strong title={workspaceTitle}>{workspaceTitle}</strong>
            </div>
          </Space>
          <Space size={8} className="pa-header-actions">
            <Tag
              icon={state.connection === 'connecting' ? <Spin size="small" /> : undefined}
              color={
                state.connection === 'online'
                  ? 'success'
                  : state.connection === 'offline'
                    ? 'error'
                    : 'default'
              }
              className="pa-connection-tag"
            >
              {state.connection === 'online'
                ? '本地已连接'
                : state.connection === 'offline'
                  ? '连接已断开'
                  : '连接中'}
            </Tag>
            <Tooltip title={colorMode === 'light' ? '切换到深色主题' : '切换到浅色主题'}>
              <Button
                icon={colorMode === 'light' ? <SunOutlined /> : <MoonOutlined />}
                onClick={onToggleColorMode}
                data-testid="theme-toggle"
              >
                <span className="pa-button-label">{colorMode === 'light' ? '浅色' : '深色'}</span>
              </Button>
            </Tooltip>
            {window.personalAgentDesktop && (
              <Tooltip title="打开开发者工具（F12 亦可）">
                <Button
                  icon={<ExperimentOutlined />}
                  onClick={() => void window.personalAgentDesktop?.toggleDevTools()}
                  aria-label="打开开发者工具"
                />
              </Tooltip>
            )}
            <Tooltip title="模型调用调试">
              <Badge count={modelCalls.length} size="small" overflowCount={99}>
                <Button
                  icon={<BugOutlined />}
                  onClick={() => setDebugModalOpen(true)}
                  aria-label="打开模型调用调试"
                />
              </Badge>
            </Tooltip>
            <Tooltip title="模型统计">
              <Button
                icon={<BarChartOutlined />}
                onClick={() => setStatsModalOpen(true)}
                aria-label="打开模型统计"
              />
            </Tooltip>
            <Tooltip title="侧边栏">
              <Button
                icon={<MenuUnfoldOutlined />}
                onClick={() => patchState({ inspectorOpen: !stateRef.current.inspectorOpen })}
                aria-label="侧边栏"
              />
            </Tooltip>
          </Space>
        </Header>

        <Content className="pa-content">
          {!state.configured && state.runtime && (
            <Alert
              className="pa-config-alert"
              type="warning"
              showIcon
              title="还需要配置模型"
              description={
                state.runtime.initializationError || '选择 Provider、模型并保存后即可开始对话。'
              }
              action={
                <Button size="small" onClick={() => openProviderSettings('providers')}>
                  立即配置
                </Button>
              }
            />
          )}

          {desktop && userTurns.length > 0 && (
            <TurnNavigation
              turns={userTurns}
              activeId={activeTurnId}
              onSelect={scrollToTurn}
              left={turnNavLeft}
            />
          )}

          <div
            className="pa-transcript"
            ref={transcriptRef}
            aria-live="polite"
            onScroll={(event) => {
              const element = event.currentTarget;
              const nearBottom =
                element.scrollHeight - element.scrollTop - element.clientHeight < 72;
              followOutputRef.current = nearBottom;
              setShowScrollButton(!nearBottom);
              updateActiveTurnId();
            }}
          >
            <div className="pa-transcript-inner">
              {timeline.length === 0 ? (
                <Welcome onSelectPrompt={submitPrompt} prompts={starterItems} />
              ) : (
                timeline.map((item) => {
                  // 计划文档 / 修改文件卡片吸附进所属 assistant 消息的
                  // .pa-message-content 内部末尾（plan 在前、run-changes 在后）；
                  // 无归属 assistant 的卡片（异常数据）独立渲染兜底。
                  if (
                    (item.kind === 'plan-doc' || item.kind === 'run-changes') &&
                    attachedCardIds.has(item.id)
                  ) {
                    return null;
                  }
                  return (
                    <TimelineEntry
                      key={item.id}
                      item={item}
                      cards={item.kind === 'message' ? assistantCards.get(item.id) : undefined}
                      planDocs={planDocs}
                      fileChanges={fileChanges}
                      onMessageElement={registerMessageElement}
                      onOpenPlanDoc={openPlanDocTab}
                      onOpenFileDiff={openFileDiffTab}
                    />
                  );
                })
              )}
              {contextCompacting && (
                <div className="pa-compacting-hint" role="status">
                  <LoadingOutlined spin /> 正在压缩上下文...
                </div>
              )}
            </div>
          </div>

          <Composer
            showScrollButton={showScrollButton}
            onScrollToLatest={scrollToLatest}
            prompt={prompt}
            images={promptImages}
            enabled={composerEnabled}
            skills={availableSkills}
            busy={state.busy}
            creatingTask={state.creatingTask}
            planActive={state.planActive}
            contextUsage={state.contextUsage}
            compressing={compressing}
            permissionMode={state.permissionMode}
            pendingPermission={state.pendingPermission}
            pendingTitle={
              state.pendingPermission
                ? (state.tasks.find((task) => task.id === state.pendingPermission?.taskId)?.title ??
                  '任务')
                : undefined
            }
            pendingQuestion={state.pendingQuestion}
            pendingQuestionTitle={
              state.pendingQuestion
                ? (state.tasks.find((task) => task.id === state.pendingQuestion?.taskId)?.title ??
                  '任务')
                : undefined
            }
            rememberPermission={rememberPermission}
            runtime={state.runtime}
            runtimeModelValue={runtimeModelValue}
            taskModelValue={taskModelOptionValue}
            taskReasoningEffort={
              // 草稿（新建任务）：显示草稿中已选的思考强度；否则显示任务当前生效档位。
              pendingTaskDraftRef.current?.reasoningEffort ??
              state.tasks.find((task) => task.id === state.activeTaskId)?.reasoningEffort
            }
            runtimeModels={runtimeModels}
            onTaskModelChange={changeTaskModel}
            runtimeReasoningOptions={runtimeReasoningOptions}
            runtimeDisabled={runtimeDisabled}
            queuedMessages={queuedMessages}
            onPromptChange={setPrompt}
            onImagesChange={setPromptImages}
            onSubmit={submitPrompt}
            onRemoveQueued={removeQueuedMessage}
            onInjectQueued={injectQueuedMessage}
            onStop={() => send({ type: 'interrupt', taskId: stateRef.current.activeTaskId })}
            onAnswerPermission={answerPermission}
            onAnswerQuestion={answerQuestion}
            onRememberPermissionChange={setRememberPermission}
            onPlanModeChange={(enabled) => {
              const draft = pendingTaskDraftRef.current;
              if (draft) {
                // 新建任务草稿：任务还不存在，不能发 set_plan_mode
                // （否则会误改当前激活任务）。本地切换 UI 并把选择记进
                // 草稿，任务创建后随 prompt 一起应用。
                pendingTaskDraftRef.current = { ...draft, planMode: enabled };
                patchState({ planActive: enabled });
                return;
              }
              send({ type: 'set_plan_mode', enabled, taskId: stateRef.current.activeTaskId });
            }}
            onCompressContext={confirmCompressContext}
            onPermissionModeChange={(mode) => {
              const draft = pendingTaskDraftRef.current;
              if (draft) {
                // 新建任务草稿：任务还不存在，不能发 set_permission_mode
                // （否则会误改当前激活任务）。把权限记在草稿里，随 create_task
                // 一起提交，任务创建后由 task_changed 回写。
                pendingTaskDraftRef.current = { ...draft, permissionMode: mode };
                patchState({ permissionMode: mode });
                return;
              }
              patchState({ permissionMode: mode });
              send({
                type: 'set_permission_mode',
                mode,
                taskId: stateRef.current.activeTaskId,
              });
            }}
            onModelChange={(value) => {
              const selection = parseRuntimeModelSelectValue(value);
              if (!selection) return;
              const modelInfo = findRuntimeModel(
                state.runtime,
                selection.provider,
                selection.model,
              );
              saveRuntimeSelection(
                selection.provider,
                selection.model,
                modelInfo?.reasoningEffort ?? 'off',
              );
            }}
            onReasoningChange={(reasoningEffort) => {
              // 新建任务草稿：任务还不存在，把思考强度（连同生效模型）记进草稿，
              // 任务创建后随 set_task_model 一起应用——绝不能改写全局运行时
              // （否则会把全局模型/档位改成 deepseek-v4-flash 之类）。
              const draft = pendingTaskDraftRef.current;
              if (draft) {
                const selection = parseRuntimeModelSelectValue(taskModelOptionValue);
                if (selection) {
                  pendingTaskDraftRef.current = {
                    ...draft,
                    taskModel: selection,
                    reasoningEffort,
                  };
                  patchState({});
                }
                return;
              }
              // 输入框属于当前任务：思考强度修改作用于该任务（任务级覆盖，
              // set_task_model 带档位）。模型继承全局时同样按任务生效——
              // 对 Ollama 而言全局保存不落地（档位按模型配置），必须走任务。
              const taskId = stateRef.current.activeTaskId;
              if (taskId) {
                const selection = parseRuntimeModelSelectValue(taskModelOptionValue);
                if (selection) {
                  send({
                    type: 'set_task_model',
                    taskId,
                    providerId: selection.provider,
                    model: selection.model,
                    reasoningEffort,
                  });
                  return;
                }
              }
              if (!state.runtime?.provider || !state.runtime.model) return;
              saveRuntimeSelection(state.runtime.provider, state.runtime.model, reasoningEffort);
            }}
          />
        </Content>
      </Layout>

      {desktop ? (
        <aside
          className="pa-right-sidebar"
          style={{ width: state.inspectorOpen ? inspectorWidth : 0 }}
        >
          {state.inspectorOpen && (
            <>
              <div className="pa-right-resizer" onPointerDown={startResize} />
              {inspectorPanel}
            </>
          )}
        </aside>
      ) : (
        <Drawer
          placement="right"
          size={Math.min(inspectorWidth, Math.round(window.innerWidth * 0.92))}
          open={state.inspectorOpen}
          onClose={() => patchState({ inspectorOpen: false })}
          className="pa-inspector pa-inspector-drawer"
        >
          {inspectorPanel}
        </Drawer>
      )}

      <StatsModal open={statsModalOpen} onClose={() => setStatsModalOpen(false)} />
      <ModelDebugModal
        open={debugModalOpen}
        calls={modelCalls}
        selectedCallId={selectedModelCallId}
        onSelectCall={setSelectedModelCallId}
        onClose={() => setDebugModalOpen(false)}
      />

      <Modal
        title="创建项目"
        open={projectModalOpen}
        onCancel={() => {
          setProjectModalOpen(false);
          patchState({ creatingProject: false });
        }}
        footer={null}
        destroyOnHidden
        afterOpenChange={(open) => {
          if (open) projectForm.resetFields();
        }}
      >
        <Text type="secondary">
          每个项目对应一个本地根目录，Agent 的文件和命令操作会限制在该工作区中。
        </Text>
        <Form
          form={projectForm}
          layout="vertical"
          className="pa-modal-form"
          onFinish={createProject}
        >
          <Form.Item
            name="name"
            label="项目名称"
            rules={[{ required: true, whitespace: true, message: '请输入项目名称' }]}
          >
            <Input autoFocus placeholder="例如：personal-agent" />
          </Form.Item>
          <div className="pa-root-path-row">
            <Form.Item
              name="rootPath"
              label="本地根目录"
              rules={[{ required: true, whitespace: true, message: '请输入本地根目录' }]}
            >
              <Input placeholder="请选择本地根目录" />
            </Form.Item>
            <Button
              type="primary"
              icon={<FolderOpenOutlined />}
              onClick={() => {
                void openDirectoryPicker();
              }}
            >
              选择
            </Button>
          </div>
          <div className="pa-modal-actions">
            <Button onClick={() => setProjectModalOpen(false)}>取消</Button>
            <Button type="primary" htmlType="submit" loading={state.creatingProject}>
              创建项目
            </Button>
          </div>
        </Form>
      </Modal>

      <Modal
        title="选择本地根目录"
        open={directoryPickerOpen}
        width={680}
        okText="使用此目录"
        cancelText="取消"
        okButtonProps={{ disabled: !selectedDirectory }}
        onOk={applyDirectorySelection}
        onCancel={() => setDirectoryPickerOpen(false)}
      >
        <div className="pa-directory-picker">
          <div className="pa-directory-toolbar">
            <div>
              <span>已选择</span>
              <code title={selectedDirectory}>{selectedDirectory ?? '尚未选择目录'}</code>
            </div>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => {
                void loadDirectoryChildren();
              }}
            >
              刷新
            </Button>
          </div>
          <Spin spinning={directoryPickerLoading}>
            {directoryTreeData.length > 0 ? (
              <Tree
                showLine
                blockNode
                className="pa-directory-tree"
                treeData={directoryTreeData}
                selectedKeys={selectedDirectory ? [selectedDirectory] : []}
                loadData={(node) =>
                  node.children ? Promise.resolve() : loadDirectoryChildren(String(node.key))
                }
                onSelect={(_, info) => selectDirectory(String(info.node.key))}
                onDoubleClick={(_, node) => {
                  selectDirectory(String(node.key));
                  applyDirectorySelection();
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && selectedDirectory) {
                    applyDirectorySelection();
                  }
                }}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可浏览的目录" />
            )}
          </Spin>
        </div>
      </Modal>

      <Modal
        title="设置"
        data-testid="settings-dialog"
        open={providerModalOpen}
        onCancel={() => setProviderModalOpen(false)}
        footer={null}
        width={860}
        destroyOnHidden
        className="pa-settings-modal"
      >
        <div className="pa-settings-layout">
          <nav className="pa-settings-nav" aria-label="设置菜单">
            <Menu
              mode="inline"
              onClick={({ key }) =>
                setSettingsTab(key as 'providers' | 'general' | 'prompts' | 'skills')
              }
              selectedKeys={[settingsTab]}
              items={[
                {
                  key: 'general',
                  icon: <SettingOutlined />,
                  label: '通用',
                },
                {
                  key: 'skills',
                  icon: <BulbOutlined />,
                  label: '技能',
                },
                {
                  key: 'prompts',
                  icon: <FileTextOutlined />,
                  label: '系统内置提示词',
                },
                {
                  key: 'providers',
                  icon: <RobotOutlined />,
                  label: '模型提供商',
                },
              ]}
            />
          </nav>
          <Spin spinning={providerLoading} className="pa-settings-spin">
            {settingsTab === 'general' && (
              <section className="pa-settings-content">
                <GeneralSettingsPanel
                  colorMode={colorMode}
                  onToggleColorMode={onToggleColorMode}
                  accentColors={accentColors}
                  onAccentColorsChange={onAccentColorsChange}
                  onResetAccent={onResetAccent}
                  onRuntimeChange={(runtime) =>
                    patchState({ runtime, configured: runtime.configured })
                  }
                />
              </section>
            )}
            {settingsTab === 'skills' && (
              <section className="pa-settings-content">
                <SkillsPanel />
              </section>
            )}
            {settingsTab === 'prompts' && (
              <section className="pa-settings-content">
                <PromptsPanel onStarterPromptsChange={() => void reloadStarterPrompts()} />
              </section>
            )}
            <section
              className="pa-settings-content"
              style={settingsTab !== 'providers' ? { display: 'none' } : undefined}
            >
              <div className="pa-settings-heading">
                <div>
                  <Title level={4}>模型提供商</Title>
                  <Text type="secondary">
                    管理本机模型供应商配置，配置后可在对话输入框中切换模型。
                  </Text>
                </div>
                {providerView === 'list' && availableProviders.length > 0 && (
                  <Button type="primary" icon={<PlusOutlined />} onClick={addProvider}>
                    添加供应商
                  </Button>
                )}
              </div>

              {providerView === 'list' ? (
                configuredProviders.length ? (
                  <div className="pa-provider-list">
                    {configuredProviders.map((provider) => {
                      const info = providerSettings!.providers[provider];
                      return (
                        <Card key={provider} size="small" className="pa-provider-card">
                          <div className="pa-provider-card-main">
                            <Avatar
                              shape="square"
                              src={providerIcons[provider]}
                              icon={<RobotOutlined />}
                            />
                            <div>
                              <Space size={8}>
                                <strong>{providerLabels[provider]}</strong>
                              </Space>
                              <Text type="secondary">{info.defaultModel}</Text>
                            </div>
                          </div>
                          <Space>
                            <Button size="small" onClick={() => editProvider(provider)}>
                              编辑
                            </Button>
                            <Button
                              size="small"
                              danger
                              icon={<DeleteOutlined />}
                              loading={providerDeleting === provider}
                              onClick={() => deleteProvider(provider)}
                            >
                              删除
                            </Button>
                          </Space>
                        </Card>
                      );
                    })}
                  </div>
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置模型供应商">
                    <Button type="primary" icon={<PlusOutlined />} onClick={addProvider}>
                      选择供应商进行配置
                    </Button>
                  </Empty>
                )
              ) : (
                <Form
                  form={providerForm}
                  layout="vertical"
                  className="pa-provider-form"
                  onFinish={saveProvider}
                >
                  <div className="pa-provider-form-title">
                    <Button type="link" onClick={() => setProviderView('list')}>
                      返回列表
                    </Button>
                    <strong>
                      {selectedProviderSettings?.configured ? '编辑供应商' : '添加供应商'}
                    </strong>
                  </div>
                  <Form.Item name="provider" label="供应商">
                    <Select
                      disabled={Boolean(selectedProviderSettings?.configured)}
                      popupClassName="pa-provider-select-popup"
                      options={Object.entries(providerLabels).map(([value, label]) => ({
                        value,
                        label: (
                          <Space size={8} className="pa-provider-option">
                            {providerIcons[value as ProviderId] && (
                              <img
                                src={providerIcons[value as ProviderId]}
                                alt={label}
                                className="pa-provider-option-icon"
                              />
                            )}
                            <span>{label}</span>
                          </Space>
                        ),
                        disabled:
                          providerSettings?.providers[value as ProviderId].configured &&
                          value !== selectedProvider,
                      }))}
                      onChange={(provider: ProviderId) =>
                        hydrateProviderForm(provider, providerSettings)
                      }
                    />
                  </Form.Item>
                  {selectedProviderSettings?.requiresApiKey && (
                    <Form.Item
                      name="apiKey"
                      label="API Key"
                      extra={
                        selectedProviderSettings.hasApiKey
                          ? '已检测到密钥。留空会保留当前值，服务端不会回传密钥。'
                          : '密钥仅写入本机配置文件，不会回显。'
                      }
                      rules={[
                        {
                          required: !selectedProviderSettings.hasApiKey,
                          message: '请输入 API Key',
                        },
                      ]}
                    >
                      <Input.Password
                        autoComplete="new-password"
                        placeholder={
                          selectedProviderSettings.hasApiKey
                            ? '已配置；留空保持不变'
                            : '输入 API Key'
                        }
                      />
                    </Form.Item>
                  )}
                  <Form.Item name="baseURL" label="Base URL">
                    <Input placeholder="留空使用供应商默认地址" />
                  </Form.Item>
                  <Form.Item
                    name="defaultModel"
                    label="默认模型"
                    extra={
                      selectedProvider === 'lmstudio'
                        ? '填写 LM Studio 中加载的模型标识（可在 LM Studio 的模型面板复制）。'
                        : undefined
                    }
                    rules={[{ required: true, message: '请输入默认模型' }]}
                  >
                    <AutoComplete options={providerModelOptions} placeholder="模型 ID" />
                  </Form.Item>
                  <Form.Item
                    label="可选模型"
                    extra={
                      selectedProvider === 'ollama'
                        ? '为每个模型配置 token 限制与思考档位：勾选「思考档位」后，该模型才会开启思考，任务中会自动按模型显示可选强度；未勾选则完全不开启思考。视觉模型请开启“图片输入”。'
                        : selectedProvider === 'lmstudio'
                          ? '为每个模型配置 token 限制；视觉模型请开启“图片输入”，开启后可在通用设置中选作视觉模型。'
                          : '为每个模型配置总上下文长度与输出长度（单位 token）；留空使用内置默认值。'
                    }
                  >
                    <Form.List name="models">
                      {(fields, { add, remove }) => (
                        <div
                          className={`pa-model-list${
                            selectedProvider === 'ollama' || selectedProvider === 'lmstudio'
                              ? ' pa-model-list-ollama'
                              : ''
                          }`}
                        >
                          <div className="pa-model-list-head">
                            <span>模型 ID</span>
                            <span>上下文长度</span>
                            <span>输出长度</span>
                            {(selectedProvider === 'ollama' || selectedProvider === 'lmstudio') && (
                              <span>图片输入</span>
                            )}
                            {selectedProvider === 'ollama' && <span>思考档位</span>}
                            <span />
                          </div>
                          {fields.map((field) => (
                            <div key={field.key} className="pa-model-row">
                              <Form.Item
                                name={[field.name, 'id']}
                                rules={[
                                  { required: true, whitespace: true, message: '请输入模型 ID' },
                                ]}
                              >
                                <Input placeholder="模型 ID" />
                              </Form.Item>
                              <Form.Item name={[field.name, 'contextWindow']}>
                                <InputNumber
                                  min={1024}
                                  max={10_000_000}
                                  step={1000}
                                  placeholder="自动"
                                  style={{ width: '100%' }}
                                />
                              </Form.Item>
                              <Form.Item name={[field.name, 'maxOutputTokens']}>
                                <InputNumber
                                  min={1}
                                  max={10_000_000}
                                  step={500}
                                  placeholder="自动"
                                  style={{ width: '100%' }}
                                />
                              </Form.Item>
                              {(selectedProvider === 'ollama' ||
                                selectedProvider === 'lmstudio') && (
                                <Form.Item
                                  name={[field.name, 'imageInput']}
                                  valuePropName="checked"
                                >
                                  <Switch aria-label="支持图片输入" />
                                </Form.Item>
                              )}
                              {selectedProvider === 'ollama' && (
                                <Form.Item name={[field.name, 'reasoningOptions']}>
                                  <Select
                                    mode="multiple"
                                    allowClear
                                    placeholder="不开启思考"
                                    maxTagCount="responsive"
                                    aria-label="思考档位"
                                    options={getReasoningOptions([
                                      'off',
                                      'low',
                                      'medium',
                                      'high',
                                      'max',
                                      'xhigh',
                                    ])}
                                    style={{ width: '100%' }}
                                  />
                                </Form.Item>
                              )}
                              <Button
                                type="text"
                                danger
                                icon={<DeleteOutlined />}
                                aria-label="删除模型"
                                onClick={() => remove(field.name)}
                              />
                            </div>
                          ))}
                          <Button
                            type="dashed"
                            block
                            icon={<PlusOutlined />}
                            onClick={() =>
                              add({
                                id: '',
                                contextWindow: undefined,
                                maxOutputTokens: undefined,
                                imageInput: false,
                                reasoningOptions: undefined,
                              })
                            }
                          >
                            添加模型
                          </Button>
                        </div>
                      )}
                    </Form.List>
                  </Form.Item>
                  {(selectedProvider === 'deepseek' ||
                    selectedProvider === 'volcano' ||
                    selectedProvider === 'lmstudio') && (
                    <Form.Item
                      name="thinkingEffort"
                      label="默认思考强度"
                      extra={
                        selectedProvider === 'deepseek'
                          ? 'DeepSeek 支持 off / low / high / max；medium 不支持，将按 low 处理。'
                          : selectedProvider === 'lmstudio'
                            ? 'LM Studio 上 Qwen3 类模型支持 xhigh（默认）/ medium / low 三档思考强度，选择「关闭」可关闭思考模式。'
                            : '火山方舟仅深度思考模型（如 doubao-seed-thinking）支持思考，普通模型请选择「关闭」。'
                      }
                    >
                      <Select
                        options={getReasoningOptions(
                          selectedProvider === 'deepseek'
                            ? ['off', 'low', 'high', 'max']
                            : selectedProvider === 'lmstudio'
                              ? ['off', 'low', 'medium', 'xhigh']
                              : ['off', 'low', 'medium', 'high'],
                        )}
                      />
                    </Form.Item>
                  )}
                  <div className="pa-config-path">
                    <span>保存位置</span>
                    <code title={providerSettings?.configPath}>
                      {providerSettings?.configPath ?? '正在读取…'}
                    </code>
                  </div>
                  <div className="pa-modal-actions">
                    <Button onClick={() => setProviderView('list')}>取消</Button>
                    <Button type="primary" htmlType="submit" loading={providerSaving}>
                      保存配置
                    </Button>
                  </div>
                </Form>
              )}
            </section>
          </Spin>
        </div>
      </Modal>
    </Layout>
  );
}

function SidebarContent({
  projects,
  tasks,
  activeProjectId,
  activeTaskId,
  unreadTaskIds,
  waitingActionTaskIds,
  busy,
  creatingTask,
  renamingTaskId,
  renameTitle,
  renamingProjectId,
  renameProjectName,
  showArchived,
  collapsedProjects,
  onToggleArchived,
  onToggleProjectCollapse,
  onProjectChange,
  onCreateProject,
  onCreateTask,
  onRefresh,
  refreshing,
  onOpenTask,
  onStartRename,
  onRenameTitleChange,
  onSaveRename,
  onCancelRename,
  onArchiveTask,
  onStartProjectRename,
  onRenameProjectNameChange,
  onSaveProjectRename,
  onCancelProjectRename,
  onArchiveProject,
  onRestoreProject,
  onDeleteProject,
  onSetProjectPinned,
  onReorderProjects,
  onOpenSettings,
  version,
}: {
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  activeProjectId?: string;
  activeTaskId?: string;
  unreadTaskIds: ReadonlySet<string>;
  waitingActionTaskIds: ReadonlySet<string>;
  busy: boolean;
  creatingTask: boolean;
  renamingTaskId?: string;
  renameTitle: string;
  renamingProjectId?: string;
  renameProjectName: string;
  showArchived: boolean;
  collapsedProjects: Set<string>;
  onToggleArchived: () => void;
  onToggleProjectCollapse: (projectId: string) => void;
  onProjectChange: (projectId: string) => void;
  onCreateProject: () => void;
  onCreateTask: (projectId?: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onOpenTask: (taskId: string) => void;
  onStartRename: (task: TaskSummary) => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (taskId: string) => void;
  onCancelRename: () => void;
  onArchiveTask: (task: TaskSummary) => void;
  onStartProjectRename: (project: ProjectSummary) => void;
  onRenameProjectNameChange: (name: string) => void;
  onSaveProjectRename: (projectId: string) => void;
  onCancelProjectRename: () => void;
  onArchiveProject: (project: ProjectSummary) => void;
  onRestoreProject: (projectId: string) => void;
  onDeleteProject: (project: ProjectSummary) => void;
  onSetProjectPinned: (projectId: string, pinned: boolean) => void;
  onReorderProjects: (projectIds: string[], pinned: boolean) => void;
  onOpenSettings: () => void;
  version: string;
}) {
  const activeProjects = projects.filter((project) => !project.archived);
  const archivedProjects = projects.filter((project) => project.archived);
  const pinnedProjects = activeProjects.filter((project) => project.pinned);
  const regularProjects = activeProjects.filter((project) => !project.pinned);
  const projectGroups: Array<{
    key: string;
    label: string;
    projects: ProjectSummary[];
    pinned?: boolean;
  }> = [
    { key: 'pinned', label: '置顶项目', projects: pinnedProjects, pinned: true },
    { key: 'regular', label: '项目', projects: regularProjects, pinned: false },
    ...(showArchived ? [{ key: 'archived', label: '已归档', projects: archivedProjects }] : []),
  ].filter((group) => group.projects.length > 0);
  const [draggedProjectId, setDraggedProjectId] = useState<string>();
  const [projectDropTarget, setProjectDropTarget] = useState<{
    projectId: string;
    position: 'before' | 'after';
  }>();
  const [visibleProjectTaskCounts, setVisibleProjectTaskCounts] = useState<Record<string, number>>(
    {},
  );
  const projectTasks = useMemo(() => {
    const groups = new Map<string, TaskSummary[]>();
    for (const project of projects) {
      groups.set(
        project.id,
        tasks
          .filter((task) => task.projectId === project.id)
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      );
    }
    return groups;
  }, [projects, tasks]);

  function finishProjectDrag() {
    setDraggedProjectId(undefined);
    setProjectDropTarget(undefined);
  }

  function dropProject(groupProjects: ProjectSummary[], pinned: boolean, targetProjectId: string) {
    if (!draggedProjectId || draggedProjectId === targetProjectId) {
      finishProjectDrag();
      return;
    }
    const reordered = groupProjects.filter((project) => project.id !== draggedProjectId);
    const targetIndex = reordered.findIndex((project) => project.id === targetProjectId);
    if (targetIndex < 0) {
      finishProjectDrag();
      return;
    }
    const draggedProject = groupProjects.find((project) => project.id === draggedProjectId);
    if (!draggedProject) {
      finishProjectDrag();
      return;
    }
    const insertAt = targetIndex + (projectDropTarget?.position === 'after' ? 1 : 0);
    reordered.splice(insertAt, 0, draggedProject);
    onReorderProjects(
      reordered.map((project) => project.id),
      pinned,
    );
    finishProjectDrag();
  }

  function showMoreProjectTasks(projectId: string, total: number) {
    setVisibleProjectTaskCounts((current) => ({
      ...current,
      [projectId]: nextProjectTaskCount(current[projectId], total),
    }));
  }

  function renderProjectTasks(project: ProjectSummary) {
    const allTasks = projectTasks.get(project.id) ?? [];
    if (allTasks.length === 0) {
      return (
        <div className="pa-project-tasks-empty">
          <Text type="secondary">暂无任务</Text>
        </div>
      );
    }

    const page = paginateProjectTasks(allTasks, visibleProjectTaskCounts[project.id]);
    return (
      <>
        {page.tasks.map((task) => (
          <TaskMenuItem
            key={task.id}
            task={task}
            activeTaskId={activeTaskId}
            unread={unreadTaskIds.has(task.id)}
            waitingAction={waitingActionTaskIds.has(task.id)}
            busy={busy}
            renamingTaskId={renamingTaskId}
            renameTitle={renameTitle}
            onOpenTask={onOpenTask}
            onStartRename={onStartRename}
            onRenameTitleChange={onRenameTitleChange}
            onSaveRename={onSaveRename}
            onCancelRename={onCancelRename}
            onArchiveTask={onArchiveTask}
          />
        ))}
        {page.hasMore && (
          <Button
            type="text"
            size="small"
            className="pa-project-tasks-more"
            aria-label={`查看更多 ${project.name} 的任务`}
            onClick={() => showMoreProjectTasks(project.id, allTasks.length)}
          >
            查看更多
          </Button>
        )}
      </>
    );
  }

  return (
    <div className="pa-sidebar-content">
      <div className="pa-brand">
        <img className="pa-brand-logo" src="/app-icon.png" alt="" aria-hidden="true" />
        <div>
          <strong>personal-agent</strong>
          <small>你真正的一览无余的私人助理</small>
        </div>
      </div>

      <div className="pa-sidebar-menu">
        <Button
          block
          className="pa-sidebar-menu-btn"
          icon={<PlusOutlined />}
          loading={creatingTask}
          disabled={busy || !activeProjectId}
          onClick={() => onCreateTask()}
        >
          新建任务
          <kbd>Ctrl K</kbd>
        </Button>
      </div>

      <div className="pa-section-heading">
        <span>项目与任务</span>
        <Space size={0}>
          <Tooltip title="新建项目">
            <Button
              type="text"
              size="small"
              icon={<FolderAddOutlined />}
              aria-label="新建项目"
              onClick={onCreateProject}
            />
          </Tooltip>
          <Tooltip title="刷新项目和任务">
            <Button
              type="text"
              size="small"
              icon={<ReloadOutlined spin={refreshing} />}
              aria-label="刷新项目和任务"
              disabled={refreshing}
              onClick={onRefresh}
            />
          </Tooltip>
        </Space>
      </div>

      <div className="pa-project-list">
        {projectGroups.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无项目" />
        ) : (
          projectGroups.map((group) => (
            <section className="pa-project-group" key={group.key}>
              <div className="pa-project-group-heading">
                <span>
                  {group.pinned === true && <PushpinFilled />}
                  {group.label}
                </span>
                <small>{group.projects.length}</small>
              </div>
              <ul className="pa-project-menu-list">
                {group.projects.map((project) => (
                  <li
                    className={`pa-project-list-item${
                      draggedProjectId === project.id ? ' dragging' : ''
                    }${
                      projectDropTarget?.projectId === project.id
                        ? ` drop-${projectDropTarget.position}`
                        : ''
                    }`}
                    key={project.id}
                    onDragOver={(event) => {
                      if (
                        group.pinned === undefined ||
                        !draggedProjectId ||
                        draggedProjectId === project.id ||
                        projects.find((candidate) => candidate.id === draggedProjectId)?.pinned !==
                          group.pinned
                      ) {
                        return;
                      }
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      const projectRow = event.currentTarget.querySelector<HTMLElement>(
                        ':scope > .pa-project-row',
                      );
                      const bounds =
                        projectRow?.getBoundingClientRect() ??
                        event.currentTarget.getBoundingClientRect();
                      setProjectDropTarget({
                        projectId: project.id,
                        position:
                          event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after',
                      });
                    }}
                    onDrop={(event) => {
                      if (group.pinned === undefined) return;
                      event.preventDefault();
                      dropProject(group.projects, group.pinned, project.id);
                    }}
                  >
                    {renamingProjectId === project.id ? (
                      <div className="pa-task-rename">
                        <Input
                          autoFocus
                          maxLength={100}
                          value={renameProjectName}
                          onChange={(event) => onRenameProjectNameChange(event.target.value)}
                          onPressEnter={() => onSaveProjectRename(project.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') onCancelProjectRename();
                          }}
                        />
                        <Button
                          type="primary"
                          icon={<CheckCircleFilled />}
                          aria-label="保存项目名称"
                          onClick={() => onSaveProjectRename(project.id)}
                        />
                      </div>
                    ) : (
                      <>
                        <div className={`pa-project-row${project.archived ? ' archived' : ''}`}>
                          {group.pinned !== undefined ? (
                            <button
                              type="button"
                              className="pa-project-drag-handle"
                              draggable={!busy}
                              disabled={busy}
                              title="拖动排序"
                              aria-label={`拖动项目 ${project.name} 排序`}
                              onDragStart={(event) => {
                                setDraggedProjectId(project.id);
                                setProjectDropTarget(undefined);
                                event.dataTransfer.effectAllowed = 'move';
                                event.dataTransfer.setData('text/plain', project.id);
                              }}
                              onDragEnd={finishProjectDrag}
                            >
                              <HolderOutlined />
                            </button>
                          ) : (
                            <span className="pa-project-drag-placeholder" aria-hidden="true" />
                          )}
                          <button
                            type="button"
                            className="pa-project-collapse"
                            disabled={busy || project.archived}
                            onClick={(event) => {
                              event.stopPropagation();
                              onToggleProjectCollapse(project.id);
                            }}
                            aria-label={
                              collapsedProjects.has(project.id)
                                ? `展开项目 ${project.name} 的任务`
                                : `折叠项目 ${project.name} 的任务`
                            }
                          >
                            <CaretRightOutlined
                              className={collapsedProjects.has(project.id) ? '' : 'expanded'}
                            />
                          </button>
                          <button
                            type="button"
                            className="pa-project-main"
                            disabled={busy || project.archived}
                            onClick={() => onProjectChange(project.id)}
                            title={project.rootPath}
                          >
                            <strong>{project.name}</strong>
                          </button>
                          <Dropdown
                            trigger={['click']}
                            menu={{
                              items: [
                                ...(project.archived
                                  ? [
                                      {
                                        key: 'restore',
                                        icon: <ReloadOutlined />,
                                        label: '恢复项目',
                                      },
                                    ]
                                  : [
                                      {
                                        key: 'pin',
                                        icon: project.pinned ? (
                                          <PushpinFilled />
                                        ) : (
                                          <PushpinOutlined />
                                        ),
                                        label: project.pinned ? '取消置顶' : '置顶',
                                      },
                                      {
                                        key: 'rename',
                                        icon: <EditOutlined />,
                                        label: '重命名',
                                      },
                                      {
                                        key: 'archive',
                                        icon: <DeleteOutlined />,
                                        danger: true,
                                        label: '归档',
                                      },
                                    ]),
                                {
                                  key: 'delete',
                                  icon: <DeleteOutlined />,
                                  danger: true,
                                  label: '彻底删除',
                                },
                              ],
                              onClick: ({ key }) => {
                                if (key === 'pin') onSetProjectPinned(project.id, !project.pinned);
                                else if (key === 'rename') onStartProjectRename(project);
                                else if (key === 'archive') onArchiveProject(project);
                                else if (key === 'restore') onRestoreProject(project.id);
                                else if (key === 'delete') onDeleteProject(project);
                              },
                            }}
                          >
                            <Button
                              type="text"
                              size="small"
                              icon={<MoreOutlined />}
                              disabled={busy}
                              aria-label={`项目 ${project.name} 的更多操作`}
                            />
                          </Dropdown>
                          <Tooltip title="新建任务">
                            <Button
                              type="text"
                              size="small"
                              className="pa-project-add-task"
                              icon={<PlusOutlined />}
                              disabled={busy || project.archived}
                              aria-label={`为项目 ${project.name} 新建任务`}
                              onClick={(event) => {
                                event.stopPropagation();
                                onCreateTask(project.id);
                              }}
                            />
                          </Tooltip>
                        </div>
                        {!project.archived && !collapsedProjects.has(project.id) && (
                          <div className="pa-project-tasks">{renderProjectTasks(project)}</div>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        {archivedProjects.length > 0 && (
          <Button
            type="text"
            size="small"
            className="pa-archived-toggle"
            onClick={onToggleArchived}
          >
            {showArchived ? '收起已归档' : `查看已归档（${archivedProjects.length}）`}
          </Button>
        )}
      </div>

      <div className="pa-sidebar-footer">
        <div className="pa-sidebar-settings">
          <Text type="secondary">v{version}</Text>
          <Button
            type="text"
            icon={<SettingOutlined />}
            aria-label="打开设置"
            data-testid="open-settings"
            onClick={() => onOpenSettings()}
          >
            设置
          </Button>
        </div>
      </div>
    </div>
  );
}

function TaskMenuItem({
  task,
  activeTaskId,
  unread,
  waitingAction,
  busy,
  renamingTaskId,
  renameTitle,
  onOpenTask,
  onStartRename,
  onRenameTitleChange,
  onSaveRename,
  onCancelRename,
  onArchiveTask,
}: {
  task: TaskSummary;
  activeTaskId?: string;
  unread: boolean;
  waitingAction: boolean;
  busy: boolean;
  renamingTaskId?: string;
  renameTitle: string;
  onOpenTask: (taskId: string) => void;
  onStartRename: (task: TaskSummary) => void;
  onRenameTitleChange: (title: string) => void;
  onSaveRename: (taskId: string) => void;
  onCancelRename: () => void;
  onArchiveTask: (task: TaskSummary) => void;
}) {
  return (
    <div className="pa-task-list-item">
      <div className={`pa-task-row${task.id === activeTaskId ? ' active' : ''}`}>
        {renamingTaskId === task.id ? (
          <div className="pa-task-rename">
            <Input
              autoFocus
              maxLength={200}
              value={renameTitle}
              onChange={(event) => onRenameTitleChange(event.target.value)}
              onPressEnter={() => onSaveRename(task.id)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') onCancelRename();
              }}
            />
            <Button
              type="primary"
              icon={<CheckCircleFilled />}
              aria-label="保存任务名称"
              onClick={() => onSaveRename(task.id)}
            />
          </div>
        ) : (
          <>
            <button
              type="button"
              className="pa-task-main"
              onClick={() => onOpenTask(task.id)}
              title={`${task.title} · ${relativeTime(task.updatedAt)} · ${
                task.sessionId ? '可恢复' : '尚未开始'
              }`}
            >
              <strong>{task.title}</strong>
              {waitingAction && (
                <Tag color="orange" className="pa-task-waiting-tag">
                  等待处理
                </Tag>
              )}
              {unread && (
                <span
                  className="pa-task-unread-dot"
                  aria-label={`${task.title} 有未读的完成消息`}
                  title="任务已完成，点击查看"
                />
              )}
              {task.running && <Spin size="small" className="pa-task-running" />}
            </button>
            <Dropdown
              trigger={['click']}
              menu={{
                items: [
                  {
                    key: 'rename',
                    icon: <EditOutlined />,
                    label: '重命名',
                  },
                  {
                    key: 'archive',
                    icon: <DeleteOutlined />,
                    danger: true,
                    label: '归档',
                  },
                ],
                onClick: ({ key }) => {
                  if (key === 'rename') onStartRename(task);
                  else onArchiveTask(task);
                },
              }}
            >
              <Button
                type="text"
                size="small"
                icon={<MoreOutlined />}
                disabled={busy}
                aria-label={`任务 ${task.title} 的更多操作`}
              />
            </Dropdown>
          </>
        )}
      </div>
    </div>
  );
}

function Welcome({
  onSelectPrompt,
  prompts,
}: {
  onSelectPrompt: (prompt: string) => void;
  prompts: StarterPrompt[];
}) {
  return (
    <section className="pa-welcome">
      <img className="pa-welcome-logo" src="/app-icon.png" alt="" aria-hidden="true" />
      <span className="pa-eyebrow">YOUR LOCAL AI AGENT</span>
      <Title level={1}>今天想一起完成什么？</Title>
      <Text type="secondary" className="pa-welcome-copy">
        直接描述目标。Agent 可以理解项目、编辑文件、运行命令，并在敏感操作前请求你的批准。
      </Text>
      <div className="pa-starter-grid">
        {prompts.map((starter) => (
          <Card
            key={starter.title}
            hoverable
            className="pa-starter"
            onClick={() => onSelectPrompt(starter.prompt)}
          >
            <strong>{starter.title}</strong>
            <small>{starter.description}</small>
            <span>↗</span>
          </Card>
        ))}
      </div>
    </section>
  );
}

/** 轮次导航最多显示的轮次数：仅展示最近 N 轮，更早的轮次不再显示。 */
const MAX_TURN_NAV_TURNS = 30;

function TurnNavigation({
  turns,
  activeId,
  onSelect,
  left = 30,
}: {
  turns: Array<MessageTimelineItem & { role: 'user' }>;
  activeId?: string;
  onSelect: (turnId: string) => void;
  left?: number;
}) {
  // 限制导航条数量：只显示最近 MAX_TURN_NAV_TURNS 轮；
  // 序号仍按真实轮次计算（如「第 35 轮」），避免截断后提示错位。
  const offset = Math.max(0, turns.length - MAX_TURN_NAV_TURNS);
  const visibleTurns = offset > 0 ? turns.slice(offset) : turns;
  return (
    <nav className="pa-turn-nav" style={{ left }} aria-label="对话轮次导航">
      {visibleTurns.map((turn, index) => {
        const turnNumber = offset + index + 1;
        const preview =
          turn.text.replace(/\s+/g, ' ').trim() ||
          turn.images?.map((image) => image.name).join('、') ||
          '（空消息）';
        return (
          <button
            key={turn.id}
            type="button"
            className={`pa-turn-nav-item${turn.id === activeId ? ' active' : ''}`}
            aria-label={`跳到第 ${turnNumber} 轮：${preview}`}
            onClick={() => onSelect(turn.id)}
          >
            <span className="pa-turn-nav-tip" role="tooltip">
              <span className="pa-turn-nav-tip-index">第 {turnNumber} 轮</span>
              <span className="pa-turn-nav-tip-text">{preview}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * 任务完成 · 修改文件卡片：超过 3 个文件时自动折叠，底部居中浮动「展开全部」按钮。
 */
function RunChangesCard({
  changes,
  time,
  onOpenFileDiff,
}: {
  changes: FileChange[];
  time: string;
  onOpenFileDiff?: (changeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = changes.length > 3;
  const collapsed = collapsible && !expanded;
  const visible = collapsed ? changes.slice(0, 3) : changes;

  return (
    <div className={`pa-run-changes-card${collapsed ? ' collapsed' : ''}`}>
      <div className="pa-run-changes-head">
        <span className="pa-run-changes-icon" aria-hidden="true">
          <DiffOutlined />
        </span>
        <span className="pa-run-changes-copy">
          <strong>任务完成 · 修改 {changes.length} 个文件</strong>
          <time>{time}</time>
        </span>
      </div>
      {changes.length > 0 && (
        <ul className={`pa-run-changes-files${collapsed ? ' collapsed' : ''}`}>
          {visible.map((change) => (
            <li key={change.id}>
              <button type="button" title={change.path} onClick={() => onOpenFileDiff?.(change.id)}>
                <FileTextOutlined />
                <span>{lastPathSegment(change.path) ?? change.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {collapsible && (
        <button
          type="button"
          className="pa-run-changes-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <DownOutlined style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
          {expanded ? '收起' : `展开全部 ${changes.length} 个文件`}
        </button>
      )}
    </div>
  );
}

function TimelineEntry({
  item,
  cards,
  planDocs,
  fileChanges,
  onMessageElement,
  onOpenPlanDoc,
  onOpenFileDiff,
}: {
  item: TimelineItem;
  /** 吸附进本消息 .pa-message-content 内部末尾的卡片（plan-doc / run-changes，plan 在前）。 */
  cards?: TimelineItem[];
  planDocs?: Record<string, PlanDoc>;
  fileChanges?: Record<string, FileChange>;
  onMessageElement?: (id: string, element: HTMLElement | null) => void;
  onOpenPlanDoc?: (docId: string) => void;
  onOpenFileDiff?: (changeId: string) => void;
}) {
  const { message: messageApi } = AntApp.useApp();

  if (item.kind === 'run-changes') {
    const changes = item.changeIds
      .map((id) => fileChanges?.[id])
      .filter((change): change is FileChange => Boolean(change));
    return <RunChangesCard changes={changes} time={item.time} onOpenFileDiff={onOpenFileDiff} />;
  }

  if (item.kind === 'plan-doc') {
    const status = planDocs?.[item.docId]?.plan.status;
    return (
      <button
        type="button"
        className="pa-plan-doc-card"
        title="查看计划文档"
        onClick={() => onOpenPlanDoc?.(item.docId)}
      >
        <span className="pa-plan-doc-card-icon" aria-hidden="true">
          <FileTextOutlined />
        </span>
        <span className="pa-plan-doc-card-copy">
          <strong>{item.title}</strong>
          <span className="pa-plan-doc-card-meta">
            {status && (
              <Tag color={PLAN_STATUS_TAG_COLORS[status] ?? 'default'}>
                {planStatusLabel(status)}
              </Tag>
            )}
            <time>{item.time}</time>
          </span>
        </span>
      </button>
    );
  }

  if (item.kind === 'tool') {
    const status =
      item.status === 'running'
        ? '正在运行'
        : item.status === 'interrupted'
          ? '已停止'
          : item.status === 'success'
            ? item.duration !== undefined
              ? `${item.duration} ms`
              : '已完成'
            : '执行失败';
    const bashCommand =
      item.name === 'bash' && typeof item.arguments?.command === 'string'
        ? item.arguments.command
        : undefined;
    return (
      <div className={`pa-tool-entry ${item.status}`}>
        <Collapse
          size="small"
          defaultActiveKey={item.status === 'failed' ? ['tool'] : []}
          items={[
            {
              key: 'tool',
              label: (
                <div className="pa-tool-label">
                  {item.status === 'running' ? (
                    <Spin size="small" />
                  ) : item.status === 'interrupted' ? (
                    <StopOutlined />
                  ) : (
                    <ToolOutlined />
                  )}
                  <strong>{item.restored ? '历史工具结果' : item.name}</strong>
                  <span>{status}</span>
                </div>
              ),
              children: (
                <>
                  {bashCommand && <pre className="pa-tool-command">{bashCommand}</pre>}
                  <pre className="pa-tool-output">{item.output}</pre>
                </>
              ),
            },
          ]}
        />
      </div>
    );
  }

  const user = item.role === 'user';
  const system = item.role === 'system';
  // 一轮回复的文本：多次调用的文本按序拼接（调用之间空行分隔）
  const messageText = turnsText(item.turns);
  const showThinking =
    !user &&
    !system &&
    (Boolean(item.turns?.length) || Boolean(item.thinking) || Boolean(item.tools?.length));
  const copyUserMessage = (): void => {
    if (!item.text.trim()) {
      messageApi.info('这条消息只包含图片，没有可复制的文字。');
      return;
    }
    void copyTextToClipboard(item.text)
      .then(() => messageApi.success('用户输入已复制'))
      .catch(() => messageApi.error('复制失败，请手动选择文本'));
  };
  const copyAssistantMessage = (): void => {
    const text = messageText || item.text;
    if (!text.trim()) {
      messageApi.info('这条回复没有可复制的文字。');
      return;
    }
    void copyTextToClipboard(text)
      .then(() => messageApi.success('回复已复制'))
      .catch(() => messageApi.error('复制失败，请手动选择文本'));
  };
  const avatar = (
    <Avatar
      className={`pa-message-avatar ${item.role}`}
      icon={user ? <UserOutlined /> : system ? <InfoCircleOutlined /> : <RobotOutlined />}
    />
  );
  const body = (
    <div className={`pa-message-body ${item.role}${item.error ? ' error' : ''}`}>
      <div className="pa-message-head">
        <strong>{user ? '你' : system ? '系统' : 'personal-agent'}</strong>
        <time>{item.time}</time>
      </div>
      {showThinking && (
        <ThinkingBlock
          turns={item.turns ?? []}
          thinking={item.thinking ?? ''}
          tools={item.tools ?? []}
          streaming={Boolean(item.streaming)}
        />
      )}
      {(messageText ||
        item.text ||
        user ||
        system ||
        (cards && cards.length > 0) ||
        (!user && !system && typeof item.durationMs === 'number')) && (
        <div
          className={`pa-message-content${item.streaming && (messageText || item.text) ? ' streaming' : ''}`}
        >
          {user && item.images && item.images.length > 0 && (
            <div className="pa-message-images">
              <Image.PreviewGroup>
                {item.images.map((image, index) => (
                  <Image
                    key={`${image.name}-${index}`}
                    src={image.src}
                    alt={image.name}
                    title={image.name}
                  />
                ))}
              </Image.PreviewGroup>
            </div>
          )}
          {system
            ? item.text
            : (messageText || item.text) && <MarkdownContent text={messageText || item.text} />}
          {!user && cards && cards.length > 0 && (
            <div className="pa-message-cards">
              {cards.map((card) => {
                if (card.kind === 'plan-doc') {
                  const status = planDocs?.[card.docId]?.plan.status;
                  return (
                    <button
                      key={card.id}
                      type="button"
                      className="pa-plan-doc-card"
                      title="查看计划文档"
                      onClick={() => onOpenPlanDoc?.(card.docId)}
                    >
                      <span className="pa-plan-doc-card-icon" aria-hidden="true">
                        <FileTextOutlined />
                      </span>
                      <span className="pa-plan-doc-card-copy">
                        <strong>{card.title}</strong>
                        <span className="pa-plan-doc-card-meta">
                          {status && (
                            <Tag color={PLAN_STATUS_TAG_COLORS[status] ?? 'default'}>
                              {planStatusLabel(status)}
                            </Tag>
                          )}
                          <time>{card.time}</time>
                        </span>
                      </span>
                    </button>
                  );
                }
                if (card.kind !== 'run-changes') return null;
                const changes = card.changeIds
                  .map((id) => fileChanges?.[id])
                  .filter((change): change is FileChange => Boolean(change));
                return (
                  <RunChangesCard
                    key={card.id}
                    changes={changes}
                    time={card.time}
                    onOpenFileDiff={onOpenFileDiff}
                  />
                );
              })}
            </div>
          )}
          {!user && !system && !item.streaming && typeof item.durationMs === 'number' && (
            <div className="pa-message-meta">
              <Tooltip title="复制">
                <Button
                  className="pa-message-copy"
                  type="text"
                  size="small"
                  aria-label="复制回复"
                  icon={<CopyOutlined />}
                  onClick={copyAssistantMessage}
                />
              </Tooltip>
              {item.finishedAt && (
                <span className="pa-message-meta-item">{formatClockTime(item.finishedAt)}</span>
              )}
              <span className="pa-message-meta-sep">·</span>
              <span className="pa-message-meta-item">
                用时 {formatElapsedChinese(item.durationMs)}
              </span>
              {typeof item.ttftMs === 'number' && (
                <>
                  <span className="pa-message-meta-sep">·</span>
                  <span className="pa-message-meta-item">首 token {formatTtft(item.ttftMs)}</span>
                </>
              )}
              {typeof item.tokensPerSecond === 'number' && (
                <>
                  <span className="pa-message-meta-sep">·</span>
                  <span className="pa-message-meta-item">
                    {formatTokenSpeed(item.tokensPerSecond)}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {user && (
        <div className="pa-user-message-actions">
          <Tooltip title="复制">
            <Button
              className="pa-user-message-copy"
              type="text"
              size="small"
              aria-label="复制用户输入"
              icon={<CopyOutlined />}
              onClick={copyUserMessage}
            />
          </Tooltip>
        </div>
      )}
    </div>
  );

  return (
    <article
      ref={(element) => onMessageElement?.(item.id, element)}
      className={`pa-message-row ${item.role}`}
    >
      {user ? (
        <>
          {body}
          {avatar}
        </>
      ) : (
        <>
          {avatar}
          {body}
        </>
      )}
    </article>
  );
}

function ThinkingBlock({
  turns,
  thinking,
  tools,
  streaming,
}: {
  turns: AssistantTurn[];
  thinking: string;
  tools: ToolTimelineItem[];
  streaming: boolean;
}) {
  // 兼容无 turns 的旧消息：用顶层 thinking/tools 组装单个分组
  const groups: AssistantTurn[] =
    turns.length > 0
      ? turns
      : [{ turnNumber: 1, thinking: thinking ?? '', text: '', tools: tools ?? [] }];
  const allTools = groups.flatMap((group) => group.tools);
  const runningTools = allTools.filter((tool) => tool.status === 'running').length;
  const failedTools = allTools.filter((tool) => tool.status === 'failed').length;
  const interruptedTools = allTools.filter((tool) => tool.status === 'interrupted').length;
  const summary = runningTools
    ? `${runningTools} 个工具执行中`
    : failedTools
      ? `${allTools.length} 个工具 · ${failedTools} 个失败`
      : interruptedTools
        ? `${allTools.length} 个工具 · ${interruptedTools} 个已停止`
        : allTools.length
          ? `${allTools.length} 个工具`
          : streaming
            ? '思考中'
            : '思考完成';

  return (
    <div className="pa-thinking-block">
      <Collapse
        size="small"
        items={[
          {
            key: 'thinking',
            label: (
              <div className="pa-thinking-label">
                {streaming || runningTools > 0 ? <Spin size="small" /> : <BulbOutlined />}
                <strong>thinking...</strong>
                <span>{summary}</span>
              </div>
            ),
            children: (
              <div className="pa-thinking-details">
                {groups.map((group, index) => (
                  <ThinkingTurnGroup
                    key={group.turnNumber}
                    group={group}
                    showHeading={groups.length > 1}
                    headingIndex={index + 1}
                    streaming={streaming}
                  />
                ))}
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

/**
 * 一轮回复中一次 LLM 调用（turn）的分组：
 * 多次调用时显示「第 N 次调用」标题，组内思考内容/工具调用各自默认折叠。
 */
function ThinkingTurnGroup({
  group,
  showHeading,
  headingIndex,
  streaming,
}: {
  group: AssistantTurn;
  showHeading: boolean;
  headingIndex: number;
  streaming: boolean;
}) {
  const toolNames = [...new Set(group.tools.map((tool) => tool.name))].join(' · ');
  const runningTools = group.tools.filter((tool) => tool.status === 'running').length;
  const failedTools = group.tools.filter((tool) => tool.status === 'failed').length;
  const headSummary = runningTools
    ? `${runningTools} 个工具执行中`
    : failedTools
      ? `${group.tools.length} 个工具 · ${failedTools} 个失败`
      : group.tools.length
        ? `${group.tools.length} 个工具`
        : streaming
          ? '思考中'
          : '思考完成';

  return (
    <div className="pa-thinking-turn">
      {showHeading && (
        <div className="pa-thinking-turn-head">
          <strong>第 {headingIndex} 次调用</strong>
          <span>{headSummary}</span>
        </div>
      )}
      {group.thinking && (
        <Collapse
          size="small"
          className="pa-thinking-sub-collapse"
          items={[
            {
              key: 'thinking-content',
              label: (
                <div className="pa-thinking-sub-label">
                  <BulbOutlined />
                  <strong>思考内容</strong>
                </div>
              ),
              children: (
                <div className="pa-thinking-content">
                  <MarkdownContent text={group.thinking} />
                </div>
              ),
            },
          ]}
        />
      )}
      {group.tools.length > 0 && (
        <Collapse
          size="small"
          className="pa-thinking-sub-collapse"
          items={[
            {
              key: 'tools',
              label: (
                <div className="pa-thinking-sub-label">
                  <ToolOutlined />
                  <strong>工具调用</strong>
                  <span className="pa-thinking-sub-names" title={toolNames}>
                    {toolNames}
                  </span>
                  <span>{group.tools.length} 个</span>
                </div>
              ),
              children: (
                <div className="pa-thinking-tools">
                  {group.tools.map((tool) => (
                    <ThinkingTool key={tool.toolCallId} tool={tool} />
                  ))}
                </div>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function ThinkingTool({ tool }: { tool: ToolTimelineItem }) {
  const status =
    tool.status === 'running'
      ? '正在运行'
      : tool.status === 'interrupted'
        ? '已停止'
        : tool.status === 'success'
          ? tool.duration !== undefined
            ? `${tool.duration} ms`
            : '已完成'
          : '执行失败';
  const bashCommand =
    tool.name === 'bash' && typeof tool.arguments?.command === 'string'
      ? tool.arguments.command
      : undefined;
  const askQuestion =
    tool.name === 'ask_user' && typeof tool.arguments?.question === 'string'
      ? tool.arguments.question
      : undefined;
  return (
    <div className={`pa-thinking-tool ${tool.status}`}>
      <div className="pa-thinking-tool-head">
        {tool.status === 'running' ? (
          <Spin size="small" />
        ) : tool.status === 'interrupted' ? (
          <StopOutlined />
        ) : (
          <ToolOutlined />
        )}
        <strong>{tool.name}</strong>
        <span>{status}</span>
      </div>
      {bashCommand && <pre className="pa-tool-command">{bashCommand}</pre>}
      {askQuestion && <pre className="pa-tool-command">{askQuestion}</pre>}
      {tool.name === 'todo_write' && parseTodoTasks(tool) ? (
        <TodoTaskList tool={tool} />
      ) : (
        <pre className="pa-tool-output">{tool.output}</pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// todo_write — structured task list with antd status icons
// ---------------------------------------------------------------------------

interface TodoTask {
  status: string;
  subject: string;
}

/** Extract structured tasks: prefer metadata.tasks, fall back to parsing the plain-text output. */
function parseTodoTasks(tool: ToolTimelineItem): TodoTask[] | undefined {
  if (tool.metadata?.tasks && tool.metadata.tasks.length > 0) {
    return tool.metadata.tasks;
  }
  // Fallback for restored history items (no metadata): "  [pending] Task A"
  const tasks: TodoTask[] = [];
  for (const line of tool.output.split('\n')) {
    const match = /^\[(pending|in_progress|completed|deleted)\]\s*(.*)$/.exec(line.trim());
    if (match) tasks.push({ status: match[1], subject: match[2] });
  }
  return tasks.length > 0 ? tasks : undefined;
}

const TODO_STATUS_ICONS: Record<string, ReactNode> = {
  pending: <ClockCircleOutlined />,
  in_progress: <PlayCircleOutlined />,
  completed: <CheckCircleOutlined />,
  deleted: <MinusCircleOutlined />,
};

const TODO_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
  deleted: '已删除',
};

function TodoTaskList({ tool }: { tool: ToolTimelineItem }) {
  const tasks = parseTodoTasks(tool);
  if (!tasks) return null;
  return (
    <div className="pa-todo-list">
      {tasks.map((task, index) => {
        const status = task.status;
        return (
          <div key={`${index}-${task.subject}`} className={`pa-todo-item pa-todo-${status}`}>
            <span className="pa-todo-icon">
              {TODO_STATUS_ICONS[status] ?? <ClockCircleOutlined />}
            </span>
            <span className="pa-todo-subject">{task.subject}</span>
            <span className="pa-todo-status">{TODO_STATUS_LABELS[status] ?? status}</span>
          </div>
        );
      })}
    </div>
  );
}

function MarkdownContent({ text }: { text: string }) {
  return (
    <Image.PreviewGroup>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ children, className, ...props }) => (
            <code className={className} {...props}>
              {children}
            </code>
          ),
          img: ({ src, alt, title }) => (
            <Image src={src} alt={alt ?? ''} title={title} />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </Image.PreviewGroup>
  );
}

function AskUserCard({
  request,
  taskTitle,
  onAnswer,
}: {
  request: AskUserRequest;
  taskTitle?: string;
  onAnswer: (answer: UserAnswer) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');
  const canSubmit = customMode ? customText.trim().length > 0 : selected.length > 0;

  /** 第一个选项是模型最推荐的，用「推荐」标签标识。 */
  const renderOptionLabel = (option: string, index: number) => (
    <>
      {index === 0 && (
        <Tag color="gold" style={{ marginRight: 6 }}>
          推荐
        </Tag>
      )}
      {option}
    </>
  );

  const submit = () => {
    if (customMode) {
      onAnswer({ selections: [], custom: customText.trim() });
      return;
    }
    onAnswer({ selections: selected });
  };

  return (
    <div className="pa-permission-floating" role="alertdialog">
      <div className="pa-permission-card">
        <div className="pa-permission-header">
          <Avatar size={30} icon={<QuestionCircleOutlined />} />
          <div>
            <strong>{taskTitle ? `「${taskTitle}」需要你的选择` : 'Agent 需要你的选择'}</strong>
            <span>{request.multiSelect ? '可多选（勾选多个选项）' : '请选择一个答案'}</span>
          </div>
        </div>
        <div className="pa-question-body">
          <p className="pa-question-text">{request.question}</p>
          {request.multiSelect ? (
            <Checkbox.Group
              className="pa-question-options"
              value={customMode ? [] : selected}
              onChange={(values) => {
                setSelected(values as string[]);
                setCustomMode(false);
              }}
            >
              {request.options.map((option, i) => (
                <Checkbox key={option} value={option}>
                  {renderOptionLabel(option, i)}
                </Checkbox>
              ))}
              {request.allowCustom && (
                <Checkbox
                  value="__custom__"
                  checked={customMode}
                  onChange={(event) => {
                    setCustomMode(event.target.checked);
                    if (event.target.checked) setSelected([]);
                  }}
                >
                  ✎ 自定义答案（以上都不选）
                </Checkbox>
              )}
            </Checkbox.Group>
          ) : (
            <Radio.Group
              className="pa-question-options"
              value={customMode ? '__custom__' : selected[0]}
              onChange={(event) => {
                const value = event.target.value as string;
                if (value === '__custom__') {
                  setCustomMode(true);
                  setSelected([]);
                } else {
                  setCustomMode(false);
                  setSelected([value]);
                }
              }}
            >
              {request.options.map((option, i) => (
                <Radio key={option} value={option}>
                  {renderOptionLabel(option, i)}
                </Radio>
              ))}
              {request.allowCustom && <Radio value="__custom__">✎ 自定义答案（以上都不选）</Radio>}
            </Radio.Group>
          )}
          {customMode && (
            <Input.TextArea
              autoFocus
              rows={2}
              value={customText}
              placeholder="请输入自定义答案…"
              onChange={(event) => setCustomText(event.target.value)}
            />
          )}
        </div>
        <div className="pa-permission-actions">
          <Space size={8}>
            <Button onClick={() => onAnswer({ selections: [] })}>跳过</Button>
            <Button
              type="primary"
              icon={<CheckCircleFilled />}
              disabled={!canSubmit}
              onClick={submit}
            >
              提交答案
            </Button>
          </Space>
        </div>
      </div>
    </div>
  );
}

function Composer({
  showScrollButton,
  onScrollToLatest,
  prompt,
  images,
  enabled,
  skills,
  busy,
  creatingTask,
  planActive,
  contextUsage,
  compressing,
  permissionMode,
  pendingPermission,
  pendingTitle,
  pendingQuestion,
  pendingQuestionTitle,
  rememberPermission,
  runtime,
  runtimeModelValue,
  taskModelValue,
  runtimeModels,
  runtimeReasoningOptions,
  runtimeDisabled,
  queuedMessages,
  onPromptChange,
  onImagesChange,
  onSubmit,
  onRemoveQueued,
  onInjectQueued,
  onStop,
  onAnswerPermission,
  onAnswerQuestion,
  onRememberPermissionChange,
  onPlanModeChange,
  onCompressContext,
  onPermissionModeChange,
  onModelChange,
  onTaskModelChange,
  onReasoningChange,
  taskReasoningEffort,
}: {
  /** 是否显示「滚动到最新消息」悬浮按钮（由对话区滚动状态驱动）。 */
  showScrollButton: boolean;
  onScrollToLatest: () => void;
  prompt: string;
  images: PromptImageInput[];
  enabled: boolean;
  skills: SkillInfo[];
  busy: boolean;
  creatingTask: boolean;
  planActive: boolean;
  contextUsage?: ContextUsage;
  compressing: boolean;
  permissionMode: PermissionMode;
  pendingPermission?: PermissionRequest;
  pendingTitle?: string;
  pendingQuestion?: AskUserRequest;
  pendingQuestionTitle?: string;
  rememberPermission: boolean;
  runtime?: RuntimeInfo;
  runtimeModelValue?: string;
  taskModelValue: string;
  /** 当前任务生效的思考强度（任务级覆盖或模型默认档），无任务时为 undefined。 */
  taskReasoningEffort?: ReasoningEffort;
  runtimeModels: RuntimeModelGroup[];
  runtimeReasoningOptions: ReasoningEffort[];
  runtimeDisabled: boolean;
  /** 当前任务的排队消息（任务执行中 Enter 入队，展示在输入框上方浮窗）。 */
  queuedMessages: QueuedMessage[];
  onPromptChange: (prompt: string) => void;
  onImagesChange: (images: PromptImageInput[]) => void;
  onSubmit: (prompt?: string) => void;
  /** 删除一条排队消息。 */
  onRemoveQueued: (id: string) => void;
  /** 把一条排队消息「插入」到当前执行循环（补充消息引导模型）。 */
  onInjectQueued: (id: string) => void;
  onStop: () => void;
  onAnswerPermission: (approved: boolean) => void;
  onAnswerQuestion: (answer: UserAnswer) => void;
  onRememberPermissionChange: (remember: boolean) => void;
  onPlanModeChange: (enabled: boolean) => void;
  onCompressContext: () => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onModelChange: (value: string) => void;
  onTaskModelChange: (value: string) => void;
  onReasoningChange: (effort: ReasoningEffort) => void;
}) {
  const { message: messageApi } = AntApp.useApp();
  const textAreaRef = useRef<TextAreaRef | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  /** 影子高亮层（与 TextArea 重叠，滚动同步）。 */
  const highlightRef = useRef<HTMLDivElement | null>(null);
  /** Markdown 工具栏是否展开（默认收起）。 */
  const [toolbarOpen, setToolbarOpen] = useState(false);
  /** 预览/编辑模式切换（预览复用 MarkdownContent 渲染）。 */
  const [previewMode, setPreviewMode] = useState(false);
  /** `/` 技能选择菜单是否打开。 */
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  /** 「+」附件菜单（图片上传 / 计划模式）是否打开。 */
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  /** 模型/推理等级选择浮层是否打开（截图样式：输入框内摘要按钮 + 列表式浮层）。 */
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  /** 浮层当前层级：root（参数行）/ model（模型列表）/ reasoning（推理等级列表）。 */
  const [modelPickerView, setModelPickerView] = useState<'root' | 'model' | 'reasoning'>('root');

  /** 「+」附件菜单打开时：点击菜单与触发按钮之外的区域关闭。 */
  useEffect(() => {
    if (!plusMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('.pa-plus-floating') || target.closest('[data-testid="add-attachment"]')) {
        return;
      }
      setPlusMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [plusMenuOpen]);

  const selectImages = async (files: FileList | File[] | null): Promise<void> => {
    if (!files?.length) return;
    const candidates = Array.from(files);
    if (images.length + candidates.length > MAX_PROMPT_IMAGES) {
      messageApi.error(`一次最多上传 ${MAX_PROMPT_IMAGES} 张图片。`);
      return;
    }
    const unsupported = candidates.find(
      (file) => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type),
    );
    if (unsupported) {
      messageApi.error(`${unsupported.name} 不是支持的图片格式（PNG、JPEG、WebP、GIF）。`);
      return;
    }
    const oversized = candidates.find((file) => file.size > MAX_PROMPT_IMAGE_BYTES);
    if (oversized) {
      messageApi.error(`${oversized.name} 超过 5 MB 限制。`);
      return;
    }
    const totalBytes =
      promptImagesByteLength(images) + candidates.reduce((total, file) => total + file.size, 0);
    if (totalBytes > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
      messageApi.error('图片总大小不能超过 10 MB。');
      return;
    }
    try {
      const next = await Promise.all(candidates.map(readPromptImage));
      onImagesChange([...images, ...next]);
    } catch (error) {
      messageApi.error(`读取图片失败：${formatError(error)}`);
    }
  };

  /**
   * 兼容用户提出的 Ctrl+C 图片粘贴习惯：仅在输入框没有选中文字时尝试读取
   * 剪贴板图片；标准 Ctrl+V 仍由 onPaste 处理，普通文字复制行为不受影响。
   */
  const pasteClipboardImagesOnCopyShortcut = async (): Promise<void> => {
    if (!navigator.clipboard?.read) return;
    try {
      const clipboardItems = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of clipboardItems) {
        for (const type of item.types.filter((candidate) => candidate.startsWith('image/'))) {
          const blob = await item.getType(type);
          const extension = type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
          files.push(
            new File([blob], `clipboard-${Date.now()}-${files.length + 1}.${extension}`, {
              type,
            }),
          );
        }
      }
      if (files.length > 0) await selectImages(files);
    } catch {
      // 浏览器未授予剪贴板读取权限时保持标准 Ctrl+C 行为，不额外打扰用户。
    }
  };

  /** 取 TextArea 原生元素（用于读写光标/选区）。 */
  const textareaElement = (): HTMLTextAreaElement | null =>
    textAreaRef.current?.resizableTextArea?.textArea ??
    (textAreaRef.current?.nativeElement as HTMLTextAreaElement | null) ??
    null;

  /** 包裹/插入行内语法：选中文本被 prefix/suffix 包裹，无选中时插入占位文本，并恢复光标与选区。 */
  const applyInline = (prefix: string, suffix: string, placeholder: string): void => {
    const textarea = textareaElement();
    if (!textarea) return;
    const start = textarea.selectionStart ?? prompt.length;
    const end = textarea.selectionEnd ?? start;
    const selected = prompt.slice(start, end);
    const insert = selected || placeholder;
    const next = `${prompt.slice(0, start)}${prefix}${insert}${suffix}${prompt.slice(end)}`;
    onPromptChange(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + prefix.length, start + prefix.length + insert.length);
    });
  };

  /** 行首插入前缀（标题/列表/引用）：作用于选中区域（多行逐行加前缀）或光标所在行。 */
  const applyLinePrefix = (prefix: string, placeholder: string): void => {
    const textarea = textareaElement();
    if (!textarea) return;
    const start = textarea.selectionStart ?? prompt.length;
    const end = textarea.selectionEnd ?? start;
    const lineStart = prompt.lastIndexOf('\n', start - 1) + 1;
    const lineEnd =
      prompt.indexOf('\n', end) === -1 ? prompt.length : prompt.indexOf('\n', end) + 1;
    const block = prompt.slice(lineStart, lineEnd);
    const content =
      block.trim() === ''
        ? `${prefix}${placeholder}\n`
        : block
            .replace(/\n$/, '')
            .split('\n')
            .map((line) => prefix + line)
            .join('\n') + (block.endsWith('\n') ? '\n' : '');
    const next = `${prompt.slice(0, lineStart)}${content}${prompt.slice(lineEnd)}`;
    onPromptChange(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(lineStart + content.length, lineStart + content.length);
    });
  };

  /** 代码块：包裹选中文本（无选中插入占位）。 */
  const applyCodeBlock = (): void => {
    applyInline('\n```\n', '\n```\n', '代码');
  };

  /** 在光标处插入固定模板（表格/分隔线）。 */
  const insertSnippet = (template: string): void => {
    const textarea = textareaElement();
    if (!textarea) return;
    const start = textarea.selectionStart ?? prompt.length;
    const next = `${prompt.slice(0, start)}${template}${prompt.slice(start)}`;
    onPromptChange(next);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + template.length, start + template.length);
    });
  };

  const placeholder = !enabled
    ? '配置 Provider 后即可开始对话'
    : busy
      ? '任务执行中…输入后按 Enter 加入队列'
      : '给 personal-agent 发送消息…（输入 / 选择技能，Enter 发送，Shift+Enter 换行）';

  /** 取光标之前最近的 `/技能名前缀`（/ 前需为行首或空白，避免误匹配 URL 等），无则返回 null。 */
  const getSkillPrefix = (): string | null => {
    const textarea = textareaElement();
    const caret = textarea?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, caret);
    const match = before.match(/(^|\s)\/([a-zA-Z0-9._-]*)$/);
    return match ? match[2] : null;
  };

  const skillPrefix = getSkillPrefix();
  const matchedSkills =
    skillPrefix !== null
      ? skills.filter((skill) => skill.name.toLowerCase().startsWith(skillPrefix.toLowerCase()))
      : [];
  const showSkillMenu = skillMenuOpen && skillPrefix !== null && matchedSkills.length > 0;

  /** 选中技能：把光标前的 `/前缀` 替换为 `/技能名 `（保留前后文字），并聚焦回输入框。 */
  function chooseSkill(name: string) {
    const textarea = textareaElement();
    const caret = textarea?.selectionStart ?? prompt.length;
    const before = prompt.slice(0, caret);
    const match = before.match(/(^|\s)\/([a-zA-Z0-9._-]*)$/);
    if (match) {
      const slashStart = caret - match[2].length - 1;
      const next = `${prompt.slice(0, slashStart)}/${name} ${prompt.slice(caret)}`;
      onPromptChange(next);
      requestAnimationFrame(() => {
        textarea?.focus();
        const pos = slashStart + name.length + 2;
        textarea?.setSelectionRange(pos, pos);
      });
    } else {
      onPromptChange(`/${name} `);
      requestAnimationFrame(() => textareaElement()?.focus());
    }
    setSkillMenuOpen(false);
  }
  const activeModel = findRuntimeModel(runtime, runtime?.provider, runtime?.model);
  // The select's displayed value: per-task model override, else the global
  // default. The title/width must follow the *selected* model — using the
  // global runtime model here makes the tooltip always show the default
  // (e.g. deepseek-v4-flash) even after switching this task to another model.
  const taskModelSelection = parseRuntimeModelSelectValue(taskModelValue);
  const taskModelInfo = taskModelSelection
    ? findRuntimeModel(runtime, taskModelSelection.provider, taskModelSelection.model)
    : undefined;
  // 思考强度选择器跟随「任务生效模型」（任务覆盖优先，否则全局默认）：
  // 选项、当前值、是否支持思考都按该模型解析，切换任务模型时自动变化。
  const reasoningSupported = taskModelInfo?.reasoningSupported ?? runtime?.reasoningSupported;
  const reasoningOptions: ReasoningEffort[] =
    taskModelInfo?.reasoningOptions ?? runtimeReasoningOptions;
  const reasoningEffortValue =
    taskReasoningEffort ?? taskModelInfo?.reasoningEffort ?? runtime?.reasoningEffort;
  const activeModelLabel =
    taskModelInfo?.displayName ||
    taskModelSelection?.model ||
    activeModel?.displayName ||
    runtime?.model ||
    '选择模型';
  const activeModelTitle = activeModelLabel;
  /** 推理等级展示文案（如 High），用于摘要按钮与浮层当前值。 */
  const reasoningEffortLabel = getReasoningOptions(reasoningOptions).find(
    (option) => option.value === reasoningEffortValue,
  )?.label ?? reasoningEffortValue ?? '';

  /** 模型/推理等级选择浮层内容：一级为参数行（模型 / 推理等级），点击进入对应选项列表。 */
  const renderModelPickerContent = (): ReactNode => {
    const close = () => setModelPickerOpen(false);
    if (modelPickerView === 'model') {
      return (
        <div className="pa-model-picker">
          <button
            type="button"
            className="pa-model-picker-back"
            onClick={() => setModelPickerView('root')}
          >
            <LeftOutlined /> 模型
          </button>
          {runtimeModels.length === 0 ? (
            <div className="pa-model-picker-empty">未配置</div>
          ) : (
            runtimeModels.map((group) => (
              <div key={group.label} className="pa-model-picker-group">
                <div className="pa-model-picker-group-label">{group.label}</div>
                {group.options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`pa-model-picker-option${
                      option.value === taskModelValue ? ' active' : ''
                    }`}
                    onClick={() => {
                      onTaskModelChange(option.value);
                      close();
                    }}
                  >
                    <span className="pa-model-picker-option-label">{option.label}</span>
                    {option.value === taskModelValue && (
                      <CheckOutlined className="pa-model-picker-check" aria-hidden="true" />
                    )}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      );
    }
    if (modelPickerView === 'reasoning') {
      return (
        <div className="pa-model-picker">
          <button
            type="button"
            className="pa-model-picker-back"
            onClick={() => setModelPickerView('root')}
          >
            <LeftOutlined /> 推理等级
          </button>
          {getReasoningOptions(reasoningOptions).map((option) => (
            <button
              key={option.value}
              type="button"
              className={`pa-model-picker-option${
                option.value === reasoningEffortValue ? ' active' : ''
              }`}
              onClick={() => {
                onReasoningChange(option.value as ReasoningEffort);
                close();
              }}
            >
              <span className="pa-model-picker-option-label">{option.label}</span>
              {option.value === reasoningEffortValue && (
                <CheckOutlined className="pa-model-picker-check" aria-hidden="true" />
              )}
            </button>
          ))}
        </div>
      );
    }
    return (
      <div className="pa-model-picker">
        <button
          type="button"
          className="pa-model-picker-row"
          onClick={() => setModelPickerView('model')}
        >
          <span className="pa-model-picker-label">模型</span>
          <span className="pa-model-picker-value">{activeModelLabel}</span>
          <RightOutlined className="pa-model-picker-chevron" aria-hidden="true" />
        </button>
        {reasoningSupported && (
          <button
            type="button"
            className="pa-model-picker-row"
            onClick={() => setModelPickerView('reasoning')}
          >
            <span className="pa-model-picker-label">推理等级</span>
            <span className="pa-model-picker-value">{reasoningEffortLabel}</span>
            <RightOutlined className="pa-model-picker-chevron" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  };

  return (
    <footer className="pa-composer-wrap">
      {pendingPermission && (
        <div
          className="pa-permission-floating"
          role="alertdialog"
          aria-labelledby="permission-title"
          aria-describedby="permission-description"
        >
          <div className="pa-permission-card">
            <div className="pa-permission-header">
              <Avatar size={30} icon={<ToolOutlined />} />
              <div>
                <strong id="permission-title">
                  {pendingTitle
                    ? `「${pendingTitle}」请求执行这个操作吗？`
                    : '允许执行这个操作吗？'}
                </strong>
                <span id="permission-description">
                  Agent 请求调用 <Text code>{pendingPermission.toolName}</Text>
                </span>
              </div>
            </div>
            <pre>{JSON.stringify(pendingPermission.params, null, 2)}</pre>
            <div className="pa-permission-actions">
              <Checkbox
                checked={rememberPermission}
                onChange={(event) => onRememberPermissionChange(event.target.checked)}
              >
                本次会话中记住此决定
              </Checkbox>
              <Space size={8}>
                <Button danger onClick={() => onAnswerPermission(false)}>
                  拒绝
                </Button>
                <Button
                  type="primary"
                  icon={<CheckCircleFilled />}
                  onClick={() => onAnswerPermission(true)}
                >
                  允许执行
                </Button>
              </Space>
            </div>
          </div>
        </div>
      )}
      {pendingQuestion && (
        <AskUserCard
          key={pendingQuestion.requestId}
          request={pendingQuestion}
          taskTitle={pendingQuestionTitle}
          onAnswer={onAnswerQuestion}
        />
      )}
      {showSkillMenu && (
        <div className="pa-skill-menu" role="listbox" aria-label="技能列表">
          {matchedSkills.map((skill) => (
            <button
              key={skill.name}
              type="button"
              role="option"
              className="pa-skill-menu-item"
              onClick={() => chooseSkill(skill.name)}
            >
              <span className="pa-skill-menu-name">/{skill.name}</span>
              <span className="pa-skill-menu-desc">{skill.description}</span>
            </button>
          ))}
        </div>
      )}
      {queuedMessages.length > 0 && (
        <div className="pa-queue-floating">
          <div className="pa-queue-card">
            <div className="pa-queue-header">
              <span className="pa-queue-title">消息队列（{queuedMessages.length}）</span>
              <span className="pa-queue-hint">任务结束后自动按序执行，也可插入当前执行循环</span>
            </div>
            <div className="pa-queue-list">
              {queuedMessages.map((item, index) => (
                <div className="pa-queue-item" key={item.id}>
                  <span className="pa-queue-index">{index + 1}</span>
                  <span className="pa-queue-text" title={item.text}>
                    {item.text}
                  </span>
                  <Tooltip
                    title={
                      busy
                        ? '插入到当前执行循环，作为补充消息引导模型思考方向'
                        : '当前任务空闲，立即执行'
                    }
                  >
                    <Button
                      type="text"
                      size="small"
                      className="pa-queue-action"
                      icon={<InboxOutlined />}
                      aria-label="插入当前任务"
                      disabled={!enabled || creatingTask}
                      onClick={() => onInjectQueued(item.id)}
                    />
                  </Tooltip>
                  <Tooltip title="删除">
                    <Button
                      type="text"
                      size="small"
                      className="pa-queue-action"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label="删除排队消息"
                      onClick={() => onRemoveQueued(item.id)}
                    />
                  </Tooltip>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {showScrollButton && (
        <Tooltip title="滚动到最新消息">
          <Button
            className="pa-scroll-latest"
            icon={<DownOutlined />}
            aria-label="滚动到最新消息"
            onClick={onScrollToLatest}
          />
        </Tooltip>
      )}
      {plusMenuOpen && (
        <div className="pa-plus-floating">
          <div className="pa-plus-menu" role="menu" aria-label="添加内容">
            <button
              type="button"
              role="menuitem"
              className="pa-plus-menu-item"
              data-testid="plus-menu-image"
              onClick={() => {
                setPlusMenuOpen(false);
                imageInputRef.current?.click();
              }}
            >
              <PictureOutlined />
              <span>图片上传</span>
            </button>
            <div className="pa-plus-menu-divider" aria-hidden="true" />
            <div
              className="pa-plus-menu-item"
              role="menuitem"
              aria-label="计划模式"
              onClick={() => {
                if (enabled && !busy && !creatingTask) {
                  setPlusMenuOpen(false);
                  onPlanModeChange(!planActive);
                }
              }}
            >
              <FileTextOutlined />
              <div className="pa-plus-menu-plan-row">
                <span className="pa-plus-menu-label">计划模式</span>
                <span className="pa-plus-menu-plan-desc">先制定方案，确认后再执行</span>
                <Switch
                  size="small"
                  checked={planActive}
                  disabled={!enabled || busy || creatingTask}
                  onClick={(checked, event) => event.stopPropagation()}
                  onChange={(checked) => {
                    setPlusMenuOpen(false);
                    onPlanModeChange(checked);
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="pa-composer">
        <div className="pa-md-toolbar">
          <div className="pa-md-toolbar-left">
            <Button
              type="text"
              size="small"
              className="pa-md-toolbar-toggle"
              disabled={!enabled || creatingTask || Boolean(pendingQuestion)}
              onClick={() => setToolbarOpen((open) => !open)}
            >
              Markdown 工具栏
              <DownOutlined
                style={{
                  fontSize: 9,
                  transition: 'transform 0.2s ease',
                  transform: toolbarOpen ? 'rotate(180deg)' : undefined,
                }}
              />
            </Button>
            <span className="pa-md-hint">支持 Markdown</span>
          </div>
          <div className="pa-md-toolbar-right">
            <Button
              type="text"
              size="small"
              disabled={!enabled || creatingTask || Boolean(pendingQuestion)}
              icon={previewMode ? <EditOutlined /> : <EyeOutlined />}
              onClick={() => setPreviewMode((mode) => !mode)}
            >
              {previewMode ? '编辑' : '预览'}
            </Button>
          </div>
        </div>
        {toolbarOpen && (
          <div className="pa-md-toolbar-actions">
            <Tooltip title="加粗">
              <Button
                type="text"
                size="small"
                icon={<BoldOutlined />}
                disabled={!enabled}
                onClick={() => applyInline('**', '**', '加粗文本')}
              />
            </Tooltip>
            <Tooltip title="斜体">
              <Button
                type="text"
                size="small"
                icon={<ItalicOutlined />}
                disabled={!enabled}
                onClick={() => applyInline('*', '*', '斜体文本')}
              />
            </Tooltip>
            <Tooltip title="行内代码">
              <Button
                type="text"
                size="small"
                icon={<CodeOutlined />}
                disabled={!enabled}
                onClick={() => applyInline('`', '`', '代码')}
              />
            </Tooltip>
            <Tooltip title="链接">
              <Button
                type="text"
                size="small"
                icon={<LinkOutlined />}
                disabled={!enabled}
                onClick={() => applyInline('[', '](https://)', '链接文字')}
              />
            </Tooltip>
            <span className="pa-md-toolbar-sep" aria-hidden="true" />
            <Tooltip title="标题">
              <Button
                type="text"
                size="small"
                icon={<FontSizeOutlined />}
                disabled={!enabled}
                onClick={() => applyLinePrefix('## ', '标题')}
              />
            </Tooltip>
            <Tooltip title="无序列表">
              <Button
                type="text"
                size="small"
                icon={<UnorderedListOutlined />}
                disabled={!enabled}
                onClick={() => applyLinePrefix('- ', '列表项')}
              />
            </Tooltip>
            <Tooltip title="有序列表">
              <Button
                type="text"
                size="small"
                icon={<OrderedListOutlined />}
                disabled={!enabled}
                onClick={() => applyLinePrefix('1. ', '列表项')}
              />
            </Tooltip>
            <Tooltip title="引用">
              <Button
                type="text"
                size="small"
                icon={<CommentOutlined />}
                disabled={!enabled}
                onClick={() => applyLinePrefix('> ', '引用内容')}
              />
            </Tooltip>
            <Tooltip title="代码块">
              <Button
                type="text"
                size="small"
                icon={<CodeOutlined />}
                disabled={!enabled}
                onClick={applyCodeBlock}
              />
            </Tooltip>
            <Tooltip title="表格">
              <Button
                type="text"
                size="small"
                icon={<TableOutlined />}
                disabled={!enabled}
                onClick={() => insertSnippet('\n| 列1 | 列2 |\n| --- | --- |\n| 内容 | 内容 |\n')}
              />
            </Tooltip>
            <Tooltip title="分隔线">
              <Button
                type="text"
                size="small"
                icon={<MinusOutlined />}
                disabled={!enabled}
                onClick={() => insertSnippet('\n---\n')}
              />
            </Tooltip>
          </div>
        )}
        {images.length > 0 && (
          <div className="pa-composer-images" data-testid="prompt-image-list">
            {images.map((image, index) => (
              <div className="pa-composer-image" key={`${image.name}-${index}`}>
                <Image
                  src={promptImageSrc(image)}
                  alt={image.name}
                  preview={{ mask: null }}
                />
                <span title={image.name}>{image.name}</span>
                <Button
                  type="text"
                  size="small"
                  icon={<CloseOutlined />}
                  aria-label={`移除图片 ${image.name}`}
                  onClick={() =>
                    onImagesChange(images.filter((_, itemIndex) => itemIndex !== index))
                  }
                />
              </div>
            ))}
          </div>
        )}
        {previewMode ? (
          <div className="pa-composer-preview pa-message-content">
            {prompt.trim() ? (
              <MarkdownContent text={prompt} />
            ) : (
              <span className="pa-composer-preview-empty">暂无内容</span>
            )}
          </div>
        ) : (
          <div className="pa-composer-input-wrap">
            <div ref={highlightRef} className="pa-composer-highlight" aria-hidden="true">
              {renderHighlightedPrompt(prompt, skills)}
            </div>
            <TextArea
              ref={textAreaRef}
              id="prompt-input"
              data-testid="prompt-input"
              value={prompt}
              disabled={!enabled || creatingTask || Boolean(pendingQuestion)}
              autoSize={{ minRows: 2, maxRows: 8 }}
              placeholder={placeholder}
              onChange={(event) => {
                onPromptChange(event.target.value);
                // 输入任意位置出现 / 前缀即尝试打开技能菜单（渲染时按光标位置过滤）
                setSkillMenuOpen(event.target.value.includes('/'));
              }}
              onPaste={(event) => {
                const pastedImages = Array.from(event.clipboardData.items)
                  .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => Boolean(file));
                if (pastedImages.length === 0) return;
                event.preventDefault();
                void selectImages(pastedImages);
              }}
              onScroll={(event) => {
                if (highlightRef.current) {
                  highlightRef.current.scrollTop = event.currentTarget.scrollTop;
                }
              }}
              onKeyDown={(event) => {
                if (
                  (event.ctrlKey || event.metaKey) &&
                  event.key.toLowerCase() === 'c' &&
                  event.currentTarget.selectionStart === event.currentTarget.selectionEnd
                ) {
                  void pasteClipboardImagesOnCopyShortcut();
                }
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  setSkillMenuOpen(false);
                  onSubmit();
                }
                if (event.key === 'Escape') setSkillMenuOpen(false);
              }}
            />
          </div>
        )}
        <div className="pa-composer-bottom">
          <div className="pa-composer-left">
            <input
              ref={imageInputRef}
              type="file"
              hidden
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif"
              data-testid="prompt-image-input"
              onChange={(event) => {
                void selectImages(event.currentTarget.files);
                event.currentTarget.value = '';
              }}
            />
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              disabled={!enabled || busy || creatingTask || Boolean(pendingQuestion)}
              aria-label="添加附件"
              data-testid="add-attachment"
              onClick={() => setPlusMenuOpen((open) => !open)}
            />
            <Select
              value={permissionMode}
              options={permissionOptions}
              disabled={!enabled || busy || creatingTask}
              popupMatchSelectWidth={false}
              aria-label="设置工具权限"
              onChange={(value: PermissionMode) => onPermissionModeChange(value)}
            />
            {planActive && (
              <Tag color="processing" icon={<FileTextOutlined />} className="pa-plan-tag">
                计划
              </Tag>
            )}
            <Tooltip
              title={
                <ContextUsagePanel
                  usage={contextUsage}
                  footer={
                    <Button
                      size="small"
                      block
                      icon={<CompressOutlined />}
                      disabled={busy || creatingTask || !contextUsage}
                      loading={compressing}
                      onClick={onCompressContext}
                    >
                      压缩上下文
                    </Button>
                  }
                />
              }
              placement="top"
              classNames={{ root: 'pa-context-tip-overlay' }}
            >
              <Button
                type="text"
                size="small"
                icon={<DashboardOutlined />}
                aria-label="查看上下文使用情况"
              />
            </Tooltip>
          </div>
          <div className="pa-composer-right">
            <Dropdown
              trigger={['click']}
              open={modelPickerOpen}
              onOpenChange={(open) => {
                setModelPickerOpen(open);
                if (open) setModelPickerView('root');
              }}
              placement="topRight"
              classNames={{ root: 'pa-model-picker-overlay' }}
              popupRender={() => renderModelPickerContent()}
              disabled={runtimeDisabled}
            >
              <button
                type="button"
                className="pa-model-summary"
                disabled={runtimeDisabled}
                title={`${activeModelTitle}（当前任务模型，可独立于其他任务）${
                  reasoningSupported && reasoningEffortLabel ? ` · 推理等级 ${reasoningEffortLabel}` : ''
                }`}
                aria-label="切换当前任务模型与思考强度"
              >
                <span className="pa-model-summary-text">
                  {activeModelLabel}
                  {reasoningSupported && reasoningEffortLabel && (
                    <span className="pa-model-summary-effort">{reasoningEffortLabel}</span>
                  )}
                </span>
                {modelPickerOpen ? (
                  <UpOutlined className="pa-model-summary-arrow" aria-hidden="true" />
                ) : (
                  <DownOutlined className="pa-model-summary-arrow" aria-hidden="true" />
                )}
              </button>
            </Dropdown>
            {busy && (
              <Tooltip title="停止生成">
                <button
                  type="button"
                  className="pa-stop-btn"
                  aria-label="停止生成"
                  data-testid="stop-generating"
                  onClick={onStop}
                >
                  <svg
                    className="pa-stop-icon"
                    viewBox="0 0 24 24"
                    width="13"
                    height="13"
                    fill="none"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <rect
                      x="6.2"
                      y="6.2"
                      width="11.6"
                      height="11.6"
                      rx="2.2"
                      stroke="currentColor"
                      strokeWidth="2.4"
                    />
                  </svg>
                </button>
              </Tooltip>
            )}
            {/* 发送按钮始终存在：任务执行中点击会把消息加入排队队列（不直接发送） */}
            <Tooltip title={busy ? '任务执行中，发送将加入队列' : '发送消息'}>
              <Button
                type="primary"
                shape="circle"
                icon={<SendOutlined />}
                loading={creatingTask}
                disabled={!enabled || creatingTask || (!prompt.trim() && images.length === 0)}
                aria-label="发送消息"
                data-testid="send-message"
                onClick={() => onSubmit()}
              />
            </Tooltip>
          </div>
        </div>
      </div>
      <p className="pa-disclaimer">Agent 可能会出错。请在批准工具调用前检查参数。</p>
    </footer>
  );
}

function ModelDebugModal({
  open,
  calls,
  selectedCallId,
  onSelectCall,
  onClose,
}: {
  open: boolean;
  calls: ModelCallTrace[];
  selectedCallId?: string;
  onSelectCall: (callId: string) => void;
  onClose: () => void;
}) {
  const selectedCall = calls.find((call) => call.callId === selectedCallId) ?? calls.at(-1);

  return (
    <Modal
      title={
        <div>
          <span className="pa-eyebrow">LLM CALL TRACE</span>
          <div>模型调用调试</div>
        </div>
      }
      open={open}
      width={1180}
      footer={
        <Button type="primary" onClick={onClose}>
          关闭
        </Button>
      }
      onCancel={onClose}
      className="pa-debug-modal"
    >
      <Alert
        type="info"
        showIcon
        title="这里展示当前这次用户请求触发的实际模型调用；数据仅保存在当前页面内存中，且不包含 API Key。"
      />
      {selectedCall ? (
        <div className="pa-debug-layout">
          <aside className="pa-debug-call-list" aria-label="模型调用列表">
            <div className="pa-debug-call-list-heading">
              <strong>调用记录</strong>
              <Tag>{calls.length} 次</Tag>
            </div>
            {calls.map((call, index) => (
              <button
                type="button"
                key={call.callId}
                className={`pa-debug-call-item${call.callId === selectedCall.callId ? ' active' : ''}`}
                onClick={() => onSelectCall(call.callId)}
              >
                <span className="pa-debug-call-item-title">
                  <strong>{call.label ?? `第 ${index + 1} 次调用`}</strong>
                  <Tag color={modelCallStatusColor(call.status)}>
                    {modelCallStatusLabel(call.status)}
                  </Tag>
                </span>
                <span>
                  {call.provider} · {call.model}
                </span>
                <small>
                  {call.kind === 'vision' ? '视觉预处理' : `Turn ${call.turnNumber}`}
                  {call.durationMs === undefined ? '' : ` · ${call.durationMs} ms`}
                </small>
              </button>
            ))}
          </aside>
          <section className="pa-debug-detail">
            <div className="pa-debug-metadata">
              <div>
                <span>阶段</span>
                <strong>{selectedCall.label ?? '主 Agent 调用'}</strong>
              </div>
              <div>
                <span>Provider</span>
                <strong>{selectedCall.provider}</strong>
              </div>
              <div>
                <span>Model</span>
                <strong>{selectedCall.model}</strong>
              </div>
              <div>
                <span>开始时间</span>
                <strong>{formatDebugTimestamp(selectedCall.startedAt)}</strong>
              </div>
              <div>
                <span>耗时</span>
                <strong>
                  {selectedCall.durationMs === undefined
                    ? '进行中'
                    : `${selectedCall.durationMs} ms`}
                </strong>
              </div>
            </div>
            {selectedCall.error && <Alert type="error" showIcon title={selectedCall.error} />}
            <div className="pa-debug-json-grid">
              <DebugJsonPanel
                title="请求入参"
                value={{
                  provider: selectedCall.provider,
                  model: selectedCall.model,
                  ...selectedCall.request,
                }}
              />
              <DebugJsonPanel
                title="响应出参"
                value={
                  selectedCall.response ?? {
                    status: 'running',
                    message: '等待模型返回…',
                  }
                }
              />
            </div>
          </section>
        </div>
      ) : (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="发送一条消息后，这里会显示模型调用的请求入参与响应出参。"
        />
      )}
    </Modal>
  );
}

interface StatsSummaryData {
  count: number;
  errorCount: number;
  interruptedCount: number;
  inputTokens: number;
  outputTokens: number;
  avgDurationMs: number;
}

interface StatsByModelRow {
  provider: string;
  model: string;
  count: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
}

interface StatsByDayRow {
  day: string;
  count: number;
  inputTokens: number;
  outputTokens: number;
}

interface StatsRecordRow {
  id: number;
  createdAt?: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestMessages?: unknown;
  response?: {
    text?: string;
    thinking?: string;
    toolCalls?: unknown;
    messageId?: string;
  };
  error?: string;
}

interface StatsModalResponse {
  available: boolean;
  days: number;
  summary?: StatsSummaryData;
  byModel?: StatsByModelRow[];
  byDay?: StatsByDayRow[];
  total?: number;
  records?: StatsRecordRow[];
}

function StatsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [days, setDays] = useState(7);
  const [refreshTick, setRefreshTick] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [statsTab, setStatsTab] = useState<'overview' | 'records'>('overview');
  const [data, setData] = useState<StatsModalResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch(`/api/stats?days=${days}&page=${page}&pageSize=${pageSize}`)
      .then((response) => {
        if (!response.ok) throw new Error(`统计接口请求失败 (${response.status})`);
        return response.json() as Promise<StatsModalResponse>;
      })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, days, refreshTick, page, pageSize]);

  return (
    <Modal
      title={
        <div>
          <span className="pa-eyebrow">MODEL STATS</span>
          <div>模型统计</div>
        </div>
      }
      open={open}
      width={980}
      footer={
        <Button type="primary" onClick={onClose}>
          关闭
        </Button>
      }
      onCancel={onClose}
      className="pa-stats-modal"
    >
      <Alert
        type="info"
        showIcon
        title="统计来自本地 SQLite 数据库 ~/.personal-agent/stats/model-requests.db；是否保存请求入参/出参由设置中的「统计模型请求入参/出参」开关控制。"
      />
      <Space className="pa-stats-toolbar">
        <Select
          value={days}
          onChange={(value) => {
            setPage(1);
            setDays(value);
          }}
          style={{ width: 140 }}
          options={[
            { value: 7, label: '最近 7 天' },
            { value: 30, label: '最近 30 天' },
            { value: 90, label: '最近 90 天' },
          ]}
        />
        <Button
          icon={<ReloadOutlined />}
          onClick={() => setRefreshTick((value) => value + 1)}
          disabled={loading}
        >
          刷新
        </Button>
      </Space>
      {error ? (
        <Alert type="error" showIcon title={error} />
      ) : data && data.available === false ? (
        <Alert
          type="warning"
          showIcon
          title="模型统计当前不可用"
          description="当前运行环境缺少 node:sqlite（需要 Node.js >= 22.13），或统计数据库初始化失败。"
        />
      ) : data && data.summary ? (
        <div className="pa-stats-body">
          <Tabs
            activeKey={statsTab}
            onChange={(key) => setStatsTab(key as 'overview' | 'records')}
            items={[
              {
                key: 'overview',
                label: '统计概览',
                children: (
                  <>
                    <div className="pa-stats-summary">
                      <Statistic title="调用次数" value={data.summary.count} />
                      <Statistic
                        title="失败"
                        value={data.summary.errorCount}
                        valueStyle={{ color: '#cf1322' }}
                      />
                      <Statistic title="中断" value={data.summary.interruptedCount} />
                      <Statistic title="输入 tokens" value={data.summary.inputTokens} />
                      <Statistic title="输出 tokens" value={data.summary.outputTokens} />
                      <Statistic
                        title="平均耗时"
                        value={
                          data.summary.avgDurationMs >= 1000
                            ? `${(data.summary.avgDurationMs / 1000).toFixed(1)} s`
                            : `${Math.round(data.summary.avgDurationMs)} ms`
                        }
                      />
                    </div>
                    <Table<StatsByModelRow>
                      size="small"
                      rowKey={(row) => `${row.provider}:${row.model}`}
                      title={() => '按模型'}
                      loading={loading}
                      dataSource={data.byModel ?? []}
                      pagination={false}
                      columns={[
                        { title: 'Provider', dataIndex: 'provider' },
                        { title: '模型', dataIndex: 'model' },
                        { title: '次数', dataIndex: 'count', align: 'right' },
                        { title: '错误', dataIndex: 'errorCount', align: 'right' },
                        { title: '输入 tokens', dataIndex: 'inputTokens', align: 'right' },
                        { title: '输出 tokens', dataIndex: 'outputTokens', align: 'right' },
                      ]}
                    />

                    <Table<StatsByDayRow>
                      size="small"
                      rowKey={(row) => row.day}
                      title={() => '按天'}
                      loading={loading}
                      dataSource={data.byDay ?? []}
                      pagination={false}
                      columns={[
                        { title: '日期', dataIndex: 'day' },
                        { title: '次数', dataIndex: 'count', align: 'right' },
                        { title: '输入 tokens', dataIndex: 'inputTokens', align: 'right' },
                        { title: '输出 tokens', dataIndex: 'outputTokens', align: 'right' },
                      ]}
                    />
                  </>
                ),
              },
              {
                key: 'records',
                label: '详细记录',
                children: (
                  <Table<StatsRecordRow>
                    size="small"
                    rowKey={(row) => row.id}
                    title={() => '详细记录'}
                    loading={loading}
                    dataSource={data.records ?? []}
                    pagination={{
                      current: page,
                      pageSize,
                      total: data.total ?? 0,
                      showSizeChanger: true,
                      pageSizeOptions: [10, 20, 50],
                      showTotal: (total) => `共 ${total} 条`,
                      onChange: (nextPage, nextPageSize) => {
                        setPage(nextPage);
                        setPageSize(nextPageSize);
                      },
                    }}
                    columns={[
                      {
                        title: '创建时间',
                        dataIndex: 'createdAt',
                        render: (value: number | undefined) =>
                          value === undefined ? '-' : formatStatsTime(value),
                      },
                      { title: '供应商', dataIndex: 'provider' },
                      { title: '模型', dataIndex: 'model' },
                      { title: '输入 tokens', dataIndex: 'inputTokens', align: 'right' },
                      { title: '输出 tokens', dataIndex: 'outputTokens', align: 'right' },
                      {
                        title: '请求入参',
                        render: (value: unknown) =>
                          value === undefined ? (
                            <Text type="secondary">未记录</Text>
                          ) : (
                            <StatsPayloadCell
                              text={excerptText(renderStatsPayload(value), 80)}
                              copyValue={renderStatsPayload(value)}
                            />
                          ),
                      },
                      {
                        title: '出参',
                        render: (_value: unknown, row) =>
                          row.response === undefined ? (
                            row.error ? (
                              <Text type="danger">{excerptText(row.error, 60)}</Text>
                            ) : (
                              '-'
                            )
                          ) : (
                            <StatsPayloadCell
                              text={excerptText(renderStatsPayload(row.response), 80)}
                              copyValue={renderStatsPayload(row.response)}
                            />
                          ),
                      },
                    ]}
                  />
                ),
              },
            ]}
          />
        </div>
      ) : loading ? (
        <div className="pa-stats-loading">
          <Spin />
        </div>
      ) : null}
    </Modal>
  );
}

function StatsPayloadCell({ text, copyValue }: { text: string; copyValue: string }) {
  const { message: messageApi } = AntApp.useApp();

  async function copyPayload() {
    try {
      if (!navigator.clipboard) throw new Error('当前浏览器不支持自动复制，请手动选择文本');
      await navigator.clipboard.writeText(copyValue);
      messageApi.success('已复制');
    } catch (err) {
      messageApi.error(`复制失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="pa-stats-payload-cell">
      <span className="pa-stats-payload-text">{text}</span>
      <Button
        type="text"
        size="small"
        className="pa-stats-copy-btn"
        icon={<CopyOutlined />}
        aria-label="复制"
        onClick={copyPayload}
      />
    </div>
  );
}

function formatStatsTime(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function renderStatsPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function excerptText(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function GeneralSettingsPanel({
  colorMode,
  onToggleColorMode,
  accentColors,
  onAccentColorsChange,
  onResetAccent,
  onRuntimeChange,
}: {
  colorMode: ColorMode;
  onToggleColorMode: () => void;
  accentColors: AccentColors;
  onAccentColorsChange: (colors: AccentColors) => void;
  onResetAccent: () => void;
  onRuntimeChange: (runtime: RuntimeInfo) => void;
}) {
  const { message: messageApi } = AntApp.useApp();
  const [recordPayloads, setRecordPayloads] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const [savingMaxTurns, setSavingMaxTurns] = useState(false);
  const [shell, setShell] = useState<'auto' | 'powershell' | 'bash' | null>(null);
  const [savingShell, setSavingShell] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState<boolean | null>(null);
  const [savingMemoryEnabled, setSavingMemoryEnabled] = useState(false);
  const [memoryMaxEntries, setMemoryMaxEntries] = useState<number | null>(null);
  const [savingMemoryMaxEntries, setSavingMemoryMaxEntries] = useState(false);
  const [visionSettings, setVisionSettings] = useState<VisionSettingsInfo | null>(null);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionProvider, setVisionProvider] = useState<ProviderId>();
  const [visionModel, setVisionModel] = useState<string>();
  const [savingVision, setSavingVision] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/stats-config')
      .then((response) => {
        if (!response.ok) throw new Error(`读取统计配置失败 (${response.status})`);
        return response.json() as Promise<{ recordPayloads: boolean }>;
      })
      .then((payload) => {
        if (!cancelled) setRecordPayloads(payload.recordPayloads);
      })
      .catch((err: unknown) => {
        if (!cancelled) messageApi.error(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [messageApi]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/vision-settings')
      .then(async (response) => {
        const payload = (await response.json()) as VisionSettingsInfo & { error?: string };
        if (!response.ok)
          throw new Error(payload.error ?? `读取视觉模型配置失败 (${response.status})`);
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setVisionSettings(payload);
        setVisionEnabled(payload.enabled);
        setVisionProvider(payload.provider);
        setVisionModel(payload.model);
      })
      .catch((err: unknown) => {
        if (!cancelled) messageApi.error(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [messageApi]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/agent-config')
      .then((response) => {
        if (!response.ok) throw new Error(`读取 Agent 配置失败 (${response.status})`);
        return response.json() as Promise<{
          maxTurns: number;
          shell: 'auto' | 'powershell' | 'bash';
        }>;
      })
      .then((payload) => {
        if (!cancelled) {
          setMaxTurns(payload.maxTurns);
          setShell(payload.shell);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) messageApi.error(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [messageApi]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/memory-config')
      .then((response) => {
        if (!response.ok) throw new Error(`读取记忆配置失败 (${response.status})`);
        return response.json() as Promise<{ enabled: boolean; maxEntries: number }>;
      })
      .then((payload) => {
        if (!cancelled) {
          setMemoryEnabled(payload.enabled);
          setMemoryMaxEntries(payload.maxEntries);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) messageApi.error(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [messageApi]);

  async function toggleRecordPayloads(value: boolean) {
    setRecordPayloads(value);
    setSaving(true);
    try {
      const response = await apiFetch('/api/stats-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recordPayloads: value }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败 (${response.status})`);
      }
      messageApi.success(value ? '已开启：新请求将保存完整入参/出参' : '已关闭：仅保存统计元数据');
    } catch (err) {
      messageApi.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
      setRecordPayloads((current) => (current === null ? null : !current));
    } finally {
      setSaving(false);
    }
  }

  async function persistMaxTurns(value: number | null) {
    if (value === null || value === undefined) return;
    if (!Number.isInteger(value) || value < 50 || value > 500) {
      messageApi.warning('最大循环轮数必须是 50–500 之间的整数。');
      // 输入非法时回滚为服务端当前值
      apiFetch('/api/agent-config')
        .then((response) => response.json() as Promise<{ maxTurns: number }>)
        .then((payload) => setMaxTurns(payload.maxTurns))
        .catch(() => undefined);
      return;
    }
    setSavingMaxTurns(true);
    try {
      const response = await apiFetch('/api/agent-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxTurns: value }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败 (${response.status})`);
      }
      const payload = (await response.json()) as { maxTurns: number };
      setMaxTurns(payload.maxTurns);
      messageApi.success(`已保存：最大循环轮数 ${payload.maxTurns}`);
    } catch (err) {
      messageApi.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
      // 保存失败时回滚为服务端当前值
      apiFetch('/api/agent-config')
        .then((response) => response.json() as Promise<{ maxTurns: number }>)
        .then((payload) => setMaxTurns(payload.maxTurns))
        .catch(() => undefined);
    } finally {
      setSavingMaxTurns(false);
    }
  }

  async function persistShell(value: 'auto' | 'powershell' | 'bash' | null) {
    if (value === null || value === undefined) return;
    setSavingShell(true);
    try {
      const response = await apiFetch('/api/agent-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shell: value }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败 (${response.status})`);
      }
      const payload = (await response.json()) as {
        shell: 'auto' | 'powershell' | 'bash';
      };
      setShell(payload.shell);
      messageApi.success('已保存：bash 工具使用的 shell 配置');
    } catch (err) {
      messageApi.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
      // 保存失败时回滚为服务端当前值
      apiFetch('/api/agent-config')
        .then((response) => response.json() as Promise<{ shell: 'auto' | 'powershell' | 'bash' }>)
        .then((payload) => setShell(payload.shell))
        .catch(() => undefined);
    } finally {
      setSavingShell(false);
    }
  }

  async function toggleMemoryEnabled(value: boolean) {
    setMemoryEnabled(value);
    setSavingMemoryEnabled(true);
    try {
      const response = await apiFetch('/api/memory-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: value }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败 (${response.status})`);
      }
      messageApi.success(value ? '已开启记忆' : '已关闭记忆');
    } catch (err) {
      messageApi.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
      setMemoryEnabled((current) => (current === null ? null : !current));
    } finally {
      setSavingMemoryEnabled(false);
    }
  }

  async function persistMemoryMaxEntries(value: number | null) {
    if (value === null || value === undefined) return;
    if (!Number.isInteger(value) || value < 1 || value > 100000) {
      messageApi.warning('最大记忆条数必须是 1–100000 之间的整数。');
      // 输入非法时回滚为服务端当前值
      apiFetch('/api/memory-config')
        .then((response) => response.json() as Promise<{ maxEntries: number }>)
        .then((payload) => setMemoryMaxEntries(payload.maxEntries))
        .catch(() => undefined);
      return;
    }
    setSavingMemoryMaxEntries(true);
    try {
      const response = await apiFetch('/api/memory-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxEntries: value }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败 (${response.status})`);
      }
      const payload = (await response.json()) as { maxEntries: number };
      setMemoryMaxEntries(payload.maxEntries);
      messageApi.success(`已保存：最大记忆条数 ${payload.maxEntries}`);
    } catch (err) {
      messageApi.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
      // 保存失败时回滚为服务端当前值
      apiFetch('/api/memory-config')
        .then((response) => response.json() as Promise<{ maxEntries: number }>)
        .then((payload) => setMemoryMaxEntries(payload.maxEntries))
        .catch(() => undefined);
    } finally {
      setSavingMemoryMaxEntries(false);
    }
  }

  async function saveVisionSettingsForm() {
    if (visionEnabled && (!visionProvider || !visionModel)) {
      messageApi.warning('启用视觉模型前请选择供应商和模型。');
      return;
    }
    setSavingVision(true);
    try {
      const response = await apiFetch('/api/vision-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: visionEnabled,
          provider: visionEnabled ? visionProvider : undefined,
          model: visionEnabled ? visionModel : undefined,
        }),
      });
      const payload = (await response.json()) as VisionSettingsInfo & {
        runtime?: RuntimeInfo;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? `保存失败 (${response.status})`);
      setVisionSettings(payload);
      setVisionEnabled(payload.enabled);
      setVisionProvider(payload.provider);
      setVisionModel(payload.model);
      // REST 响应直接回写，避免等待 WebSocket 广播时仍使用旧的 visionReady。
      if (payload.runtime) {
        onRuntimeChange(payload.runtime);
      }
      messageApi.success('视觉模型配置已保存');
    } catch (err) {
      messageApi.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingVision(false);
    }
  }

  const visionProviders = Array.from(
    new Map(
      (visionSettings?.models ?? []).map((model) => [
        model.provider,
        { value: model.provider, label: providerLabels[model.provider] ?? model.providerName },
      ]),
    ).values(),
  );
  const visionModels = (visionSettings?.models ?? [])
    .filter((model) => model.provider === visionProvider)
    .map((model) => ({
      value: model.model,
      label:
        model.displayName === model.model ? model.model : `${model.displayName} (${model.model})`,
    }));

  return (
    <div className="pa-settings-general">
      <div className="pa-settings-heading">
        <div>
          <Title level={4}>通用</Title>
          <Text type="secondary">Agent 运行与模型请求统计的通用设置。</Text>
        </div>
      </div>
      <Card size="small" title="外观" className="pa-appearance-card">
        <Form
          layout="horizontal"
          colon
          labelAlign="left"
          labelCol={{ flex: '220px' }}
          style={{ maxWidth: 640 }}
        >
          <Form.Item
            label={
              <Space size={4}>
                主题模式
                <Tooltip title="浅色与深色模式可各自配置主色，切换后互不影响。">
                  <QuestionCircleOutlined className="pa-settings-help" />
                </Tooltip>
              </Space>
            }
          >
            <Segmented
              value={colorMode}
              options={[
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ]}
              onChange={(value) => {
                const mode = value as ColorMode;
                if (mode !== colorMode) onToggleColorMode();
              }}
            />
          </Form.Item>
          <Form.Item label="浅色模式主色">
            <AccentPicker
              mode="light"
              value={accentColors.light}
              onChange={(color) => onAccentColorsChange({ ...accentColors, light: color })}
            />
          </Form.Item>
          <Form.Item label="深色模式主色">
            <AccentPicker
              mode="dark"
              value={accentColors.dark}
              onChange={(color) => onAccentColorsChange({ ...accentColors, dark: color })}
            />
          </Form.Item>
          <Form.Item label=" " colon={false}>
            <Button size="small" icon={<ReloadOutlined />} onClick={onResetAccent}>
              恢复默认主色
            </Button>
          </Form.Item>
        </Form>
      </Card>
      <Card size="small">
        <Form
          layout="horizontal"
          colon
          labelAlign="left"
          labelCol={{ flex: '220px' }}
          style={{ maxWidth: 640 }}
        >
          <Form.Item
            label={
              <Space size={4}>
                统计模型请求入参/出参
                <Tooltip title="开启后，新产生的模型请求会保存完整入参。">
                  <QuestionCircleOutlined className="pa-settings-help" />
                </Tooltip>
              </Space>
            }
          >
            <Switch
              checked={recordPayloads ?? false}
              disabled={recordPayloads === null}
              loading={saving}
              onChange={toggleRecordPayloads}
            />
          </Form.Item>
          <Form.Item
            label={
              <Space size={4}>
                最大循环轮数
                <Tooltip title="单次任务中 Agent 最多执行的循环轮数（50-500），达到上限后任务自动结束；修改后对新建任务立即生效。">
                  <QuestionCircleOutlined className="pa-settings-help" />
                </Tooltip>
              </Space>
            }
          >
            <InputNumber
              min={50}
              max={500}
              precision={0}
              value={maxTurns ?? undefined}
              disabled={maxTurns === null || savingMaxTurns}
              onChange={(value) => setMaxTurns(value as number | null)}
              onBlur={() => void persistMaxTurns(maxTurns)}
              onPressEnter={() => void persistMaxTurns(maxTurns)}
              style={{ width: 140 }}
            />
          </Form.Item>
          <Form.Item
            label={
              <Space size={4}>
                bash 工具 Shell
                <Tooltip title="选择bash工具在系统上使用的命令环境">
                  <QuestionCircleOutlined className="pa-settings-help" />
                </Tooltip>
              </Space>
            }
          >
            <Select
              value={shell ?? undefined}
              disabled={shell === null || savingShell}
              loading={savingShell}
              style={{ width: 320 }}
              onChange={(value: 'auto' | 'powershell' | 'bash') => void persistShell(value)}
              options={[
                {
                  value: 'auto',
                  label: '自动（Windows 默认 PowerShell）',
                },
                { value: 'powershell', label: 'PowerShell' },
                { value: 'bash', label: 'bash（Git Bash 或 WSL）' },
              ]}
            />
          </Form.Item>
        </Form>
      </Card>
      <Card size="small" title="记忆">
        <Form
          layout="horizontal"
          colon
          labelAlign="left"
          labelCol={{ flex: '220px' }}
          style={{ maxWidth: 640 }}
        >
          <Form.Item
            label={
              <Space size={4}>
                是否开启
                <Tooltip title="开启后，Agent 会跨会话记住用户的事实、偏好与决策，并在对话中自动注入相关记忆。">
                  <QuestionCircleOutlined className="pa-settings-help" />
                </Tooltip>
              </Space>
            }
          >
            <Switch
              checked={memoryEnabled ?? false}
              disabled={memoryEnabled === null}
              loading={savingMemoryEnabled}
              onChange={toggleMemoryEnabled}
            />
          </Form.Item>
          <Form.Item
            label={
              <Space size={4}>
                最大记忆条数
                <Tooltip title="记忆库的条目上限（1-100000），超出后按「重要性 + 最近访问」自动淘汰最不重要的记忆。">
                  <QuestionCircleOutlined className="pa-settings-help" />
                </Tooltip>
              </Space>
            }
          >
            <InputNumber
              min={1}
              max={100000}
              precision={0}
              value={memoryMaxEntries ?? undefined}
              disabled={memoryMaxEntries === null || savingMemoryMaxEntries}
              onChange={(value) => setMemoryMaxEntries(value as number | null)}
              onBlur={() => void persistMemoryMaxEntries(memoryMaxEntries)}
              onPressEnter={() => void persistMemoryMaxEntries(memoryMaxEntries)}
              style={{ width: 140 }}
            />
          </Form.Item>
        </Form>
      </Card>
      <Card size="small" title="视觉模型" data-testid="vision-settings-card">
        <Text type="secondary" className="pa-settings-card-description">
          全局用于前端截图审查，以及当前任务模型不支持图片时的用户图片识别。这里只显示已配置且支持图片输入的模型。
        </Text>
        {!visionSettings ? (
          <Spin size="small" />
        ) : (
          <Form
            layout="horizontal"
            colon
            labelAlign="left"
            labelCol={{ flex: '220px' }}
            style={{ maxWidth: 640 }}
          >
            <Form.Item label="启用视觉模型">
              <Switch checked={visionEnabled} disabled={savingVision} onChange={setVisionEnabled} />
            </Form.Item>
            <Form.Item label="视觉供应商">
              <Select
                aria-label="视觉供应商"
                value={visionProvider}
                disabled={savingVision || visionProviders.length === 0}
                placeholder="选择已配置的模型供应商"
                options={visionProviders}
                onChange={(provider: ProviderId) => {
                  setVisionProvider(provider);
                  const firstModel = visionSettings.models.find(
                    (candidate) => candidate.provider === provider,
                  );
                  setVisionModel(firstModel?.model);
                }}
              />
            </Form.Item>
            <Form.Item label="视觉模型">
              <Select
                aria-label="视觉模型"
                value={visionModel}
                disabled={savingVision || !visionProvider || visionModels.length === 0}
                placeholder="选择支持图片输入的模型"
                options={visionModels}
                onChange={setVisionModel}
              />
            </Form.Item>
            {visionProviders.length === 0 && (
              <Form.Item label=" " colon={false}>
                <Alert
                  type="warning"
                  showIcon
                  title="暂无可用视觉模型"
                  description="请先在“模型提供商”中配置支持图片输入的供应商和模型。"
                />
              </Form.Item>
            )}
            <Form.Item label="保存位置">
              <code className="pa-inline-config-path" title={visionSettings.configPath}>
                {visionSettings.configPath}
              </code>
            </Form.Item>
            <Form.Item label=" " colon={false}>
              <Button
                type="primary"
                loading={savingVision}
                onClick={() => void saveVisionSettingsForm()}
              >
                保存视觉模型配置
              </Button>
            </Form.Item>
          </Form>
        )}
      </Card>
    </div>
  );
}

interface BuiltinPromptItem {
  key: string;
  category: string;
  name: string;
  description: string;
  content: string;
  dynamic?: boolean;
  variables?: Array<{ name: string; description: string }>;
  location: string;
  defaultContent: string;
  customized: boolean;
}

interface SkillInfo {
  name: string;
  description: string;
  triggers: string[];
  sourcePath: string;
}

/**
 * 渲染输入框的"影子高亮层"：把已加载技能引用（/skill-name 或 #skill-name）
 * 包成 chip 背景块，其余文本透明，叠在 TextArea 下方形成整体高亮效果。
 */
function renderHighlightedPrompt(prompt: string, skills: SkillInfo[]): ReactNode {
  const skillNames = new Set(skills.map((skill) => skill.name));
  const parts: ReactNode[] = [];
  const regex = /([#/])([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(prompt)) !== null) {
    if (match.index > last) parts.push(prompt.slice(last, match.index));
    const name = match[2];
    if (skillNames.has(name)) {
      parts.push(
        <span key={key} className="pa-skill-chip">
          {match[0]}
        </span>,
      );
      key += 1;
    } else {
      parts.push(match[0]);
    }
    last = match.index + match[0].length;
  }
  if (last < prompt.length) parts.push(prompt.slice(last));
  return parts.length > 0 ? parts : '\u200b';
}

function SkillsPanel() {
  const { message: messageApi } = AntApp.useApp();
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [directory, setDirectory] = useState('');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/api/skills');
      if (!response.ok) throw new Error(`读取技能列表失败 (${response.status})`);
      const payload = (await response.json()) as {
        directory: string;
        skills: SkillInfo[];
      };
      setDirectory(payload.directory);
      setSkills(payload.skills);
    } catch (err: unknown) {
      messageApi.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  async function handleUpload(file: File) {
    if (!/\.zip$/i.test(file.name)) {
      messageApi.error('只支持 .zip 压缩包');
      return;
    }
    setUploading(true);
    try {
      const buffer = await file.arrayBuffer();
      const response = await apiFetch(`/api/skills/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: buffer,
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        skill?: { name: string; path: string; fileCount: number };
      };
      if (!response.ok) throw new Error(payload.error ?? `上传失败 (${response.status})`);
      messageApi.success(`技能「${payload.skill?.name ?? file.name}」已安装并生效`);
      await loadSkills();
    } catch (err: unknown) {
      messageApi.error(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function openSkillFolder(skill: SkillInfo) {
    const directory = skill.sourcePath.replace(/[\\/]SKILL\.md$/i, '');
    const desktopApi = window.personalAgentDesktop;
    if (desktopApi?.openPath) {
      const error = await desktopApi.openPath(directory);
      if (error) messageApi.error(`打开目录失败：${error}`);
      return;
    }
    // 普通浏览器无法打开本地目录，回退为复制路径
    try {
      await navigator.clipboard.writeText(directory);
      messageApi.success(`已复制目录路径：${directory}`);
    } catch {
      messageApi.info(`技能目录：${directory}`);
    }
  }

  return (
    <>
      <div className="pa-settings-heading">
        <div>
          <Title level={4}>技能</Title>
          <Text type="secondary">
            上传 Claude Code / Codex 标准格式的技能压缩包（zip：单个技能根目录 + SKILL.md）。 仅{' '}
            {directory || '~/.personal-agent/skills/'} 内的技能会生效，上传后立即生效、无需重启。
          </Text>
        </div>
      </div>

      <Upload.Dragger
        className="pa-skill-upload-dragger"
        height={150}
        accept=".zip,application/zip"
        multiple={false}
        showUploadList={false}
        disabled={uploading}
        beforeUpload={(file) => {
          void handleUpload(file as unknown as File);
          return false;
        }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">
          {uploading ? '正在上传…' : '点击或拖拽技能 zip 压缩包到此处'}
        </p>
      </Upload.Dragger>

      <Divider />

      <Title level={5}>已安装技能（{skills?.length ?? 0}）</Title>
      <Spin spinning={loading}>
        {skills && skills.length > 0 ? (
          <List
            dataSource={skills}
            renderItem={(skill) => (
              <List.Item
                extra={
                  <Button
                    size="small"
                    icon={<FolderOpenOutlined />}
                    onClick={() => void openSkillFolder(skill)}
                  >
                    打开目录
                  </Button>
                }
              >
                <List.Item.Meta
                  title={<Text strong>{skill.name}</Text>}
                  description={skill.description}
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={loading ? '加载中…' : '还没有安装标准技能，上传一个 zip 试试'}
          />
        )}
      </Spin>
    </>
  );
}

function PromptsPanel({ onStarterPromptsChange }: { onStarterPromptsChange: () => void }) {
  const { message: messageApi, modal } = AntApp.useApp();
  const [prompts, setPrompts] = useState<BuiltinPromptItem[] | null>(null);
  const [editing, setEditing] = useState<BuiltinPromptItem | null>(null);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const editTextAreaRef = useRef<TextAreaRef | null>(null);

  const loadPrompts = useCallback(async () => {
    try {
      const response = await apiFetch('/api/prompts');
      if (!response.ok) throw new Error(`读取提示词清单失败 (${response.status})`);
      const payload = (await response.json()) as { prompts: BuiltinPromptItem[] };
      setPrompts(payload.prompts);
    } catch (err) {
      messageApi.error(err instanceof Error ? err.message : String(err));
    }
  }, [messageApi]);

  useEffect(() => {
    let cancelled = false;
    void loadPrompts();
    return () => {
      cancelled = true;
    };
  }, [loadPrompts]);

  const savePrompt = async (key: string, content: string | null): Promise<void> => {
    setSaving(true);
    try {
      const response = await apiFetch('/api/prompts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(content === null ? { key, reset: true } : { key, content }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `保存失败 (${response.status})`);
      }
      const payload = (await response.json()) as { prompts: BuiltinPromptItem[] };
      setPrompts(payload.prompts);
      messageApi.success(content === null ? '已恢复默认提示词' : '提示词已保存，下一条消息生效');
      if (key === 'starter-prompts') onStarterPromptsChange();
    } catch (err) {
      messageApi.error(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const openEditor = (prompt: BuiltinPromptItem): void => {
    setEditing(prompt);
    setEditText(prompt.content);
  };

  const confirmSave = async (): Promise<void> => {
    if (!editing) return;
    try {
      await savePrompt(editing.key, editText);
      setEditing(null);
    } catch {
      // 错误提示已在 savePrompt 中处理
    }
  };

  const confirmReset = (prompt: BuiltinPromptItem): void => {
    modal.confirm({
      title: '恢复默认提示词',
      content: `确定将「${prompt.name}」恢复为内置默认内容吗？`,
      okText: '恢复默认',
      cancelText: '取消',
      onOk: () => void savePrompt(prompt.key, null),
    });
  };

  /** 在编辑框光标位置插入变量占位符 */
  const insertVariable = (variable: string): void => {
    const textarea = editTextAreaRef.current?.nativeElement as HTMLTextAreaElement | null;
    if (!textarea) return;
    const start = textarea.selectionStart ?? editText.length;
    const end = textarea.selectionEnd ?? start;
    const next = editText.slice(0, start) + variable + editText.slice(end);
    setEditText(next);
    requestAnimationFrame(() => {
      textarea.focus();
      const position = start + variable.length;
      textarea.setSelectionRange(position, position);
    });
  };

  const groups = useMemo(() => {
    const map = new Map<string, BuiltinPromptItem[]>();
    for (const prompt of prompts ?? []) {
      const list = map.get(prompt.category) ?? [];
      list.push(prompt);
      map.set(prompt.category, list);
    }
    return [...map.entries()];
  }, [prompts]);

  return (
    <div className="pa-settings-prompts">
      <div className="pa-settings-heading">
        <div>
          <Title level={4}>系统内置提示词</Title>
          <Text type="secondary">
            查看系统内置提示词及其作用，可编辑自定义（Web 下一条消息生效，CLI 重启生效）。
          </Text>
        </div>
      </div>
      {prompts === null ? (
        <Spin />
      ) : (
        groups.map(([category, items]) => (
          <Card key={category} size="small" title={category} className="pa-prompts-group">
            {items.map((prompt) => (
              <PromptCard
                key={`${category}-${prompt.name}`}
                prompt={prompt}
                onEdit={() => openEditor(prompt)}
                onReset={() => confirmReset(prompt)}
              />
            ))}
          </Card>
        ))
      )}
      <Modal
        title={editing ? `编辑提示词 · ${editing.name}` : '编辑提示词'}
        open={Boolean(editing)}
        onCancel={() => setEditing(null)}
        onOk={() => void confirmSave()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        width={720}
        destroyOnHidden
      >
        <div className="pa-prompt-edit">
          <Text type="secondary" className="pa-prompt-edit-hint">
            {editing?.dynamic
              ? '动态模板：正文中的 ${...} 占位符会在运行时替换为实际数据，编辑时请保留。'
              : '编辑后将覆盖内置默认内容；Web 下一条消息生效，CLI 重启生效。'}
          </Text>
          {editing?.variables && editing.variables.length > 0 && (
            <div className="pa-prompt-variables">
              <span className="pa-prompt-variables-label">可用变量（点击插入光标处）：</span>
              {editing.variables.map((variable) => (
                <Tooltip key={variable.name} title={variable.description}>
                  <Tag
                    color="blue"
                    className="pa-prompt-variable"
                    onClick={() => insertVariable(variable.name)}
                  >
                    {variable.name}
                  </Tag>
                </Tooltip>
              ))}
            </div>
          )}
          <TextArea
            ref={editTextAreaRef}
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            autoSize={{ minRows: 8, maxRows: 22 }}
            className="pa-prompt-edit-textarea"
          />
        </div>
      </Modal>
    </div>
  );
}

function PromptCard({
  prompt,
  onEdit,
  onReset,
}: {
  prompt: BuiltinPromptItem;
  onEdit: () => void;
  onReset: () => void;
}) {
  const { message: messageApi } = AntApp.useApp();
  const copyPrompt = (): void => {
    void copyTextToClipboard(prompt.content)
      .then(() => messageApi.success('提示词内容已复制'))
      .catch(() => messageApi.error('复制失败，请手动选择文本'));
  };
  return (
    <div className="pa-prompt-item">
      <Collapse
        size="small"
        defaultActiveKey={[prompt.name]}
        items={[
          {
            key: prompt.name,
            label: (
              <div className="pa-prompt-label">
                <strong>{prompt.name}</strong>
                {prompt.dynamic && <Tag color="blue">动态模板</Tag>}
                {prompt.customized && <Tag color="green">已自定义</Tag>}
              </div>
            ),
            children: (
              <div className="pa-prompt-body">
                <Text type="secondary" className="pa-prompt-description">
                  {prompt.description}
                </Text>
                <pre className="pa-prompt-content">{prompt.content}</pre>
                <div className="pa-prompt-footer">
                  <Text type="secondary" className="pa-prompt-location">
                    来源：{prompt.location}
                  </Text>
                  <Space size={8}>
                    {prompt.customized && (
                      <Button size="small" icon={<ReloadOutlined />} onClick={onReset}>
                        恢复默认
                      </Button>
                    )}
                    <Button size="small" icon={<EditOutlined />} onClick={onEdit}>
                      编辑
                    </Button>
                    <Button size="small" icon={<CopyOutlined />} onClick={copyPrompt}>
                      复制
                    </Button>
                  </Space>
                </div>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

/** 主色选择器：预设色板（按当前模式显示对应色）+ 自由选色 */
function AccentPicker({
  mode,
  value,
  onChange,
}: {
  mode: keyof AccentColors;
  value: string;
  onChange: (color: string) => void;
}) {
  const normalized = value.toLowerCase();
  return (
    <Space wrap size={8} className="pa-accent-picker">
      {ACCENT_PRESETS.map((preset) => {
        const presetColor = preset[mode];
        const active = presetColor.toLowerCase() === normalized;
        return (
          <Tooltip key={presetColor} title={presetColor}>
            <button
              type="button"
              className={`pa-accent-swatch${active ? ' active' : ''}`}
              style={{ background: presetColor }}
              aria-label={`预设主色 ${presetColor}`}
              onClick={() => onChange(presetColor)}
            />
          </Tooltip>
        );
      })}
      <ColorPicker
        value={value}
        onChange={(color) => onChange(color.toHexString())}
        showText
        size="small"
      />
    </Space>
  );
}

function DebugJsonPanel({ title, value }: { title: string; value: unknown }) {
  const { message: messageApi } = AntApp.useApp();
  const json = prettyJson(value);

  function copyJson() {
    if (!navigator.clipboard) {
      messageApi.error('当前浏览器不支持自动复制，请手动选择文本');
      return;
    }
    void navigator.clipboard
      .writeText(json)
      .then(() => messageApi.success(`${title}已复制`))
      .catch(() => messageApi.error('复制失败，请手动选择文本'));
  }

  return (
    <section className="pa-debug-json-panel">
      <div className="pa-debug-json-heading">
        <strong>{title}</strong>
        <Button type="text" size="small" icon={<CopyOutlined />} onClick={copyJson}>
          复制
        </Button>
      </div>
      <pre>{json}</pre>
    </section>
  );
}

function FileDiffViewer({ change }: { change?: FileChange }) {
  const { message: messageApi } = AntApp.useApp();
  const diff = useMemo(
    () => (change ? computeLineDiff(change.oldContent, change.newContent) : null),
    [change],
  );
  // 只展示被修改区域：大段未修改的上下文折叠为省略行
  const displayLines = useMemo(() => (diff ? collapseDiffContext(diff.lines) : null), [diff]);

  if (!change || !diff || !displayLines) {
    return (
      <div className="pa-file-diff-viewer">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="修改记录不存在或已失效" />
      </div>
    );
  }

  const added = diff.lines.filter((line) => line.kind === 'add').length;
  const removed = diff.lines.filter((line) => line.kind === 'remove').length;
  const copyDiff = (): void => {
    void copyTextToClipboard(toUnifiedDiffText(change.path, change.oldContent, change.newContent))
      .then(() => messageApi.success('Unified Diff 已复制'))
      .catch(() => messageApi.error('复制失败，请手动选择文本'));
  };

  return (
    <div className="pa-file-diff-viewer">
      <div className="pa-file-diff-header">
        <div className="pa-file-diff-header-copy">
          <strong title={change.path}>{lastPathSegment(change.path) ?? change.path}</strong>
          <span>
            <Tag color="success">+{added}</Tag>
            <Tag color="error">-{removed}</Tag>
            <small title={change.path}>{change.path}</small>
          </span>
        </div>
        <Button size="small" icon={<CopyOutlined />} onClick={copyDiff}>
          复制 Diff
        </Button>
      </div>
      <div className="pa-file-diff-body">
        {displayLines.map((line, index) =>
          line.kind === 'gap' ? (
            <div key={`gap-${index}`} className="pa-diff-gap" role="separator">
              <span>⋯ 省略 {line.skipped} 行未修改内容 ⋯</span>
            </div>
          ) : (
            <div key={index} className={`pa-diff-line ${line.kind}`}>
              <span className="pa-diff-ln pa-diff-ln-old">{line.oldLineNo ?? ''}</span>
              <span className="pa-diff-ln pa-diff-ln-new">{line.newLineNo ?? ''}</span>
              <span className="pa-diff-marker">
                {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
              </span>
              <pre className="pa-diff-text">{line.text || ' '}</pre>
            </div>
          ),
        )}
        {diff.truncated && (
          <div className="pa-diff-truncated">
            文件超过 {MAX_DIFF_LINES} 行，仅展示前 {MAX_DIFF_LINES} 行
          </div>
        )}
        {change.truncated && (
          <div className="pa-diff-truncated">
            该修改记录保存时内容超过上限已截断，diff 可能不完整
          </div>
        )}
      </div>
    </div>
  );
}

function PlanDocViewer({ doc }: { doc?: PlanDoc }) {
  const { message: messageApi } = AntApp.useApp();

  if (!doc) {
    return (
      <div className="pa-plan-doc-viewer">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="文档不存在或已失效" />
      </div>
    );
  }

  const copyMarkdown = (): void => {
    void copyTextToClipboard(doc.markdown)
      .then(() => messageApi.success('Markdown 已复制'))
      .catch(() => messageApi.error('复制失败，请手动选择文本'));
  };

  return (
    <div className="pa-plan-doc-viewer">
      <div className="pa-plan-doc-header">
        <div className="pa-plan-doc-header-copy">
          <strong title={doc.title}>{doc.title}</strong>
          <span>
            <Tag color={PLAN_STATUS_TAG_COLORS[doc.plan.status] ?? 'default'}>
              {planStatusLabel(doc.plan.status)}
            </Tag>
            <small>
              更新于{' '}
              {new Date(doc.updatedAt).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </small>
          </span>
        </div>
        <Button size="small" icon={<CopyOutlined />} onClick={copyMarkdown}>
          复制 Markdown
        </Button>
      </div>
      <div className="pa-plan-doc-body">
        <MarkdownContent text={doc.markdown} />
      </div>
    </div>
  );
}

function Inspector({
  state,
  activeProject,
  activeTask,
  rootPath,
  onApprovePlan,
}: {
  state: WorkspaceState;
  activeProject?: ProjectSummary;
  activeTask?: TaskSummary;
  rootPath: string;
  onApprovePlan: () => void;
}) {
  const planStatus = state.planActive
    ? '规划中'
    : state.plan
      ? planStatusLabel(state.plan.status)
      : '未启用';
  const mcpConnected = state.runtime?.mcpServers.filter((server) => server.connected).length ?? 0;

  return (
    <Space direction="vertical" size={18} className="pa-inspector-content">
      <Card
        size="small"
        title="执行计划"
        extra={
          <Tag color={state.planActive || state.plan ? 'processing' : 'default'}>{planStatus}</Tag>
        }
      >
        {!state.plan ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="开启计划模式后，Agent 会先只读分析并等待你批准执行。"
          />
        ) : (
          <Space direction="vertical" size={12} className="pa-plan-content">
            <div className="pa-plan-heading">
              <strong>{state.plan.title}</strong>
              <span>{state.planProgress.percentage}%</span>
            </div>
            <Progress
              percent={state.planProgress.percentage}
              showInfo={false}
              status={state.planProgress.failed ? 'exception' : 'active'}
            />
            <div className="pa-inspector-list pa-plan-steps">
              {state.plan.steps.map((step) => (
                <div
                  className={`pa-inspector-list-item ${step.status}`}
                  key={`${step.order}-${step.title}`}
                >
                  <Avatar size={24} className={`pa-plan-step ${step.status}`}>
                    {step.status === 'completed' ? (
                      <CheckCircleFilled />
                    ) : step.status === 'failed' ? (
                      <CloseCircleFilled />
                    ) : step.status === 'in_progress' ? (
                      <LoadingOutlined spin />
                    ) : (
                      step.order
                    )}
                  </Avatar>
                  <div className="pa-inspector-list-copy">
                    <div className="pa-inspector-list-title">{step.title}</div>
                  </div>
                </div>
              ))}
            </div>
            {state.planActive && state.plan.status === 'draft' && (
              <Button type="primary" block onClick={onApprovePlan}>
                批准并开始执行
              </Button>
            )}
          </Space>
        )}
      </Card>

      <Card size="small" title="能力">
        <div className="pa-inspector-list">
          {[
            {
              icon: <BulbOutlined />,
              name: 'Memory',
              value: state.runtime?.memoryEnabled ? '已启用持久化记忆' : '未启用',
            },
            {
              icon: <CodeOutlined />,
              name: 'MCP',
              value: state.runtime?.mcpServers.length
                ? `${mcpConnected}/${state.runtime.mcpServers.length} 已连接`
                : '未配置服务',
            },
            {
              icon: <AppstoreOutlined />,
              name: 'Plugins',
              value:
                state.runtime?.plugins.length || state.runtime?.standaloneSkills
                  ? `${state.runtime.plugins.length} 个插件 · ${state.runtime.standaloneSkills} 个 Skill`
                  : '未加载插件',
            },
          ].map((item) => (
            <div className="pa-inspector-list-item" key={item.name}>
              <Avatar icon={item.icon} />
              <div className="pa-inspector-list-copy">
                <div className="pa-inspector-list-title">{item.name}</div>
                <div className="pa-inspector-list-description">{item.value}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card size="small" title="会话">
        <dl className="pa-metadata-list">
          <Metadata label="ID" value={state.sessionId?.slice(0, 12) ?? '—'} />
          <Metadata label="项目" value={activeProject?.name ?? '—'} />
          <Metadata label="任务" value={activeTask?.title ?? '—'} />
          <Metadata label="Provider" value={state.runtime?.provider ?? '—'} />
          <Metadata label="Model" value={state.runtime?.model ?? '—'} />
          <Metadata label="工具" value={`${state.runtime?.toolCount ?? 0} tools`} />
          <Metadata label="工作目录" value={rootPath || '—'} />
        </dl>
      </Card>
    </Space>
  );
}

function Metadata({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={typeof value === 'string' ? value : undefined}>{value}</dd>
    </div>
  );
}

function planDocCardItem(doc: PlanDoc): PlanDocTimelineItem {
  return {
    id: `plan-doc-${doc.id}`,
    kind: 'plan-doc',
    docId: doc.id,
    title: doc.title,
    requestSeq: doc.requestSeq,
    time: currentTime(),
  };
}

/**
 * 把 planDocs 中 taskId 匹配（或未绑定任务）且尚未出现在 items 里的计划文档
 * 卡片按所属轮次插入时间线（每张卡片插到该轮回复的下方、下一轮用户消息之前；
 * requestSeq 缺失时回退追加到末尾）。history 重放与 /api/plans 恢复共用，
 * 按 docId 去重（幂等）。
 */
function insertPlanDocCards(
  items: TimelineItem[],
  docs: Record<string, PlanDoc>,
  taskId?: string,
): TimelineItem[] {
  const result = [...items];
  const existing = new Set(
    result
      .filter((item): item is PlanDocTimelineItem => item.kind === 'plan-doc')
      .map((item) => item.docId),
  );
  for (const doc of Object.values(docs)) {
    if (doc.taskId && doc.taskId !== taskId) continue;
    if (existing.has(doc.id)) continue;
    // 同一轮内 plan 卡片应位于 run-changes 卡片之前（与实时顺序一致）：
    // 从轮次结束位置向前跳过紧邻的 run-changes 卡片
    let insertAt = findRoundInsertIndex(result, doc.requestSeq);
    while (insertAt > 0 && result[insertAt - 1]?.kind === 'run-changes') insertAt -= 1;
    result.splice(insertAt, 0, planDocCardItem(doc));
    existing.add(doc.id);
  }
  return result;
}

/**
 * history 重放/seed 恢复时统一插入计划与修改文件两类卡片：
 * 先插 run-changes 再插 plan（同一轮内 plan 卡片在前、文件列表卡片在后，与实时一致），
 * 两类卡片都按 requestSeq 定位到对应轮次回复下方；无法定位时回退末尾。
 * 各步骤幂等（按卡片 id 去重），plan/批次任一来源先到后到都安全。
 */
function insertReplayCards(
  items: TimelineItem[],
  docs: Record<string, PlanDoc>,
  batches: StoredFileChangeBatch[],
  taskId?: string,
): TimelineItem[] {
  return insertPlanDocCards(insertRunChangesCards(items, batches, taskId), docs, taskId);
}

/** 把服务端落盘文档 JSON 中的 Plan 元信息时间字符串还原为 Date。 */
function normalizeStoredPlanDoc(doc: PlanDoc): PlanDoc {
  const plan = { ...doc.plan, metadata: { ...doc.plan.metadata } };
  const createdAt = plan.metadata.createdAt as unknown;
  if (typeof createdAt === 'string') plan.metadata.createdAt = new Date(createdAt);
  const approvedAt = plan.metadata.approvedAt as unknown;
  if (typeof approvedAt === 'string') plan.metadata.approvedAt = new Date(approvedAt);
  const completedAt = plan.metadata.completedAt as unknown;
  if (typeof completedAt === 'string') plan.metadata.completedAt = new Date(completedAt);
  return { ...doc, plan };
}

/**
 * 把已落盘的修改文件记录批次按所属轮次插入时间线：每批卡片插到该轮回复的下方、
 * 下一轮用户消息之前；requestSeq 缺失或超出轮次数（旧数据/历史被压缩等）时
 * 回退追加到末尾。实时 run_changes 事件、history 重放与 seedFileChanges 三条
 * 路径共用本函数（实时时该轮回复位于末尾，插入即追加），保证卡片位置稳定且不重复。
 * 卡片与 changeIds 的构造内聚在此处（确定性 id：run-changes-<batchId> /
 * file-change-<batchId>-<index>，与 fileChanges map 的条目 id 一致）。
 */
function insertRunChangesCards(
  items: TimelineItem[],
  batches: StoredFileChangeBatch[],
  taskId?: string,
): TimelineItem[] {
  const result = [...items];
  const existing = new Set(
    result
      .filter((item): item is RunChangesTimelineItem => item.kind === 'run-changes')
      .map((item) => item.id),
  );
  for (const batch of batches) {
    if (batch.taskId && batch.taskId !== taskId) continue;
    const cardId = `run-changes-${batch.id}`;
    if (existing.has(cardId)) continue;
    const changeIds = batch.files.map((_, index) => `file-change-${batch.id}-${index}`);
    if (changeIds.length === 0) continue;
    const card: RunChangesTimelineItem = {
      id: cardId,
      kind: 'run-changes',
      changeIds,
      requestSeq: batch.requestSeq,
      time: new Date(batch.time).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      }),
    };
    result.splice(findRoundInsertIndex(result, batch.requestSeq), 0, card);
    existing.add(cardId);
  }
  return result;
}

/**
 * 返回第 requestSeq 轮（该任务第 requestSeq 次用户请求，1-based）的结束位置：
 * 即下一轮用户消息的索引，plan / run-changes 卡片应插在此处。requestSeq 缺失
 * 或超出时间线轮次数（历史被压缩/截断等）时回退到时间线末尾。
 */
function findRoundInsertIndex(items: TimelineItem[], requestSeq: number | undefined): number {
  if (typeof requestSeq !== 'number' || requestSeq < 1) return items.length;
  let userCount = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== 'message' || item.role !== 'user') continue;
    userCount += 1;
    if (userCount === requestSeq + 1) return index;
  }
  return items.length;
}

/**
 * 定位/创建当前用户请求（responseSequence）的助手消息并应用更新。
 * 一轮回复中的多次 LLM 调用（turn）合并到同一条助手消息下，但按 turn 分组
 * 存储（turns 数组）：每次调用的思考/文本/工具独立维护，展示时分组可见。
 */
function updateAssistantTurn(
  items: TimelineItem[],
  responseSequence: number,
  turnNumber: number,
  updater: (turn: AssistantTurn) => AssistantTurn,
): TimelineItem[] {
  const id = assistantResponseId(responseSequence);
  const index = items.findIndex((item) => item.id === id);
  const current: MessageTimelineItem =
    index >= 0 && items[index]?.kind === 'message'
      ? items[index]
      : {
          id,
          kind: 'message',
          role: 'assistant',
          text: '',
          turns: [],
          turnNumber,
          time: currentTime(),
          streaming: true,
          startedAt: Date.now(),
        };
  const turns = current.turns ?? [];
  const turnIndex = turns.findIndex((turn) => turn.turnNumber === turnNumber);
  const turn: AssistantTurn =
    turnIndex >= 0 ? turns[turnIndex] : { turnNumber, thinking: '', text: '', tools: [] };
  const updatedTurn = updater(turn);
  const nextTurns =
    turnIndex >= 0
      ? turns.map((item, itemIndex) => (itemIndex === turnIndex ? updatedTurn : item))
      : [...turns, updatedTurn];
  const updated = { ...current, turns: nextTurns, streaming: true };
  if (index === -1) return [...items, updated];
  return items.map((item, itemIndex) => (itemIndex === index ? updated : item));
}

/** 合并消息的文本：各次调用的文本按顺序拼接（调用之间空行分隔）。 */
function turnsText(turns: AssistantTurn[] | undefined): string {
  if (!turns || turns.length === 0) return '';
  return turns
    .map((turn) => turn.text)
    .filter(Boolean)
    .join('\n\n');
}

function upsertTurnTool(tools: ToolTimelineItem[], value: ToolTimelineItem): ToolTimelineItem[] {
  const index = tools.findIndex((tool) => tool.toolCallId === value.toolCallId);
  if (index === -1) return [...tools, value];
  return tools.map((tool, toolIndex) => (toolIndex === index ? value : tool));
}

function updateTurnTool(
  tools: ToolTimelineItem[],
  toolCallId: string,
  updater: (tool: ToolTimelineItem) => ToolTimelineItem,
): ToolTimelineItem[] {
  return tools.map((tool) => (tool.toolCallId === toolCallId ? updater(tool) : tool));
}

function extractMessageText(message: UnifiedMessage): string {
  const content = message.displayContent ?? message.content;
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'tool_result') {
      // 结构化工具结果：提取文本内容；错误消息优先展示 error 字段
      const resultText =
        typeof block.content === 'string'
          ? block.content
          : extractMessageText({ content: block.content } as UnifiedMessage);
      parts.push(block.error && !resultText ? block.error : resultText);
    }
  }
  return parts.join('\n');
}

function extractMessageImages(message: UnifiedMessage): MessageTimelineItem['images'] {
  const content = message.displayContent ?? message.content;
  if (typeof content === 'string') return undefined;
  const images = content
    .filter((block) => block.type === 'image')
    .map((block, index) => ({
      name: block.name || `用户图片 ${index + 1}`,
      src: `data:${block.source.mediaType};base64,${block.source.data}`,
    }));
  return images.length > 0 ? images : undefined;
}

function promptImageSrc(image: PromptImageInput): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

function promptImagesForTimeline(
  images: PromptImageInput[],
): NonNullable<MessageTimelineItem['images']> {
  return images.map((image) => ({ name: image.name, src: promptImageSrc(image) }));
}

function promptImagesByteLength(images: PromptImageInput[]): number {
  return images.reduce((total, image) => {
    const padding = image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0;
    return total + (image.data.length / 4) * 3 - padding;
  }, 0);
}

async function readPromptImage(file: File): Promise<PromptImageInput> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
  const separator = dataUrl.indexOf(',');
  if (separator < 0) throw new Error('图片数据格式无效');
  return {
    name: file.name || `clipboard-${Date.now()}.${file.type.split('/')[1] || 'png'}`,
    mediaType: file.type as PromptImageInput['mediaType'],
    data: dataUrl.slice(separator + 1),
  };
}

function extractMessageThinking(message: UnifiedMessage): string {
  if (typeof message.content === 'string') return '';
  return message.content
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('\n');
}

function extractAssistantTools(message: UnifiedMessage): ToolTimelineItem[] {
  const tools = new Map<string, ToolTimelineItem>();
  if (typeof message.content !== 'string') {
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      tools.set(block.id, {
        id: `history-tool-${block.id}`,
        kind: 'tool',
        toolCallId: block.id,
        name: block.name,
        arguments: block.input,
        status: 'running',
        output: '等待工具返回…',
        restored: true,
      });
    }
  }
  for (const toolCall of message.toolCalls ?? []) {
    if (tools.has(toolCall.id)) continue;
    tools.set(toolCall.id, {
      id: `history-tool-${toolCall.id}`,
      kind: 'tool',
      toolCallId: toolCall.id,
      name: toolCall.function.name,
      arguments: tryParseToolArguments(toolCall.function.arguments),
      status: 'running',
      output: '等待工具返回…',
      restored: true,
    });
  }
  return [...tools.values()];
}

function tryParseToolArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed arguments
  }
  return undefined;
}

function getRestoredToolStatus(
  output: string,
  message?: UnifiedMessage,
): Extract<ToolTimelineItem['status'], 'success' | 'failed' | 'interrupted'> {
  // 结构化 tool_result 块优先：isError / interrupted 是明确标志，不靠文本猜测
  if (message && typeof message.content !== 'string') {
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue;
      if (block.isError) {
        return block.metadata?.interrupted ? 'interrupted' : 'failed';
      }
      return 'success';
    }
  }
  // 旧格式（纯字符串）回退：靠文本前缀猜测
  const normalized = output.trim();
  if (/tool (?:execution )?interrupted by user/iu.test(normalized)) return 'interrupted';
  return /^(?:Error:|Permission denied:|\[tool error\])/iu.test(normalized) ? 'failed' : 'success';
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  const index = items.findIndex((item) => item.id === value.id);
  if (index === -1) return [value, ...items];
  return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function loadStoredIds(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

function saveStoredIds(key: string, ids: Set<string>): void {
  localStorage.setItem(key, JSON.stringify([...ids]));
}

function toggleId(current: Set<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function directoryEntryToNode(entry: DirectoryEntryInfo): DirectoryTreeNode {
  return {
    title: entry.name,
    key: entry.path,
    isLeaf: !entry.hasChildren,
  };
}

function updateDirectoryTreeChildren(
  nodes: DirectoryTreeNode[],
  targetKey: string,
  children: DirectoryTreeNode[],
): DirectoryTreeNode[] {
  return nodes.map((node) => {
    if (node.key === targetKey) return { ...node, children, isLeaf: children.length === 0 };
    if (!node.children) return node;
    return {
      ...node,
      children: updateDirectoryTreeChildren(node.children, targetKey, children),
    };
  });
}

function rememberActiveTask(taskId?: string) {
  if (taskId) localStorage.setItem('personal-agent-active-task', taskId);
}

/**
 * 页面加载最早阶段从 URL 提取认证 token 存入 sessionStorage。
 * 桌面端通过 ?token= 携带认证，若等 WebSocket 连接时才存储，
 * 挂载时发起的 /api/skills 等请求会因缺少 Authorization 而 401，
 * 导致技能列表为空、输入框 / 无法弹出技能菜单。
 */
function bootstrapAuthToken(): void {
  const pageParams = new URLSearchParams(location.search);
  const token =
    pageParams.get('token') ?? sessionStorage.getItem('personal-agent-token') ?? undefined;
  if (token) sessionStorage.setItem('personal-agent-token', token);
}

bootstrapAuthToken();

/**
 * 当前认证 token：优先 sessionStorage（bootstrapAuthToken 已在页面加载时写入），
 * 其次 URL 参数。WebSocket 连接后 token 会从 URL 移除（history.replaceState），
 * 因此必须回退到 sessionStorage，否则验证截图等 <img> 请求会因缺少 token 而 401 裂图。
 */
function currentAuthToken(): string | undefined {
  return (
    sessionStorage.getItem('personal-agent-token') ??
    new URLSearchParams(location.search).get('token') ??
    undefined
  );
}

function apiFetch(path: string, options: RequestInit = {}) {
  const token = currentAuthToken();
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(path, { ...options, headers });
}

async function fetchDirectoryChildren(path?: string): Promise<DirectoryListResponse> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  const query = params.size ? `?${params}` : '';
  const response = await apiFetch(`/api/filesystem/directories${query}`);
  const data = (await response.json()) as DirectoryListResponse & { error?: string };
  if (!response.ok) throw new Error(data.error || '读取本地目录失败');
  return data;
}

function parseModelRows(rows: ProviderModelRow[]): Array<string | ProviderModelRow> {
  const models: Array<string | ProviderModelRow> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = (row?.id ?? '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (
      row.contextWindow ||
      row.maxOutputTokens ||
      row.imageInput ||
      row.reasoningOptions?.length ||
      row.thinkingEffort
    ) {
      models.push({
        id,
        contextWindow: row.contextWindow,
        maxOutputTokens: row.maxOutputTokens,
        imageInput: row.imageInput || undefined,
        reasoningOptions: row.reasoningOptions?.length ? row.reasoningOptions : undefined,
        thinkingEffort: row.thinkingEffort,
      });
    } else {
      models.push(id);
    }
  }
  return models;
}

function modelConfigListToRows(models: Array<string | ProviderModelRow>): ProviderModelRow[] {
  return models.map((model) =>
    typeof model === 'string'
      ? { id: model, imageInput: false }
      : {
          id: model.id,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          imageInput: model.imageInput ?? false,
          reasoningOptions: model.reasoningOptions,
          thinkingEffort: model.thinkingEffort,
        },
  );
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * 缓存命中 token 占已使用 token 的百分比（分母为「已使用」= 最后一次模型调用的输入 token）。
 * 统一保留两位小数。
 */
function cacheHitPercentage(cacheHitTokens: number, usedTokens: number): string {
  if (usedTokens <= 0) return '0%';
  const percentage = (cacheHitTokens / usedTokens) * 100;
  return `${percentage.toFixed(2)}%`;
}

function ContextUsagePanel({ usage, footer }: { usage?: ContextUsage; footer?: ReactNode }) {
  if (!usage || usage.totalTokens <= 0) {
    return <div className="pa-context-tip">暂无上下文数据</div>;
  }
  const warn = usage.percentage >= 75;
  const danger = usage.percentage >= 90;
  return (
    <div className="pa-context-tip">
      <div className="pa-context-tip-title">上下文使用情况</div>
      <Progress
        percent={usage.percentage}
        size="small"
        status={danger ? 'exception' : warn ? 'active' : 'normal'}
        format={(percent) => `${(percent ?? 0).toFixed(2)}%`}
      />
      <div className="pa-context-tip-row">
        <span>已使用</span>
        <b>{formatTokens(usage.usedTokens)} tokens</b>
      </div>
      <div className="pa-context-tip-row">
        <span>总上下文</span>
        <b>{formatTokens(usage.totalTokens)} tokens</b>
      </div>
      <div className="pa-context-tip-row">
        <span>占用</span>
        <b>{usage.percentage.toFixed(2)}%</b>
      </div>
      {typeof usage.cacheHitTokens === 'number' && usage.cacheHitTokens > 0 && (
        <div className="pa-context-tip-row">
          <span>缓存命中</span>
          <b>{cacheHitPercentage(usage.cacheHitTokens, usage.usedTokens)}</b>
        </div>
      )}
      <div className="pa-context-tip-hint">
        <div>已使用：最后一次模型调用的输入Token</div>
        <div>预留输出：{formatTokens(usage.reservedOutputTokens)} tokens</div>
        <div>自动压缩阈值：0.75</div>
      </div>
      {footer && <div className="pa-context-tip-footer">{footer}</div>}
    </div>
  );
}

function findRuntimeModel(runtime?: RuntimeInfo, provider?: string, model?: string) {
  if (!runtime || !provider || !model) return undefined;
  return runtime.models.find(
    (candidate) => candidate.provider === provider && candidate.id === model,
  );
}

function runtimeModelSelectValue(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function parseRuntimeModelSelectValue(
  value: string,
): { provider: ProviderId; model: string } | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string'
    ) {
      return undefined;
    }
    if (!isProviderId(parsed[0]) || !parsed[1]) return undefined;
    return { provider: parsed[0], model: parsed[1] };
  } catch {
    return undefined;
  }
}

function buildRuntimeModelGroups(runtime?: RuntimeInfo): RuntimeModelGroup[] {
  if (!runtime) return [];
  const groups = new Map<string, RuntimeModelGroup>();

  for (const model of runtime.models) {
    const group = groups.get(model.provider) ?? {
      label: model.providerName || providerLabels[model.provider as ProviderId] || model.provider,
      options: [],
    };
    group.options.push({
      value: runtimeModelSelectValue(model.provider, model.id),
      label: model.displayName || model.id,
      title: model.id,
    });
    groups.set(model.provider, group);
  }

  if (
    runtime.provider &&
    runtime.model &&
    !findRuntimeModel(runtime, runtime.provider, runtime.model)
  ) {
    const group = groups.get(runtime.provider) ?? {
      label:
        runtime.providerName || providerLabels[runtime.provider as ProviderId] || runtime.provider,
      options: [],
    };
    group.options.unshift({
      value: runtimeModelSelectValue(runtime.provider, runtime.model),
      label: runtime.model,
      title: runtime.model,
    });
    groups.set(runtime.provider, group);
  }

  return Array.from(groups.values());
}

function getReasoningOptions(options: ReasoningEffort[]) {
  const allowed = new Set(options);
  return reasoningOptions.filter((option) => allowed.has(option.value as ReasoningEffort));
}

function isProviderId(value: string): value is ProviderId {
  return (
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'deepseek' ||
    value === 'ollama' ||
    value === 'volcano' ||
    value === 'lmstudio'
  );
}

function getConfiguredProviders(settings: ProviderSettingsInfo | null): ProviderId[] {
  if (!settings) return [];
  return (Object.keys(providerLabels) as ProviderId[]).filter(
    (provider) => settings.providers[provider].configured,
  );
}

function currentTime(): string {
  return new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function relativeTime(value: string): string {
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86_400 * 7) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Date(value).toLocaleDateString('zh-CN');
}

function lastPathSegment(value: string): string | undefined {
  return value.split(/[\\/]/).filter(Boolean).at(-1);
}

/** 任务完成时计算总耗时（ms）：从消息创建时间戳起算；缺时间戳（如历史恢复的消息）返回 undefined。 */
function completedDurationMs(item: MessageTimelineItem): number | undefined {
  return item.startedAt === undefined ? undefined : Date.now() - item.startedAt;
}

/**
 * 中文耗时格式：35秒 / 2分43秒 / 2小时20分49秒。
 */
function formatElapsedChinese(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
  if (totalMinutes > 0) return `${minutes}分${seconds}秒`;
  return `${seconds}秒`;
}

/** 任务结束时间：HH:MM 格式（与消息头部的时间口径一致）。 */
function formatClockTime(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 首 token 时间（TTFT）：保留 1 位小数的秒数。 */
function formatTtft(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}秒`;
}

/** 模型输出 token 速度：≥100 取整，<100 保留 1 位小数。 */
function formatTokenSpeed(tokensPerSecond: number): string {
  const value =
    tokensPerSecond >= 100 ? Math.round(tokensPerSecond) : Math.round(tokensPerSecond * 10) / 10;
  return `${value} tok/s`;
}

function modelCallStatusLabel(status: ModelCallTrace['status']): string {
  return {
    running: '调用中',
    completed: '已完成',
    error: '失败',
    interrupted: '已中断',
  }[status];
}

function modelCallStatusColor(status: ModelCallTrace['status']): string {
  return {
    running: 'processing',
    completed: 'success',
    error: 'error',
    interrupted: 'warning',
  }[status];
}

function formatDebugTimestamp(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.focus();
    textarea.select();
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
  }
  if (!copied) throw new Error('Clipboard API is unavailable');
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
