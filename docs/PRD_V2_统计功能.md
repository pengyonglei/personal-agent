# 模型请求统计功能 · 详细实施计划（PRD v2）

> 状态：已评审，待执行
> 日期：2026-08-04
> 关联需求：新增模型请求统计功能，SQLite 存储

---

## 一、背景与目标

在 personal-agent 中新增"模型请求统计"能力：每次模型调用落地一条明细记录到 SQLite，包含输入 token、输出 token、请求入参、响应出参、模型供应商、模型名称等，并提供按天/按模型/按供应商的汇总查询与费用估算。

**交互入口**：CLI 交互模式（readline + TUI）新增 `/stats`、`/stats-recent` 命令；单次 prompt 模式同样自动记录（无命令展示）。

## 二、已确认决策

| 决策点 | 结论 |
|---|---|
| 存储方案 | Node 内置 `node:sqlite`（`DatabaseSync`），无原生依赖，不受 pnpm `allowBuilds` 供应链限制 |
| 入参出参存储 | 默认**不存**（`recordPayloads: false`）；配置开启后**新请求**才存储（配置在启动时读取） |
| 版本兼容 | Node < 22.13 时探测 `node:sqlite` 不可用 → log warn + 静默禁用统计，**不影响主流程** |
| 存储边界 | 元数据（token/模型/状态/耗时/供应商/会话）**始终存**；响应文本/思考/工具调用**始终存**（体量小、便于排障）；仅 `request_messages/tools/options` 三个 JSON 受开关控制 |

## 三、数据库设计

库文件：`~/.personal-agent/stats/model-requests.db`（目录约定与 memory 包一致，可用 `stats.dbPath` 覆盖）

```sql
CREATE TABLE IF NOT EXISTS model_requests ( -- 模型请求统计明细
  id                          INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增主键（插入顺序即创建顺序，稳定排序键）
  created_at                  INTEGER NOT NULL,           -- 创建时间（epoch ms，记录写入时刻）
  session_id                  TEXT,                       -- 所属会话 ID（可空，非会话链路调用无值）
  timestamp                   INTEGER NOT NULL,           -- 请求开始时间（epoch ms）
  provider                    TEXT NOT NULL,              -- 模型供应商（deepseek/anthropic/openai/ollama/volcano）
  model                       TEXT NOT NULL,              -- 模型名称（如 deepseek-v4-flash）
  turn_number                 INTEGER,                    -- Agent 循环轮次（第几轮调用，可空）
  status                      TEXT NOT NULL,              -- 请求状态：completed | error | interrupted
  stop_reason                 TEXT,                       -- 停止原因（end_turn/tool_use/max_tokens 等）
  duration_ms                 INTEGER,                    -- 请求耗时（毫秒）
  input_tokens                INTEGER NOT NULL DEFAULT 0, -- 输入 token 数
  output_tokens               INTEGER NOT NULL DEFAULT 0, -- 输出 token 数
  cache_creation_input_tokens INTEGER,                    -- Prompt 缓存写入 token（可空）
  cache_read_input_tokens     INTEGER,                    -- Prompt 缓存读取 token（可空）
  request_messages            TEXT,                       -- 请求入参 messages（JSON，仅 recordPayloads=true 时写入）
  request_tools               TEXT,                       -- 请求入参工具定义（JSON，同上）
  request_options             TEXT,                       -- 请求入参选项（JSON，同上）
  response_text               TEXT,                       -- 响应文本
  response_thinking           TEXT,                       -- 响应思考内容
  response_tool_calls         TEXT,                       -- 响应工具调用（JSON 数组）
  response_message_id         TEXT,                       -- 响应消息 ID
  error                       TEXT                        -- 错误信息（status=error 时）
);
CREATE INDEX IF NOT EXISTS idx_model_requests_ts      ON model_requests(timestamp);
CREATE INDEX IF NOT EXISTS idx_model_requests_session ON model_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_model_requests_model   ON model_requests(provider, model);
-- 初始化时执行 PRAGMA journal_mode = WAL
```

