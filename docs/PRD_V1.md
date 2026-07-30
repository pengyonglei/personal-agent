# Personal-Agent — 产品需求文档 (PRD v1.0)

> 文档版本: v1.0 | 日期: 2026-07-30 | 状态: Phase 5 已完成

---

## 1. 产品概述

### 1.1 产品定位

**personal-agent** 是一个**生产级 AI Agent CLI 工具**，功能对标 Claude Code / Codex / OpenCode。它通过统一接口接入多厂商 LLM（Anthropic Claude、OpenAI GPT、本地 Ollama 模型），提供终端命令行和 TUI 两种交互方式，帮助开发者完成软件工程任务——包括文件读写、Shell 命令执行、代码搜索、Web 信息检索等。

### 1.2 核心价值

- **厂商无关**: 统一 Provider 抽象层，一套代码适配多个 LLM 厂商，避免厂商锁定
- **本地可控**: 支持 Ollama 本地模型，数据不出本机
- **完整工具链**: 内置 11 种工具覆盖文件/Shell/搜索/Web 场景，支持 MCP 协议扩展
- **开发者友好**: TS/Node.js 技术栈，monorepo 架构，插件可扩展

### 1.3 目标用户

- 软件开发者，希望有一个智能的命令行 AI 助手
- 偏好开源/可自托管的工具，而非闭源 SaaS
- 需要多模型灵活切换（Claude 做复杂推理、GPT 做快速迭代、本地模型做隐私场景）

---

## 2. 功能需求

### 2.1 功能矩阵

| 模块              | 需求                                                                        | 优先级 | 状态      |
| ----------------- | --------------------------------------------------------------------------- | ------ | --------- |
| **多模型支持**    | 统一接口适配 Anthropic (Claude)、OpenAI (GPT)、Ollama (本地模型)            | P0     | ✅ 已完成 |
| **Agent Loop**    | 完整的 输入→上下文组装→LLM调用→工具执行→结果→循环 引擎                      | P0     | ✅ 已完成 |
| **工具系统**      | 内置文件读写/编辑、Shell 执行、Glob/Grep 搜索、Web 抓取/搜索、任务管理      | P0     | ✅ 已完成 |
| **权限/沙箱**     | 工具调用前的权限检查（allow/deny/ask），文件路径和命令的沙箱限制            | P1     | ✅ 已完成 |
| **流式输出**      | 文本和工具调用参数均流式传输                                                | P0     | ✅ 已完成 |
| **Slash 命令**    | /help, /clear, /model, /permissions, /allow, /deny 等                       | P1     | ✅ 已完成 |
| **TUI 界面**      | 基于 Ink/React 的终端 UI，支持流式输出、内联工具状态、Diff 预览、键盘快捷键 | P1     | ✅ 已完成 |
| **子代理系统**    | 主代理委派任务给子代理，独立上下文，受限工具集，结果汇总                    | P2     | ✅ 已完成 |
| **持久化记忆**    | 基于文件系统或 SQLite 的记忆存储，关键词+语义搜索，自动注入上下文           | P2     | ✅ 已完成 |
| **MCP 协议**      | MCP Client 实现，支持 stdio/HTTP 传输，动态工具发现                         | P2     | ✅ 已完成 |
| **计划模式**      | 生成结构化执行计划，分步执行/审批，TUI 侧栏进度显示                         | P2     | ✅ 已完成 |
| **插件/技能系统** | 可扩展的插件清单，Markdown 技能文件，生命周期 Hooks                         | P3     | ✅ 已完成 |
| **Web 界面**      | 流式对话、工具审批、会话恢复、Plan 进度和运行状态                           | P3     | ✅ 已完成 |

### 2.2 内置工具清单

| 工具名           | 类别    | 功能                                                 | 权限           |
| ---------------- | ------- | ---------------------------------------------------- | -------------- |
| `read_file`      | file    | 读取文件内容，支持行号显示、偏移量、行数限制         | 自动通过       |
| `write_file`     | file    | 写入文件内容，自动创建父目录                         | 需要审批       |
| `edit_file`      | file    | 精确字符串替换编辑，支持全部替换                     | 需要审批       |
| `list_directory` | file    | 列出目录内容，支持递归                               | 自动通过       |
| `glob`           | file    | 基于 fast-glob 的文件模式匹配，按修改时间排序        | 自动通过       |
| `grep`           | file    | 基于正则的内容搜索（逐行流式读取），支持多种输出模式 | 自动通过       |
| `bash`           | shell   | 执行 Shell 命令，支持超时、stdin，沙箱约束           | 需要审批(危险) |
| `web_fetch`      | web     | 抓取 URL 并转换为纯文本（HTML 标签剥离）             | 需要审批       |
| `web_search`     | web     | DuckDuckGo 网页搜索                                  | 需要审批       |
| `todo_write`     | utility | 创建/更新结构化任务列表                              | 自动通过       |
| `ask_user`       | utility | 向用户提问获取决策                                   | 自动通过       |

