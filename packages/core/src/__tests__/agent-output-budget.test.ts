import { describe, expect, it } from "vitest";
import { agentContextBudget, agentOutputBudget } from "../agent/agent-session.js";
import type { Model, Api } from "@mariozechner/pi-ai";

function modelStub(overrides: Partial<Model<Api>>): Model<Api> {
  return {
    id: "fixture",
    name: "fixture",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "http://127.0.0.1/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
    ...overrides,
  };
}

describe("agentOutputBudget", () => {
  it("uses the advertised DeepSeek V4 max instead of the old 8192 chat cap", () => {
    expect(agentOutputBudget(modelStub({
      id: "deepseek-v4.1-flash",
      name: "deepseek-v4.1-flash",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      contextWindow: 1_000_000,
      maxTokens: 393_216,
    }))).toBe(393_216);
  });

  it("floors non-DeepSeek models to 32768 when the card is lower", () => {
    expect(agentOutputBudget(modelStub({
      id: "qwen-turbo",
      name: "qwen-turbo",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      contextWindow: 128_000,
      maxTokens: 4096,
    }))).toBe(32_768);
  });

  it("floors every DeepSeek id to the official V4 output even when the card is tiny", () => {
    expect(agentOutputBudget(modelStub({
      id: "vanchin/deepseek-v3.2",
      name: "vanchin/deepseek-v3.2",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      contextWindow: 128_000,
      maxTokens: 4096,
    }))).toBe(393_216);
  });

  it("keeps enough input room when a card advertises more output than the window", () => {
    expect(agentOutputBudget(modelStub({
      contextWindow: 32_000,
      maxTokens: 393_216,
    }))).toBe(32_000 - Math.max(2048, Math.floor(32_000 * 0.05)) - 8_192);
  });

  it("does not collapse an unknown Claude gateway model into a 2k chat budget", () => {
    const budget = agentContextBudget(modelStub({
      id: "claude-opus-5-5",
      name: "claude-opus-5-5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://756777.xyz",
      contextWindow: 0,
      maxTokens: 0,
    }));
    expect(budget).toBeGreaterThanOrEqual(8_192);
    expect(budget).toBeGreaterThan(5_534);
  });
});
