import { renderMarkdown } from '/markdown.js';

const elements = {
  transcript: document.querySelector('#transcript'),
  welcome: document.querySelector('#welcome'),
  input: document.querySelector('#prompt-input'),
  send: document.querySelector('#send-button'),
  stop: document.querySelector('#stop-button'),
  executionTimer: document.querySelector('#execution-timer'),
  composer: document.querySelector('#composer'),
  connectionPill: document.querySelector('#connection-pill'),
  connectionLabel: document.querySelector('#connection-label'),
  themeToggle: document.querySelector('#theme-toggle'),
  themeIcon: document.querySelector('#theme-icon'),
  themeLabel: document.querySelector('#theme-label'),
  modelSwitcher: document.querySelector('#model-switcher'),
  reasoningControl: document.querySelector('#reasoning-control'),
  reasoningEffort: document.querySelector('#reasoning-effort'),
  runtimeOrb: document.querySelector('#runtime-orb'),
  runtimeModel: document.querySelector('#runtime-model'),
  runtimeProvider: document.querySelector('#runtime-provider'),
  workspaceName: document.querySelector('#workspace-name'),
  composerContext: document.querySelector('#composer-context'),
  configBanner: document.querySelector('#config-banner'),
  configMessage: document.querySelector('#config-message'),
  openProviderSettings: document.querySelector('#open-provider-settings'),
  configureProviderBanner: document.querySelector('#configure-provider-banner'),
  projectSelect: document.querySelector('#project-select'),
  newTask: document.querySelector('#new-task'),
  taskList: document.querySelector('#task-list'),
  sessionId: document.querySelector('#session-id'),
  projectDetail: document.querySelector('#project-detail'),
  taskDetail: document.querySelector('#task-detail'),
  providerDetail: document.querySelector('#provider-detail'),
  modelDetail: document.querySelector('#model-detail'),
  cwdDetail: document.querySelector('#cwd-detail'),
  toolCount: document.querySelector('#tool-count'),
  memoryStatus: document.querySelector('#memory-status'),
  mcpStatus: document.querySelector('#mcp-status'),
  pluginStatus: document.querySelector('#plugin-status'),
  planMode: document.querySelector('#plan-mode'),
  modeExecute: document.querySelector('#mode-execute'),
  modePlan: document.querySelector('#mode-plan'),
  permissionMode: document.querySelector('#permission-mode'),
  planBadge: document.querySelector('#plan-badge'),
  planEmpty: document.querySelector('#plan-empty'),
  planDetail: document.querySelector('#plan-detail'),
  planTitle: document.querySelector('#plan-title'),
  planPercent: document.querySelector('#plan-percent'),
  planProgress: document.querySelector('#plan-progress'),
  planSteps: document.querySelector('#plan-steps'),
  approvePlan: document.querySelector('#approve-plan'),
  inspector: document.querySelector('#inspector'),
  sidebar: document.querySelector('#sidebar'),
  permissionDialog: document.querySelector('#permission-dialog'),
  permissionTool: document.querySelector('#permission-tool'),
  permissionParams: document.querySelector('#permission-params'),
  permissionRemember: document.querySelector('#permission-remember'),
  projectDialog: document.querySelector('#project-dialog'),
  projectForm: document.querySelector('#project-form'),
  projectNameInput: document.querySelector('#project-name-input'),
  projectRootInput: document.querySelector('#project-root-input'),
  createProjectSubmit: document.querySelector('#create-project-submit'),
  providerDialog: document.querySelector('#provider-dialog'),
  providerForm: document.querySelector('#provider-form'),
  providerSelect: document.querySelector('#provider-select'),
  providerApiKeyField: document.querySelector('#provider-api-key-field'),
  providerApiKey: document.querySelector('#provider-api-key'),
  providerKeyHint: document.querySelector('#provider-key-hint'),
  providerBaseURL: document.querySelector('#provider-base-url'),
  providerModel: document.querySelector('#provider-model'),
  providerModelOptions: document.querySelector('#provider-model-options'),
  providerModels: document.querySelector('#provider-models'),
  providerThinkingField: document.querySelector('#provider-thinking-field'),
  providerThinkingEffort: document.querySelector('#provider-thinking-effort'),
  providerConfigPath: document.querySelector('#provider-config-path'),
  providerFormError: document.querySelector('#provider-form-error'),
  saveProvider: document.querySelector('#save-provider'),
  scrollBottom: document.querySelector('#scroll-bottom'),
  toastRegion: document.querySelector('#toast-region'),
};

const state = {
  socket: null,
  connected: false,
  configured: false,
  busy: false,
  sessionId: null,
  projects: [],
  tasks: [],
  activeProjectId: null,
  activeTaskId: null,
  creatingProject: false,
  creatingTask: false,
  savingProvider: false,
  switchingRuntime: false,
  providerSettings: null,
  runtime: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
  assistantByTurn: new Map(),
  tools: new Map(),
  pendingPermission: null,
  planActive: false,
  permissionMode: 'ask',
  followOutput: true,
  autoScrolling: false,
  lastTranscriptScrollTop: 0,
  scrollEndTimer: null,
  executionStartedAt: null,
  executionInterval: null,
  executionHideTimer: null,
};

