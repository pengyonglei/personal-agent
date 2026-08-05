# Web 端多任务并行改造设计文档

**文档状态**：Approved v1.0 ｜ **适用范围**：apps/web（server.ts / runtime.ts / protocol.ts / client/src/App.tsx）+ packages/tool（types.ts）｜ **关联计划**：step-1 ~ step-8

---

## 1. 背景与目标

### 1.1 现状问题

当前 Web UI 的任务执行模型是**"单连接单任务串行"**：

| 限制 | 代码依据 |
|---|---|
| 一个 WebSocket 连接只有一个 `WebConversation`，切换任务靠 `switchWorkspace` 复用 | server.ts:361 |
| 任务生成中（busy）切换/新建任务直接抛错 | runtime.ts:1351 `assertIdle()` |
| 所有任务共享同一个 provider 实例，模型切换全局生效 | runtime.ts:109, 577-579 |
| 协议消息无 taskId，事件天然归属当前连接唯一任务 | protocol.ts:31-58, 115-171 |

用户需要在**同一页面内**并行执行多个任务，且**每个任务使用不同模型**，同时希望**权限规则表保持全局共享**（安全基线统一）。

### 1.2 改造目标

1. **任务级并行**：同一连接内 `Map<taskId, WebConversation>`，各任务独立 AgentLoop / ContextAssembler / TokenBudget / Plan / 中断，互不干扰
2. **每任务独立模型**：Provider 实例池 `Map<'provider:model', LLMProvider>`，任务 A 用 deepseek-v4-flash、任务 B 用 deepseek-v4-pro 互不影响；未覆盖的任务继承全局默认
3. **权限规则表共享 + 任务级差异**：全局规则（config.tools.permissions / SAFE_TOOLS / MCP autoApprove）一份表全任务生效；`check()` 增加 taskId 上下文过滤，支持 `target: 'task:xxx'` 任务特定规则
4. **兼容性**：缺省 taskId 的消息路由到 activeTask，多标签页旧行为不回归

---

## 2. 现状架构分析

### 2.1 执行链路（改造前）

```
浏览器标签页 (1 条 WebSocket)
  └─ App.tsx:927  new WebSocket(`ws://host/ws?task=xxx`)
       │ send({type:'prompt', text})
       ▼
server.ts:443  ws.on('message') → messageQueue 串行排队（interrupt/permission_response 除外）
       ▼
server.ts:604  conversation.runPrompt(text)     ← 唯一的 WebConversation
       │          └─ AgentLoop.run()  ←→ 共享 toolExecutor / permissionManager
       ▼
实时事件 → send() → App.tsx:535 handleServerMessage → 单条 timeline
```

### 2.2 状态归属清单（改造基准）

| 状态 | 当前归属 | 改造后归属 |
|---|---|---|
| `ContextAssembler` / 上下文历史 | conversation 实例级 ✅ | 不变 |
| `TokenBudget` / context_usage | conversation 实例级 ✅ | 不变 |
| `SessionManager` / session 文件 | conversation 实例级 ✅ | 不变 |
| `PlanModeEngine` / plan | conversation 实例级 ✅ | 不变 |
| `permissionMode`（ask/allow/approval） | conversation 实例级 ✅ | 不变 |
| `rememberedPermissions` | conversation 实例级 ✅ | 不变 |
| **provider / 模型** | **runtime 全局单例 ❌** | **实例池，per-task** |
| **PermissionManager 规则表** | runtime 全局单例（保持共享 ✅） | 共享 + check(ctx) 过滤 |
| MCP / 记忆库 / 统计 / 插件 | runtime 全局共享（合理 ✅） | 不变 |
| 前端 busy / timeline / contextUsage / plan | 连接级单例 ❌ | per-task Map |

**关键结论**：runtime 层的 `WebConversation` 已经是"任务级独立"的完整单元（多标签页并行已被验证），改造的核心是**连接层不再复用 conversation** + **provider 解耦** + **前端状态任务化**。

---

## 3. 目标架构

```
浏览器标签页 (1 条 WebSocket)
  │
  ├─ conversations: Map<taskId, WebConversation>   ← 新增（替代单 conversation）
  │     ├─ task-A → WebConversation(provider: deepseek-v4-flash 实例)
  │     │            ├─ AgentLoop / ContextAssembler / TokenBudget / PlanEngine
  │     │            └─ SessionManager(session-A.json)
  │     └─ task-B → WebConversation(provider: deepseek-v4-pro 实例)
  │                  ├─ AgentLoop / ContextAssembler / TokenBudget / PlanEngine
  │                  └─ SessionManager(session-B.json)
  │
  ├─ 消息路由：handleMessage(msg.taskId ?? activeTaskId)
  ├─ 权限：pendingPermissions: Map<requestId, {taskId, resolve, timeout}>
  └─ 共享（不变）：PermissionManager 规则表 / toolExecutor / MCP / memoryStore / statsStore