> **Schema v3 说明**：
> - `id` 为自增主键（bigint），**排序统一按 `ORDER BY id DESC`**——单调递增、稳定，等于记录创建顺序；会话内第 N 条请求可用按 `session_id` + `id` 排序得出。
> - `created_at` 为记录**写入时刻**（epoch ms）；`timestamp` 为**请求开始时间**（epoch ms），二者语义不同。
> - `turn_number` 为 Agent 循环轮次（"第几轮调用"，已有字段，常规链路均写入）。
> - 旧库（v1 无注释 / v2 带注释 TEXT id）在 `initialize()` 时自动迁移：事务内重建为 v3 表，数据按原 `rowid` 顺序重编号保留（`created_at` 以旧 `timestamp` 兜底）。

## 四、新增包 `packages/stats`

结构仿 `packages/memory`（tsup 构建 esm+cjs 双格式、`tsx --test` 测试、tsconfig 引用 shared/core）。

### 1. `package.json`

- name `@personal-agent/stats`，version `0.1.0`，engines `>=22.13.0`
- dependencies：`@personal-agent/shared`（workspace:*）
- devDependencies：`@personal-agent/core`（workspace:*，仅类型引用）、`@types/node`、`tsup`、`typescript`
- scripts：build/test/dev/lint/clean 与 memory 一致

### 2. `src/sqlite.ts` — 兼容加载器

```ts
// 用 createRequire(import.meta.url) 延迟加载 node:sqlite，
// 避免旧 Node 直接 import 崩溃；失败返回 null
export function loadDatabaseSync(): DatabaseSyncLike | null;
// 内部定义最小化结构类型 DatabaseSyncLike / StatementSyncLike + 断言，
// 不依赖 @types/node 版本对 node:sqlite 的支持
```

### 3. `src/types.ts` — 记录类型

```ts
export interface ModelRequestRecord {
  id: string;
  sessionId?: string;
  timestamp: number;                    // epoch ms
  provider: string;
  model: string;
  turnNumber?: number;
  status: 'completed' | 'error' | 'interrupted';
  stopReason?: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  requestMessages?: unknown;            // 仅 recordPayloads=true
  requestTools?: unknown;
  requestOptions?: unknown;
  responseText?: string;
  responseThinking?: string;
  responseToolCalls?: unknown;
  responseMessageId?: string;
  error?: string;
}
```

### 4. `src/store.ts` — `UsageStore`（核心存储）

```ts
export interface UsageStoreOptions {
  dbPath?: string;           // 默认 ~/.personal-agent/stats/model-requests.db
  recordPayloads?: boolean;  // 默认 false
}
export class UsageStore {
  static isAvailable(): boolean;                 // node:sqlite 探测
  constructor(options?: UsageStoreOptions);      // 不可用时抛错
  initialize(): void;        // mkdir + 打开 + 建表 + WAL + 索引（幂等）
  insert(record: ModelRequestRecord): void;      // 同步写
  getRecent(limit: number): ModelRequestRecord[];
  getBySession(sessionId: string, limit: number): ModelRequestRecord[];
  querySummary(from: number, to: number): RequestSummary;
  queryByModel(from: number, to: number): ModelAggregate[];
  queryByDay(from: number, to: number): DayAggregate[];
  prune(retentionDays: number): number;          // 返回删除行数；0 表示不清理
  close(): void;
}
```

- 全部同步 API：`DatabaseSync` 是同步的，而 AgentLoop 钩子回调是同步 void，天然匹配
- 行→对象映射用统一的 `rowToRecord` 函数（处理 JSON.parse、null）

### 5. `src/recorder.ts` — `ModelRequestRecorder`