### 2.3 非功能需求

| 需求               | 说明                                                             |
| ------------------ | ---------------------------------------------------------------- |
| **跨平台**         | Windows / macOS / Linux 全平台支持                               |
| **流式输出**       | 文本增量和工具调用参数增量均实时流式传输                         |
| **错误恢复**       | Provider 错误自动重试（指数退避），工具错误作为 tool_result 返回 |
| **会话持久化**     | 支持保存/恢复对话历史                                            |
| **Token 预算管理** | 自动 compact/截断超长对话（75% 水位触发）                        |
| **安全**           | 文件路径沙箱、危险命令拦截、输出内容截断                         |

---

## 3. 技术架构

### 3.1 分层架构图

```
+-------------------------------------------------------------------+
|                        CLI / TUI Layer                             |
|  entry point, arg parsing, Ink/React components, keyboard handling |
+-------------------------------------------------------------------+
|                     Application / Session Layer                    |
|   session manager, command router, slash commands, plan mode       |
+-------------------------------------------------------------------+
|                       Core Agent Engine                            |
|  agent loop, context assembler, token budget, streaming handler    |
+-------------------------------------------------------------------+
|  +------------------+  +---------------+  +---------------------+  |
|  |  Tool System     |  |  Sub-Agent    |  |  Memory System      |  |
|  |  registry, exec, |  |  spawn, comm, |  |  CRUD, search,      |  |
|  |  sandbox, perms  |  |  result merge |  |  vector/embedding   |  |
|  +------------------+  +---------------+  +---------------------+  |
+-------------------------------------------------------------------+
|                     Model Abstraction Layer                        |
|    unified provider interface, adapters (Anthropic/OpenAI/Ollama)  |
+-------------------------------------------------------------------+
|                     Infrastructure Layer                           |
|    MCP client, plugin loader, config manager, logging, storage     |
+-------------------------------------------------------------------+
```

### 3.2 Agent 数据流

```
User Input → TUI → AgentLoop
  → ContextAssembler (system prompt + history + memory + tool defs)
  → ProviderAdapter.streamChat()
  → StreamHandler (解析 SSE, 累积文本, 检测 tool_call)
  → [文本] → TUI 渲染
  → [工具调用] → ToolExecutor.execute()
    → 参数验证 → 沙箱检查 → 权限判定 → 工具执行 → 后处理(截断)
    → 结果注入上下文
  → 循环直到停止条件 (end_turn / max_turns / interrupted)
  → 最终响应渲染到 TUI
```

### 3.3 技术栈

| 类别            | 选择                        | 理由                              |
| --------------- | --------------------------- | --------------------------------- |
| **Monorepo**    | pnpm workspaces + Turborepo | 高效磁盘利用，简洁配置，增量构建  |
| **语言**        | TypeScript (strict mode)    | 类型安全，生态丰富                |
| **运行时**      | Node.js ≥20                 | LTS 版本，稳定 API                |
| **TUI**         | Ink 5.x + React 18+         | React 组件模型，Yoga Flexbox 布局 |
| **CLI 参数**    | commander                   | 成熟稳定                          |
| **Schema 验证** | Zod                         | TypeScript 原生集成               |
| **LLM SDK**     | @anthropic-ai/sdk, openai   | 官方 SDK，稳定兼容                |
| **MCP SDK**     | @modelcontextprotocol/sdk   | MCP 官方实现                      |
| **构建**        | tsup (esbuild)              | 快速 TS 编译打包                  |
| **测试**        | Vitest                      | 快速，TS 原生                     |

### 3.4 Monorepo 包结构

