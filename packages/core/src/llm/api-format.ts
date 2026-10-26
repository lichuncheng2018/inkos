import type { Api } from "@mariozechner/pi-ai";

export const LLM_API_FORMATS = ["chat", "responses", "anthropic"] as const;

export type LLMApiFormat = typeof LLM_API_FORMATS[number];

export function isLLMApiFormat(value: unknown): value is LLMApiFormat {
  return typeof value === "string" && (LLM_API_FORMATS as readonly string[]).includes(value);
}

export function toPiApi(format: LLMApiFormat): Api {
  if (format === "anthropic") return "anthropic-messages";
  if (format === "responses") return "openai-responses";
  return "openai-completions";
}

export function impliedApiFormat(presetApi: string | undefined): LLMApiFormat {
  if (presetApi === "anthropic-messages") return "anthropic";
  if (presetApi === "openai-responses") return "responses";
  return "chat";
}

export function resolveTransportApi(
  service: string,
  apiFormat: LLMApiFormat | undefined,
  presetApi: string | undefined,
): Api {
  const custom = service === "custom" || service.startsWith("custom:");
  if (custom) return toPiApi(apiFormat ?? "chat");
  if (apiFormat && apiFormat !== impliedApiFormat(presetApi)) return toPiApi(apiFormat);
  return (presetApi ?? "openai-completions") as Api;
}
