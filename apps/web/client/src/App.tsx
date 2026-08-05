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
  ConfigProvider,
  Drawer,
  Dropdown,
  Empty,
  Form,
  Grid,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Progress,
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
  theme as antdTheme,
} from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import {
  AppstoreOutlined,
  BarChartOutlined,
  BugOutlined,
  BulbOutlined,
  CaretRightOutlined,
  CheckCircleFilled,
  CloseOutlined,
  CodeOutlined,
  CompressOutlined,
  CopyOutlined,
  DashboardOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  MenuOutlined,
  MoonOutlined,
  MoreOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  SunOutlined,
  ToolOutlined,
  UserOutlined,
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
import type { ReasoningEffort, UnifiedMessage } from '@personal-agent/shared';
import { VERSION } from '@personal-agent/shared';
import type {
  ClientMessage,
  ContextUsage,
  PermissionMode,
  ProjectSummary,
  RuntimeInfo,
  ServerMessage,
  TaskSummary,
} from '../../src/protocol';
import { assistantTurnId } from './timeline';

const { Header, Content, Sider } = Layout;
const { Text, Title } = Typography;
const { TextArea } = Input;

type ColorMode = 'light' | 'dark';
type ConnectionState = 'connecting' | 'online' | 'offline';
type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'ollama' | 'volcano';
type PlanMessage = Extract<ServerMessage, { type: 'plan' }>;
type PermissionRequest = Extract<ServerMessage, { type: 'permission_request' }>;
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
  time: string;
  streaming?: boolean;
  error?: boolean;
  turnNumber?: number;
  thinking?: string;
  tools?: ToolTimelineItem[];
}

interface ToolTimelineItem {
  id: string;
  kind: 'tool';
  toolCallId: string;
  name: string;
  status: 'running' | 'success' | 'failed' | 'interrupted';
  output: string;
  duration?: number;
  restored?: boolean;
}

type TimelineItem = MessageTimelineItem | ToolTimelineItem;

interface ModelCallTrace {
  callId: string;
  turnNumber: number;
  provider: string;
  model: string;
  startedAt: string;
  request: ModelCallStart['request'];
  status: 'running' | ModelCallEnd['status'];
  finishedAt?: string;
  durationMs?: number;
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
  responseSeq: number;
}

interface ProviderModelRow {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
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
];

const providerLabels: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  ollama: 'Ollama（本地）',
  volcano: '火山方舟',
};

/** Brand icons for providers, keyed by provider id (see public/icons). */
const providerIcons: Partial<Record<ProviderId, string>> = {
  anthropic: '/icons/anthropic.svg',
  openai: '/icons/openai.svg',
  deepseek: '/icons/deepseek-color.svg',
  ollama: '/icons/ollama.svg',
  volcano: '/icons/volcengine-color.svg',
};

function getInitialColorMode(): ColorMode {
  return localStorage.getItem('personal-agent-theme') === 'dark' ? 'dark' : 'light';
}

export default function PersonalAgentApp() {
  const [colorMode, setColorMode] = useState<ColorMode>(getInitialColorMode);

  useEffect(() => {
    document.documentElement.dataset.theme = colorMode;
    localStorage.setItem('personal-agent-theme', colorMode);
  }, [colorMode]);

  const themeConfig = useMemo(
    () => ({
      algorithm: colorMode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: {
        colorPrimary: colorMode === 'dark' ? '#b7e56d' : '#5f8f22',
        colorInfo: colorMode === 'dark' ? '#b7e56d' : '#5f8f22',
        borderRadius: 10,
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      },
      components: {
        Layout: {
          headerBg: colorMode === 'dark' ? '#141814' : '#fbfcf8',
          siderBg: colorMode === 'dark' ? '#111511' : '#ffffff',
          bodyBg: colorMode === 'dark' ? '#0d100d' : '#f5f7f1',
        },
        Button: {
          controlHeight: 34,
        },
        Input: {
          activeShadow: '0 0 0 2px rgba(95, 143, 34, 0.12)',
        },
      },
    }),
    [colorMode],
  );

  return (
    <ConfigProvider locale={zhCN} theme={themeConfig}>
      <AntApp>
        <AgentWorkspace
          colorMode={colorMode}
          onToggleColorMode={() =>
            setColorMode((current) => (current === 'light' ? 'dark' : 'light'))
          }
        />
      </AntApp>
    </ConfigProvider>
  );
}