function connect() {
  clearTimeout(state.reconnectTimer);
  setConnection('connecting');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams(location.search);
  const token = params.get('token') || sessionStorage.getItem('personal-agent-token');
  if (token) sessionStorage.setItem('personal-agent-token', token);
  const socketParams = new URLSearchParams();
  if (token) socketParams.set('token', token);
  const preferredTaskId = localStorage.getItem('personal-agent-active-task');
  if (preferredTaskId) socketParams.set('task', preferredTaskId);
  const query = socketParams.size > 0 ? `?${socketParams}` : '';
  const socket = new WebSocket(`${protocol}//${location.host}/ws${query}`);
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.connected = true;
    state.reconnectAttempts = 0;
    setConnection('online');
    updateComposer();
  });

  socket.addEventListener('message', (event) => {
    try {
      handleServerMessage(JSON.parse(event.data));
    } catch (error) {
      showToast(`无法处理服务端消息：${error.message}`, true);
    }
  });

  socket.addEventListener('close', () => {
    state.connected = false;
    state.busy = false;
    stopExecutionTimer(false);
    setConnection('offline');
    updateComposer();
    if (state.pendingPermission && elements.permissionDialog.open) {
      elements.permissionDialog.close();
      state.pendingPermission = null;
    }
    if (state.creatingProject) setCreationState('project', false);
    if (state.creatingTask) setCreationState('task', false);
    const delay = Math.min(1000 * 2 ** state.reconnectAttempts, 12000);
    state.reconnectAttempts += 1;
    state.reconnectTimer = setTimeout(connect, delay);
  });

  socket.addEventListener('error', () => setConnection('offline'));
}

function handleServerMessage(message) {
  switch (message.type) {
    case 'ready':
      state.runtime = message.runtime;
      state.configured = message.runtime.configured;
      state.sessionId = message.sessionId || null;
      state.activeProjectId = message.activeProjectId || null;
      state.activeTaskId = message.activeTaskId || null;
      rememberActiveTask();
      updateRuntime(message.runtime);
      updateSessionMetadata();
      updateComposer();
      break;
    case 'runtime_updated':
      {
        const becameConfigured = !state.configured && message.runtime.configured;
        state.runtime = message.runtime;
        state.configured = message.runtime.configured;
        updateRuntime(message.runtime);
        updateComposer();
        if (becameConfigured && state.activeTaskId) {
          send({ type: 'open_task', taskId: state.activeTaskId });
        }
      }
      break;
    case 'history':
      state.sessionId = message.sessionId;
      renderHistory(message.messages);
      updateSessionMetadata();
      break;
    case 'project_list':
      state.projects = message.projects;
      state.activeProjectId = message.activeProjectId || state.activeProjectId;
      renderProjects();
      updateWorkspaceMetadata();
      break;
    case 'task_list':
      if (message.projectId !== state.activeProjectId) break;
      state.tasks = message.tasks;
      state.activeTaskId = message.activeTaskId || state.activeTaskId;
      renderTasks();
      updateWorkspaceMetadata();
      break;
    case 'project_changed':
      if (state.activeProjectId !== message.project.id) state.tasks = [];
      state.activeProjectId = message.project.id;
      state.activeTaskId = null;
      upsertById(state.projects, message.project);
      renderProjects();
      renderTasks();
      updateWorkspaceMetadata();
      if (state.creatingProject) {
        elements.projectDialog.close();
        setCreationState('project', false);
      }
      break;
    case 'task_changed':
      state.activeProjectId = message.task.projectId;
      state.activeTaskId = message.task.id;
      rememberActiveTask();
      upsertById(state.tasks, message.task);
      renderTasks();
      updateWorkspaceMetadata();
      if (state.creatingTask) {
        setCreationState('task', false);
        closeSidebar();
        requestAnimationFrame(() => elements.input.focus());
      }
      break;
    case 'task_renamed':
      upsertById(state.tasks, message.task);
      renderTasks();
      updateWorkspaceMetadata();
      break;
    case 'session_list':
      break;
    case 'session_changed':
      state.sessionId = message.sessionId;
      updateSessionMetadata();
      break;
    case 'busy':
      state.busy = message.busy;
      if (message.busy) {
        startExecutionTimer();
      } else {
        finishStreamingMessages();
        stopExecutionTimer(true);
      }
      updateComposer();
      break;
    case 'turn_start':
      break;
    case 'assistant_delta':
      appendAssistantDelta(message.turnNumber, message.text);
      break;
    case 'tool_start':
      createToolCard(message);
      break;
    case 'tool_progress':
      updateToolProgress(message);
      break;
    case 'tool_end':
      finishToolCard(message);
      break;
    case 'permission_request':
      showPermission(message);
      break;
    case 'permission_mode':
      state.permissionMode = message.mode;
      elements.permissionMode.value = message.mode;
      break;
    case 'turn_end':
      finishAssistantTurn(message.turnNumber);
      break;
    case 'done':
      finishStreamingMessages();
      break;
    case 'interrupted':
      finishStreamingMessages();
      showToast('已停止生成');
      break;
    case 'plan':
      renderPlan(message);
      break;
    case 'notice':
      showToast(message.message);
      break;
    case 'error':
      showToast(message.message, true);
      if (state.creatingProject) setCreationState('project', false);
      if (state.creatingTask) setCreationState('task', false);
      if (message.code === 'REQUEST_FAILED') renderTasks();
      if (message.code === 'AGENT_ERROR') appendSystemMessage(message.message, true);
      break;
  }
}

