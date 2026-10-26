import { describe, expect, it } from "vitest";
import { impliedApiFormat, resolveTransportApi } from "../llm/api-format.js";

describe("resolveTransportApi", () => {
  it("honors Chat Completions on a built-in Anthropic preset", () => {
    expect(resolveTransportApi("bailian", "chat", "anthropic-messages")).toBe("openai-completions");
  });

  it("keeps the built-in Anthropic preset when the UI protocol is unset or matches", () => {
    expect(resolveTransportApi("bailian", undefined, "anthropic-messages")).toBe("anthropic-messages");
    expect(resolveTransportApi("bailian", "anthropic", "anthropic-messages")).toBe("anthropic-messages");
  });

  it("does not replace Google's native transport with the Chat Completions UI default", () => {
    expect(resolveTransportApi("google", "chat", "google-generative-ai")).toBe("google-generative-ai");
    expect(impliedApiFormat("google-generative-ai")).toBe("chat");
  });

  it("honors named custom service protocols, including Anthropic Messages", () => {
    expect(resolveTransportApi("custom:百炼 Chat Completions", "chat", undefined)).toBe("openai-completions");
    expect(resolveTransportApi("custom:启德流", "anthropic", undefined)).toBe("anthropic-messages");
  });
});
