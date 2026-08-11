---
'@personal-agent/plugin': minor
'@personal-agent/cli': minor
---

- 支持显式指定技能：输入 `#skill-name`（如 `#code-review`）强制使用该技能，引用标记会自动从发给模型的输入中移除（新增 `parseSkillReferences`，CLI 与 Web 均已接入）；未显式指定时仍按 triggers / name / description 自动匹配。
- 技能生效范围限定为 `~/.personal-agent/skills`（Web 端上传的目标目录，与插件、配置等用户级目录同根），不再自动加载 `~/.claude/skills`、`~/.codex/skills` 等外部目录；`skills.paths` 配置的目录仍作为可选扩展。
- Web UI「设置 -> 技能」：已安装列表仅展示 `~/.personal-agent/skills` 内的技能（标题 + 描述 + 「打开目录」按钮，桌面版通过系统文件管理器打开、浏览器版复制路径）；上传区支持 zip 压缩包（技能目录名取 zip 文件名），解压校验（结构、zip-slip 路径穿越、大小限制）后安装并热加载生效；新增 `GET /api/skills` 与 `POST /api/skills/upload` 接口。
