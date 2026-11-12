import { expect, it, vi } from "vitest";
import { ReaderSimulatorAgent } from "../agents/reader-simulator.js";
import type { AgentContext } from "../agents/base.js";

it("sends only reader-visible context and requires evidence from the current chapter", async () => {
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
    language: "en",
  });

  expect(result.observations[0]).toMatchObject({ code: "reader-weak-payoff", assessment: "issue" });
  const [messages, sources, tool, options] = submit.mock.calls[0]!;
  expect(sources.get("chapter-1")).toBe("She folded the receipt without reading it.\nThe clerk waited.");
  expect(tool.name).toBe("submit_reader_simulation");
  expect(options).toMatchObject({ professionalGuidance: false, includeAuthorRequest: false });
  expect(messages).toHaveLength(2);
  const userInput = JSON.parse(messages[1]!.content);
  expect(userInput.story).toEqual({ title: "The Receipt", genre: "Mystery", platform: "Fiction app" });
  expect(userInput).not.toHaveProperty("outline");
  expect(userInput).not.toHaveProperty("authorRequest");
});