function updateRuntime(runtime) {
  const model = runtime.model || '未配置模型';
  const provider = runtime.providerName || runtime.provider || '需要配置';
  elements.runtimeModel.textContent = model;
  elements.runtimeProvider.textContent = provider;
  elements.providerDetail.textContent = runtime.provider || '—';
  elements.modelDetail.textContent = runtime.model || '—';
  elements.cwdDetail.textContent = runtime.workingDirectory || '—';
  elements.cwdDetail.title = runtime.workingDirectory || '';
  elements.toolCount.textContent = `${runtime.toolCount} tools`;
  elements.memoryStatus.textContent = runtime.memoryEnabled ? '已启用持久化记忆' : '未启用';
  elements.mcpStatus.textContent = runtime.mcpServers.length
    ? `${runtime.mcpServers.filter((server) => server.connected).length}/${runtime.mcpServers.length} 已连接`
    : '未配置服务';
  elements.pluginStatus.textContent = runtime.plugins.length
    ? `${runtime.plugins.length} 个已加载`
    : '未加载插件';
  elements.runtimeOrb.className = `status-orb ${runtime.configured ? 'online' : 'error'}`;
  renderRuntimeSelectors(runtime);

  updateWorkspaceMetadata();

  elements.configBanner.classList.toggle('hidden', runtime.configured);
  elements.configMessage.textContent =
    runtime.initializationError || '点击“立即配置”选择 Provider、模型并保存。';
}

function renderRuntimeSelectors(runtime) {
  const models = runtime.models.filter((model) => model.provider === runtime.provider);
  elements.modelSwitcher.replaceChildren();
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.displayName || model.id;
    elements.modelSwitcher.append(option);
  }
  if (runtime.model && !models.some((model) => model.id === runtime.model)) {
    const option = document.createElement('option');
    option.value = runtime.model;
    option.textContent = runtime.model;
    elements.modelSwitcher.prepend(option);
  }
  if (!elements.modelSwitcher.options.length) {
    const option = document.createElement('option');
    option.textContent = '未配置';
    elements.modelSwitcher.append(option);
  }
  elements.modelSwitcher.value = runtime.model || '';
  elements.reasoningControl.classList.toggle('hidden', !runtime.reasoningSupported);
  elements.reasoningEffort.value = runtime.reasoningEffort || 'off';
  updateRuntimeSelectorState();
}

function updateRuntimeSelectorState() {
  const disabled =
    !state.connected || !state.configured || state.busy || state.switchingRuntime;
  elements.modelSwitcher.disabled = disabled;
  elements.reasoningEffort.disabled = disabled;
}

async function openProviderSettings() {
  elements.providerFormError.classList.add('hidden');
  elements.providerApiKey.value = '';
  elements.providerDialog.showModal();
  setProviderSaving(false);

  try {
    const response = await apiFetch('/api/provider-settings');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取 Provider 配置失败');
    state.providerSettings = data;
    elements.providerConfigPath.textContent = data.configPath;
    elements.providerConfigPath.title = data.configPath;
    elements.providerSelect.value = data.active || 'openai';
    renderProviderFields();
    requestAnimationFrame(() => elements.providerSelect.focus());
  } catch (error) {
    showProviderFormError(error.message);
  }
}

function renderProviderFields() {
  const provider = elements.providerSelect.value;
  const defaults = {
    openai: {
      baseURL: '',
      defaultModel: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'o4-mini'],
      thinkingEffort: 'off',
      requiresApiKey: true,
    },
    anthropic: {
      baseURL: '',
      defaultModel: 'claude-sonnet-5-20251001',
      models: [
        'claude-sonnet-5-20251001',
        'claude-opus-5-20251001',
        'claude-fable-5-20251001',
      ],
      thinkingEffort: 'off',
      requiresApiKey: true,
    },
    deepseek: {
      baseURL: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-flash',
      models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      thinkingEffort: 'high',
      requiresApiKey: true,
    },
    ollama: {
      baseURL: 'http://localhost:11434',
      defaultModel: 'llama3.1',
      models: ['llama3.1'],
      thinkingEffort: 'off',
      requiresApiKey: false,
    },
  };
  const settings = state.providerSettings?.providers?.[provider] || defaults[provider];
  const requiresApiKey = settings.requiresApiKey;
  elements.providerApiKeyField.classList.toggle('hidden', !requiresApiKey);
  elements.providerApiKey.required = requiresApiKey && !settings.hasApiKey;
  elements.providerApiKey.placeholder = settings.hasApiKey
    ? '已配置；留空保持不变'
    : '输入 API Key';
  elements.providerKeyHint.textContent = settings.hasApiKey
    ? '已检测到密钥。留空会保留当前值，服务端不会将密钥回传。'
    : '密钥仅写入本机配置文件，不会回显。';
  elements.providerBaseURL.value = settings.baseURL ?? defaults[provider].baseURL;
  elements.providerModel.value = settings.defaultModel ?? defaults[provider].defaultModel;
  elements.providerModels.value = (settings.models ?? defaults[provider].models).join('\n');
  elements.providerThinkingField.classList.toggle('hidden', provider !== 'deepseek');
  elements.providerThinkingEffort.value =
    settings.thinkingEffort ?? defaults[provider].thinkingEffort;
  renderProviderModelOptions();
}