runtime 层（WebAgentRuntime）
  ├─ providerPool: Map<'provider:model', LLMProvider>   ← 新增
  ├─ globalDefaultProvider: LLMProvider                 ← 原 this.provider（默认模型）
  └─ taskModelOverrides: Map<taskId, LLMProvider>       ← 每任务覆盖
```

---

## 4. 协议变更（protocol.ts）

### 4.1 ClientMessage 变更

| 消息 | 变更 |
|---|---|
| `prompt` | + 可选 `taskId`（缺省=activeTask） |
| `interrupt` | + 可选 `taskId` |
| `permission_response` | + 可选 `taskId`（用于校验归属） |
| `load_session` / `new_session` | + 可选 `taskId` |
| `set_permission_mode` / `set_plan_mode` / `approve_plan` / `compress_context` | + 可选 `taskId` |
| **`set_task_model`**（新增） | `{ taskId, providerId, model, reasoningEffort? }` — 每任务切换模型 |
| **`set_task_rule`**（新增） | `{ taskId, tool, action }` — 添加任务特定权限规则 |

### 4.2 ServerMessage 变更

| 消息 | 变更 |
|---|---|
| `busy` / `turn_start` / `thinking_delta` / `assistant_delta` / `tool_start` / `tool_progress` / `tool_end` / `turn_end` / `done` / `interrupted` / `permission_mode` / `plan` / `context_usage` | + 可选 `taskId`（缺省=activeTask，兼容旧客户端） |
| **`permission_request`** | + **必填 `taskId`**（安全关键：审批归属） |
| `notice` / `error` | + 可选 `taskId` |
| `task_list` | TaskSummary + `running: boolean`、`model?: string` |
| `ready` | 不变（activeTaskId 已有） |

**兼容策略**：服务端收到缺 taskId 的消息 → 按 `activeTaskId` 路由；推送事件缺 taskId → 前端按 activeTask 渲染。旧客户端（不带新字段）行为与现状完全一致。

---

## 5. Provider 实例池（runtime.ts）

### 5.1 设计

```ts
class WebAgentRuntime {
  // 原 this.provider 拆分为三部分：
  private providerPool = new Map<string, LLMProvider>();      // key: `${providerId}:${model}`
  private globalDefault: LLMProvider | null = null;           // 全局默认（原 this.provider 语义）
  private taskOverrides = new Map<string, LLMProvider>();     // taskId → 覆盖实例

  /** 取（或创建）指定 (provider, model) 的实例 —— 同组合复用 */
  getProviderForTask(providerId: string, model: string): LLMProvider {
    const key = `${providerId}:${model}`;
    let instance = this.providerPool.get(key);
    if (!instance) {
      instance = createFromConfig(providerId, model);   // 复用 configureProvider 的构造逻辑
      await instance.initialize();
      this.providerPool.set(key, instance);
    }
    return instance;
  }

