---
'@personal-agent/provider': patch
---

Split DeepSeek out of OpenAIProvider into a standalone DeepSeekProvider. DeepSeek's
thinking parameters, reasoning content handling, and model defaults now live in
`deepseek.ts`, with shared OpenAI-compatible helpers extracted to `openai-compat.ts`.
The OpenAIProvider constructor no longer accepts the `providerIdOverride` argument.