```ts
export class ModelRequestRecorder {
  constructor(store: UsageStore, getSessionId?: () => string | undefined);
  onModelCallStart(call: ModelCallDebugStart): void;  // 以 callId 缓存 start 信息
  onModelCallEnd(call: ModelCallDebugEnd): void;      // 组装记录写入 store
}
```

映射逻辑：

- provider ← `start.provider`；model ← `call.response.model ?? start.model`
- timestamp ← `Date.parse(start.startedAt)`；durationMs ← `call.durationMs`
- token ← `call.response.usage`（input/output + cache 两字段）
- status ← `call.status`；error ← `call.error`；stopReason ← `call.response.stopReason`
- 响应内容 ← `call.response.text / thinking / toolCalls / messageId`
- sessionId ← `getSessionId()` 回调（CLI 绑 `session.getSessionId()`）
- `recordPayloads=true` 时才写 request_messages/tools/options

兜底策略：start 缓存缺失（recorder 后启动等）→ 用 end 信息降级写入半条；任何异常 → log.warn 后忽略，**绝不影响主链路**。

### 6. `src/stats.ts` — 聚合与展示

```ts
export interface RequestSummary {
  count: number; errorCount: number; interruptedCount: number;
  inputTokens: number; outputTokens: number;
  avgDurationMs: number; costUsd?: number;
}
export interface ModelAggregate {
  provider: string; model: string; count: number;
  inputTokens: number; outputTokens: number; errorCount: number; costUsd?: number;
}
export interface DayAggregate { day: string; count: number; inputTokens: number; outputTokens: number; }
export type PricingMap = Record<string, { inputPer1k: number; outputPer1k: number }>; // key `${provider}:${model}`

export function getSummary(store, from, to, pricing?): RequestSummary;
export function getByModel(store, from, to, pricing?): ModelAggregate[];
export function getByDay(store, from, to): DayAggregate[];
export function formatStatsText(summary, byModel, byDay, days): string;   // CLI 文本表
export function formatRecentText(records): string;
```

费用估算：`costUsd = input/1000*inputPer1k + output/1000*outputPer1k`，pricing 由 CLI 从 `provider.getModelList()` 的 `ModelInfo.pricing` 构建，无 pricing 则不显示费用。

### 7. `src/index.ts` — 统一导出

## 五、配置改动（`packages/config`）

`src/schema.ts`：

```ts
const statsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().optional(),                   // 默认 ~/.personal-agent/stats/model-requests.db
  recordPayloads: z.boolean().default(false),      // 默认不存完整入参出参
  retentionDays: z.number().int().min(0).default(90), // 0 = 不自动清理
});
// appConfigSchema 增加：
stats: statsConfigSchema.default({}),
// 导出：
export type StatsConfig = z.infer<typeof statsConfigSchema>;
```

`src/defaults.ts`：`stats: { enabled: true, recordPayloads: false, retentionDays: 90 }`

配置示例（用户可写）：

```yaml
stats:
  enabled: true
  recordPayloads: true   # 开启后新请求才存完整入参出参
  retentionDays: 30
```

## 六、CLI 接线（`apps/cli/src/index.ts`）

1. **依赖**：`apps/cli/package.json` 增加 `"@personal-agent/stats": "workspace:*"`
2. **初始化**（Session 创建之后、AgentLoop 创建之前，约 310 行）：

```ts
const statsStore = mergedConfig.stats.enabled ? createStatsStore(mergedConfig.stats) : null;
const statsRecorder = statsStore
  ? new ModelRequestRecorder(statsStore, () => session.getSessionId())
  : null;
```

辅助函数 `createStatsStore`：`isAvailable()` 为 false → warn + null；构造/初始化抛错 → warn + null。

3. **挂钩子**（AgentLoop 配置，约 448 行）：

```ts
onModelCallStart: (call) => statsRecorder?.onModelCallStart(call),
onModelCallEnd: (call) => statsRecorder?.onModelCallEnd(call),
```

