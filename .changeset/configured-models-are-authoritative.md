---
'@personal-agent/provider': patch
---

修复：显式配置 `models` 后仍能在模型选择器中看到已删除的内置模型。各 provider（智谱 / DeepSeek / Anthropic / OpenAI / 火山方舟）现在以配置中的 `models` 列表为准，内置模型目录仅在未配置任何模型时作为兜底；默认模型始终保留在列表中，纯 id 配置仍复用内置目录的上下文窗口 / 定价等元数据。
