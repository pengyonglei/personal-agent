---
'@personal-agent/web': patch
'@personal-agent/core': patch
---

侧边栏「刷新项目和任务」按钮现在真正生效：

- **从磁盘重新加载**：点击刷新时服务端会先调用 `ProjectManager.reload()` 重新读取 `projects.json`，拾取其他进程/外部编辑对存储文件所做的变更，再下发最新的 `project_list` / `task_list`；文件缺失或解析失败时保留当前内存数据，不会清空列表。
- **加载反馈**：刷新期间按钮图标旋转并禁用，收到 `project_list` 后自动复位（含 8 秒超时兜底）。