  /** 任务创建/激活时：默认继承全局，覆盖时用 taskOverrides */
  resolveProviderForTask(taskId: string): LLMProvider {
    return this.taskOverrides.get(taskId) ?? this.globalDefault;
  }
}
```

### 5.2 语义规则

1. **任务创建**：`createConversation(taskId, workingDirectory)` → 使用 `resolveProviderForTask(taskId)`
2. **每任务切换模型**：`configureTaskModel(taskId, providerId, model)` → 从池取实例 → `taskOverrides.set(taskId, instance)` → 仅对该任务调 `conversation.replaceProvider(instance)`（runtime.ts:1097 已有，会重建 agent loop 与 tokenBudget）
3. **全局切换模型**：原 `configureRuntimeModel`（无 taskId）→ 更新 `globalDefault` + `provider.setModel()` → 广播给**未被覆盖**的任务（`taskOverrides` 中的跳过）
4. **configureProvider / removeProvider**：重建池中该供应商全部实例；删除时从池和 taskOverrides 移除
5. **dispose()**：遍历池统一 `disposeAll`（防泄漏）

### 5.3 附带收益（无需额外改动）

- 上下文窗口：`resolveContextWindow(provider)`（runtime.ts:1517）基于实例 `getModelList()` → 每任务上下文窗口随模型自然独立
- 统计：`ModelRequestRecorder(store, () => sessionId)`（runtime.ts:1219）按 sessionId 记账 → 多模型并发记账天然兼容
- 子代理（未来 Web 端引入时）：SubAgentManager 接收 provider 参数（sub-agent.ts:30），可直接复用任务实例

### 5.4 资源开销

- 每 `(provider:model)` 组合一个 SDK client 连接；5 个任务 × 2 个模型 = 最多 2 个实例（同组合复用），可接受
- Ollama 本地服务无 key 校验，多实例安全

---

## 6. 权限规则表：共享基线 + 任务级过滤

### 6.1 原则（保持共享）

规则注入方式**完全不变**，仍是一份全局表：

| 来源 | 代码位置 | 改造 |
|---|---|---|
| config.tools.permissions | runtime.ts:154 | 不变（可新增 target 字段配置） |
| SAFE_TOOLS 自动放行 | runtime.ts:155-157 | 不变 |
| MCP autoApprove | runtime.ts:235-244 | 不变 |

**为什么共享**：安全策略统一、配置一处生效、MCP 连接变化无需同步副本（若 per-task 复制规则表，漏同步一次就是安全漏洞）。

### 6.2 任务级差异（types.ts 扩展）

```ts
// types.ts:186 —— PermissionRule 增加 target
interface PermissionRule {
  tool: string;
  pattern?: string;
  action: 'allow' | 'ask' | 'approval';
  scope: 'session' | 'project' | 'global';   // 保留（现为语义标记）
  target?: 'all' | `task:${string}` | `project:${string}`;  // 新增，缺省 'all'
}

// types.ts:204 —— check 增加 ctx 过滤
check(toolName: string, params?: Record<string, unknown>,
      ctx?: { taskId?: string; projectId?: string }): 'allow' | 'ask' | 'approval' {
  for (const rule of this.rules) {
    if (rule.target && ctx && rule.target !== 'all') {
      if (rule.target.startsWith('task:') && rule.target !== `task:${ctx.taskId}`) continue;
      if (rule.target.startsWith('project:') && rule.target !== `project:${ctx.projectId}`) continue;
    }
    // ... 原有 tool/pattern 匹配逻辑不变
  }
}
```

### 6.3 决策链路（改造后）

```
requestToolPermission(conversation, toolName, params):
  ① conversation.permissionMode === 'allow'      → true        【任务独立】
  ② getRememberedPermission(toolName)            → 记住值      【任务独立】
  ③ mode === 'approval'                          → 弹窗        【任务独立】
  ④ permissionManager.check(toolName, params,
       { taskId: conversation.taskId })          → 共享表+过滤 【共享基线 + 任务规则】
       - 'allow' → true
       - 'ask' 且工具非危险 → true
       - 否则 → 弹窗（permission_request 带 taskId）
```

**安全要点**：`permission_request` 必带 taskId；前端弹窗标题显示任务名；`pendingPermissions` 增加 taskId 字段用于回复校验（server.ts:366 附近）。

---

## 7. 服务端连接层改造（server.ts）

### 7.1 核心变更

```ts
// 改造前（server.ts:361）：
let conversation: WebConversation | null = null;
// 改造后：
const conversations = new Map<string, WebConversation>();   // taskId → conversation

async function activateTask(taskId: string, announce = true): Promise<void> {
  // 不再 switchWorkspace 复用；按 taskId 查找，无则创建
  let conversation = conversations.get(taskId);
  if (!conversation) {
    conversation = runtime.createConversation(
      send, requestPermission.bind(taskId),
      project.rootPath,                                // 任务工作目录
      runtime.resolveProviderForTask(taskId),          // 任务模型实例
    );
    await conversation.start();
    if (task.sessionId) await conversation.restoreSession(task.sessionId);
    conversations.set(taskId, conversation);
  }
  activeTaskId = taskId;   // 仅用于 UI 焦点，不再承载执行状态
}
```

### 7.2 配套变更

| 位置 | 变更 |
|---|---|
| `handleMessage` | 按 `msg.taskId ?? activeTaskId` 取 conversation；`prompt` 不再受 busy 限制（各任务独立 busy） |
| `interrupt` | 带 taskId → 只中断目标任务；缺省 → activeTask |
| `permission_response` | 校验 requestId 对应的 taskId（防串扰） |
| `activateTask` | 移除对 `assertIdle` 的依赖（不再等待任务空闲） |
| `ws.on('close')` | 遍历关闭所有 conversations（现只关单个） |
| `requestPermission` | 闭包携带 taskId，`permission_request` 附 taskId |
| `sendProjectState` | `task_list` 附 running / model 字段 |
| `switchAwayFromProject` | 关闭该项目下所有 conversation |

### 7.3 保留的兼容路径

`WebConversation.switchWorkspace()`（runtime.ts:1068）保留但不被 Web 连接层调用——仅作 API 兼容，避免破坏桌面端/测试代码引用。

---

## 8. 前端多任务视图（App.tsx + styles.css）

### 8.1 状态重构（WorkspaceState）

```ts
// 改造前：单例
busy: boolean;  timeline: MessageTimelineItem[];  contextUsage?: ContextUsage;
plan: Plan | null;  planProgress: PlanProgress;  permissionMode: PermissionMode;

