---
'@personal-agent/provider': minor
'@personal-agent/config': minor
'@personal-agent/web': minor
'@personal-agent/cli': minor
---

新增智谱AI（Zhipu GLM）模型供应商：

- `@personal-agent/provider` 新增 `ZhipuProvider`（`zhipu.ts`），走智谱开放平台 OpenAI 兼容接口（默认 `https://open.bigmodel.cn/api/paas/v4`），内置 glm-4.6 / glm-4.5 / glm-4.5-air / glm-4.5-flash 模型，支持流式输出、工具调用、深度思考（`thinking: {type: enabled|disabled}`，无档位概念）与缓存命中 token 统计（`prompt_tokens_details.cached_tokens` → `cacheHitTokens`）。
- 配置层新增 `providers.zhipu`（schema 枚举 / `PROVIDER_IDS`）与环境变量 `PERSONAL_AGENT_ZHIPU_API_KEY`。
- Web 设置面板与 CLI `--provider` 均可选择智谱AI；思考强度仅 off / high 两档（high 表示开启深度思考）。
