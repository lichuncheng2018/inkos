/**
 * DeepSeek
 *
 * - 官网：https://www.deepseek.com/
 * - 控制台：https://platform.deepseek.com/
 * - API key：https://platform.deepseek.com/api_keys
 * - API 文档：https://api-docs.deepseek.com/
 * - 模型列表：https://api-docs.deepseek.com/quick_start/pricing
 * - V4 开源模型：https://huggingface.co/collections/deepseek-ai/deepseek-v4
 *
 * 官方 API 当前 Flash：deepseek-flash（后端 DeepSeek-V4.1-Flash-1017）。
 * deepseek-v4-flash 仍可作为旧 id 路由到同一模型；Pro 仍是 deepseek-v4-pro。
 * deepseek-chat / deepseek-reasoner 是兼容别名，官方标注将在 2026-07-24 废弃。
 */
import type { InkosEndpoint } from "../types.js";

export const DEEPSEEK: InkosEndpoint = {
  id: "deepseek",
  label: "DeepSeek",
  group: "china",
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
  checkModel: "deepseek-flash",
  compat: { requiresAssistantAfterToolResult: true },
  temperatureRange: [0, 2],
  defaultTemperature: 1,
  writingTemperature: 1.5,
  temperatureHint: "创意写作推荐 1.5",
  models: [
    { id: "deepseek-flash", maxOutput: 393216, contextWindowTokens: 1_000_000, enabled: true, releasedAt: "2026-09-10" },
    { id: "deepseek-v4-pro", maxOutput: 393216, contextWindowTokens: 1_000_000, enabled: true, releasedAt: "2026-04-24" },
    { id: "deepseek-v4-flash", maxOutput: 393216, contextWindowTokens: 1_000_000, enabled: true, releasedAt: "2026-04-24" },
    { id: "deepseek-chat", maxOutput: 393216, contextWindowTokens: 1_000_000, releasedAt: "2026-04-24" },
    { id: "deepseek-reasoner", maxOutput: 393216, contextWindowTokens: 1_000_000, releasedAt: "2026-04-24" },
  ],
};
