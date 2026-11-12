import { describe, expect, it, vi } from "vitest";
import { ReaderSimulatorAgent } from "../agents/reader-simulator.js";
import { ReviserAgent } from "../agents/reviser.js";
import { simulateAndReviseChapter } from "../pipeline/reader-revision.js";
import type { AgentContext } from "../agents/base.js";
import type { ReaderSimulationResult } from "../agents/reader-simulator.js";

const context = { projectRoot: "/tmp", model: "fixture", client: { defaults: { maxTokens: 4096 } } } as unknown as AgentContext;
const input = {
  storyTitle: "The Receipt",
  genre: "Mystery",
  platform: "Fiction app",
  chapterNumber: 2,
  chapterTitle: "The Signature",
  chapterContent: "Mara signs the receipt.\nThe clerk seals it.",
  previousChapterSummary: "Mara found an unsigned receipt.",
  language: "en" as const,
};
const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const observation = {
  code: "reader-unclear-motive",
  category: "quality" as const,
  assessment: "issue" as const,
  summary: "The reader cannot tell why Mara signs before checking the name.",
  evidence: [],
  sourceRefs: [{ sourceId: "chapter-2", quote: "Mara signs the receipt." }],
};

function simulationResult(observations: ReaderSimulationResult["observations"]): ReaderSimulationResult {
  return { summary: "The scene is clear overall.", observations, tokenUsage: usage };
}

describe("simulateAndReviseChapter", () => {
  it("skips revision when the reader has no actionable feedback", async () => {
    const reader = new ReaderSimulatorAgent(context);
    const reviser = new ReviserAgent(context);
    vi.spyOn(reader, "simulateChapter").mockResolvedValue(simulationResult([]));
    const revise = vi.spyOn(reviser, "reviseChapter");

    const result = await simulateAndReviseChapter({
      reader, reviser, simulation: input, bookDir: "/tmp/book", contextPackage: { chapter: 2, selectedContext: [] },
    });

    expect(revise).not.toHaveBeenCalled();
    expect(result).toMatchObject({ content: input.chapterContent, simulationStatus: "completed", revisionStatus: "not-needed", tokenUsage: usage });
  });

  it("runs one spot-fix, passes the cited excerpt to the reviser, and combines usage", async () => {
    const reader = new ReaderSimulatorAgent(context);
    const reviser = new ReviserAgent(context);
    vi.spyOn(reader, "simulateChapter").mockResolvedValue(simulationResult([observation]));
    const revise = vi.spyOn(reviser, "reviseChapter").mockResolvedValue({
      revisedContent: "Mara checks the name, then signs the receipt.\nThe clerk seals it.",
      wordCount: 12,
      tokenUsage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
    });

    const result = await simulateAndReviseChapter({
      reader, reviser, simulation: input, bookDir: "/tmp/book", contextPackage: { chapter: 2, selectedContext: [] },
    });

    expect(revise).toHaveBeenCalledTimes(1);
    expect(revise.mock.calls[0]?.[4]).toBe("spot-fix");
    expect(revise.mock.calls[0]?.[3][0]?.evidence).toContain("Mara signs the receipt.");
    expect(result).toMatchObject({
      content: "Mara checks the name, then signs the receipt.\nThe clerk seals it.",
      simulationStatus: "completed",
      revisionStatus: "completed",
      tokenUsage: { promptTokens: 30, completionTokens: 13, totalTokens: 43 },
    });
    expect(result.observations[0]?.assessment).toBe("observation");
  });

  it("keeps the source chapter when simulation or revision fails", async () => {
    const reader = new ReaderSimulatorAgent(context);
    const reviser = new ReviserAgent(context);
    vi.spyOn(reader, "simulateChapter").mockRejectedValueOnce(new Error("reader offline"));
    const failedSimulation = await simulateAndReviseChapter({
      reader, reviser, simulation: input, bookDir: "/tmp/book", contextPackage: { chapter: 2, selectedContext: [] },
    });
    expect(failedSimulation).toMatchObject({ content: input.chapterContent, simulationStatus: "failed", revisionStatus: "not-needed" });
    expect(failedSimulation.observations).toContainEqual(expect.objectContaining({
      code: "reader-simulation-unavailable",
      assessment: "unavailable",
    }));

    vi.spyOn(reader, "simulateChapter").mockResolvedValueOnce(simulationResult([observation]));
    vi.spyOn(reviser, "reviseChapter").mockRejectedValueOnce(new Error("reviser offline"));
    const failedRevision = await simulateAndReviseChapter({
      reader, reviser, simulation: input, bookDir: "/tmp/book", contextPackage: { chapter: 2, selectedContext: [] },
    });
    expect(failedRevision).toMatchObject({ content: input.chapterContent, simulationStatus: "completed", revisionStatus: "failed" });
    expect(failedRevision.observations).toContainEqual(expect.objectContaining({
      code: "reader-revision-unavailable",
      assessment: "unavailable",
    }));
  });
});
