import { describe, expect, it } from "vitest";
import { resolveAgentModelOverride } from "../llm/model-override.js";
import type { LLMConfig } from "../models/project.js";

const llm: LLMConfig = {
  provider: "openai",
  service: "custom:阿里云",
  configSource: "studio",
  baseUrl: "https://ws-plzmu33saeovo49i.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  apiKey: "aliyun-key",
  model: "deepseek-v4.1-flash-1017",
  apiFormat: "chat",
  stream: true,
  temperature: 0.7,
  thinkingBudget: 0,
  services: [
    { service: "deepseek", models: ["deepseek-flash"], apiFormat: "chat", stream: true },
    {
      service: "custom",
      name: "启德流",
      baseUrl: "https://756777.xyz",
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      apiFormat: "anthropic",
      stream: true,
    },
    {
      service: "custom",
      name: "阿里云",
      baseUrl: "https://ws-plzmu33saeovo49i.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      models: ["deepseek-v4.1-flash-1017"],
      apiFormat: "chat",
      stream: true,
    },
  ],
};

describe("resolveAgentModelOverride", () => {
  it("reuses the default client when the model stays on the same endpoint", () => {
    const resolved = resolveAgentModelOverride({
      override: "deepseek-v4.1-flash-1017",
      llm,
      projectRoot: "/tmp",
      getApiKey: () => "unused",
    });
    expect(resolved).toEqual({ model: "deepseek-v4.1-flash-1017", reuseDefaultClient: true });
  });

  it("routes a catalog model onto its own service, format, and secret", () => {
    const resolved = resolveAgentModelOverride({
      override: "claude-opus-5-5",
      llm,
      projectRoot: "/tmp",
      getApiKey: (service) => service === "custom:启德流" ? "qide-key" : null,
    });
    expect(resolved.reuseDefaultClient).toBe(false);
    expect(resolved.model).toBe("claude-opus-5-5");
    expect(resolved.clientConfig).toMatchObject({
      service: "custom:启德流",
      baseUrl: "https://756777.xyz",
      apiFormat: "anthropic",
      apiKey: "qide-key",
      model: "claude-opus-5-5",
    });
    expect(resolved.cacheKey).toContain("claude-opus-5-5");
    expect(resolved.cacheKey).toContain("anthropic");
  });

  it("does not reuse a DeepSeek client for Sonnet on a different protocol", () => {
    const resolved = resolveAgentModelOverride({
      override: "claude-sonnet-5-5",
      llm,
      projectRoot: "/tmp",
      getApiKey: () => "qide-key",
    });
    expect(resolved.reuseDefaultClient).toBe(false);
    expect(resolved.clientConfig?.apiFormat).toBe("anthropic");
    expect(resolved.clientConfig?.baseUrl).toBe("https://756777.xyz");
  });

  it("honors an explicit service hint when the same model id exists twice", () => {
    const resolved = resolveAgentModelOverride({
      override: { model: "deepseek-flash", service: "deepseek" },
      llm,
      projectRoot: "/tmp",
      getApiKey: (service) => service === "deepseek" ? "official-ds" : null,
    });
    expect(resolved.reuseDefaultClient).toBe(false);
    expect(resolved.clientConfig).toMatchObject({
      service: "deepseek",
      apiKey: "official-ds",
      model: "deepseek-flash",
      apiFormat: "chat",
    });
    expect(resolved.clientConfig?.baseUrl).toContain("deepseek.com");
  });
});
