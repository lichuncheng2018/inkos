import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerAgent, type OutlineSectionSelectionRequest } from "../agents/composer.js";
import { PlannerAgent } from "../agents/planner.js";
import { createLLMClient } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import type { ContextPackage } from "../models/input-governance.js";
import { createInitialRuntimeState } from "../state/runtime-state-store.js";

const client = createLLMClient({
  service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture",
  baseUrl: "http://127.0.0.1:9/v1", apiFormat: "chat", stream: false, thinkingBudget: 0, temperature: 0,
});

const book: BookConfig = {
  id: "story", title: "Story", genre: "general", platform: "other", status: "active",
  targetChapters: 10, chapterWordCount: 1000, language: "en",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

async function writeStory(bookDir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = join(bookDir, "story", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

describe("planning context", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tempBook(): Promise<{ root: string; bookDir: string }> {
    const root = await mkdtemp(join(tmpdir(), "inkos-planner-context-"));
    roots.push(root);
    return { root, bookDir: join(root, "works/story/source") };
  }

  it("sends the task goal to each selector and the memo entry exactly once", async () => {
    const { root, bookDir } = await tempBook();
    await createInitialRuntimeState({ bookDir, language: "en" });
    await writeStory(bookDir, {
      "author_intent.md": "# Author Intent\nA courier earns trust one delivery at a time.",
      "current_focus.md": "# Current Focus\nDeliver the sealed letter.",
      "outline/story_frame.md": "# Departure\nThe courier leaves.\n# Return\nThe courier returns.",
      "outline/volume_map.md": "# Volume One\nThe letter.\n# Volume Two\nThe reply.",
      "roles/major/Courier.md": "Carries the letter.",
      "roles/major/Clerk.md": "Signs for the letter.",
      "volume_summaries.md": "## Earlier\nThe letter was sealed.\n## Later\nIts sender was found.",
    });
    await writeFile(join(bookDir, "story/state/current_state.json"), JSON.stringify({
      chapter: 0,
      facts: ["courier", "clerk"].map((subject) => ({
        subject, predicate: "location", object: "station", validFromChapter: 0, validUntilChapter: null, sourceChapter: 0,
      })),
    }));
    const selectorGoals: string[] = [];
    vi.spyOn(ComposerAgent.prototype, "selectOutlineSections").mockImplementation(async (request: OutlineSectionSelectionRequest) => {
      selectorGoals.push(request.goal);
      return request.candidates.map((candidate) => candidate.source);
    });
    const memoryQueries: string[] = [];
    vi.spyOn(ComposerAgent.prototype, "selectMemoryCandidates").mockImplementation(async (request) => {
      memoryQueries.push(request.query);
      return [];
    });
    const goal = "Deliver the sealed letter before the station closes.";

    const selected = await new ComposerAgent({ client, model: "fixture", projectRoot: root }).selectTaskContext({
      bookDir, chapterNumber: 1, goal, language: "en",
      contextBudget: { contextWindowTokens: 1001, reservedOutputTokens: 1000 },
    });

    expect(selectorGoals).toEqual([goal, goal, goal, goal]);
    expect(memoryQueries).toEqual([goal]);
    expect(selected.selectedContext.find((entry) => entry.source === "runtime/chapter_memo")?.excerpt).toBe(`goal=${goal}`);
  });

  async function planWith(files: Record<string, string>, externalContext?: string): Promise<{
    readonly goal: string;
    readonly memoContext: ContextPackage;
  }> {
    const { root, bookDir } = await tempBook();
    await writeStory(bookDir, files);
    let goal = "";
    vi.spyOn(ComposerAgent.prototype, "selectTaskContext").mockImplementation(async (input) => {
      goal = input.goal;
      return {
        chapter: input.chapterNumber,
        selectedContext: [
          { source: "runtime/chapter_memo", reason: "Carry the planner's chapter memo into governed writing.", excerpt: `goal=${input.goal}`, protection: "protected" },
          { source: "story/current_focus.md", reason: "Current task focus for this chapter.", excerpt: files["current_focus.md"]!, protection: "protected" },
          { source: "story/author_intent.md", reason: "Long-term intent.", excerpt: files["author_intent.md"]!, protection: "protected" },
          { source: "story/outline/volume_map.md#volume-one", reason: "Anchor the default planning node.", excerpt: "# Volume One", protection: "protected" },
        ],
      };
    });
    let memoContext: ContextPackage | undefined;
    vi.spyOn(PlannerAgent.prototype, "planChapterMemo").mockImplementation(async (input) => {
      memoContext = input.contextPackage;
      return { chapter: input.chapterNumber, goal: "Deliver the letter.", body: "The courier delivers the letter.", threadRefs: [] };
    });

    await new PlannerAgent({ client, model: "fixture", projectRoot: root }).planChapter({ book, bookDir, chapterNumber: 1, externalContext });
    return { goal, memoContext: memoContext! };
  }

  it("does not repeat a brief that author intent already copies", async () => {
    const brief = "# Brief\nA courier earns trust one delivery at a time.";
    const { goal, memoContext } = await planWith({
      "author_intent.md": brief,
      "current_focus.md": "# Current Focus\nDeliver the sealed letter.",
      "brief.md": brief,
    }, "Keep the station scene short.");

    expect(goal.split("A courier earns trust").length - 1).toBe(1);
    expect(goal).toContain("Keep the station scene short.");
    expect(memoContext.selectedContext.map((entry) => entry.source)).toEqual([
      "story/current_focus.md",
      "story/author_intent.md",
      "story/outline/volume_map.md#volume-one",
    ]);
  });

  it("keeps a distinct brief once, after author intent and below it in precedence", async () => {
    const { goal, memoContext } = await planWith({
      "author_intent.md": "# Author Intent\nThe courier works for the guild.",
      "current_focus.md": "# Current Focus\nDeliver the sealed letter.",
      "brief.md": "# Brief\nThe courier works alone.",
    });

    expect(goal.split("The courier works alone.").length - 1).toBe(1);
    expect(memoContext.selectedContext.map((entry) => entry.source)).toEqual([
      "story/current_focus.md",
      "story/author_intent.md",
      "story/brief.md",
      "story/outline/volume_map.md#volume-one",
    ]);
    const briefEntry = memoContext.selectedContext.find((entry) => entry.source === "story/brief.md")!;
    expect(briefEntry.excerpt).toBe("# Brief\nThe courier works alone.");
    expect(briefEntry.reason).toContain("take precedence");
  });
});
