import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ContinuityAuditor } from "../agents/continuity.js";
import { ReaderSimulatorAgent } from "../agents/reader-simulator.js";
import { ReviserAgent } from "../agents/reviser.js";
import { StateValidatorAgent } from "../agents/state-validator.js";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import { createLLMClient } from "../llm/provider.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { savePersistedPlan } from "../pipeline/persisted-governed-plan.js";
import { createInitialRuntimeState } from "../state/runtime-state-store.js";
import { StateManager } from "../state/manager.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["completed", "failed", "empty", "aborted"] as const)("runs deslop after review (%s), then passes its accepted content through reader revision and persistence", async (deslopStatus) => {
  const root = await mkdtemp(join(tmpdir(), "inkos-reader-longform-"));
  roots.push(root);
  const id = "receipt";
  const state = new StateManager(root);
  const bookDir = state.bookDir(id);
  const now = new Date().toISOString();

  await saveWorkManifest(root, createWorkManifest({ id, title: "The Receipt", profileId: "longform-novel", language: "en" }));
  await state.saveBookConfig(id, {
    id, title: "The Receipt", genre: "Mystery", platform: "Fiction app", status: "active",
    targetChapters: 3, chapterWordCount: 10, language: "en", createdAt: now, updatedAt: now,
  });
  await mkdir(join(bookDir, "story/outline"), { recursive: true });
  await writeFile(join(bookDir, "story/outline/story_frame.md"), "A clerk hides a signed receipt.");
  await writeFile(join(bookDir, "story/outline/volume_map.md"), "The signature changes who owns the receipt.");
  await writeFile(join(bookDir, "story/book_rules.md"), "# Rules\nPreserve established facts.\n");
  await writeFile(join(bookDir, "story/book_rules.json"), JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }));
  await createInitialRuntimeState({ bookDir, language: "en" });
  await state.saveChapterIndex(id, []);
  await mkdir(join(bookDir, "story/runtime"), { recursive: true });
  await savePersistedPlan(bookDir, {
    intent: { chapter: 1, goal: "Show Mara deciding whether to sign." },
    memo: { chapter: 1, goal: "Show Mara deciding whether to sign.", body: "The clerk waits for her signature.", threadRefs: [] },
    intentMarkdown: "Show Mara deciding whether to sign.",
    runtimePath: "runtime/chapter-1.intent.md",
    plannerInputs: [],
  });

  const order: string[] = [];
  const draft = {
    ...chapterOutput(1),
    content: "Mara signs the receipt before checking the name. The clerk seals it.",
    tokenUsage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  };
  const deslopContent = "Before checking the name, Mara signs the receipt. The clerk seals it.";
  const readerSource = deslopStatus === "completed" ? deslopContent : draft.content;
  const revisedContent = "Mara checks the name, then signs the receipt. The clerk seals it.";
  vi.spyOn(WriterAgent.prototype, "writeChapter").mockImplementation(async () => {
    order.push("writer");
    return draft;
  });
  vi.spyOn(WriterAgent.prototype, "settleChapterState").mockImplementation(async (input) => {
    order.push("settle");
    expect(input.content).toBe(revisedContent);
    return { ...draft, content: input.content, wordCount: 12 };
  });
  vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockImplementation(async () => {
    order.push("audit");
    return { summary: "The scene is clear.", observations: [], tokenUsage: { promptTokens: 4, completionTokens: 5, totalTokens: 9 } };
  });
  const reader = vi.spyOn(ReaderSimulatorAgent.prototype, "simulateChapter").mockImplementation(async (input) => {
    order.push("reader");
    expect(input.chapterContent).toBe(readerSource);
    return {
      summary: "Mara's choice is clear after she checks the name.",
      observations: [{
        code: "unclear-choice",
        category: "quality",
        assessment: "issue",
        summary: "Signing before checking the name makes Mara's choice feel arbitrary.",
        evidence: [],
        sourceRefs: [{ sourceId: "chapter-1", quote: readerSource.split(". ")[0] + "." }],
      }],
      tokenUsage: { promptTokens: 10, completionTokens: 6, totalTokens: 16 },
    };
  });
  const revise = vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockImplementation(async function (this: ReviserAgent, ...args) {
    if (args[4] === "anti-detect") {
      order.push("deslop");
      expect(args[1]).toBe(draft.content);
      expect(args[2]).toBe(1);
      expect(args[5]).toBe("Mystery");
      expect(args[6]).toMatchObject({ language: "en", chapterTitle: draft.title, proseChannel: "text" });
      const context = (this as unknown as { ctx: { activatedSkills: { skill: { id: string } }[] } }).ctx;
      expect(context.activatedSkills.map(({ skill }) => skill.id)).toContain("inkos-story-deslop");
      expect(args[6]?.contextPackage.selectedContext).toContainEqual(expect.objectContaining({
        source: "pipeline:semantic-prose-cleanup", protection: "protected",
      }));
      if (deslopStatus === "failed") throw new Error("deslop unavailable");
      if (deslopStatus === "aborted") throw new DOMException("Cancelled", "AbortError");
      return {
        revisedContent: deslopStatus === "empty" ? "   " : deslopContent,
        wordCount: 13,
        tokenUsage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      };
    }
    order.push("reviser");
    expect(args[1]).toBe(readerSource);
    expect(args[2]).toBe(1);
    expect(args[3][0]?.evidence).toContain(readerSource.split(". ")[0] + ".");
    expect(args[4]).toBe("spot-fix");
    return {
      revisedContent,
      wordCount: 12,
      tokenUsage: { promptTokens: 20, completionTokens: 7, totalTokens: 27 },
    };
  });
  const validate = vi.spyOn(StateValidatorAgent.prototype, "validate").mockImplementation(async (content) => {
    order.push("validator");
    expect(content).toBe(revisedContent);
    return { consistent: true, reconciliationRequired: false, observations: [] };
  });

  const client = createLLMClient({
    service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture",
    baseUrl: "http://127.0.0.1:1/v1", apiFormat: "chat", stream: false, thinkingBudget: 0, temperature: 0,
  });
  const pipeline = new PipelineRunner({ projectRoot: root, client, model: "fixture" });
  const writing = pipeline.writeChapters(id, 1, { startChapterNumber: 1 });
  if (deslopStatus === "aborted") {
    await expect(writing).rejects.toMatchObject({ name: "AbortError" });
    expect(order).toEqual(["writer", "audit", "deslop"]);
    expect(reader).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(await state.loadChapterIndex(id)).toEqual([]);
    return;
  }
  const [result] = await writing;

  expect(order).toEqual(["writer", "audit", "deslop", "reader", "reviser", "settle", "validator"]);
  expect(reader).toHaveBeenCalledTimes(1);
  expect(revise).toHaveBeenCalledTimes(2);
  expect(validate).toHaveBeenCalledTimes(1);
  const usage = deslopStatus === "failed"
    ? { promptTokens: 35, completionTokens: 20, totalTokens: 55 }
    : { promptTokens: 37, completionTokens: 23, totalTokens: 60 };
  expect(result?.tokenUsage).toEqual(usage);
  expect(result?.review.observations).toContainEqual(expect.objectContaining({
    code: "unclear-choice",
    assessment: "observation",
  }));

  const chapterFile = (await readdir(join(bookDir, "chapters"))).find((file) => file.endsWith(".md"));
  expect(chapterFile).toBeDefined();
  expect(await readFile(join(bookDir, "chapters", chapterFile!), "utf8")).toContain(revisedContent);
  const [persisted] = await state.loadChapterIndex(id);
  expect(persisted?.tokenUsage).toEqual(usage);
  if (deslopStatus !== "completed") {
    expect(result?.review.observations).toContainEqual(expect.objectContaining({
      code: "deslop-unavailable", assessment: "unavailable",
    }));
    expect(persisted?.observations).toContainEqual(expect.objectContaining({
      code: "deslop-unavailable", assessment: "unavailable",
    }));
  }
  expect(persisted?.observations).toContainEqual(expect.objectContaining({
    code: "unclear-choice",
    assessment: "observation",
  }));
});

function chapterOutput(chapterNumber: number): WriteChapterOutput {
  const summary = {
    chapter: chapterNumber,
    title: `Chapter ${chapterNumber}`,
    characters: "Mara",
    events: "Mara signs the receipt.",
    stateChanges: "The receipt is sealed.",
    hookActivity: "",
    mood: "tense",
    chapterType: "investigation",
  };
  return {
    chapterNumber,
    title: `Chapter ${chapterNumber}`,
    content: "Mara signs the receipt.",
    wordCount: 5,
    postSettlement: "",
    runtimeStateDelta: {
      chapter: chapterNumber,
      factOps: { upsert: [], expire: [] },
      hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
      newHookCandidates: [],
      chapterSummary: summary,
    },
    runtimeStateSnapshot: {
      manifest: { schemaVersion: 2, language: "en", lastAppliedChapter: chapterNumber, projectionVersion: 1 },
      currentState: { chapter: chapterNumber, facts: [] },
      hooks: { hooks: [] },
      chapterSummaries: { rows: [summary] },
    },
    updatedState: "# Current State\n",
    updatedHooks: "# Pending Hooks\n",
    updatedChapterSummaries: `| ${chapterNumber} | Mara signs |`,
    runtimeStateApplied: true,
  };
}