function renderProviderModelOptions() {
  elements.providerModelOptions.replaceChildren();
  for (const model of parseModelList(elements.providerModels.value)) {
    const option = document.createElement('option');
    option.value = model;
    elements.providerModelOptions.append(option);
  }
}

function parseModelList(value) {
  return [...new Set(value.split(/[,\n]/).map((model) => model.trim()).filter(Boolean))];
}

async function saveProviderSettings(event) {
  event.preventDefault();
  if (state.savingProvider) return;
  elements.providerFormError.classList.add('hidden');
  setProviderSaving(true);

  try {
    const response = await apiFetch('/api/provider-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: elements.providerSelect.value,
        apiKey: elements.providerApiKey.value,
        baseURL: elements.providerBaseURL.value,
        defaultModel: elements.providerModel.value,
        models: parseModelList(elements.providerModels.value),
        thinkingEffort: elements.providerThinkingEffort.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '保存 Provider 配置失败');

    state.providerSettings = data.settings;
    state.runtime = data.runtime;
    state.configured = data.runtime.configured;
    updateRuntime(data.runtime);
    updateComposer();
    elements.providerDialog.close();
    showToast(
      `已启用 ${data.runtime.providerName || data.runtime.provider} · ${data.runtime.model}`,
    );
  } catch (error) {
    showProviderFormError(error.message);
  } finally {
    setProviderSaving(false);
  }
}

async function saveRuntimeSelection() {
  if (state.switchingRuntime || !state.runtime) return;
  state.switchingRuntime = true;
  updateRuntimeSelectorState();
  try {
    const response = await apiFetch('/api/runtime/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: elements.modelSwitcher.value,
        reasoningEffort: elements.reasoningEffort.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '切换模型失败');
    state.runtime = data.runtime;
    updateRuntime(data.runtime);
    showToast(
      `已切换至 ${data.runtime.model}${
        data.runtime.reasoningSupported ? ` · 思考 ${data.runtime.reasoningEffort}` : ''
      }`,
    );
  } catch (error) {
    updateRuntime(state.runtime);
    showToast(error.message, true);
  } finally {
    state.switchingRuntime = false;
    updateRuntimeSelectorState();
  }
}

function setProviderSaving(saving) {
  state.savingProvider = saving;
  elements.saveProvider.disabled = saving;
  elements.saveProvider.textContent = saving ? '正在保存…' : '保存并启用';
}

function showProviderFormError(message) {
  elements.providerFormError.textContent = message;
  elements.providerFormError.classList.remove('hidden');
}