4. **斜杠命令**（`handleSlashCommand`，1061 行）：
   - `/stats [days]`：默认 7 天，范围 1–365。输出：汇总行（次数/失败/中断/token 合计/平均耗时/费用）+ 按模型分组表 + 按天趋势 + 费用估算
   - `/stats-recent <n>`：默认 10 条，范围 1–100。输出：最近请求明细（时间/模型/状态/token/耗时/响应摘要）
   - 统计未启用 → 提示 `Stats tracking is disabled (set stats.enabled=true in config).`
   - `/help` 文本补充两行说明

5. **上下文扩展**：`CommandContext` 增加 `statsStore: UsageStore | null` 与 `getModelList?: () => ModelInfo[]`（用于费用估算）；`TuiModeOptions` 增加 `statsStore`；readline（657 行）与 TUI（810 行）两处 ctx 构造同步补充
6. **退出清理**：三条退出路径统一 `statsStore?.close()` —— 单次 prompt 模式（~608 行）、readline `/exit`（~678 行）、readline `close`（~711 行）+ TUI `onExit`（~623 行，TUI 内部 exit 也走它）

## 七、测试计划（`packages/stats/test/`）

`store.test.ts`（临时目录数据库，`os.tmpdir()`）：

- 建表迁移幂等（重复 initialize 不报错）
- insert + getRecent / getBySession / querySummary / queryByModel / queryByDay 数据正确
- `recordPayloads=false` 时 request_* 不写入；`=true` 时写入
- prune 按保留期删除、返回删除数；0 天不清理
- `node:sqlite` 不可用 → `isAvailable()` false（测试条件跳过）

`recorder.test.ts`（假 `ModelCallDebugStart/End` 载荷）：

- completed：字段映射全对、sessionId 来自回调
- error / interrupted：status 与 error 正确
- 无 start 缓存的 end：降级写入
- 写入异常不向外抛出

## 八、文档与版本

- 根 `package.json` engines：`>=20.0.0` → `>=22.13.0`（stats 包 engines `>=22.13.0`；CLI 保持 `>=20`，旧 Node 降级可用）
- README：主要能力加一条；配置说明示例 YAML 加 `stats` 段；运行时数据一节补充 stats 数据库说明
- 新增 `.changeset/xxx.md`：`@personal-agent/stats` minor + `@personal-agent/cli` minor + `@personal-agent/config` minor

## 九、实施顺序（依赖关系）

```
① 包骨架(sqlite.ts/types.ts/package.json/tsconfig)
      ↓
② UsageStore ──→ ③ ModelRequestRecorder ──→ ④ 聚合 API(stats.ts)
                                      │
⑤ config stats 段 ──→ ⑥ CLI 接线（依赖①②③④⑤）
                                      │
⑦ 单元测试 + 构建验证 ──→ ⑧ README/engines/changeset
```

## 十、验证方式

1. `pnpm --filter @personal-agent/stats build && pnpm --filter @personal-agent/stats test`
2. `pnpm build`（全仓 turbo 编译，确认 CLI/TUI/Web 无破坏）
3. 冒烟：`pnpm cli` 启动 → 问一个问题 → `/stats`、`/stats-recent` 看到记录；`~/.personal-agent/stats/model-requests.db` 可查

## 十一、风险与边界（明确不做）

| 项 | 说明 |
|---|---|
| node:sqlite 实验性 | Node 22.13+ 无 flag；低版本自动降级禁用，不阻断 |
| 库膨胀 | recordPayloads 默认关 + retentionDays prune + WAL |
| 非流式 `provider.chat()` | 上下文压缩 summarizer、plan 引擎的调用 v1 不记录（后续 provider 装饰器补齐） |
| 子 Agent 调用 | SubAgentManager 内部 AgentLoop 不走 CLI 钩子，v1 不覆盖 |
| 写入性能 | 同步单条 INSERT，Agent 每轮 1–N 次调用，量级可忽略 |

