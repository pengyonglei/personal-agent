---
'@personal-agent/web': minor
'@personal-agent/tool': minor
'@personal-agent/config': minor
---

Web 多任务并行改造：

- **单连接多任务并行**：同一页面内多个任务可同时执行，各自独立上下文、进度、Plan 与中断互不干扰；任务侧边栏显示运行状态徽标与模型名；权限审批弹窗标注来源任务。
- **每任务独立模型**：Composer 模型下拉按当前任务生效，默认继承全局模型，可单独覆盖（`set_task_model`），不影响其他任务；Provider 实例池按 `(provider, model)` 复用实例。
- **权限规则任务级过滤**：`tools.permissions` 规则保持全局共享基线，新增可选 `target` 字段（`all` / `task:<id>` / `project:<id>`）支持任务/项目级规则差异，任务特定规则优先于全局规则（`PermissionManager.check` 增加 taskId/projectId 上下文过滤）。
- 协议层 `ClientMessage`/`ServerMessage` 增加可选 `taskId` 字段，缺省按当前激活任务路由，旧客户端行为不回归。