// 改造后：per-task
busyTaskIds: Set<string>;
timelines: Map<taskId, MessageTimelineItem[]>;
contextUsages: Map<taskId, ContextUsage>;
plans: Map<taskId, Plan | null>;
planProgresses: Map<taskId, PlanProgress>;
modelCalls: Map<taskId, ModelCallDebugStart[]>;
```

### 8.2 UI 变更

| 区域 | 变更 |
|---|---|
| 任务侧边栏 | 每任务显示运行徽标（⏳/✅）、模型名；点击切换视图（不再清空 timeline） |
| Composer | `submitPrompt` 携带当前 taskId；`busy` 判断改为 `busyTaskIds.has(activeTaskId)`；新增 per-task 模型下拉（`set_task_model`，未覆盖显示"继承全局"） |
| 权限弹窗 | 标题标注任务名（`permission_request.taskId` → 任务标题映射） |
| 上下文面板 / Plan 面板 | 按 activeTask 渲染对应 Map 条目 |
| 服务端事件处理 | `handleServerMessage` 按 `incoming.taskId ?? activeTaskId` 分派到 per-task 状态 |

---

## 9. 分阶段实施与验证

| 阶段 | 内容 | 验证 |
|---|---|---|
| P1 | 设计文档（本文档） | 评审通过 |
| P2 | 协议层（protocol.ts） | `parseClientMessage` 单测：新旧字段兼容 |
| P3 | 权限过滤（tool/types.ts） | 单测：同工具不同任务返回不同 action |
| P4 | Provider 实例池（runtime.ts） | 单测：同组合复用、dispose 清理 |
| P5 | 服务端连接层（server.ts） | 手工：两任务并行、中断互不影响 |
| P6 | 前端多任务视图（App.tsx） | 手工验证矩阵（见 §10） |
| P7 | 兼容 + 全量联调 | 构建通过 + 验证矩阵全绿 |
| P8 | 文档/版本号/changeset | 发布包验证 |

## 10. 手工验证矩阵

| # | 场景 | 期望 |
|---|---|---|
| V1 | 任务A(deepseek-v4-flash) + 任务B(deepseek-v4-pro) 同时执行 | 互不中断、各自输出流正确 |
| V2 | 任务A busy 时新建任务C 并发送 prompt | C 立即执行，A 不受影响 |
| V3 | 任务A、B 同时请求权限 | 两个弹窗可区分（标题含任务名），回复互不串扰 |
| V4 | 任务A 上下文 80%，任务B 上下文 10% | 各自 context_usage 独立显示 |
| V5 | 任务A 生成中切换其模型 | 只重建 A，B 不受影响 |
| V6 | 多标签页（旧行为） | 不回归：单连接单任务仍正常 |
| V7 | 服务重启后恢复 | 各任务 session 按 taskId 正确恢复 |
| V8 | 中断任务A | B 继续运行 |
| V9 | config 增加 target: 'task:xxx' 规则 | 仅目标任务生效，其他任务不受影响 |

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 前后端协议不同步（缺 taskId） | 双端可选字段 + 缺省路由 + 同版本发布 |
| 权限审批串扰（安全） | permission_request 必带 taskId + 回复校验归属 |
| provider 实例泄漏 | dispose() 统一清理池；实例池单测覆盖 |
| 前端状态重构回归 | WorkspaceState 集中改造 + V6/V7 回归项 |
| LLM API 并发限流 | 文档说明；预留 `agent.maxConcurrentTasks` 配置（本期不做，标记 TODO） |
| MCP 并发调用 | 依赖 SDK requestId 隔离，联调验证 V3 覆盖 |

## 12. 回滚方案

- **代码回滚**：协议层为可选字段，回滚只影响新功能（多任务并行），旧功能无损
- **数据回滚**：无 schema 变更（session/project 存储格式不变）
- **灰度**：先发布协议+服务端（旧客户端兼容），再发布前端
