---
'@personal-agent/stats': minor
'@personal-agent/cli': minor
'@personal-agent/config': minor
---

新增模型请求统计功能（packages/stats）：基于 Node 内置 `node:sqlite` 存储每次模型请求明细（输入/输出 token、供应商、模型、状态、耗时、会话，可选完整入参出参），通过 AgentLoop 的 `onModelCallStart/onModelCallEnd` 钩子无侵入埋点（core 零改动）。CLI 新增 `/stats [days]` 与 `/stats-recent <n>` 命令；config 新增 `stats` 配置段（`enabled`/`dbPath`/`recordPayloads`/`retentionDays`）。Node < 22.13 时自动降级禁用统计，不影响主流程。
