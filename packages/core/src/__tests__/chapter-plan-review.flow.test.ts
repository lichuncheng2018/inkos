import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WriterAgent } from "../agents/writer.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { loadPersistedPlan, savePersistedPlan } from "../pipeline/persisted-governed-plan.js";
import { createLLMClient } from "../llm/provider.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import { createInitialRuntimeState } from "../state/runtime-state-store.js";

const draft = {
  goal: "Mara sees the receipt.",
  body: "## Scenes\n### Play out | shop | Mara\n- Mara sorts the shelves.\n- A stranger sets the receipt on the counter.\n\n## Notes\n- FUTURE_NOTE\n",
  threadRefs: [],
};
const revised = {
  ...draft,
  goal: "Mara recognizes the missing receipt.",
  body: "## Scenes\n### Play out | shop | Mara\n- A stranger sets the receipt on the counter.\n- Mara recognizes the signature.\n",
};
const problem = {
  code: "opening-delayed",
  assessment: "issue",
  summary: "Open with the stranger setting the receipt on the counter, then pass over shelf sorting.",
  sourceRefs: [{ sourceId: "chapter-1-plan", startLine: 3, endLine: 4 }],
};

it.each(["reorder", "opening-choice", "legacy-cache", "review-fails", "replan-fails"] as const)("reviews the plan before writing (%s)", async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), "inkos-plan-review-"));
  const id = "receipt";
  const state = new StateManager(root);
  const bookDir = state.bookDir(id);
  const runtimeDir = join(bookDir, "story", "runtime");
  const calls: { tool: string; model: string; messages: string }[] = [];
  const cached = scenario === "legacy-cache";
  const openingChoice = scenario === "opening-choice";
  const wantsReorder = scenario === "reorder" || scenario === "replan-fails" || openingChoice;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const tool = body.tools?.[0]?.function?.name as string;
    const review = tool === "submit_chapter_plan_review";
    const replan = tool === "submit_chapter_memo" && calls.some((call) => call.tool === "submit_chapter_plan_review");
    calls.push({ tool, model: body.model, messages: JSON.stringify(body.messages) });
    if ((review && scenario === "review-fails") || (replan && scenario === "replan-fails")) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Fixture unavailable" } }));
      return;
    }
    const result = review
      ? {
          summary: wantsReorder ? "Move the receipt forward." : "The scene works.",
          openingLine: 3,
          premiseOpeningLine: openingChoice ? 4 : null,
          observations: wantsReorder && !openingChoice ? [problem] : [],
        }
      : replan ? revised : draft;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
      id: `fixture-${calls.length}`, type: "function", function: { name: tool, arguments: JSON.stringify(result) },
    }] } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const now = new Date().toISOString();
    await saveWorkManifest(root, createWorkManifest({ id, title: "The Receipt", profileId: "longform-novel", language: "en" }));
    await state.saveBookConfig(id, {
      id, title: "The Receipt", genre: "Mystery", platform: "other", status: "active",
      targetChapters: 4, chapterWordCount: 1000, language: "en", createdAt: now, updatedAt: now,
    });
    await mkdir(join(bookDir, "story", "outline"), { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    const files = {
      "outline/story_frame.md": "# Story\nThe signature will matter.",
      "outline/volume_map.md": "# Volume One\nMara looks for a receipt.",
      "book_rules.md": "# Rules\nPreserve what has happened.",
      "book_rules.json": JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }),
      "author_intent.md": "# Author Intent\nPRIVATE_AUTHOR_DIRECTION",
      "texture_bank.md": "# Texture bank\n",
    };
    await Promise.all(Object.entries(files).map(([file, body]) => writeFile(join(bookDir, "story", file), body, "utf8")));
    await createInitialRuntimeState({ bookDir, language: "en" });
    await state.saveChapterIndex(id, []);
    if (cached) {
      await savePersistedPlan(bookDir, {
        memo: { chapter: 1, ...draft }, intent: { chapter: 1, goal: draft.goal },
        intentMarkdown: draft.body, plannerInputs: [], runtimePath: join(runtimeDir, "chapter-0001.intent.md"),
      });
      await writeFile(join(runtimeDir, "chapter-0001.intent.md"), draft.body, "utf8");
    }
    const client = createLLMClient({
      service: "custom", provider: "openai", configSource: "studio", model: "planner-fixture", apiKey: "fixture",
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiFormat: "chat",
      stream: false, thinkingBudget: 0, temperature: 0,
    });
    const runner = new PipelineRunner({
      projectRoot: root, client, model: "planner-fixture", modelOverrides: {
        "reader-simulator": "reader-flash-fixture",
        ...(cached ? {} : { "chapter-plan-reviewer": "plan-reader-fixture" }),
      },
    });
    const writer = vi.spyOn(WriterAgent.prototype, "writeChapter").mockRejectedValue(new Error("Writing boundary reached"));
    const instruction = openingChoice ? "Write chapter one." : "Keep Mara in the shop.";
    const options = { startChapterNumber: 1, ...(cached ? {} : { externalContext: instruction }) };
    await expect(runner.writeChapters(id, 1, options)).rejects.toThrow("Writing boundary reached");

    const observed = calls.filter((call) => call.tool === "submit_chapter_plan_review");
    const planned = calls.filter((call) => call.tool === "submit_chapter_memo");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ model: cached ? "reader-flash-fixture" : "plan-reader-fixture" });
    expect(observed[0]!.messages).toContain("shelves");
    expect(observed[0]!.messages).not.toMatch(/FUTURE_NOTE|PRIVATE_AUTHOR_DIRECTION|Keep Mara in the shop|Write chapter one\./);
    expect(planned).toHaveLength(cached ? 0 : wantsReorder ? 2 : 1);
    if (wantsReorder) {
      expect(planned[1]!.messages).toContain(openingChoice ? "Open on the action at line 4" : problem.summary);
      expect(planned[1]!.messages).toContain(instruction);
    }

    const expected = scenario === "reorder" || openingChoice ? revised : draft;
    const stored = await loadPersistedPlan(bookDir, 1);
    expect(writer).toHaveBeenCalledOnce();
    expect(writer.mock.calls[0]?.[0].chapterMemo?.body).toBe(expected.body);
    expect(stored?.memo.body).toBe(expected.body);
    expect(stored?.intentMarkdown).toContain(expected.goal === draft.goal && cached ? "Mara sorts the shelves." : expected.goal);
    expect(stored?.readerReviewed).toBe(scenario === "reorder" || openingChoice || cached ? true : undefined);
    if (scenario === "reorder" || openingChoice || cached) {
      const requestCount = calls.length;
      await expect(runner.writeChapters(id, 1, { startChapterNumber: 1 })).rejects.toThrow("Writing boundary reached");
      expect(calls).toHaveLength(requestCount);
    }
    expect(await readFile(join(bookDir, "chapters", "index.json"), "utf8")).toBe("[]");
  } finally {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
