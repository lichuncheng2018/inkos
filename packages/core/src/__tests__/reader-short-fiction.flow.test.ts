import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ReaderSimulatorAgent, type ReaderSimulationResult } from "../agents/reader-simulator.js";
import { ReviserAgent } from "../agents/reviser.js";
import { ShortFictionWriterAgent, type ShortFictionBatchDraft } from "../agents/short-fiction.js";
import { runShortFictionStage } from "../pipeline/short-fiction-runner.js";
import { readShortProductionState } from "../pipeline/short-production-state.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("simulates completed short-fiction chapters in batch order, persists revisions, and skips them on resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-reader-short-"));
  roots.push(root);
  await saveWorkManifest(root, createWorkManifest({
    id: "receipt",
    title: "The Receipt",
    profileId: "short-fiction",
    language: "en",
    metadata: { genre: "Mystery", platform: "Fiction app" },
  }));
  await mkdir(join(root, "works/receipt/source/outline"), { recursive: true });
  await writeFile(join(root, "works/receipt/source/outline/v001.md"), "Mara discovers and returns a signed receipt.");

  const draft: ShortFictionBatchDraft = {
    storyTitle: "The Receipt",
    rawContent: "",
    chapters: [
      { number: 1, title: "Discovery", content: "Mara finds a signed receipt.", charCount: 6 },
      { number: 2, title: "Return", content: "Mara returns it to the clerk.", charCount: 7 },
    ],
  };
  const runtime = { projectRoot: root, model: "fixture", client: { defaults: { maxTokens: 4096 } } } as never;
  const calls: Array<{ chapterNumber: number; previousChapterSummary?: string; genre?: string; platform?: string }> = [];
  const feedback: ReaderSimulationResult["observations"] = [{
    code: "reader-weak-payoff",
    category: "quality",
    assessment: "issue",
    summary: "The discovery is not clear until the next sentence.",
    evidence: [],
    sourceRefs: [{ sourceId: "chapter-1", quote: "Mara finds a signed receipt." }],
  }];
  const writer = vi.spyOn(ShortFictionWriterAgent.prototype, "writeDraft").mockImplementation(async (input) => {
    if (!input.onBatchComplete) throw new Error("Expected the draft batch completion callback");
    await input.onBatchComplete(draft, [1]);
    await input.onBatchComplete(draft, [1, 2]);
    return draft;
  });
  vi.spyOn(ShortFictionWriterAgent.prototype, "continueDraft").mockImplementation(async (input) => input.draft);
  vi.spyOn(ReaderSimulatorAgent.prototype, "simulateChapter").mockImplementation(async (input) => {
    calls.push({
      chapterNumber: input.chapterNumber,
      previousChapterSummary: input.previousChapterSummary,
      genre: input.genre,
      platform: input.platform,
    });
    return {
      summary: `Reviewed chapter ${input.chapterNumber}.`,
      observations: input.chapterNumber === 1 ? feedback : [],
      tokenUsage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    };
  });
  vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({
    revisedContent: "Mara spots the signature and finds a signed receipt.",
    wordCount: 10,
    tokenUsage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
  });

  const options = {
    projectRoot: root,
    storyId: "receipt",
    direction: "Return a signed receipt.",
    stage: "draft" as const,
    language: "en" as const,
    chapterCount: 2,
    charsPerChapter: 1,
    minChapterLength: 1,
    cover: false,
    runtimes: { planner: runtime, writer: runtime, reader: runtime, draftReview: runtime, package: runtime },
  };

  await runShortFictionStage(options);

  expect(writer).toHaveBeenCalledTimes(1);
  const firstState = await readShortProductionState(root, "works/receipt/source");
  expect(firstState?.stages.readerSimulation, JSON.stringify(firstState?.stages)).toBeDefined();
  expect(calls.map((call) => call.chapterNumber), JSON.stringify(firstState?.stages.readerSimulation)).toEqual([1, 2]);
  expect(calls[0]).toMatchObject({ genre: "Mystery", platform: "Fiction app" });
  expect(calls[1]?.previousChapterSummary).toContain("Mara spots the signature");
  const savedDraft = JSON.parse(await readFile(join(root, "works/receipt/source/drafts/v001/draft.json"), "utf8"));
  expect(savedDraft.chapters[0].content).toBe("Mara spots the signature and finds a signed receipt.");
  const state = firstState;
  expect(state?.stages.readerSimulation).toMatchObject({
    status: "completed",
    tokenUsage: { promptTokens: 40, completionTokens: 13, totalTokens: 53 },
  });
  expect(state?.stages.readerSimulation?.chapters["2"]?.inputSummary).toContain("Mara spots the signature");

  await runShortFictionStage(options);
  expect(calls).toHaveLength(2);
});