```
personal-agent/
├── package.json                 # workspace root
├── pnpm-workspace.yaml          # workspace 定义
├── turbo.json                   # Turborepo 构建管道
├── tsconfig.base.json           # 共享 TypeScript 配置
├── apps/
│   ├── cli/                     # @personal-agent/cli — CLI 入口应用
│   └── web/                     # @personal-agent/web — 未来 Web 界面
├── packages/
│   ├── shared/                  # @personal-agent/shared  — 公共类型/工具函数
│   ├── config/                  # @personal-agent/config  — 配置管理(YAML+Zod)
│   ├── provider/                # @personal-agent/provider — 多模型抽象层
│   ├── tool/                    # @personal-agent/tool    — 工具系统(11个内置工具)
│   ├── core/                    # @personal-agent/core    — 核心Agent引擎
│   ├── tui/                     # @personal-agent/tui     — Ink/React TUI
│   ├── mcp/                     # @personal-agent/mcp     — MCP 客户端
│   ├── memory/                  # @personal-agent/memory  — 持久化记忆
│   └── plugin/                  # @personal-agent/plugin  — 插件系统
└── docs/
```

### 3.5 包依赖关系

```
shared ← config ← provider ← core ← tui ← cli
  ↑         ↑          ↑
  |         +---- tool ----+--- mcp
  |                         +--- memory
  |                         +--- plugin
  +--- (所有包都依赖 shared)
```

### 3.6 已实现的核心模块

| 包         | 核心文件                                                                                        | 功能                                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `shared`   | `types.ts`, `utils.ts`                                                                          | UnifiedMessage、UnifiedStreamEvent、UnifiedToolDefinition 等 Provider-Neutral 类型；Token 估算、Logger、UUID 生成、重试/超时工具 |
| `config`   | `schema.ts`, `loader.ts`, `defaults.ts`                                                         | Zod Schema 验证、多源配置加载(全局→项目→ENV→CLI)、深合并                                                                         |
| `provider` | `interface.ts`, `anthropic.ts`, `openai.ts`, `registry.ts`                                      | LLMProvider 抽象基类、Anthropic/OpenAI/Ollama 适配器、流式+非流式、Provider 注册中心                                             |
| `tool`     | `types.ts`, `tools/file.ts`, `tools/shell.ts`, `tools/search.ts`, `tools/web.ts`, `register.ts` | Tool/BaseTool 抽象、ToolRegistry、ToolExecutor(6步生命周期)、PermissionManager(3级权限)、Sandbox、11个内置工具                   |
| `core`     | `agent-loop.ts`, `context.ts`, `session.ts`                                                     | AgentLoop 主循环、ContextAssembler(多节系统提示)、TokenBudget(75%水位触发compact)、SessionManager                                |
| `cli`      | `index.ts`                                                                                      | Commander CLI 入口、TUI 模式（Ink 自动检测 TTY）、Readline 交互回退、流式 Event 渲染、Slash 命令路由、交互式权限审批             |
| `tui`      | `app.tsx`, `components/*.tsx`, `hooks/*.ts`, `themes/theme.ts`                                  | Ink/React 组件树：StatusBar、MessageList、InputBox、AgentChatView、Agent Loop 事件桥接、暗/亮主题、键盘快捷键                    |

---

## 4. 开发阶段

### Phase 1: 核心基础 ✅ 已完成

- Monorepo 搭建 (pnpm + Turborepo + TS)
- `@personal-agent/shared` — 类型定义、工具函数
- `@personal-agent/config` — 配置加载、验证
- `@personal-agent/provider` — LLMProvider 接口 + Anthropic/OpenAI 适配器
- `@personal-agent/core` — AgentLoop、ContextAssembler、TokenBudget、SessionManager
- `@personal-agent/cli` — 入口 + readline 交互

**里程碑**: ✅ `pnpm run build` 全部通过，基础对话可用

### Phase 2: 工具系统 ✅ 已完成

- `@personal-agent/tool` — Tool 接口、ToolRegistry、ToolExecutor、PermissionManager、Sandbox
- 11 个内置工具实现（file/shell/search/web/utility）
- CLI 交互式权限审批（y/n/a/d）
- Agent Loop 集成工具调用 → 执行 → 结果注入

**里程碑**: ✅ Agent 可读写文件、执行 Shell、搜索代码、抓取 Web

### Phase 3: TUI ✅ 已完成