function AgentWorkspace({
  colorMode,
  onToggleColorMode,
}: {
  colorMode: ColorMode;
  onToggleColorMode: () => void;
}) {
  const { message: messageApi, modal } = AntApp.useApp();
  const screens = Grid.useBreakpoint();
  const desktop = Boolean(screens.md);
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const sequenceRef = useRef(0);
  const responseSequenceRef = useRef(0);
  const activeResponseSequenceRef = useRef(0);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const timelineRef = useRef(timeline);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const userMessageEls = useRef(new Map<string, HTMLElement>());
  const followOutputRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string>();
  const [turnNavLeft, setTurnNavLeft] = useState(30);
  const [prompt, setPrompt] = useState('');
  const [draftTaskProjectId, setDraftTaskProjectId] = useState<string>();
  const pendingTaskDraftRef = useRef<{
    projectId: string;
    prompt?: string;
    permissionMode?: PermissionMode;
    taskModel?: { provider: string; model: string };
  }>();
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryPickerLoading, setDirectoryPickerLoading] = useState(false);
  const [directoryTreeData, setDirectoryTreeData] = useState<DirectoryTreeNode[]>([]);
  const [selectedDirectory, setSelectedDirectory] = useState<string>();
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'providers' | 'general'>('providers');
  const [providerView, setProviderView] = useState<'list' | 'form'>('list');
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerDeleting, setProviderDeleting] = useState<ProviderId>();
  const [compressing, setCompressing] = useState(false);
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
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() =>
    loadStoredIds('pa-collapsed-projects'),
  );
  useEffect(() => {
    saveStoredIds('pa-collapsed-projects', collapsedProjects);
  }, [collapsedProjects]);

  const [projectForm] = Form.useForm<ProjectFormValues>();
  const [providerForm] = Form.useForm<ProviderFormValues>();
  const selectedProvider = Form.useWatch('provider', providerForm);
  const providerModels = Form.useWatch('models', providerForm) ?? ([] as ProviderModelRow[]);
  const executionLabel = useExecutionTimer(state.busy);

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

  const userTurns = useMemo(
    () =>
      timeline.filter(
        (item): item is MessageTimelineItem & { role: 'user' } =>
          item.kind === 'message' && item.role === 'user',
      ),
    [timeline],
  );

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
      options: Pick<MessageTimelineItem, 'streaming' | 'error'> = {},
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
          const restored: TimelineItem[] = [];
          const restoredToolOwners = new Map<string, number>();
          for (const historyMessage of incoming.messages) {
            if (historyMessage.role === 'system') continue;
            const text = extractMessageText(historyMessage);
            const thinking = extractMessageThinking(historyMessage);
            if (historyMessage.role === 'user') {
              restored.push({
                id: nextId('history-user'),
                kind: 'message',
                role: 'user',
                text,
                time: currentTime(),
              });
            } else if (historyMessage.role === 'assistant') {
              const tools = extractAssistantTools(historyMessage);
              if (!text && !thinking && tools.length === 0) continue;
              const itemIndex = restored.length;
              restored.push({
                id: nextId('history-assistant'),
                kind: 'message',
                role: 'assistant',
                text,
                thinking,
                tools,
                time: currentTime(),
              });
              for (const tool of tools) restoredToolOwners.set(tool.toolCallId, itemIndex);
            } else if (historyMessage.role === 'tool') {
              const toolCallId = historyMessage.toolCallId ?? nextId('tool-call');
              const ownerIndex = restoredToolOwners.get(toolCallId);
              const owner = ownerIndex === undefined ? undefined : restored[ownerIndex];
              if (ownerIndex !== undefined && owner?.kind === 'message') {
                restored[ownerIndex] = {
                  ...owner,
                  tools: (owner.tools ?? []).map((tool) =>
                    tool.toolCallId === toolCallId
                      ? {
                          ...tool,
                          status: getRestoredToolStatus(text),
                          output: text || '(无输出)',
                        }
                      : tool,
                  ),
                };
              } else {
                restored.push({
                  id: nextId('history-tool'),
                  kind: 'tool',
                  toolCallId,
                  name: historyMessage.name ?? '历史工具结果',
                  status: getRestoredToolStatus(text),
                  output: text || '(无输出)',
                  restored: true,
                });
              }
            }
          }
          followOutputRef.current = true;
          replaceTimeline(restored);
          patchState({ sessionId: incoming.sessionId });
          if (eventTaskId && eventTaskId !== viewingTask && viewingTask) {
            switchTaskView(viewingTask, eventTaskId);
          }
          break;
        }
        case 'project_list':
          patchState((current) => ({
            projects: incoming.projects,
            activeProjectId:
              pendingTaskDraftRef.current?.projectId ??
              incoming.activeProjectId ??
              current.activeProjectId,
          }));
          break;
        case 'task_list': {
          const nextActive = pendingTaskDraftRef.current
            ? undefined
            : (incoming.activeTaskId ?? stateRef.current.activeTaskId);
          if (nextActive !== stateRef.current.activeTaskId) switchTaskView(nextActive);
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
          patchState((current) => ({
            projects: current.projects.filter((project) => project.id !== incoming.projectId),
            tasks: current.tasks.filter((task) => task.projectId !== incoming.projectId),
            activeTaskId:
              current.activeProjectId === incoming.projectId ? undefined : current.activeTaskId,
          }));
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
            pendingTaskDraftRef.current?.prompt &&
            pendingTaskDraftRef.current.projectId === incoming.task.projectId
          ) {
            const initialPrompt = pendingTaskDraftRef.current.prompt;
            const draftTaskModel = pendingTaskDraftRef.current.taskModel;
            pendingTaskDraftRef.current = undefined;
            setDraftTaskProjectId(undefined);
            followOutputRef.current = true;
            // 草稿中选过任务模型：先应用模型（任务空闲），再发 prompt。
            if (draftTaskModel) {
              send({
                type: 'set_task_model',
                taskId: incoming.task.id,
                providerId: draftTaskModel.provider,
                model: draftTaskModel.model,
              });
            }
            appendMessage('user', initialPrompt);
            if (send({ type: 'prompt', text: initialPrompt, taskId: incoming.task.id })) setPrompt('');
          }
          requestAnimationFrame(() =>
            document.querySelector<HTMLTextAreaElement>('#prompt-input')?.focus(),
          );
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
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            if (incoming.busy) data.responseSeq += 1;
            data.busy = incoming.busy;
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          if (incoming.busy && !stateRef.current.busy) {
            responseSequenceRef.current += 1;
            activeResponseSequenceRef.current = responseSequenceRef.current;
          }
          patchState({ busy: incoming.busy });
          if (!incoming.busy) {
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
        case 'llm_call_start': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.modelCalls = [
              ...data.modelCalls,
              { ...incoming.call, status: 'running' },
            ];
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
        case 'llm_call_end':
          setModelCalls((current) => {
            const next: ModelCallTrace[] = current.map((call) =>
              call.callId === incoming.call.callId ? { ...call, ...incoming.call } : call,
            );
            modelCallsRef.current = next;
            return next;
          });
          break;
        case 'thinking_delta': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.timeline = updateAssistantTurn(
              data.timeline,
              data.responseSeq,
              incoming.turnNumber,
              (item) => ({
                ...item,
                thinking: `${item.thinking ?? ''}${incoming.thinking}`,
                streaming: true,
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
              (item) => ({
                ...item,
                thinking: `${item.thinking ?? ''}${incoming.thinking}`,
                streaming: true,
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
              (item) => ({
                ...item,
                text: `${item.text}${incoming.text}`,
                streaming: true,
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
              (item) => ({
                ...item,
                text: `${item.text}${incoming.text}`,
                streaming: true,
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
              (item) => ({
                ...item,
                streaming: true,
                tools: upsertTurnTool(item.tools ?? [], {
                  id: `tool-${incoming.toolCallId}`,
                  kind: 'tool',
                  toolCallId: incoming.toolCallId,
                  name: incoming.toolName,
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
              (item) => ({
                ...item,
                streaming: true,
                tools: upsertTurnTool(item.tools ?? [], {
                  id: `tool-${incoming.toolCallId}`,
                  kind: 'tool',
                  toolCallId: incoming.toolCallId,
                  name: incoming.toolName,
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
              (item) => ({
                ...item,
                tools: updateTurnTool(item.tools ?? [], incoming.toolCallId, (tool) => ({
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
              (item) => ({
                ...item,
                tools: updateTurnTool(item.tools ?? [], incoming.toolCallId, (tool) => ({
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
              (item) => ({
                ...item,
                tools: updateTurnTool(item.tools ?? [], incoming.toolCallId, (tool) => ({
                  ...tool,
                  status: incoming.result.metadata?.interrupted
                    ? 'interrupted'
                    : incoming.result.success
                      ? 'success'
                      : 'failed',
                  output:
                    (incoming.result.success ? incoming.result.content : incoming.result.error) ||
                    '(无输出)',
                  duration: incoming.result.metadata?.duration,
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
              (item) => ({
                ...item,
                tools: updateTurnTool(item.tools ?? [], incoming.toolCallId, (tool) => ({
                  ...tool,
                  status: incoming.result.metadata?.interrupted
                    ? 'interrupted'
                    : incoming.result.success
                      ? 'success'
                      : 'failed',
                  output:
                    (incoming.result.success ? incoming.result.content : incoming.result.error) ||
                    '(无输出)',
                  duration: incoming.result.metadata?.duration,
                })),
              }),
            ),
          );
          break;
        }
        case 'permission_request': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
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
        case 'turn_end': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.timeline = data.timeline.map((item) =>
              item.id === assistantTurnId(data.responseSeq, incoming.turnNumber) &&
              item.kind === 'message'
                ? { ...item, streaming: false }
                : item,
            );
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          updateTimeline((items) =>
            items.map((item) =>
              item.id === assistantTurnId(activeResponseSequenceRef.current, incoming.turnNumber) &&
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
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.timeline = data.timeline.map((item) =>
              item.kind === 'message' && item.streaming ? { ...item, streaming: false } : item,
            );
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          updateTimeline((items) =>
            items.map((item) =>
              item.kind === 'message' && item.streaming ? { ...item, streaming: false } : item,
            ),
          );
          break;
        }
        case 'interrupted': {
          const eventTaskId = incoming.taskId ?? stateRef.current.activeTaskId;
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.pendingPermission = undefined;
            data.timeline = data.timeline.map((item) => {
              if (item.kind === 'tool') {
                return item.status === 'running' ? { ...item, status: 'interrupted' } : item;
              }
              return {
                ...item,
                streaming: false,
                tools: item.tools?.map((tool) =>
                  tool.status === 'running' ? { ...tool, status: 'interrupted' } : tool,
                ),
              };
            });
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          messageApi.info('已停止生成');
          patchState({ pendingPermission: undefined });
          updateTimeline((items) =>
            items.map((item) => {
              if (item.kind === 'tool') {
                return item.status === 'running' ? { ...item, status: 'interrupted' } : item;
              }
              return {
                ...item,
                streaming: false,
                tools: item.tools?.map((tool) =>
                  tool.status === 'running' ? { ...tool, status: 'interrupted' } : tool,
                ),
              };
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
          if (eventTaskId && eventTaskId !== stateRef.current.activeTaskId) {
            const data = taskDataRef.current[eventTaskId] ?? emptyTaskSnapshot();
            data.planActive = incoming.active;
            data.plan = incoming.plan;
            data.planProgress = incoming.progress;
            taskDataRef.current[eventTaskId] = data;
            break;
          }
          patchState({
            planActive: incoming.active,
            plan: incoming.plan,
            planProgress: incoming.progress,
          });
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
    [appendMessage, messageApi, nextId, patchState, replaceTimeline, send, updateTimeline, switchTaskView],
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
  const activeTaskModel = state.tasks.find(
    (task) => task.id === state.activeTaskId,
  )?.model;
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
    (state.runtime?.reasoningSupported ? ['off', 'high', 'max'] : ['off']);

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
      pendingTaskDraftRef.current = { ...draft, taskModel: selection };
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

  function submitPrompt(value = prompt.trim()) {
    const text = value.trim();
    const hasDraft = Boolean(pendingTaskDraftRef.current);
    if (
      !text ||
      !stateRef.current.connected ||
      !stateRef.current.configured ||
      // Creating a new task must not be blocked by the current task's busy state.
      (!hasDraft && stateRef.current.busy) ||
      stateRef.current.creatingTask
    ) {
      return;
    }
    setModelCalls([]);
    setSelectedModelCallId(undefined);
    const pendingTaskDraft = pendingTaskDraftRef.current;
    if (pendingTaskDraft) {
      pendingTaskDraftRef.current = { ...pendingTaskDraft, prompt: text };
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
    appendMessage('user', text);
    if (send({ type: 'prompt', text, taskId: stateRef.current.activeTaskId })) setPrompt('');
  }

  function discardTaskDraft() {
    pendingTaskDraftRef.current = undefined;
    setDraftTaskProjectId(undefined);
    patchState({ creatingTask: false });
  }

  function answerPermission(approved: boolean) {
    const pending = stateRef.current.pendingPermission;
    if (!pending) return;
    send({
      type: 'permission_response',
      requestId: pending.requestId,
      approved,
      remember: rememberPermission,
      taskId: pending.taskId ?? stateRef.current.activeTaskId,
    });
    patchState({ pendingPermission: undefined });
    setRememberPermission(false);
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

  async function openProviderSettings() {
    setProviderModalOpen(true);
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
    if (window.personalAgentDesktop) {
      try {
        const directory = await window.personalAgentDesktop.selectDirectory(initialDirectory);
        if (!directory) return;
        projectForm.setFieldValue('rootPath', directory);
        await projectForm.validateFields(['rootPath']);
      } catch (error) {
        messageApi.error(formatError(error));
      }
      return;
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
      onRefresh={() => send({ type: 'list_projects' })}
      onOpenTask={(taskId) => {
        discardTaskDraft();
        send({ type: 'open_task', taskId });
        patchState({ sidebarOpen: false });
      }}
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

  return (
    <Layout className="pa-shell">
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
                icon={<MenuOutlined />}
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
              >
                <span className="pa-button-label">{colorMode === 'light' ? '浅色' : '深色'}</span>
              </Button>
            </Tooltip>
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
            <Tooltip title="运行详情">
              <Button
                icon={<InfoCircleOutlined />}
                onClick={() => patchState({ inspectorOpen: true })}
                aria-label="运行详情"
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
              message="还需要配置模型"
              description={
                state.runtime.initializationError || '选择 Provider、模型并保存后即可开始对话。'
              }
              action={
                <Button size="small" onClick={openProviderSettings}>
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
                <Welcome onSelectPrompt={submitPrompt} />
              ) : (
                timeline.map((item) => (
                  <TimelineEntry
                    key={item.id}
                    item={item}
                    onMessageElement={registerMessageElement}
                  />
                ))
              )}
            </div>
          </div>

          {showScrollButton && (
            <Button className="pa-scroll-latest" onClick={scrollToLatest}>
              ↓ 最新消息
            </Button>
          )}

          <Composer
            rootPath={rootPath}
            prompt={prompt}
            enabled={composerEnabled}
            busy={state.busy}
            creatingTask={state.creatingTask}
            planActive={state.planActive}
            contextUsage={state.contextUsage}
            compressing={compressing}
            permissionMode={state.permissionMode}
            pendingPermission={state.pendingPermission}
            pendingTitle={
              state.pendingPermission
                ? (state.tasks.find(
                    (task) => task.id === state.pendingPermission?.taskId,
                  )?.title ?? '任务')
                : undefined
            }
            rememberPermission={rememberPermission}
            runtime={state.runtime}
            runtimeModelValue={runtimeModelValue}
            taskModelValue={taskModelOptionValue}
            runtimeModels={runtimeModels}
            onTaskModelChange={changeTaskModel}
            runtimeReasoningOptions={runtimeReasoningOptions}
            runtimeDisabled={runtimeDisabled}
            executionLabel={executionLabel}
            onPromptChange={setPrompt}
            onSubmit={submitPrompt}
            onStop={() => send({ type: 'interrupt', taskId: stateRef.current.activeTaskId })}
            onAnswerPermission={answerPermission}
            onRememberPermissionChange={setRememberPermission}
            onPlanModeChange={(enabled) =>
              send({ type: 'set_plan_mode', enabled, taskId: stateRef.current.activeTaskId })}
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
              if (!state.runtime?.provider || !state.runtime.model) return;
              saveRuntimeSelection(state.runtime.provider, state.runtime.model, reasoningEffort);
            }}
          />
        </Content>
      </Layout>

      <Drawer
        title={
          <div>
            <span className="pa-eyebrow">LIVE CONTEXT</span>
            <div>运行详情</div>
          </div>
        }
        placement="right"
        size={380}
        open={state.inspectorOpen}
        onClose={() => patchState({ inspectorOpen: false })}
        className="pa-inspector"
      >
        <Inspector
          state={state}
          activeProject={activeProject}
          activeTask={activeTask}
          rootPath={rootPath}
          onApprovePlan={() =>
            send({ type: 'approve_plan', taskId: stateRef.current.activeTaskId })}
        />
      </Drawer>

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
          <Form.Item
            name="rootPath"
            label="本地根目录"
            rules={[{ required: true, whitespace: true, message: '请输入本地根目录' }]}
          >
            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="请选择本地根目录"
                onClick={() => {
                  void openDirectoryPicker();
                }}
              />
              <Button
                type="primary"
                icon={<FolderOpenOutlined />}
                onClick={() => {
                  void openDirectoryPicker();
                }}
              >
                选择
              </Button>
            </Space.Compact>
          </Form.Item>
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
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可浏览的目录" />
            )}
          </Spin>
        </div>
      </Modal>

      <Modal
        title="设置"
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
              onClick={({ key }) => setSettingsTab(key as 'providers' | 'general')}
              selectedKeys={[settingsTab]}
              items={[
                {
                  key: 'general',
                  icon: <SettingOutlined />,
                  label: '通用',
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
                <GeneralSettingsPanel />
              </section>
            )}
            <section
              className="pa-settings-content"
              style={settingsTab === 'general' ? { display: 'none' } : undefined}
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
                    rules={[{ required: true, message: '请输入默认模型' }]}
                  >
                    <AutoComplete options={providerModelOptions} placeholder="模型 ID" />
                  </Form.Item>
                  <Form.Item
                    label="可选模型"
                    extra="为每个模型配置总上下文长度与输出长度（单位 token）；留空使用内置默认值。"
                  >
                    <Form.List name="models">
                      {(fields, { add, remove }) => (
                        <div className="pa-model-list">
                          <div className="pa-model-list-head">
                            <span>模型 ID</span>
                            <span>上下文长度</span>
                            <span>输出长度</span>
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
                              })
                            }
                          >
                            添加模型
                          </Button>
                        </div>
                      )}
                    </Form.List>
                  </Form.Item>
                  {(selectedProvider === 'deepseek' || selectedProvider === 'volcano') && (
                    <Form.Item
                      name="thinkingEffort"
                      label="默认思考强度"
                      extra={
                        selectedProvider === 'deepseek'
                          ? 'DeepSeek 的 low/medium 等价于 high，因此仅展示有效档位。'
                          : '火山方舟仅深度思考模型（如 doubao-seed-thinking）支持思考，普通模型请选择「关闭」。'
                      }
                    >
                      <Select
                        options={getReasoningOptions(
                          selectedProvider === 'deepseek'
                            ? ['off', 'high', 'max']
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
  onOpenSettings,
  version,
}: {
  projects: ProjectSummary[];
  tasks: TaskSummary[];
  activeProjectId?: string;
  activeTaskId?: string;
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
  onOpenSettings: () => void;
  version: string;
}) {
  const activeProjects = projects.filter((project) => !project.archived);
  const archivedProjects = projects.filter((project) => project.archived);
  const visibleProjects = showArchived ? projects : activeProjects;
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

  return (
    <div className="pa-sidebar-content">
      <div className="pa-brand">
        <div className="pa-brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <strong>personal-agent</strong>
          <small>LOCAL WORKSPACE</small>
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
            <Button type="text" size="small" icon={<ReloadOutlined />} onClick={onRefresh} />
          </Tooltip>
        </Space>
      </div>

      <div className="pa-project-list">
        {visibleProjects.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无项目" />
        ) : (
          <ul className="pa-project-menu-list">
            {visibleProjects.map((project) => (
              <li className="pa-project-list-item" key={project.id}>
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
                    <div
                      className={`pa-project-row${project.archived ? ' archived' : ''}`}
                    >
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
                            if (key === 'rename') onStartProjectRename(project);
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
                      <div className="pa-project-tasks">
                        {projectTasks.get(project.id)?.length ? (
                          (projectTasks.get(project.id) ?? []).map((task) => (
                            <TaskMenuItem
                              key={task.id}
                              task={task}
                              activeTaskId={activeTaskId}
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
                          ))
                        ) : (
                          <div className="pa-project-tasks-empty">
                            <Text type="secondary">暂无任务</Text>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
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
            onClick={onOpenSettings}
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

function Welcome({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) {
  return (
    <section className="pa-welcome">
      <div className="pa-welcome-symbol" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span className="pa-eyebrow">YOUR LOCAL AI AGENT</span>
      <Title level={1}>今天想一起完成什么？</Title>
      <Text type="secondary" className="pa-welcome-copy">
        直接描述目标。Agent 可以理解项目、编辑文件、运行命令，并在敏感操作前请求你的批准。
      </Text>
      <div className="pa-starter-grid">
        {starterPrompts.map((starter) => (
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
  return (
    <nav className="pa-turn-nav" style={{ left }} aria-label="对话轮次导航">
      {turns.map((turn, index) => {
        const preview = turn.text.replace(/\s+/g, ' ').trim() || '（空消息）';
        return (
          <button
            key={turn.id}
            type="button"
            className={`pa-turn-nav-item${turn.id === activeId ? ' active' : ''}`}
            aria-label={`跳到第 ${index + 1} 轮：${turn.text}`}
            onClick={() => onSelect(turn.id)}
          >
            <span className="pa-turn-nav-tip" role="tooltip">
              <span className="pa-turn-nav-tip-index">第 {index + 1} 轮</span>
              <span className="pa-turn-nav-tip-text">{preview}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function TimelineEntry({
  item,
  onMessageElement,
}: {
  item: TimelineItem;
  onMessageElement?: (id: string, element: HTMLElement | null) => void;
}) {
  const { message: messageApi } = AntApp.useApp();

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
              children: <pre className="pa-tool-output">{item.output}</pre>,
            },
          ]}
        />
      </div>
    );
  }

  const user = item.role === 'user';
  const system = item.role === 'system';
  const showThinking = !user && !system && (Boolean(item.thinking) || Boolean(item.tools?.length));
  const copyUserMessage = (): void => {
    void copyTextToClipboard(item.text)
      .then(() => messageApi.success('用户输入已复制'))
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
          thinking={item.thinking ?? ''}
          tools={item.tools ?? []}
          streaming={Boolean(item.streaming)}
        />
      )}
      {(item.text || user || system) && (
        <div className={`pa-message-content${item.streaming && item.text ? ' streaming' : ''}`}>
          {system ? item.text : <MarkdownContent text={item.text} />}
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
  thinking,
  tools,
  streaming,
}: {
  thinking: string;
  tools: ToolTimelineItem[];
  streaming: boolean;
}) {
  const runningTools = tools.filter((tool) => tool.status === 'running').length;
  const failedTools = tools.filter((tool) => tool.status === 'failed').length;
  const interruptedTools = tools.filter((tool) => tool.status === 'interrupted').length;
  const summary = runningTools
    ? `${runningTools} 个工具执行中`
    : failedTools
      ? `${tools.length} 个工具 · ${failedTools} 个失败`
      : interruptedTools
        ? `${tools.length} 个工具 · ${interruptedTools} 个已停止`
        : tools.length
          ? `${tools.length} 个工具`
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
                {thinking && (
                  <div className="pa-thinking-content">
                    <MarkdownContent text={thinking} />
                  </div>
                )}
                {tools.length > 0 && (
                  <div className="pa-thinking-tools">
                    {tools.map((tool) => (
                      <ThinkingTool key={tool.toolCallId} tool={tool} />
                    ))}
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
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
      <pre className="pa-tool-output">{tool.output}</pre>
    </div>
  );
}

function MarkdownContent({ text }: { text: string }) {
  return (
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
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function Composer({
  rootPath,
  prompt,
  enabled,
  busy,
  creatingTask,
  planActive,
  contextUsage,
  compressing,
  permissionMode,
  pendingPermission,
  pendingTitle,
  rememberPermission,
  runtime,
  runtimeModelValue,
  taskModelValue,
  runtimeModels,
  runtimeReasoningOptions,
  runtimeDisabled,
  executionLabel,
  onPromptChange,
  onSubmit,
  onStop,
  onAnswerPermission,
  onRememberPermissionChange,
  onPlanModeChange,
  onCompressContext,
  onPermissionModeChange,
  onModelChange,
  onTaskModelChange,
  onReasoningChange,
}: {
  rootPath: string;
  prompt: string;
  enabled: boolean;
  busy: boolean;
  creatingTask: boolean;
  planActive: boolean;
  contextUsage?: ContextUsage;
  compressing: boolean;
  permissionMode: PermissionMode;
  pendingPermission?: PermissionRequest;
  pendingTitle?: string;
  rememberPermission: boolean;
  runtime?: RuntimeInfo;
  runtimeModelValue?: string;
  taskModelValue: string;
  runtimeModels: RuntimeModelGroup[];
  runtimeReasoningOptions: ReasoningEffort[];
  runtimeDisabled: boolean;
  executionLabel?: string;
  onPromptChange: (prompt: string) => void;
  onSubmit: (prompt?: string) => void;
  onStop: () => void;
  onAnswerPermission: (approved: boolean) => void;
  onRememberPermissionChange: (remember: boolean) => void;
  onPlanModeChange: (enabled: boolean) => void;
  onCompressContext: () => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onModelChange: (value: string) => void;
  onTaskModelChange: (value: string) => void;
  onReasoningChange: (effort: ReasoningEffort) => void;
}) {
  const placeholder = !enabled
    ? '配置 Provider 后即可开始对话'
    : busy
      ? 'Agent 正在处理…'
      : '给 personal-agent 发送消息…（Enter 发送，Shift+Enter 换行）';
  const activeModel = findRuntimeModel(runtime, runtime?.provider, runtime?.model);
  // The select's displayed value: per-task model override, else the global
  // default. The title/width must follow the *selected* model — using the
  // global runtime model here makes the tooltip always show the default
  // (e.g. deepseek-v4-flash) even after switching this task to another model.
  const taskModelSelection = parseRuntimeModelSelectValue(taskModelValue);
  const taskModelInfo = taskModelSelection
    ? findRuntimeModel(runtime, taskModelSelection.provider, taskModelSelection.model)
    : undefined;
  const activeModelLabel =
    taskModelInfo?.displayName ||
    taskModelSelection?.model ||
    activeModel?.displayName ||
    runtime?.model ||
    '选择模型';
  const activeModelTitle = activeModelLabel;

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
      <div className="pa-composer">
        <Tooltip title={rootPath} placement="topLeft">
          <div className="pa-composer-path">
            <Badge status="success" />
            <span>{rootPath}</span>
          </div>
        </Tooltip>
        <TextArea
          id="prompt-input"
          value={prompt}
          disabled={!enabled || creatingTask}
          autoSize={{ minRows: 2, maxRows: 8 }}
          placeholder={placeholder}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <div className="pa-composer-bottom">
          <div className="pa-composer-left">
            <Select
              value={permissionMode}
              options={permissionOptions}
              disabled={!enabled || busy || creatingTask}
              popupMatchSelectWidth={false}
              aria-label="设置工具权限"
              onChange={(value: PermissionMode) => onPermissionModeChange(value)}
            />
            <Segmented
              value={planActive ? 'plan' : 'execute'}
              disabled={!enabled || busy || creatingTask}
              options={[
                { value: 'execute', label: '执行' },
                { value: 'plan', label: '计划' },
              ]}
              onChange={(value) => onPlanModeChange(value === 'plan')}
            />
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
              color="#ffffff"
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
            <Select
              value={taskModelValue}
              options={runtimeModels.length ? runtimeModels : [{ label: '未配置', options: [] }]}
              disabled={runtimeDisabled}
              className="pa-model-select"
              popupMatchSelectWidth={false}
              style={{ width: getModelSelectWidth(activeModelLabel) }}
              title={`${activeModelTitle}（当前任务模型，可独立于其他任务）`}
              aria-label="切换当前任务模型"
              onChange={onTaskModelChange}
            />
            {runtime?.reasoningSupported && (
              <Select
                value={runtime.reasoningEffort}
                options={getReasoningOptions(runtimeReasoningOptions)}
                disabled={runtimeDisabled}
                className="pa-reasoning-select"
                aria-label="设置思考强度"
                onChange={(value: ReasoningEffort) => onReasoningChange(value)}
              />
            )}
            {executionLabel && <span className="pa-execution-timer">{executionLabel}</span>}
            {busy ? (
              <Tooltip title="停止生成">
                <Button danger shape="circle" icon={<StopOutlined />} onClick={onStop} />
              </Tooltip>
            ) : (
              <Button
                type="primary"
                shape="circle"
                icon={<SendOutlined />}
                loading={creatingTask}
                disabled={!enabled || creatingTask || !prompt.trim()}
                aria-label="发送消息"
                onClick={() => onSubmit()}
              />
            )}
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
        message="这里展示当前这次用户请求触发的实际模型调用；数据仅保存在当前页面内存中，且不包含 API Key。"
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
                  <strong>第 {index + 1} 次调用</strong>
                  <Tag color={modelCallStatusColor(call.status)}>
                    {modelCallStatusLabel(call.status)}
                  </Tag>
                </span>
                <span>
                  {call.provider} · {call.model}
                </span>
                <small>
                  Turn {call.turnNumber}
                  {call.durationMs === undefined ? '' : ` · ${call.durationMs} ms`}
                </small>
              </button>
            ))}
          </aside>
          <section className="pa-debug-detail">
            <div className="pa-debug-metadata">
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
            {selectedCall.error && <Alert type="error" showIcon message={selectedCall.error} />}
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
        message="统计来自本地 SQLite 数据库 ~/.personal-agent/stats/model-requests.db；是否保存请求入参/出参由设置中的「统计模型请求入参/出参」开关控制。"
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
        <Alert type="error" showIcon message={error} />
      ) : data && data.available === false ? (
        <Alert
          type="warning"
          showIcon
          message="模型统计当前不可用"
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

function GeneralSettingsPanel() {
  const { message: messageApi } = AntApp.useApp();
  const [recordPayloads, setRecordPayloads] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const [savingMaxTurns, setSavingMaxTurns] = useState(false);

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
    apiFetch('/api/agent-config')
      .then((response) => {
        if (!response.ok) throw new Error(`读取 Agent 配置失败 (${response.status})`);
        return response.json() as Promise<{ maxTurns: number }>;
      })
      .then((payload) => {
        if (!cancelled) setMaxTurns(payload.maxTurns);
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
      messageApi.success(
        value ? '已开启：新请求将保存完整入参/出参' : '已关闭：仅保存统计元数据',
      );
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

  return (
    <div className="pa-settings-general">
      <div className="pa-settings-heading">
        <div>
          <Title level={4}>通用</Title>
          <Text type="secondary">Agent 运行与模型请求统计的通用设置。</Text>
        </div>
      </div>
      <Card size="small">
        <Form layout="horizontal" colon labelAlign="left" labelCol={{ flex: '220px' }} style={{ maxWidth: 640 }}>
          <Form.Item
            label={
              <Space size={4}>
                统计模型请求入参/出参
                <Tooltip title="开启后，新产生的模型请求会保存完整入参（messages/tools/options）；关闭时仅保存统计元数据（token、模型、状态、耗时等）。数据存储在本地 SQLite（~/.personal-agent/stats/model-requests.db），配置在下次启动时生效。">
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
        </Form>
      </Card>
    </div>
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
            <div className="pa-inspector-list">
              {state.plan.steps.map((step) => (
                <div className="pa-inspector-list-item" key={`${step.order}-${step.title}`}>
                  <Avatar size={24} className={`pa-plan-step ${step.status}`}>
                    {step.status === 'completed'
                      ? '✓'
                      : step.status === 'failed'
                        ? '!'
                        : step.order}
                  </Avatar>
                  <div className="pa-inspector-list-copy">
                    <div className="pa-inspector-list-title">{step.title}</div>
                    {step.description && (
                      <div className="pa-inspector-list-description">{step.description}</div>
                    )}
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
              value: state.runtime?.plugins.length
                ? `${state.runtime.plugins.length} 个已加载`
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

function useExecutionTimer(busy: boolean): string | undefined {
  const startedAt = useRef<number>();
  const [label, setLabel] = useState<string>();

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    if (busy) {
      if (startedAt.current === undefined) startedAt.current = Date.now();
      const update = () => {
        if (startedAt.current === undefined) return;
        setLabel(`执行中 ${formatExecutionDuration(Date.now() - startedAt.current)}`);
      };
      update();
      interval = setInterval(update, 100);
    } else if (startedAt.current !== undefined) {
      const elapsed = Date.now() - startedAt.current;
      startedAt.current = undefined;
      setLabel(`本次 ${formatExecutionDuration(elapsed)}`);
      hideTimer = setTimeout(() => setLabel(undefined), 5000);
    }

    return () => {
      if (interval) clearInterval(interval);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [busy]);

  return label;
}

function updateAssistantTurn(
  items: TimelineItem[],
  responseSequence: number,
  turnNumber: number,
  updater: (item: MessageTimelineItem) => MessageTimelineItem,
): TimelineItem[] {
  const id = assistantTurnId(responseSequence, turnNumber);
  const index = items.findIndex((item) => item.id === id);
  const current: MessageTimelineItem =
    index >= 0 && items[index]?.kind === 'message'
      ? items[index]
      : {
          id,
          kind: 'message',
          role: 'assistant',
          text: '',
          thinking: '',
          tools: [],
          turnNumber,
          time: currentTime(),
          streaming: true,
        };
  const updated = updater(current);
  if (index === -1) return [...items, updated];
  return items.map((item, itemIndex) => (itemIndex === index ? updated : item));
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
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
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
      status: 'running',
      output: '等待工具返回…',
      restored: true,
    });
  }
  return [...tools.values()];
}

function getRestoredToolStatus(
  output: string,
): Extract<ToolTimelineItem['status'], 'success' | 'failed' | 'interrupted'> {
  const normalized = output.trim();
  if (/tool (?:execution )?interrupted by user/iu.test(normalized)) return 'interrupted';
  return /^(?:Error:|Permission denied:)/iu.test(normalized) ? 'failed' : 'success';
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

function apiFetch(path: string, options: RequestInit = {}) {
  const token = sessionStorage.getItem('personal-agent-token');
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
    if (row.contextWindow || row.maxOutputTokens) {
      models.push({
        id,
        contextWindow: row.contextWindow,
        maxOutputTokens: row.maxOutputTokens,
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
      ? { id: model }
      : {
          id: model.id,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
        },
  );
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}

function ContextUsagePanel({
  usage,
  footer,
}: {
  usage?: ContextUsage;
  footer?: ReactNode;
}) {
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
        <b>{usage.percentage}%</b>
      </div>
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

function getModelSelectWidth(label: string): number {
  const textWidth = Array.from(label).reduce(
    (width, character) => width + (/[\u2E80-\u9FFF\uF900-\uFAFF]/u.test(character) ? 14 : 8),
    0,
  );
  return Math.max(180, Math.min(480, textWidth + 54));
}

function isProviderId(value: string): value is ProviderId {
  return (
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'deepseek' ||
    value === 'ollama' ||
    value === 'volcano'
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

function planStatusLabel(status: string): string {
  return (
    {
      draft: '待批准',
      approved: '已批准',
      in_progress: '执行中',
      completed: '已完成',
    }[status] ?? status
  );
}

function formatExecutionDuration(milliseconds: number): string {
  const totalTenths = Math.max(0, Math.floor(milliseconds / 100));
  const tenths = totalTenths % 10;
  const totalSeconds = Math.floor(totalTenths / 10);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const clock = hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${clock}.${tenths}`;
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
