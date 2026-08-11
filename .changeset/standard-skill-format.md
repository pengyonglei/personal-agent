---
'@personal-agent/plugin': minor
'@personal-agent/config': minor
'@personal-agent/cli': minor
---

支持 Claude Code / Codex 标准 Skill 格式：自动发现 `~/.claude/skills`、`~/.codex/skills`、`<workspace>/.claude/skills`、`<workspace>/.codex/skills` 以及 `skills.paths` 配置目录下的 `<skill-name>/SKILL.md`，frontmatter 使用标准的 `name`/`description` 字段（可选用 `triggers` 扩展实现关键词自动触发）。原有 `plugin.json` 声明式技能保持兼容；Web 状态面板新增标准 Skill 数量展示。