- `@personal-agent/tui` — Ink/React 组件树
- ChatPane、MessageList、流式文本显示
- 内联工具调用状态卡片
- Diff 预览（文件编辑前后对比）
- InputBox + 历史导航 + 自动补全
- StatusBar（模型、Token、费用）
- 键盘快捷键系统 + 主题系统

**里程碑**: ✅ TUI 组件树完成，StatusBar + InputBox + MessageList 可用，暗/亮主题切换（Ctrl+T），流式输出 + 工具调用实时状态显示

### Phase 4: 高级功能 ✅ 已完成

- `@personal-agent/memory` — 文件系统存储、CRUD、fuse.js 关键词搜索、上下文注入
- `@personal-agent/mcp` — MCP Client 管理器、Stdio/SSE 传输、动态工具发现
- 子代理管理器 — SubAgentManager、独立 AgentLoop、受限工具集、结果摘要
- 计划模式引擎 — PlanModeEngine、分步执行/审批、依赖管理

- `@personal-agent/memory` — 文件系统存储、CRUD、搜索、上下文注入
- `@personal-agent/mcp` — MCP Client、Stdio/HTTP 传输、工具发现
- 子代理管理器
- 计划模式引擎
- 会话持久化
- Token 压缩和对话摘要

### Phase 5: 插件与完善 ✅ 已完成

- `@personal-agent/plugin` — 插件发现与安装/卸载/启用/禁用、可执行 Tool、Skill 注入、生命周期 Hook
- `@personal-agent/web` — 真实 AgentLoop、WebSocket 流式事件、浏览器权限审批、历史会话、Plan 与运行状态面板
- Ollama 原生 `/api/chat` 适配器（NDJSON 流式响应与工具调用）
- npm 公共包元数据、MIT License、Changesets 版本与发布流程

**里程碑**: CLI 与 Web 共用核心能力；Web UI 已成为完整对话入口。公开发布需要维护者在 npm 登录后显式执行 `pnpm release`。

### Phase 6: 生产强化（持续）

- E2E 测试套件
- 遥测（可选）
- 自动更新
- 国际化

---

## 5. 验收标准

### 5.1 Phase 1, 2 & 3 验收项

- [x] `pnpm run build` 全部 11 个包构建成功
- [x] `npx personal-agent --help` 显示帮助信息
- [x] 通过环境变量配置 Provider API Key
- [x] 支持 Anthropic 和 OpenAI 两个 Provider
- [x] 流式输出文本增量
- [x] 流式处理工具调用（增量参数 + 完成后解析）
- [x] 工具执行前后有参数验证和输出截断
- [x] 权限系统：allow/deny/ask 三级，CLI 交互审批
- [x] 沙箱约束：路径限制、危险命令拦截
- [x] Slash 命令：/help、/clear、/permissions、/allow、/deny
- [x] TUI 组件树：StatusBar + InputBox + MessageList 完整渲染
- [x] 流式文本输出实时显示
- [x] 工具调用状态卡片（运行中/成功/失败）
- [x] 暗/亮主题切换（Ctrl+T）
- [x] 键盘快捷键（Ctrl+C 中断、Ctrl+L 清屏）
- [x] TTY 检测自动切换 TUI/Readline 模式
- [x] Ink/React Agent Event 完整事件桥接

### 5.2 后续 Phase 验收项

- [x] TUI 组件树完整（StatusBar + InputBox + MessageList + 主题系统 + 键盘快捷键）
- [x] 子代理独立上下文，不互相干扰；执行阶段强制工具白名单并支持中断
- [x] 记忆跨会话持久化，自动注入相关上下文，并执行容量上限
- [x] MCP 工具动态发现并可在对话中使用；支持 stdio、SSE、Streamable HTTP
- [x] Plan 模式支持结构化提交、审批、依赖校验、步骤进度和 TUI 侧栏
- [x] 会话消息、轮次和 Token 用量可保存/恢复；长对话可自动压缩
- [x] 插件安装/卸载/启用/禁用无异常
- [x] 插件 Tool 可注册执行，Skill 可按触发词注入，生命周期 Hook 可执行
- [x] Web UI 使用真实 AgentLoop 并流式显示文本、工具状态和错误
- [x] Web UI 支持敏感工具审批、会话恢复/新建、停止生成和 Plan 模式
- [x] Web 服务默认仅监听回环地址，远程监听强制要求访问令牌
- [x] Ollama 原生流式响应与工具调用通过自动化测试
- [x] npm 包可打包，Changesets 版本和发布流程已配置