## 十二、Web 端扩展需求（2026-08-04 追加）

> 前置：一至九章（packages/stats + CLI 接线）已实施完成。本章为 Web UI 的两个增量需求。

### 12.1 需求描述

1. 在 Web Header 的"模型调用调试"按钮旁边添加按钮进入统计页面（Modal），展示持久化的模型请求统计。
2. 在设置弹窗左侧新增菜单"通用"，把"是否统计模型入参/出参"开关（`stats.recordPayloads`）加入其中。

### 12.2 后端设计（`apps/web/src/server.ts` + `packages/config`）

- `apps/web/package.json` 增加依赖 `@personal-agent/stats`（workspace:*）。
- `WebServerOptions` 增加 `statsDbPath?: string`：Stats SQLite 路径，默认 `~/.personal-agent/stats/model-requests.db`（与 CLI 共用同一数据库，WAL 支持多进程并发；测试传临时路径）。
- `createWebServer` 启动时初始化 `UsageStore`：`isAvailable()` 为 false 或初始化失败 → 置 null，**不阻塞服务启动**；`close()` 时关闭 store。
- 新增 REST API：
  - `GET /api/stats?days=N`（默认 7，范围 1–365）→ `{ available, summary, byModel, byDay, recent }`；store 不可用时 `available: false`。
  - `GET /api/stats-config` → `{ recordPayloads }`（通过 `loadConfig` 读取）。
  - `PUT /api/stats-config` → body `{ recordPayloads }`，写回 config.yaml。
- `packages/config` 新增 `saveStatsSettings({ recordPayloads }, configPath?)`：读 config.yaml → 仅更新 `stats.recordPayloads` → 写回（保留其他配置，与 `saveProviderSettings` 同模式），从 index.ts 导出。

### 12.3 前端设计（`apps/web/client/src/App.tsx`）

- Header："模型调用调试"按钮旁新增"模型统计"按钮（`BarChartOutlined` 图标），打开 `StatsModal`。
- 新增 `StatsModal` 组件（仿 `ModelDebugModal`）：
  - 天数切换（7/30/90）+ 刷新按钮；
  - 汇总 Statistic 卡片：调用次数 / 失败 / 中断 / 输入 token / 输出 token / 平均耗时；
  - 按模型 Table（provider/model/次数/错误数/token）；
  - 按天趋势 Table；
  - 统计不可用时显示 Alert 提示（数据来源 `~/.personal-agent/stats/model-requests.db`）。
- 设置弹窗：左侧 `Menu` 增加 `{ key: 'general', icon: <SettingOutlined />, label: '通用' }`，`selectedKeys` 受 `settingsTab` state（`'providers' | 'general'`）控制。
- 新增"通用"面板：`Switch`「统计模型请求入参/出参」+ 说明文案（默认不存；开启后新请求生效；数据落在本地 SQLite）。打开弹窗时 `GET /api/stats-config` 拉取当前值；切换开关即时 `PUT` 保存并 message 提示。
- `styles.css` 补充 `.pa-stats-*` 样式。

### 12.4 测试与验证

- 新增 `apps/web/test/stats.test.ts`（仿 `server.test.ts`）：临时 config + 临时 `statsDbPath` → `GET /api/stats` 空数据；直插一条记录后聚合正确；`PUT/GET /api/stats-config` 往返；健康检查不回归。
- `pnpm --filter @personal-agent/web build && test`，再全仓 `pnpm build`。

### 12.5 边界说明（v1 不做）

| 项 | 说明 |
|---|---|
| 费用估算 | Web 统计页不显示费用（需 provider registry pricing，CLI 已有；后续可加） |
| 实时推送 | 统计 Modal 每次打开/切换天数时拉取，不做 WebSocket 实时推送 |
| 开关生效时机 | 保存后由 CLI/Web 下次启动生效（与 CLI 行为一致） |