function apiFetch(path, options = {}) {
  const token = sessionStorage.getItem('personal-agent-token');
  const headers = new Headers(options.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(path, { ...options, headers });
}

function updateSessionMetadata() {
  elements.sessionId.textContent = state.sessionId ? state.sessionId.slice(0, 12) : '—';
  elements.sessionId.title = state.sessionId || '';
  for (const item of elements.taskList.querySelectorAll('.session-item')) {
    item.classList.toggle('active', item.dataset.taskId === state.activeTaskId);
  }
}

function renderProjects() {
  elements.projectSelect.replaceChildren();
  if (!state.projects.length) {
    const option = document.createElement('option');
    option.textContent = '暂无项目';
    option.value = '';
    elements.projectSelect.append(option);
    elements.projectSelect.disabled = true;
    return;
  }
  elements.projectSelect.disabled = false;
  for (const project of state.projects) {
    const option = document.createElement('option');
    option.value = project.id;
    option.textContent = project.name;
    option.title = project.rootPath;
    option.selected = project.id === state.activeProjectId;
    elements.projectSelect.append(option);
  }
}

function renderTasks() {
  elements.taskList.replaceChildren();
  if (!state.tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-detail';
    empty.style.padding = '10px';
    empty.textContent = '这个项目还没有任务';
    elements.taskList.append(empty);
    return;
  }
  for (const task of state.tasks) {
    const row = document.createElement('div');
    row.className = 'task-item';
    row.classList.toggle('active', task.id === state.activeTaskId);

    const button = document.createElement('button');
    button.className = 'session-item';
    button.dataset.taskId = task.id;
    button.classList.toggle('active', task.id === state.activeTaskId);
    const title = document.createElement('strong');
    title.textContent = task.title;
    const meta = document.createElement('small');
    meta.textContent = `${relativeTime(task.updatedAt)} · ${task.sessionId ? '可恢复' : '尚未开始'}`;
    button.append(title, meta);
    button.addEventListener('click', () => {
      if (state.busy) return;
      send({ type: 'open_task', taskId: task.id });
      closeSidebar();
    });

    const rename = document.createElement('button');
    rename.className = 'task-rename-button';
    rename.type = 'button';
    rename.title = `重命名“${task.title}”`;
    rename.setAttribute('aria-label', `重命名任务 ${task.title}`);
    rename.textContent = '✎';
    rename.disabled = state.busy;
    rename.addEventListener('click', () => beginTaskRename(task, row));

    row.append(button, rename);
    elements.taskList.append(row);
  }
}

function beginTaskRename(task, row) {
  if (state.busy) return;
  const form = document.createElement('form');
  form.className = 'task-rename-form';
  const input = document.createElement('input');
  input.value = task.title;
  input.maxLength = 200;
  input.setAttribute('aria-label', '新的任务名称');
  const save = document.createElement('button');
  save.type = 'submit';
  save.title = '保存任务名称';
  save.setAttribute('aria-label', '保存任务名称');
  save.textContent = '✓';
  form.append(input, save);
  row.replaceChildren(form);

  const cancel = () => renderTasks();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) {
      input.setCustomValidity('任务名称不能为空');
      input.reportValidity();
      return;
    }
    input.disabled = true;
    save.disabled = true;
    send({ type: 'rename_task', taskId: task.id, title });
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  });
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function updateWorkspaceMetadata() {
  const project = state.projects.find((item) => item.id === state.activeProjectId);
  const task = state.tasks.find((item) => item.id === state.activeTaskId);
  const fallbackRoot = state.runtime?.workingDirectory || '';
  const rootPath = project?.rootPath || fallbackRoot;
  const fallbackName = rootPath.split(/[\\/]/).filter(Boolean).at(-1);

  elements.workspaceName.textContent =
    task?.title || project?.name || fallbackName || 'personal-agent';
  elements.composerContext.textContent = rootPath || '当前工作区';
  elements.composerContext.title = rootPath;
  elements.cwdDetail.textContent = rootPath || '—';
  elements.cwdDetail.title = rootPath;
  elements.projectDetail.textContent = project?.name || '—';
  elements.projectDetail.title = project?.rootPath || '';
  elements.taskDetail.textContent = task?.title || '—';
  elements.taskDetail.title = task?.id || '';
  updateSessionMetadata();
}

function rememberActiveTask() {
  if (state.activeTaskId) {
    localStorage.setItem('personal-agent-active-task', state.activeTaskId);
  }
}

function upsertById(items, value) {
  const index = items.findIndex((item) => item.id === value.id);
  if (index === -1) items.unshift(value);
  else items[index] = value;
}

function renderHistory(messages) {
  state.followOutput = true;
  clearTranscript();
  for (const message of messages) {
    if (message.role === 'system') continue;
    const text = extractMessageText(message);
    if (message.role === 'user') {
      appendMessage('user', text);
    } else if (message.role === 'assistant' && text) {
      appendMessage('assistant', text);
    } else if (message.role === 'tool') {
      appendRestoredTool(message);
    }
  }
  toggleWelcome(messages.filter((message) => message.role !== 'system').length === 0);
  scrollToBottom(false, true);
}

function extractMessageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function appendMessage(role, text, options = {}) {
  toggleWelcome(false);
  const row = document.createElement('article');
  row.className = `message-row ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? 'YOU' : role === 'system' ? '!' : 'PA';
  const body = document.createElement('div');
  body.className = 'message-body';
  const head = document.createElement('div');
  head.className = 'message-head';
  const label = document.createElement('strong');
  label.textContent = role === 'user' ? '你' : role === 'system' ? '系统' : 'personal-agent';
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  head.append(label, time);
  const content = document.createElement('div');
  content.className = `message-content${options.streaming ? ' streaming-cursor' : ''}`;
  if (role === 'system') content.textContent = text;
  else content.innerHTML = renderMarkdown(text);
  body.append(head, content);
  row.append(avatar, body);
  elements.transcript.append(row);
  scrollToBottom();
  return { row, content, text };
}

function appendSystemMessage(text, isError = false) {
  const message = appendMessage('system', text);
  if (isError) message.row.style.color = 'var(--danger)';
}

function appendAssistantDelta(turnNumber, delta) {
  let message = state.assistantByTurn.get(turnNumber);
  if (!message) {
    message = appendMessage('assistant', '', { streaming: true });
    state.assistantByTurn.set(turnNumber, message);
  }
  message.text += delta;
  message.content.innerHTML = renderMarkdown(message.text);
  message.content.classList.add('streaming-cursor');
  scrollToBottom();
}

function finishAssistantTurn(turnNumber) {
  const message = state.assistantByTurn.get(turnNumber);
  message?.content.classList.remove('streaming-cursor');
}

function finishStreamingMessages() {
  for (const message of state.assistantByTurn.values()) {
    message.content.classList.remove('streaming-cursor');
  }
}

function createToolCard(message) {
  toggleWelcome(false);
  const details = document.createElement('details');
  details.className = 'tool-card';
  const summary = document.createElement('summary');
  const stateDot = document.createElement('span');
  stateDot.className = 'tool-state';
  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = message.toolName;
  const status = document.createElement('span');
  status.className = 'tool-status';
  status.textContent = '正在运行';
  summary.append(stateDot, name, status);
  const output = document.createElement('pre');
  output.className = 'tool-output';
  output.textContent = '等待工具返回…';
  details.append(summary, output);
  elements.transcript.append(details);
  state.tools.set(message.toolCallId, { details, status, output });
  scrollToBottom();
}

function updateToolProgress(message) {
  const tool = state.tools.get(message.toolCallId);
  if (!tool) return;
  tool.output.textContent = message.content;
}

function finishToolCard(message) {
  const tool = state.tools.get(message.toolCallId);
  if (!tool) return;
  const success = message.result.success;
  tool.details.classList.add(success ? 'success' : 'failed');
  tool.status.textContent = success ? `${message.result.metadata?.duration ?? 0} ms` : '执行失败';
  tool.output.textContent = (success ? message.result.content : message.result.error) || '(无输出)';
  if (!success) tool.details.open = true;
  scrollToBottom();
}

function appendRestoredTool(message) {
  const details = document.createElement('details');
  details.className = 'tool-card success';
  const summary = document.createElement('summary');
  summary.innerHTML =
    '<span class="tool-state"></span><span class="tool-name">历史工具结果</span><span class="tool-status">已完成</span>';
  const output = document.createElement('pre');
  output.className = 'tool-output';
  output.textContent = extractMessageText(message);
  details.append(summary, output);
  elements.transcript.append(details);
}

function showPermission(message) {
  state.pendingPermission = message;
  elements.permissionTool.textContent = message.toolName;
  elements.permissionParams.textContent = JSON.stringify(message.params, null, 2);
  elements.permissionRemember.checked = false;
  if (!elements.permissionDialog.open) elements.permissionDialog.showModal();
}

function answerPermission(approved) {
  if (!state.pendingPermission) return;
  send({
    type: 'permission_response',
    requestId: state.pendingPermission.requestId,
    approved,
    remember: elements.permissionRemember.checked,
  });
  state.pendingPermission = null;
  elements.permissionDialog.close();
}

function renderPlan(message) {
  state.planActive = message.active;
  elements.planMode.classList.toggle('active', message.active);
  elements.modeExecute.checked = !message.active;
  elements.modePlan.checked = message.active;
  elements.planBadge.textContent = message.active
    ? '规划中'
    : message.plan
      ? planStatusLabel(message.plan.status)
      : '未启用';
  elements.planBadge.classList.toggle('active', message.active || Boolean(message.plan));

  if (!message.plan) {
    elements.planEmpty.classList.remove('hidden');
    elements.planDetail.classList.add('hidden');
    return;
  }

  elements.planEmpty.classList.add('hidden');
  elements.planDetail.classList.remove('hidden');
  elements.planTitle.textContent = message.plan.title;
  elements.planPercent.textContent = `${message.progress.percentage}%`;
  elements.planProgress.style.width = `${message.progress.percentage}%`;
  elements.planSteps.replaceChildren();
  for (const step of message.plan.steps) {
    const item = document.createElement('div');
    item.className = `plan-step ${step.status}`;
    const marker = document.createElement('span');
    marker.className = 'step-marker';
    marker.textContent =
      step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : step.order;
    const title = document.createElement('span');
    title.textContent = step.title;
    item.append(marker, title);
    elements.planSteps.append(item);
  }
  const canApprove = message.active && message.plan.status === 'draft';
  elements.approvePlan.classList.toggle('hidden', !canApprove);
}

function planStatusLabel(status) {
  return (
    {
      draft: '待批准',
      approved: '已批准',
      in_progress: '执行中',
      completed: '已完成',
    }[status] || status
  );
}

function sendPrompt(text = elements.input.value.trim()) {
  if (!text || !state.connected || !state.configured || state.busy) return;
  state.followOutput = true;
  appendMessage('user', text);
  send({ type: 'prompt', text });
  elements.input.value = '';
  resizeInput();
  updateComposer();
}

function send(message) {
  if (state.socket?.readyState !== WebSocket.OPEN) {
    showToast('服务尚未连接', true);
    return;
  }
  state.socket.send(JSON.stringify(message));
}

function updateComposer() {
  const enabled = state.connected && state.configured;
  elements.input.disabled = !enabled;
  elements.input.placeholder = !state.connected
    ? '正在连接本地服务…'
    : !state.configured
      ? '配置 Provider 后即可开始对话'
      : state.busy
        ? 'Agent 正在处理…'
        : '给 personal-agent 发送消息…（Enter 发送，Shift+Enter 换行）';
  elements.send.disabled = !enabled || state.busy || elements.input.value.trim().length === 0;
  elements.modeExecute.disabled = !enabled || state.busy;
  elements.modePlan.disabled = !enabled || state.busy;
  elements.permissionMode.disabled = !enabled || state.busy;
  elements.stop.classList.toggle('hidden', !state.busy);
  updateRuntimeSelectorState();
}

function setConnection(status) {
  const orb = elements.connectionPill.querySelector('.status-orb');
  orb.className = 'status-orb';
  if (status === 'online') {
    orb.classList.add('online');
    elements.connectionLabel.textContent = '本地已连接';
  } else if (status === 'offline') {
    orb.classList.add('error');
    elements.connectionLabel.textContent = '连接已断开';
    elements.runtimeOrb.className = 'status-orb error';
  } else {
    elements.connectionLabel.textContent = '连接中';
  }
}

function startExecutionTimer() {
  clearTimeout(state.executionHideTimer);
  state.executionHideTimer = null;
  if (state.executionStartedAt === null) {
    state.executionStartedAt = Date.now();
  }
  clearInterval(state.executionInterval);
  elements.executionTimer.classList.remove('hidden', 'completed');
  updateExecutionTimer();
  state.executionInterval = setInterval(updateExecutionTimer, 100);
}

function updateExecutionTimer() {
  if (state.executionStartedAt === null) return;
  elements.executionTimer.textContent =
    `执行中 ${formatExecutionDuration(Date.now() - state.executionStartedAt)}`;
}

function stopExecutionTimer(showCompleted) {
  clearInterval(state.executionInterval);
  state.executionInterval = null;
  if (state.executionStartedAt === null) {
    if (!showCompleted) elements.executionTimer.classList.add('hidden');
    return;
  }

  const elapsed = Date.now() - state.executionStartedAt;
  state.executionStartedAt = null;
  if (!showCompleted) {
    elements.executionTimer.classList.add('hidden');
    return;
  }

  elements.executionTimer.textContent = `本次 ${formatExecutionDuration(elapsed)}`;
  elements.executionTimer.classList.add('completed');
  elements.executionTimer.classList.remove('hidden');
  clearTimeout(state.executionHideTimer);
  state.executionHideTimer = setTimeout(() => {
    elements.executionTimer.classList.add('hidden');
    elements.executionTimer.classList.remove('completed');
    state.executionHideTimer = null;
  }, 5000);
}

function formatExecutionDuration(milliseconds) {
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

function relativeTime(value) {
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(value).toLocaleDateString('zh-CN');
}

function clearTranscript() {
  for (const child of [...elements.transcript.children]) {
    if (child !== elements.welcome) child.remove();
  }
  state.assistantByTurn.clear();
  state.tools.clear();
}

function toggleWelcome(show) {
  elements.welcome.classList.toggle('hidden', !show);
}

function scrollToBottom(smooth = true, force = false) {
  if (!force && !state.followOutput) {
    updateScrollBottomButton();
    return;
  }
  state.autoScrolling = true;
  clearTimeout(state.scrollEndTimer);
  requestAnimationFrame(() => {
    elements.transcript.scrollTo({
      top: elements.transcript.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
    requestAnimationFrame(updateScrollBottomButton);
  });
  state.scrollEndTimer = setTimeout(
    () => {
      state.autoScrolling = false;
      state.followOutput = isTranscriptNearBottom();
      updateScrollBottomButton();
    },
    smooth ? 450 : 0,
  );
}

function isTranscriptNearBottom() {
  const remaining =
    elements.transcript.scrollHeight -
    elements.transcript.scrollTop -
    elements.transcript.clientHeight;
  return remaining < 72;
}

function updateScrollBottomButton() {
  elements.scrollBottom.classList.toggle('hidden', isTranscriptNearBottom());
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('personal-agent-theme', theme);
  const isLight = theme === 'light';
  elements.themeIcon.textContent = isLight ? '☀' : '☾';
  elements.themeLabel.textContent = isLight ? '浅色' : '深色';
  elements.themeToggle.title = isLight ? '切换到深色主题' : '切换到浅色主题';
  elements.themeToggle.setAttribute('aria-label', elements.themeToggle.title);
}

function resizeInput() {
  elements.input.style.height = 'auto';
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 180)}px`;
}

