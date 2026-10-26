import type { LLMApiFormat } from "./api-format.js";
import { impliedApiFormat } from "./api-format.js";
import { getServiceApiKeySync } from "./secrets.js";
import { resolveServicePreset } from "./service-presets.js";
import type { AgentLLMOverride, LLMConfig } from "../models/project.js";

export interface CatalogServiceEntry {
  readonly service: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
  readonly apiFormat?: LLMApiFormat;
  readonly stream?: boolean;
  readonly temperature?: number;
}

export interface ResolvedAgentOverride {
  readonly model: string;
  readonly reuseDefaultClient: boolean;
  readonly clientConfig?: LLMConfig;
  readonly cacheKey?: string;
}

export function catalogServiceKey(entry: Pick<CatalogServiceEntry, "service" | "name">): string {
  return entry.service === "custom" ? `custom:${entry.name ?? "Custom"}` : entry.service;
}

export function resolveAgentModelOverride(input: {
  readonly override: string | AgentLLMOverride;
  readonly llm?: LLMConfig;
  readonly projectRoot: string;
  readonly getApiKey?: (serviceKey: string) => string | null;
}): ResolvedAgentOverride {
  const { override, llm, projectRoot } = input;
  const model = typeof override === "string" ? override : override.model;
  if (!llm) {
    return { model, reuseDefaultClient: true };
  }

  const objectOverride = typeof override === "object" ? override : undefined;
  const entry = findCatalogEntry(llm, model, {
    service: objectOverride?.service,
    baseUrl: objectOverride?.baseUrl,
  });
  const serviceKey = objectOverride?.service
    ?? (entry ? catalogServiceKey(entry) : llm.service);
  const apiFormat = objectOverride?.apiFormat
    ?? entry?.apiFormat
    ?? impliedApiFormat(resolveServicePreset(baseServiceId(serviceKey))?.api)
    ?? llm.apiFormat
    ?? "chat";
  const stream = objectOverride?.stream ?? entry?.stream ?? llm.stream ?? true;
  const baseUrl = objectOverride?.baseUrl
    ?? entry?.baseUrl
    ?? resolveServicePreset(baseServiceId(serviceKey))?.baseUrl
    ?? llm.baseUrl;
  const sameEndpoint = sameLlmEndpoint(llm, { baseUrl, apiFormat, stream });
  const apiKey = resolveOverrideApiKey({
    override: objectOverride,
    serviceKey,
    llm,
    projectRoot,
    sameEndpoint,
    getApiKey: input.getApiKey,
  });

  if (sameEndpoint) {
    return { model, reuseDefaultClient: true };
  }

  const provider = objectOverride?.provider
    ?? (serviceKey === "custom" || serviceKey.startsWith("custom:")
      ? "custom"
      : apiFormat === "anthropic" ? "anthropic" : "openai");
  const clientConfig: LLMConfig = {
    ...llm,
    provider,
    service: serviceKey,
    baseUrl,
    apiKey,
    model,
    apiFormat,
    stream,
    ...(entry?.temperature !== undefined ? { temperature: entry.temperature } : {}),
  };
  const apiKeySource = objectOverride?.apiKeyEnv
    ? `env:${objectOverride.apiKeyEnv}`
    : `service:${serviceKey}`;
  return {
    model,
    reuseDefaultClient: false,
    clientConfig,
    cacheKey: [provider, serviceKey, baseUrl, apiKeySource, `stream:${stream}`, `format:${apiFormat}`, model].join("|"),
  };
}

function findCatalogEntry(
  llm: LLMConfig,
  model: string,
  hints: { readonly service?: string; readonly baseUrl?: string },
): CatalogServiceEntry | undefined {
  const services = catalogEntries(llm);
  if (hints.service) {
    const hinted = services.find((entry) =>
      catalogServiceKey(entry) === hints.service || entry.service === hints.service
    );
    if (hinted) return hinted;
  }
  if (hints.baseUrl) {
    const byUrl = services.find((entry) => normalizeBaseUrl(entry.baseUrl ?? "") === normalizeBaseUrl(hints.baseUrl ?? ""));
    if (byUrl) return byUrl;
  }
  const needle = model.toLowerCase();
  const matches = services.filter((entry) =>
    (entry.models ?? []).some((id) => id.toLowerCase() === needle)
  );
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  return matches.find((entry) => catalogServiceKey(entry) === llm.service) ?? matches[0];
}

function catalogEntries(llm: LLMConfig): CatalogServiceEntry[] {
  return Array.isArray(llm.services) ? llm.services : [];
}

function baseServiceId(serviceKey: string): string {
  return serviceKey.startsWith("custom:") ? "custom" : serviceKey;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function sameLlmEndpoint(
  llm: LLMConfig,
  target: { readonly baseUrl: string; readonly apiFormat: LLMApiFormat; readonly stream: boolean },
): boolean {
  const currentFormat = llm.apiFormat ?? "chat";
  const currentStream = llm.stream ?? true;
  return normalizeBaseUrl(llm.baseUrl) === normalizeBaseUrl(target.baseUrl)
    && currentFormat === target.apiFormat
    && currentStream === target.stream;
}

function resolveOverrideApiKey(input: {
  readonly override?: AgentLLMOverride;
  readonly serviceKey: string;
  readonly llm: LLMConfig;
  readonly projectRoot: string;
  readonly sameEndpoint: boolean;
  readonly getApiKey?: (serviceKey: string) => string | null;
}): string {
  if (input.override?.apiKeyEnv) {
    return process.env[input.override.apiKeyEnv] ?? "";
  }
  if (input.sameEndpoint) return input.llm.apiKey ?? "";
  const readKey = input.getApiKey ?? ((serviceKey: string) => getServiceApiKeySync(input.projectRoot, serviceKey));
  return readKey(input.serviceKey) ?? "";
}
