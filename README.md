# personal-agent

> 一个生产级 AI Agent CLI 工具，支持多厂商 LLM、流式工具调用、权限沙箱 —— 对标 Claude Code / Codex / OpenCode

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-≥20-green)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-11-orange)](https://pnpm.io/)
[![Phase](https://img.shields.io/badge/Phase-5%20Complete-success)](#开发状态)

---

## 简介

**personal-agent** 让你在终端或浏览器里拥有一个智能 AI 编程助手。它能够：

- 💬 与 Claude、GPT 等 LLM 进行多轮对话
- 📁 读写和编辑本地文件
- ⚡ 执行 Shell 命令并获取输出
- 🔍 Glob/Grep 搜索代码库
- 🌐 Web 抓取和信息搜索
- 🔒 三级权限模型（自动允许 / 需审批 / 拒绝）
- 🧩 通过 MCP 协议扩展工具链
- 🖥️ 通过 Web UI 管理多项目工作区与独立任务，并进行流式对话和工具审批
- ✦ 加载插件工具、Markdown Skill 和生命周期 Hook

## 技术架构

### 分层设计

```
┌─────────────────────────────────────────────────────┐
│               CLI / TUI 交互层                       │
│   commander 参数解析 · readline REPL · Ink 终端 UI   │
├─────────────────────────────────────────────────────┤
│               会话与应用层                            │
│   SessionManager · Slash 命令路由 · Plan 模式        │
├─────────────────────────────────────────────────────┤
│                核心 Agent 引擎                        │
│   AgentLoop 主循环 · ContextAssembler 上下文组装      │
│   TokenBudget 预算管理 · StreamHandler 流式处理      │
├───────────────┬──────────────┬──────────────────────┤
│   工具系统    │   子代理     │     记忆系统          │
│  ToolRegistry│   Agent      │   MemoryStore        │
│  ToolExecutor│   Spawner    │   Context Injection  │
│  Permission  │              │                      │
│  + Sandbox   │              │                      │
├───────────────┴──────────────┴──────────────────────┤
│              模型抽象层                               │
│   LLMProvider 接口 · Anthropic · OpenAI · Ollama · DeepSeek │
├─────────────────────────────────────────────────────┤
│              基础设施层                               │
│   MCP Client · Plugin Loader · Config · Logger      │
└─────────────────────────────────────────────────────┘
```

### 技术栈

| 类别        | 选择                         |
| ----------- | ---------------------------- |
| **架构**    | pnpm monorepo + Turborepo    |
| **语言**    | TypeScript 5.7 (strict mode) |
| **运行时**  | Node.js ≥ 20                 |
| **LLM SDK** | @anthropic-ai/sdk, openai    |
| **构建**    | tsup (esbuild)               |
| **TUI**     | Ink 5.x + React 18           |
| **配置**    | Zod + YAML                   |
| **Web UI**  | Express 5 + WebSocket        |
| **测试**    | Node.js test runner          |

### 包结构

```
packages/
├── shared      公共类型/工具（UnifiedMessage, Token估算, Logger）
├── config      配置系统（Zod Schema, YAML加载, 环境变量, 多源合并）
├── provider    模型抽象层（LLMProvider接口, Anthropic/OpenAI/Ollama适配器）
├── tool        工具系统（Tool接口, ToolRegistry, ToolExecutor, Permission, Sandbox）
├── core        核心引擎（AgentLoop, ContextAssembler, TokenBudget, Session）
├── tui         Ink/React 终端 UI ✅
├── mcp         MCP 客户端 ✅
├── memory      持久化记忆 ✅
└── plugin      插件工具、Skill、Hook 与生命周期 ✅

apps/
├── cli         命令行入口应用（含 TUI 模式）
└── web         流式 Web Agent 工作台 ✅
```

### Agent 数据流

```
用户输入 → AgentLoop.run()
  → ContextAssembler.assemble()         组装系统提示 + 对话历史 + 工具定义
  → TokenBudget.checkAndCompact()       检查 Token 预算，必要时压缩
  → Provider.streamChat()               流式调用 LLM
  → [文本增量] → 终端渲染
  → [工具调用] → ToolExecutor.execute()
       → validateParams()   参数校验
       → Sandbox 沙箱检查   路径/命令安全
       → PermissionManager  权限判定 (allow/deny/ask)
       → Tool.execute()     执行工具
       → PostProcess        输出截断
  → 工具结果注入上下文 → 继续循环
  → 直到 stop_reason=end_turn 或 max_turns 或用户中断
```

---

## 快速开始

### 前置条件

- **Node.js** ≥ 20.0.0
- **pnpm** ≥ 10（全局安装: `npm install -g pnpm`）

### 1. 克隆与安装

```bash
git clone <your-repo-url> personal-agent
cd personal-agent
pnpm install
```

### 2. 配置 LLM Provider

至少配置一个 LLM Provider 的 API Key：

```bash
# Anthropic Claude
export PERSONAL_AGENT_ANTHROPIC_API_KEY="sk-ant-..."

# OpenAI GPT
export PERSONAL_AGENT_OPENAI_API_KEY="sk-..."

# 或者创建配置文件 ~/.personal-agent/config.yaml
mkdir -p ~/.personal-agent
cat > ~/.personal-agent/config.yaml << 'EOF'
providers:
  anthropic:
    apiKey: "sk-ant-..."
    defaultModel: "claude-sonnet-5-20251001"
EOF
```

### 3. 启动

```bash
# 交互模式（默认）
pnpm cli

# 单次提问模式
pnpm cli "帮我写一个 Hello World"

# 自动批准所有工具（跳过权限询问）
pnpm cli -y "列出当前目录的文件"

# 指定模型和 Provider
pnpm cli -p openai -m gpt-4o "解释这个项目"
```

### 4. 启动 Web UI

```bash
# 开发模式；默认只监听 127.0.0.1:3456
pnpm web

# 或先构建，再运行构建产物
pnpm build
pnpm --filter @personal-agent/web start
```

浏览器打开 `http://127.0.0.1:3456`。Web UI 支持：

- 创建多个项目；每个项目绑定一个经过校验的本地根目录
- 在项目下创建、切换独立任务，并恢复每个任务关联的 Agent 会话
- 真实流式响应、工具执行过程与审批、Plan 模式进度
- GFM Markdown 展示、独立滚动的长对话和浅色/深色主题切换
- Memory、MCP 和插件运行状态

项目和任务元数据默认保存在 `~/.personal-agent/projects.json`；会话内容继续保存在
`~/.personal-agent/sessions`。切换项目时，文件工具、搜索和 Shell 命令都会使用该项目的根目录。
需要隔离元数据时，可通过 `PERSONAL_AGENT_PROJECTS_PATH` 指定另一个项目存储文件。
首次升级时，同一根目录下的旧 Web 会话会自动导入为默认项目中的任务。

如需监听局域网/公网地址，必须同时配置访问令牌：

```bash
export PERSONAL_AGENT_WEB_HOST="0.0.0.0"
export PERSONAL_AGENT_WEB_TOKEN="replace-with-a-long-random-token"
pnpm web
```

访问 `http://<host>:3456/?token=<token>`；不要在未启用 TLS 的公网环境直接暴露该服务。

### 5. 交互使用

```
▸ 帮我看看 src/index.ts 都导出了什么

⚙ read_file  ✓
  import { Command } from 'commander';
  ...

▸ 在当前目录搜索所有 TODO 注释

⚙ grep ✓
  src/agent-loop.ts:42: // TODO: implement memory injection
  src/session.ts:15:  // TODO: add file persistence

▸ /help
  /help          Show this help
  /clear         Clear conversation history
  /permissions   Show permission rules
  /allow <tool>  Allow a tool
  /deny <tool>   Deny a tool
  /exit          Exit
```

---

## 开发

### 常用命令

```bash
# 全量构建与测试（所有包）
pnpm build
pnpm test

# 开发模式（按需构建）
pnpm dev

# 构建单个包
pnpm --filter @personal-agent/provider build

# 运行 CLI
pnpm cli

# 运行 Web UI
pnpm web

# 直接运行开发版 CLI
pnpm --filter @personal-agent/cli dev

# 格式化代码
pnpm format

# 清理构建产物
pnpm clean
```

### 项目配置参考

```yaml
# ~/.personal-agent/config.yaml
providers:
  anthropic:
    apiKey: 'sk-ant-...'
    defaultModel: 'claude-sonnet-5-20251001'
  openai:
    apiKey: 'sk-...'
    defaultModel: 'gpt-4o'
  ollama:
    baseURL: 'http://localhost:11434'
    defaultModel: 'llama3.1'

agent:
  maxTurns: 100
  temperature: 0
  planMode:
    enabled: true

tools:
  shellTimeout: 120000
  sandbox:
    restrictPaths: true
    deniedCommands:
      - 'rm -rf /'
      - 'shutdown'

tui:
  theme: dark # dark | light | system
  showTokenCounter: true

memory:
  enabled: true
  store: filesystem # filesystem | sqlite

plugins:
  enabled: true
  paths: []
  disabled: []
```

### 配置加载优先级

后加载的覆盖前面的：

1. **内置默认值** — `packages/config/src/defaults.ts`
2. **全局用户配置** — `~/.personal-agent/config.yaml`
3. **项目配置** — `./.personal-agent/config.yaml`
4. **环境变量** — `PERSONAL_AGENT_*`（如 `PERSONAL_AGENT_ANTHROPIC_API_KEY`）
5. **CLI 参数** — `--model`, `--provider`, `--max-turns` 等

---

## 开发状态

| Phase       | 内容                                                      | 状态      |
| ----------- | --------------------------------------------------------- | --------- |
| **Phase 1** | 核心基础（Monorepo, Shared, Config, Provider, Core, CLI） | ✅ 完成   |
| **Phase 2** | 工具系统（11 个内置工具, 权限, 沙箱）                     | ✅ 完成   |
| **Phase 3** | Ink/React TUI 界面                                        | ✅ 完成   |
| **Phase 4** | 高级功能（Memory, MCP, 子代理, Plan 模式）                | ✅ 完成   |
| **Phase 5** | 插件系统 + 多项目 Web UI + npm 发布流程                   | ✅ 完成   |
| **Phase 6** | 生产强化（E2E 测试, 遥测, 国际化）                        | 📋 待开始 |

---

## 许可证

MIT

---