function showToast(message, error = false) {
  const toast = document.createElement('div');
  toast.className = `toast${error ? ' error' : ''}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  setTimeout(() => toast.remove(), 4200);
}

function closeSidebar() {
  elements.sidebar.classList.remove('open');
}

elements.input.addEventListener('input', () => {
  resizeInput();
  updateComposer();
});
elements.transcript.addEventListener('scroll', () => {
  const movingUp = elements.transcript.scrollTop < state.lastTranscriptScrollTop - 1;
  state.lastTranscriptScrollTop = elements.transcript.scrollTop;
  if (movingUp) {
    state.autoScrolling = false;
    clearTimeout(state.scrollEndTimer);
    state.followOutput = false;
  } else if (!state.autoScrolling) {
    state.followOutput = isTranscriptNearBottom();
  }
  updateScrollBottomButton();
});
elements.scrollBottom.addEventListener('click', () => {
  state.followOutput = true;
  scrollToBottom(true, true);
});
elements.themeToggle.addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});
elements.openProviderSettings.addEventListener('click', openProviderSettings);
elements.configureProviderBanner.addEventListener('click', openProviderSettings);
elements.providerSelect.addEventListener('change', () => {
  elements.providerApiKey.value = '';
  elements.providerFormError.classList.add('hidden');
  renderProviderFields();
});
elements.providerModels.addEventListener('input', renderProviderModelOptions);
elements.providerForm.addEventListener('submit', saveProviderSettings);
elements.modelSwitcher.addEventListener('change', saveRuntimeSelection);
elements.reasoningEffort.addEventListener('change', saveRuntimeSelection);
document.querySelector('#cancel-provider').addEventListener('click', () => {
  elements.providerDialog.close();
});
elements.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendPrompt();
  }
});
elements.send.addEventListener('click', () => sendPrompt());
elements.stop.addEventListener('click', () => send({ type: 'interrupt' }));
document.querySelector('#new-project').addEventListener('click', () => {
  elements.projectForm.reset();
  elements.projectDialog.showModal();
  requestAnimationFrame(() => elements.projectNameInput.focus());
});
elements.newTask.addEventListener('click', createNewTask);
document.querySelector('#refresh-projects').addEventListener('click', () => {
  send({ type: 'list_projects' });
});
elements.projectSelect.addEventListener('change', () => {
  if (!elements.projectSelect.value || state.busy) return;
  send({ type: 'select_project', projectId: elements.projectSelect.value });
});
elements.projectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = elements.projectNameInput.value.trim();
  const rootPath = elements.projectRootInput.value.trim();
  if (!name || !rootPath) return;
  setCreationState('project', true);
  send({ type: 'create_project', name, rootPath });
});
document.querySelector('#cancel-project').addEventListener('click', () => {
  setCreationState('project', false);
  elements.projectDialog.close();
});
elements.projectDialog.addEventListener('cancel', () => setCreationState('project', false));
elements.modeExecute.addEventListener('change', () => {
  if (elements.modeExecute.checked && !state.busy && state.configured) {
    send({ type: 'set_plan_mode', enabled: false });
  }
});
elements.modePlan.addEventListener('change', () => {
  if (elements.modePlan.checked && !state.busy && state.configured) {
    send({ type: 'set_plan_mode', enabled: true });
  }
});
elements.permissionMode.addEventListener('change', () => {
  state.permissionMode = elements.permissionMode.value;
  send({ type: 'set_permission_mode', mode: state.permissionMode });
});
elements.approvePlan.addEventListener('click', () => send({ type: 'approve_plan' }));
document.querySelector('#approve-permission').addEventListener('click', (event) => {
  event.preventDefault();
  answerPermission(true);
});
document.querySelector('#deny-permission').addEventListener('click', (event) => {
  event.preventDefault();
  answerPermission(false);
});
elements.permissionDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  answerPermission(false);
});
for (const starter of document.querySelectorAll('.starter')) {
  starter.addEventListener('click', () => sendPrompt(starter.dataset.prompt));
}
document.querySelector('#toggle-inspector').addEventListener('click', () => {
  setInspectorOpen(!elements.inspector.classList.contains('open'));
});
document.querySelector('#open-inspector').addEventListener('click', () => {
  setInspectorOpen(true);
});
document.querySelector('#close-inspector').addEventListener('click', () => {
  setInspectorOpen(false);
});
document.querySelector('#open-sidebar').addEventListener('click', () => {
  elements.sidebar.classList.add('open');
});
document.querySelector('#close-sidebar').addEventListener('click', closeSidebar);
document.querySelector('#sidebar-scrim').addEventListener('click', closeSidebar);
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    createNewTask();
  } else if (event.key === 'Escape' && elements.inspector.classList.contains('open')) {
    setInspectorOpen(false);
  }
});

function setInspectorOpen(open) {
  elements.inspector.classList.toggle('open', open);
  for (const button of [
    document.querySelector('#toggle-inspector'),
    document.querySelector('#open-inspector'),
  ]) {
    button.setAttribute('aria-expanded', String(open));
  }
  document.querySelector('#toggle-inspector').classList.toggle('active', open);
}

function createNewTask() {
  if (state.busy || state.creatingTask) return;
  if (!state.activeProjectId) {
    showToast('请先创建一个项目', true);
    return;
  }
  setCreationState('task', true);
  send({ type: 'create_task', projectId: state.activeProjectId });
}

function setCreationState(kind, creating) {
  const project = kind === 'project';
  if (project) state.creatingProject = creating;
  else state.creatingTask = creating;
  const button = project ? elements.createProjectSubmit : elements.newTask;
  button.disabled = creating;
  button.toggleAttribute('aria-busy', creating);
  if (project) {
    button.textContent = creating ? '正在创建…' : '创建项目';
  }
}

setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
connect();
