import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  archiveChapterVersion,
  buildRuntimeStateArtifacts,
  type ChapterMeta,
  composeGovernedChapter,
  ComposerAgent,
  ContinuityAuditor,
  createInitialRuntimeState,
  createLLMClient,
  createWorkManifest,
  loadRuntimeStateSnapshot,
  loadWorkManifest,
  PipelineRunner,
  PlannerAgent,
  ReaderSimulatorAgent,
  ReviserAgent,
  saveChapterUserBrief,
  saveRuntimeStateSnapshot,
  saveWorkManifest,
  StateManager,
  StateValidatorAgent,
  syncWorkSourceArtifacts,
  WriterAgent,
} from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";

it("deletes the latest chapter's workspace and restores the Work's current story state", async () => {
  const root = await mkdtemp(join(tmpdir(), "inkos-chapter-delete-"));
  try {
    const bookId = "test-book";
    const state = new StateManager(root);
    const bookDir = state.bookDir(bookId);
    const now = "2026-11-22T00:00:00.000Z";
    await saveWorkManifest(root, createWorkManifest({ id: bookId, title: "Test Book", profileId: "longform-novel", language: "zh" }));
    await state.saveBookConfig(bookId, {
      id: bookId, title: "Test Book", genre: "general", platform: "other", status: "active", targetChapters: 3,
      chapterWordCount: 20, language: "zh", createdAt: now, updatedAt: now,
    });
    await mkdir(join(bookDir, "story/outline"), { recursive: true });
    await writeFile(join(bookDir, "story/outline/story_frame.md"), "故事从雨夜开始。");
    await writeFile(join(bookDir, "story/outline/volume_map.md"), "第一卷：雨夜");
    await writeFile(join(bookDir, "story/book_rules.md"), "保留第一章设定。");
    await writeFile(join(bookDir, "story/texture_bank.md"), "窗台上有雨水。");
    const initialState = await createInitialRuntimeState({ bookDir, language: "zh" });
    const chapterFiles = ["chapters/0001_开头.md", "chapters/0002_旧剧情.md"];
    const index: ChapterMeta[] = [];
    for (const [position, chapterPath] of chapterFiles.entries()) {
      const chapter = position + 1;
      const title = chapter === 1 ? "开头" : "旧剧情";
      await mkdir(join(bookDir, dirname(chapterPath)), { recursive: true });
      await writeFile(join(bookDir, chapterPath), `# ${title}\n\n${title}正文。\n`, "utf-8");
      await saveRuntimeStateSnapshot(bookDir, {
        ...initialState,
        manifest: { ...initialState.manifest, lastAppliedChapter: chapter },
        currentState: { chapter, facts: [] },
      });
      await state.snapshotState(bookId, chapter);
      await archiveChapterVersion(bookDir, chapter, `${title}历史稿`, "manual");
      index.push({ number: chapter, title, wordCount: 6, createdAt: now, updatedAt: now, observations: [], provenance: "generated" });
    }
    await state.saveChapterIndex(bookId, index);
    await saveChapterUserBrief(bookDir, 2, "旧指令");
    const staleFiles = ["story/runtime/chapter-0002.intent.md", "story/runtime/chapter-0002.plan.json", "story/drafts/0002_旧剧情.md"];
    const oldPlan = JSON.stringify({
      version: 2, intent: { chapter: 2, goal: "旧剧情" }, memo: { chapter: 2, goal: "旧剧情", body: "旧剧情", threadRefs: [] },
      plannerInputs: [], readerReviewed: true,
    });
    for (const relativePath of staleFiles) {
      await mkdir(join(bookDir, dirname(relativePath)), { recursive: true });
      await writeFile(join(bookDir, relativePath), relativePath.endsWith(".json") ? oldPlan : "旧剧情", "utf-8");
    }
    const before = await syncWorkSourceArtifacts({ projectRoot: root, workId: bookId, accept: true });
    const oldChapter = before.artifacts.find((artifact) => artifact.revisions.some((revision) => revision.path === `source/${chapterFiles[1]}`))!;
    const app = createStudioServer({} as never, root);
    const chapterUrl = `/api/v1/books/${bookId}/chapters/2`;
    const response = await app.request(chapterUrl, { method: "DELETE" });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ deletedChapter: 2, rolledBackTo: 1, discarded: [2], trashedFiles: ["chapters/.trash/0002_旧剧情.md"] });
    await expect(readFile(join(bookDir, result.trashedFiles[0]), "utf-8")).resolves.toContain("旧剧情正文");

    expect((await app.request(chapterUrl)).status).toBe(404);
    const staleBriefRequest = { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief: "旧指令" }) };
    expect((await app.request(`${chapterUrl}/workspace/brief`, { ...staleBriefRequest, method: "PUT" })).status).toBe(404);
    expect((await app.request(`/api/v1/books/${bookId}/rewrite/2`, { ...staleBriefRequest, method: "POST" })).status).toBe(404);
    const workspace = await app.request(`${chapterUrl}/workspace`);
    expect(await workspace.json()).toMatchObject({ brief: "", plan: null, versions: [], canDelete: false });
    const previous = await app.request(chapterUrl.replace(/2$/, "1") + "/workspace");
    expect(await previous.json()).toMatchObject({ versions: [{ source: "manual" }], canDelete: true });
    await expect(state.getNextChapterNumber(bookId)).resolves.toBe(2);
    await expect(loadRuntimeStateSnapshot(bookDir)).resolves.toMatchObject({ manifest: { lastAppliedChapter: 1 } });
    for (const relativePath of [...staleFiles, "story/snapshots/2", "chapters/.versions/0002"]) {
      await expect(access(join(bookDir, relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    }

    const artifactsUrl = `/api/v1/works/${bookId}/artifacts`;
    expect((await app.request(`${artifactsUrl}/${oldChapter.id}/revisions/${oldChapter.currentRevisionId}`)).status).toBe(404);
    await expect(access(join(root, "works", bookId, oldChapter.revisions[0]!.snapshotPath!))).rejects.toMatchObject({ code: "ENOENT" });
    const work = await loadWorkManifest(root, bookId);
    const chapterIndex = work.artifacts.find((artifact) => artifact.revisions.some((revision) => revision.path === "source/chapters/index.json"))!;
    const currentIndex = await app.request(`${artifactsUrl}/${chapterIndex.id}/revisions/${chapterIndex.currentRevisionId}`);
    expect(currentIndex.status).toBe(200);
    expect(JSON.parse((await currentIndex.json()).content)).toEqual(index.slice(0, 1));

    const nextSync = await syncWorkSourceArtifacts({ projectRoot: root, workId: bookId, accept: true });
    expect(nextSync.artifacts.flatMap((artifact) => artifact.revisions).some((revision) => revision.path.startsWith("source/chapters/.trash/"))).toBe(false);

    const newPlan = "从窗台上的雨水开始。";
    const newText = "雨水顺着窗台往下滴，她听见门外有人敲了两下。";
    const runtimePath = join(bookDir, staleFiles[0]!);
    const planner = vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async () => {
      await writeFile(runtimePath, newPlan, "utf-8");
      return {
        intent: { chapter: 2, goal: newPlan }, memo: { chapter: 2, goal: newPlan, body: newPlan, threadRefs: [] },
        intentMarkdown: newPlan, plannerInputs: [], runtimePath, readerReviewed: true,
      };
    });
    vi.spyOn(ComposerAgent.prototype, "composeChapter").mockImplementation((input) => composeGovernedChapter({
      ...input,
      outlineSectionSelector: async ({ candidates }) => candidates.map((candidate) => candidate.source),
      memorySemanticSelector: async ({ candidates }) => candidates.map((candidate) => candidate.id),
    }));
    const writer = vi.spyOn(WriterAgent.prototype, "writeChapter").mockImplementation(async () => {
      const artifacts = await buildRuntimeStateArtifacts({ bookDir, language: "zh", delta: {
        chapter: 2, factOps: { upsert: [], expire: [] }, hookOps: { upsert: [], mention: [], resolve: [], defer: [] }, newHookCandidates: [],
        chapterSummary: { chapter: 2, title: "新剧情", characters: "她", events: newText, stateChanges: "", hookActivity: "", mood: "紧张", chapterType: "日常" },
      } });
      return {
        chapterNumber: 2, title: "新剧情", content: newText, wordCount: newText.length, postSettlement: "",
        runtimeStateDelta: artifacts.resolvedDelta, runtimeStateSnapshot: artifacts.snapshot, runtimeStateApplied: true,
        updatedState: artifacts.currentStateMarkdown, updatedHooks: artifacts.hooksMarkdown, updatedChapterSummaries: artifacts.chapterSummariesMarkdown,
      };
    });
    vi.spyOn(ContinuityAuditor.prototype, "auditChapter").mockResolvedValue({ summary: "", observations: [] });
    vi.spyOn(StateValidatorAgent.prototype, "validate").mockResolvedValue({ consistent: true, reconciliationRequired: false, observations: [] });
    vi.spyOn(ReaderSimulatorAgent.prototype, "simulateChapter").mockRejectedValue(new Error("Simulated model unavailable"));
    vi.spyOn(ReviserAgent.prototype, "reviseChapter").mockResolvedValue({ revisedContent: newText, wordCount: newText.length });
    const client = createLLMClient({ service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture", baseUrl: "http://127.0.0.1:1/v1", apiFormat: "chat", stream: false, thinkingBudget: 0, temperature: 0 });
    const pipeline = new PipelineRunner({ projectRoot: root, client, model: "fixture" });
    await expect(pipeline.writeNextChapter(bookId)).resolves.toMatchObject({ chapterNumber: 2, title: "新剧情" });
    expect(planner).toHaveBeenCalledOnce();
    expect(planner.mock.calls[0]![0].existingPlan).toBeUndefined();
    expect(writer.mock.calls[0]![0].chapterIntent).toBe(newPlan);
    expect(JSON.stringify(writer.mock.calls[0]![0].contextPackage)).not.toContain("旧剧情");
    expect(await (await app.request(chapterUrl)).json()).toMatchObject({ content: expect.stringContaining(newText) });
    expect(await (await app.request(`${chapterUrl}/workspace`)).json()).toMatchObject({ plan: newPlan, brief: "", versions: [] });
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
