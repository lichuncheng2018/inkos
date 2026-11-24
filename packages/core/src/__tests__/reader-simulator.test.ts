import { expect, it, vi } from "vitest";
import { ReaderSimulatorAgent } from "../agents/reader-simulator.js";
import type { AgentContext } from "../agents/base.js";
import { createLLMClient } from "../llm/provider.js";
import { fetchWithProxy } from "../utils/proxy-fetch.js";

vi.mock("../utils/proxy-fetch.js", () => ({ fetchWithProxy: vi.fn() }));

it.each([
  ["en", "the first line where the reader can see the result", "cite both the first telling and the repetition"],
  ["zh", "读者在哪一行第一次亲眼看到结果", "同时引用首次出现和重复的行号"],
] as const)("sends only reader-visible context and checks the payoff and repetition (%s)", async (language, payoffCheck, repetitionCheck) => {
  const agent = new ReaderSimulatorAgent({
    projectRoot: "/tmp",
    model: "fixture",
    bookId: "story",
    client: { defaults: { maxTokens: 4096 } },
  } as unknown as AgentContext);
  const submit = vi.spyOn(agent as unknown as { submitSourcedReview: (...args: any[]) => Promise<any> }, "submitSourcedReview").mockResolvedValue({
    result: {
      summary: "The scene reads clearly.",
      observations: [{
        code: "weak-payoff",
        category: "quality",
        assessment: "issue",
        summary: "The promise of a hidden signature does not pay off in this scene.",
        evidence: [],
        sourceRefs: [{ sourceId: "chapter-1", quote: "She folded the receipt without reading it." }],
      }],
    },
    usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
  });

  const result = await agent.simulateChapter({
    storyTitle: "The Receipt",
    genre: "Mystery",
    platform: "Fiction app",
    chapterNumber: 1,
    chapterTitle: "The Signature",
    chapterContent: "She folded the receipt without reading it.\nThe clerk waited.",
    previousChapterSummary: "",
    language,
  });

  expect(result.observations[0]).toMatchObject({ code: "reader-weak-payoff", assessment: "issue" });
  const [messages, sources, tool, options] = submit.mock.calls[0]!;
  expect(sources.get("chapter-1")).toBe("She folded the receipt without reading it.\nThe clerk waited.");
  expect(tool.name).toBe("submit_reader_simulation");
  expect(options).toMatchObject({ professionalGuidance: false, includeAuthorRequest: false });
  expect(messages).toHaveLength(2);
  expect(messages[0]!.content).toContain(payoffCheck);
  expect(messages[0]!.content).toContain(repetitionCheck);
  expect(messages[0]!.content).toContain('"sourceRefs":[{"sourceId":"chapter-1","startLine":1,"endLine":1}]');
  const userInput = JSON.parse(messages[1]!.content);
  expect(userInput.story).toEqual({ title: "The Receipt", genre: "Mystery", platform: "Fiction app" });
  expect(userInput).not.toHaveProperty("outline");
  expect(userInput).not.toHaveProperty("authorRequest");
});

it("retries an unusable submission and keeps a cited finding alongside malformed observations", async () => {
  const model = "fixture";
  const client = createLLMClient({
    service: "custom", provider: "openai", configSource: "studio", model, apiKey: "fixture",
    baseUrl: "https://example.test/v1", apiFormat: "chat", stream: false, thinkingBudget: 0, temperature: 0,
  });
  const agent = new ReaderSimulatorAgent({ client, model, projectRoot: "/tmp" });
  const chapterContent = "她把收据折起来。\n店员还在等。";
  const unsupported = { code: "unsupported", assessment: "issue", summary: "缺少正文引证。" };
  const malformed = [unsupported, "只有一句文字的意见"];
  const supported = {
    code: "unclear-choice", assessment: "issue", summary: "读者不明白她为什么收起收据。",
    sourceRefs: [{ sourceId: "chapter-2", startLine: 1, endLine: 1 }],
  };

  const fetch = vi.mocked(fetchWithProxy);
  fetch.mockImplementation(async () => {
    const attempt = fetch.mock.calls.length;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
      id: `reader-${attempt}`, type: "function",
      function: {
        name: "submit_reader_simulation",
        arguments: JSON.stringify({
          summary: "人物的选择交代得太快。",
          observations: attempt === 1 ? malformed : [...malformed, supported],
        }),
      },
    }] } }] }));
  });

  const result = await agent.simulateChapter({
    storyTitle: "收据", chapterNumber: 2, chapterTitle: "签名", chapterContent, language: "zh",
  });

  expect(fetch).toHaveBeenCalledTimes(2);
  const retry = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
  const feedback = retry.messages.find((message: { role: string }) => message.role === "tool");
  expect(JSON.parse(feedback.content)).toMatchObject({ code: "WORKER_SCHEMA_INVALID", issues: [
    { path: "/observations/0/sourceRefs", message: "Expected required property" },
    { path: "/observations/0/sourceRefs", message: "Expected array" },
    { path: "/observations/1", message: "Expected object" },
  ] });
  expect(result.observations).toEqual([{
    ...supported, code: "reader-unclear-choice", category: "quality", evidence: [],
    sourceRefs: [{ sourceId: "chapter-2", quote: "她把收据折起来。" }],
  }]);
});
