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
  Layout,
  Menu,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Tree,
  Typography,
  theme as antdTheme,
} from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import {
  AppstoreOutlined,
  BugOutlined,
  BulbOutlined,
  CaretRightOutlined,
  CheckCircleFilled,
  CloseOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  MenuOutlined,
  MoonOutlined,
  MoreOutlined,
  PlusOutlined,
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
import type {
  ClientMessage,
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
type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'ollama';
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

interface ProviderFormValues {
  provider: ProviderId;
  apiKey?: string;
  baseURL: string;
  defaultModel: string;
  models: string;
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
      models: string[];
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
  const followOutputRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [draftTaskProjectId, setDraftTaskProjectId] = useState<string>();
  const pendingTaskDraftRef = useRef<{ projectId: string; prompt?: string }>();
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryPickerLoading, setDirectoryPickerLoading] = useState(false);
  const [directoryTreeData, setDirectoryTreeData] = useState<DirectoryTreeNode[]>([]);
  const [selectedDirectory, setSelectedDirectory] = useState<string>();
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [providerView, setProviderView] = useState<'list' | 'form'>('list');
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerDeleting, setProviderDeleting] = useState<ProviderId>();
  const [providerSettings, setProviderSettings] = useState<ProviderSettingsInfo | null>(null);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [debugModalOpen, setDebugModalOpen] = useState(false);
  const [modelCalls, setModelCalls] = useState<ModelCallTrace[]>([]);
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
  const providerModelsText = Form.useWatch('models', providerForm) ?? '';
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
          if (becameConfigured && stateRef.current.activeTaskId) {
            send({ type: 'open_task', taskId: stateRef.current.activeTaskId });
          }
          break;
        }
        case 'history': {
          if (pendingTaskDraftRef.current) break;
          setModelCalls([]);
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
        case 'task_list':
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
        case 'project_changed':
          patchState((current) => ({
            projects: upsertById(current.projects, incoming.project),
            activeProjectId: incoming.project.id,
            activeTaskId: undefined,
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
            pendingTaskDraftRef.current = undefined;
            setDraftTaskProjectId(undefined);
            followOutputRef.current = true;
            appendMessage('user', initialPrompt);
            if (send({ type: 'prompt', text: initialPrompt })) setPrompt('');
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
        case 'busy':
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
        case 'turn_start':
          break;
        case 'llm_call_start':
          setModelCalls((current) => [
            ...current,
            {
              ...incoming.call,
              status: 'running',
            },
          ]);
          setSelectedModelCallId(incoming.call.callId);
          break;
        case 'llm_call_end':
          setModelCalls((current) =>
            current.map((call) =>
              call.callId === incoming.call.callId ? { ...call, ...incoming.call } : call,
            ),
          );
          break;
        case 'thinking_delta':
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
        case 'assistant_delta':
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
        case 'tool_start':
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
        case 'tool_progress':
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
        case 'tool_end':
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
        case 'permission_request':
          setRememberPermission(false);
          patchState({ pendingPermission: incoming });
          break;
        case 'turn_end':
          updateTimeline((items) =>
            items.map((item) =>
              item.id === assistantTurnId(activeResponseSequenceRef.current, incoming.turnNumber) &&
              item.kind === 'message'
                ? { ...item, streaming: false }
                : item,
            ),
          );
          break;
        case 'done':
          updateTimeline((items) =>
            items.map((item) =>
              item.kind === 'message' && item.streaming ? { ...item, streaming: false } : item,
            ),
          );
          break;
        case 'interrupted':
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
        case 'permission_mode':
          patchState({ permissionMode: incoming.mode });
          break;
        case 'plan':
          patchState({
            planActive: incoming.active,
            plan: incoming.plan,
            planProgress: incoming.progress,
          });
          break;
        case 'notice':
          messageApi.info(incoming.message);
          break;
        case 'error':
          messageApi.error(incoming.message);
          if (incoming.code === 'AGENT_ERROR') {
            appendMessage('system', incoming.message, { error: true });
          }
          patchState({
            creatingProject: false,
            creatingTask: false,
          });
          break;
        case 'pong':
          break;
      }
    },
    [appendMessage, messageApi, nextId, patchState, replaceTimeline, send, updateTimeline],
  );

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
          handleServerMessage(JSON.parse(String(event.data)) as ServerMessage);
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
  }, [handleServerMessage, messageApi, patchState]);

  useLayoutEffect(() => {
    if (!followOutputRef.current) return;
    const element = transcriptRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
    setShowScrollButton(false);
  }, [timeline]);

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
  const runtimeModels = buildRuntimeModelGroups(state.runtime);
  const runtimeReasoningOptions: ReasoningEffort[] =
    activeRuntimeModel?.reasoningOptions ??
    (state.runtime?.reasoningSupported ? ['off', 'high', 'max'] : ['off']);

  function createNewTask() {
    if (stateRef.current.busy || stateRef.current.creatingTask) return;
    const projectId = stateRef.current.activeProjectId;
    if (!projectId) {
      messageApi.error('请先创建一个项目');
      return;
    }
    pendingTaskDraftRef.current = { projectId };
    setDraftTaskProjectId(projectId);
    setPrompt('');
    replaceTimeline([]);
    setModelCalls([]);
    setSelectedModelCallId(undefined);
    setShowScrollButton(false);
    patchState({
      activeProjectId: projectId,
      activeTaskId: undefined,
      creatingTask: false,
      sidebarOpen: false,
    });
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('#prompt-input')?.focus(),
    );
  }

  function submitPrompt(value = prompt.trim()) {
    const text = value.trim();
    if (
      !text ||
      !stateRef.current.connected ||
      !stateRef.current.configured ||
      stateRef.current.busy ||
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
      if (!send({ type: 'create_task', projectId: pendingTaskDraft.projectId })) {
        pendingTaskDraftRef.current = pendingTaskDraft;
        patchState({ creatingTask: false });
      }
      return;
    }
    followOutputRef.current = true;
    appendMessage('user', text);
    if (send({ type: 'prompt', text })) setPrompt('');
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
      models: values.models.join('\n'),
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
          models: parseModelList(values.models),
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
      busy={state.busy || state.creatingTask}
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
        if (!state.busy) {
          discardTaskDraft();
          // 切换到项目时自动展开其任务
          setCollapsedProjects((current) => {
            const next = new Set(current);
            next.delete(projectId);
            return next;
          });
          send({ type: 'select_project', projectId });
        }
      }}
      onCreateProject={() => {
        discardTaskDraft();
        projectForm.resetFields();
        setSelectedDirectory(undefined);
        setProjectModalOpen(true);
      }}
      onCreateTask={createNewTask}
      onRefresh={() => send({ type: 'list_projects' })}
      onOpenTask={(taskId) => {
        if (state.busy) return;
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
  const providerModelOptions = parseModelList(providerModelsText).map((model) => ({
    value: model,
  }));
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
            }}
          >
            <div className="pa-transcript-inner">
              {timeline.length === 0 ? (
                <Welcome onSelectPrompt={submitPrompt} />
              ) : (
                timeline.map((item) => <TimelineEntry key={item.id} item={item} />)
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
            permissionMode={state.permissionMode}
            pendingPermission={state.pendingPermission}
            rememberPermission={rememberPermission}
            runtime={state.runtime}
            runtimeModelValue={runtimeModelValue}
            runtimeModels={runtimeModels}
            runtimeReasoningOptions={runtimeReasoningOptions}
            runtimeDisabled={runtimeDisabled}
            executionLabel={executionLabel}
            onPromptChange={setPrompt}
            onSubmit={submitPrompt}
            onStop={() => send({ type: 'interrupt' })}
            onAnswerPermission={answerPermission}
            onRememberPermissionChange={setRememberPermission}
            onPlanModeChange={(enabled) => send({ type: 'set_plan_mode', enabled })}
            onPermissionModeChange={(mode) => {
              patchState({ permissionMode: mode });
              send({ type: 'set_permission_mode', mode });
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
          onApprovePlan={() => send({ type: 'approve_plan' })}
        />
      </Drawer>

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
            <Input
              placeholder="请选择本地根目录"
              onClick={() => {
                void openDirectoryPicker();
              }}
              addonAfter={
                <Button
                  type="text"
                  size="small"
                  icon={<FolderOpenOutlined />}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void openDirectoryPicker();
                  }}
                >
                  选择
                </Button>
              }
            />
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
              selectedKeys={['providers']}
              items={[
                {
                  key: 'providers',
                  icon: <RobotOutlined />,
                  label: '模型提供商',
                },
              ]}
            />
          </nav>
          <Spin spinning={providerLoading} className="pa-settings-spin">
            <section className="pa-settings-content">
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
                            <Avatar shape="square" icon={<RobotOutlined />} />
                            <div>
                              <Space size={8}>
                                <strong>{providerLabels[provider]}</strong>
                                {providerSettings?.active === provider && (
                                  <Tag color="success">当前使用</Tag>
                                )}
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
                      options={Object.entries(providerLabels).map(([value, label]) => ({
                        value,
                        label,
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
                    name="models"
                    label="可选模型"
                    extra="每行或逗号分隔；保存后可在输入框右下角切换。"
                  >
                    <TextArea rows={4} placeholder="每行填写一个模型 ID" />
                  </Form.Item>
                  {selectedProvider === 'deepseek' && (
                    <Form.Item
                      name="thinkingEffort"
                      label="默认思考强度"
                      extra="DeepSeek 的 low/medium 等价于 high，因此仅展示有效档位。"
                    >
                      <Select options={getReasoningOptions(['off', 'high', 'max'])} />
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
  onCreateTask: () => void;
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
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
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
                      className={`pa-project-row${project.archived ? ' archived' : ''}${
                        project.id === activeProjectId ? ' active' : ''
                      }`}
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
              disabled={busy}
              onClick={() => onOpenTask(task.id)}
              title={`${task.title} · ${relativeTime(task.updatedAt)} · ${
                task.sessionId ? '可恢复' : '尚未开始'
              }`}
            >
              <strong>{task.title}</strong>
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

function TimelineEntry({ item }: { item: TimelineItem }) {
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
    <article className={`pa-message-row ${item.role}`}>
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
  permissionMode,
  pendingPermission,
  rememberPermission,
  runtime,
  runtimeModelValue,
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
  onPermissionModeChange,
  onModelChange,
  onReasoningChange,
}: {
  rootPath: string;
  prompt: string;
  enabled: boolean;
  busy: boolean;
  creatingTask: boolean;
  planActive: boolean;
  permissionMode: PermissionMode;
  pendingPermission?: PermissionRequest;
  rememberPermission: boolean;
  runtime?: RuntimeInfo;
  runtimeModelValue?: string;
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
  onPermissionModeChange: (mode: PermissionMode) => void;
  onModelChange: (value: string) => void;
  onReasoningChange: (effort: ReasoningEffort) => void;
}) {
  const placeholder = !enabled
    ? '配置 Provider 后即可开始对话'
    : busy
      ? 'Agent 正在处理…'
      : '给 personal-agent 发送消息…（Enter 发送，Shift+Enter 换行）';
  const activeModel = findRuntimeModel(runtime, runtime?.provider, runtime?.model);
  const activeModelLabel = activeModel?.displayName || runtime?.model || '选择模型';
  const activeModelTitle = runtime?.providerName
    ? `${runtime.providerName} · ${activeModelLabel}`
    : activeModelLabel;

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
                <strong id="permission-title">允许执行这个操作吗？</strong>
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
          </div>
          <div className="pa-composer-right">
            <Select
              value={runtimeModelValue}
              options={runtimeModels.length ? runtimeModels : [{ label: '未配置', options: [] }]}
              disabled={runtimeDisabled}
              className="pa-model-select"
              popupMatchSelectWidth={false}
              style={{ width: getModelSelectWidth(activeModelLabel) }}
              title={activeModelTitle}
              aria-label="切换当前模型"
              onChange={onModelChange}
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

function parseModelList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
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
      title: `${model.providerName || model.provider} · ${model.id}`,
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
      title: `${runtime.providerName || runtime.provider} · ${runtime.model}`,
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
  return value === 'openai' || value === 'anthropic' || value === 'deepseek' || value === 'ollama';
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
