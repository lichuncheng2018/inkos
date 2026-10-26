import type { InkosModel } from "./types.js";
import { getAllEndpoints, getEndpoint } from "./index.js";

/**
 * provider id 优先级。Layer 2 全局扫时同 id 多条匹配按这个顺序取第一条，
 * 保证结果确定性。白名单外的 provider 视同 999（排最后）。
 */
const PROVIDER_PRIORITY: readonly string[] = [
  "anthropic", "openai", "google", "deepseek", "bailian", "moonshot", "kimicode",
  "zhipu", "minimax", "xai",
  "siliconcloud",
  "openrouter", "aihubmix", "novita",
];

/**
 * 两层 lookup：
 * - Layer 1: 已知 provider 精确查（整串比较，不拆斜线）
 * - Layer 2: 全局扫所有 provider 的 models，按 provider id 优先级取第一条
 * - 都 miss: 返回 undefined，调用方走保守默认
 *
 * 精确 miss 后只对 DeepSeek V4 家族补别名（网关日期后缀、vendor 前缀），
 * 不把任意 `vendor/model` 拆开，避免 PPIO / SiliconCloud 原生命名误匹配。
 */
export function lookupModel(
  serviceId: string,
  modelId: string,
): InkosModel | undefined {
  const candidates = candidateModelIds(modelId);
  const provider = getEndpoint(serviceId);
  if (provider) {
    for (const candidate of candidates) {
      const hit = provider.models.find((m) => m.id.toLowerCase() === candidate);
      if (hit) return hit;
    }
  }

  for (const candidate of candidates) {
    const matches: Array<{ model: InkosModel; providerId: string }> = [];
    for (const p of getAllEndpoints()) {
      const hit = p.models.find((m) => m.id.toLowerCase() === candidate);
      if (hit) matches.push({ model: hit, providerId: p.id });
    }
    if (matches.length === 0) continue;
    matches.sort((a, b) => {
      const ai = PROVIDER_PRIORITY.indexOf(a.providerId);
      const bi = PROVIDER_PRIORITY.indexOf(b.providerId);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    return matches[0].model;
  }
  return undefined;
}

function candidateModelIds(modelId: string): string[] {
  const lowerId = modelId.toLowerCase();
  const bareId = lowerId.includes("/") ? lowerId.slice(lowerId.lastIndexOf("/") + 1) : lowerId;
  const familyId = deepSeekFamilyId(bareId);
  if (!familyId) return [lowerId];
  return [...new Set([lowerId, bareId, familyId])];
}

function deepSeekFamilyId(modelId: string): string | undefined {
  if (/^deepseek-flash(?:-|$)/.test(modelId) || /^deepseek-v4(?:\.1)?-flash(?:-|$)/.test(modelId)) {
    return "deepseek-flash";
  }
  if (/^deepseek-v4(?:\.1)?-pro(?:-|$)/.test(modelId)) return "deepseek-v4-pro";
  return undefined;
}

/** Official DeepSeek V4 Chat Completions ids that default thinking on when `thinking` is omitted. */
export function isDeepSeekV4WireCompatId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const bareId = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return (
    /^deepseek-flash(?:-|$)/.test(bareId)
    || /^deepseek-v4(?:\.1)?-(?:flash|pro)(?:-|$)/.test(bareId)
    || bareId === "deepseek-chat"
    || bareId === "deepseek-reasoner"
  );
}

export const DEEPSEEK_MAX_OUTPUT = 393_216;
export const DEEPSEEK_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_OUTPUT_FLOOR = 32_768;
export const UNKNOWN_MODEL_FALLBACK_CONTEXT_WINDOW = 128_000;

export function advertisedContextWindow(contextWindow: number | undefined): number {
  return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : UNKNOWN_MODEL_FALLBACK_CONTEXT_WINDOW;
}

export function isDeepSeekModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  const bareId = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return bareId.startsWith("deepseek");
}

export function applyModelTokenLimits(modelId: string, maxTokens: number, contextWindow: number): {
  readonly maxTokens: number;
  readonly contextWindow: number;
} {
  const resolvedWindow = advertisedContextWindow(contextWindow);
  if (isDeepSeekModelId(modelId)) {
    return {
      maxTokens: Math.max(maxTokens, DEEPSEEK_MAX_OUTPUT),
      contextWindow: Math.max(resolvedWindow, DEEPSEEK_CONTEXT_WINDOW),
    };
  }
  return {
    maxTokens: Math.max(maxTokens, DEFAULT_OUTPUT_FLOOR),
    contextWindow: resolvedWindow,
  };
}

/** 某 service 下可用（enabled !== false）的模型列表 */
export function listEnabledModels(serviceId: string): InkosModel[] {
  const provider = getEndpoint(serviceId);
  if (!provider) return [];
  return provider.models.filter((m) => m.enabled !== false);
}

export function isActiveTextModel(model: InkosModel): boolean {
  if (model.enabled === false) return false;
  if (model.status === "disabled" || model.status === "deprecated" || model.status === "nonText") return false;
  if (model.capabilities?.text === false) return false;
  if (model.capabilities?.imageOutput === true && model.capabilities?.text !== true) return false;
  return true;
}

export function listActiveTextModels(serviceId: string): InkosModel[] {
  const provider = getEndpoint(serviceId);
  if (!provider) return [];
  return provider.models.filter(isActiveTextModel);
}
