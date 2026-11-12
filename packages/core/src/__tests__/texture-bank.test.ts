import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@mariozechner/pi-ai";
import { ArchitectAgent } from "../agents/architect.js";
import { ComposerAgent } from "../agents/composer.js";
import { PlannerAgent } from "../agents/planner.js";
import { buildPlannerUserMessage } from "../agents/planner-prompts.js";
import { createLLMClient } from "../llm/provider.js";
import type { BookConfig } from "../models/book.js";
import { loadAvailableAgentSkills } from "../skills/builtin-loader.js";
import { createWorkManifest, saveWorkManifest } from "../harness/work-store.js";
import { PipelineRunner } from "../pipeline/runner.js";
import { StateManager } from "../state/manager.js";
import { createInitialRuntimeState } from "../state/runtime-state-store.js";
import { TEXTURE_BANK_PATH, parseTextureBank, renderTextureSample, sampleTextureBank } from "../utils/texture-bank.js";

const fetchWithProxyMock = vi.hoisted(() => vi.fn());

vi.mock("../utils/proxy-fetch.js", () => ({
  fetchWithProxy: fetchWithProxyMock,
}));

const bank = [
  "# 质感库",
  "",
  "说明文字不是条目。",
  "",
  "## 物价",
  "- 杂役饭堂一顿糙米饭两文",
  "- 一担干柴八文",
  "- 下品养气丹一枚三钱银子",
  "",
  "## 吃食",
  "* 腌萝卜条配糙米粥",
  "1. 逢五加一勺猪油渣",
  "",
  "## 称呼",
  "- 杂役管外门弟子叫“师兄”，不论年纪",
].join("\r\n");

describe("texture bank", () => {
  it("reads list items under their headings and ignores commentary", () => {
    expect(parseTextureBank(bank)).toEqual([
      { section: "物价", text: "杂役饭堂一顿糙米饭两文" },
      { section: "物价", text: "一担干柴八文" },
      { section: "物价", text: "下品养气丹一枚三钱银子" },
      { section: "吃食", text: "腌萝卜条配糙米粥" },
      { section: "吃食", text: "逢五加一勺猪油渣" },
      { section: "称呼", text: "杂役管外门弟子叫“师兄”，不论年纪" },
    ]);
    expect(parseTextureBank("")).toEqual([]);
  });

  it("offers each chapter a fixed sample that spans kinds and comes round before repeating", () => {
    const entries = parseTextureBank(bank);
    const first = sampleTextureBank(entries, 1, 2);
    expect(first.map((entry) => entry.section)).toEqual(["物价", "吃食"]);
    expect(sampleTextureBank(entries, 1, 2)).toEqual(first);
    const offered = [1, 2, 3].flatMap((chapter) => sampleTextureBank(entries, chapter, 2));
    expect(new Set(offered.map((entry) => entry.text)).size).toBe(entries.length);
    // The fourth chapter starts the round again.
    expect(sampleTextureBank(entries, 4, 2)).toEqual(first);
    expect(sampleTextureBank(entries.slice(0, 3), 9, 4)).toEqual(entries.slice(0, 3));
  });

  it("labels each entry with its kind", () => {
    const sample = parseTextureBank(bank).slice(0, 1);
    expect(renderTextureSample(sample, "zh")).toBe("- 〔物价〕杂役饭堂一顿糙米饭两文");
    expect(renderTextureSample(sample, "en")).toBe("- [物价] 杂役饭堂一顿糙米饭两文");
    expect(renderTextureSample([{ section: "", text: "a clay bowl" }], "en")).toBe("- a clay bowl");
    expect(renderTextureSample([], "zh")).toBe("");
  });

  it("presents the sample to the planner as optional material, never as events", () => {
    const base = { chapterNumber: 3, contextPackage: { chapter: 3, selectedContext: [] }, lengthBudget: { target: 2500, unit: "字" } };
    const withSample = buildPlannerUserMessage({ ...base, textureSample: "- 〔物价〕一担干柴八文", language: "zh" });
    expect(withSample).toContain("## 这本书里现成的小东西");
    expect(withSample).toContain("不是事件，也不是要求");
    expect(withSample).toContain("不为它另排场次");
    expect(withSample).toContain("- 〔物价〕一担干柴八文");
    expect(buildPlannerUserMessage({ ...base, language: "zh" })).not.toContain("现成的小东西");
    expect(buildPlannerUserMessage({ ...base, textureSample: "- [Prices] a cord of wood, eight coppers", language: "en" }))
      .toContain("plan no scene for their sake");
  });
});

describe("texture bank in the pipeline", () => {
  const model: Model<"openai-completions"> = {
    id: "test-model", name: "test-model", api: "openai-completions", provider: "openai", baseUrl: "https://example.test/v1",
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192,
  };
  const client = createLLMClient({ provider: "openai", service: "custom", configSource: "studio", baseUrl: model.baseUrl, model: model.id, apiKey: "fixture", apiFormat: "chat", stream: false, temperature: 0, thinkingBudget: 0 });
  const book: BookConfig = {
    id: "story", title: "柴房", genre: "修仙", platform: "other", status: "active",
    targetChapters: 10, chapterWordCount: 2500, language: "zh",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  let root: string;
  let bookDir: string;

  beforeEach(async () => {
    fetchWithProxyMock.mockReset();
    root = await mkdtemp(join(tmpdir(), "inkos-texture-bank-"));
    bookDir = join(root, "works/story/source");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function writeStory(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      const target = join(bookDir, "story", path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }

  async function plan(chapterNumber: number) {
    vi.spyOn(ComposerAgent.prototype, "selectTaskContext").mockImplementation(async (input) => ({
      chapter: input.chapterNumber,
      selectedContext: [{ source: "story/author_intent.md", reason: "Long-term intent.", excerpt: "intent", protection: "protected" }],
    }));
    let offered: string | undefined;
    vi.spyOn(PlannerAgent.prototype, "planChapterMemo").mockImplementation(async (input) => {
      offered = input.textureSample;
      return { chapter: input.chapterNumber, goal: "换到钥匙。", body: "## 场次", threadRefs: [] };
    });
    const output = await new PlannerAgent({ client, model: model.id, projectRoot: root }).planChapter({ book, bookDir, chapterNumber });
    return { offered, inputs: output.plannerInputs };
  }

  it("hands the planner this chapter's entries when the book has a bank", async () => {
    await writeStory({ "author_intent.md": "intent", "texture_bank.md": bank });
    const third = await plan(1);
    expect(third.offered!.split("\n")).toEqual([
      "- 〔物价〕杂役饭堂一顿糙米饭两文",
      "- 〔吃食〕腌萝卜条配糙米粥",
      "- 〔称呼〕杂役管外门弟子叫“师兄”，不论年纪",
      "- 〔物价〕一担干柴八文",
    ]);
    expect(third.inputs).toContain(TEXTURE_BANK_PATH);
  });

  it("plans from the governed context alone when the book has none", async () => {
    await writeStory({ "author_intent.md": "intent" });
    const result = await plan(1);
    expect(result.offered).toBe("");
    expect(result.inputs).not.toContain(TEXTURE_BANK_PATH);
  });

  const generated = ["## 物价与行情", ...Array.from({ length: 7 }, (_, index) => `- 第${index + 1}样东西${index + 2}文`), "## 吃食", ...Array.from({ length: 6 }, (_, index) => `- 吃食${index + 1}`)].join("\n");
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));

  it("writes the bank from the book's foundation as an editable document", async () => {
    await writeStory({
      "outline/story_frame.md": "青石宗外门，杂役院。",
      "book_rules.md": "下品养气丹一枚三钱银子。",
      "roles/次要角色/周茂.md": "杂役管事的侄子，管柴房钥匙。",
      "chapter_summaries.md": "第4章：陈平得了一枚养气丹。",
    });
    const requests: Array<{ tools?: unknown[]; messages: Array<{ role: string; content: string }> }> = [];
    fetchWithProxyMock.mockImplementation(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return reply("```markdown\n# 质感库\n\n" + generated + "\n```");
    });
    // The runner activates the long-form craft Skill for every worker of a long-form Work.
    const craft = (await loadAvailableAgentSkills({ projectRoot: "" })).skills.find((skill) => skill.id === "inkos-long-writing")!;
    const document = await new ArchitectAgent({ client, model: model.id, projectRoot: root, activatedSkills: [{ skill: craft, resources: [] }] })
      .generateTextureBank({ book, bookDir });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools ?? []).toHaveLength(0);
    const system = requests[0]!.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    expect(system).toContain("为这本书写一份质感库");
    // What belongs in a bank is the Skill's foundation method; the architect reads that section and its reference, not the prose craft.
    expect(system).toContain("## Texture bank");
    expect(system).toContain("particular enough that it would be wrong in another book");
    expect(system).not.toContain("### 中文正文");
    const user = requests[0]!.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
    expect(user).toContain("<story_frame>\n青石宗外门，杂役院。\n</story_frame>");
    expect(user).toContain("### 周茂\n杂役管事的侄子，管柴房钥匙。");
    expect(user).toContain("<chapter_summaries>");
    expect(document.startsWith("# 质感库\n\n这本书里现成的小东西。")).toBe(true);
    expect(document.match(/^# /gmu)).toHaveLength(1);
    expect(document).not.toContain("```");
    expect(parseTextureBank(document)).toHaveLength(13);
  });

  /** A real runner over a minimal long-form Work; planning stops the flow at a known point. */
  async function runnerAtPlanning() {
    const state = new StateManager(root);
    await saveWorkManifest(root, createWorkManifest({ id: book.id, title: book.title, profileId: "longform-novel", language: "zh" }));
    await state.saveBookConfig(book.id, book);
    await writeStory({
      "outline/story_frame.md": "青石宗外门，杂役院。",
      "outline/volume_map.md": "第1章 柴房。",
      "book_rules.md": "# 规则",
      "book_rules.json": JSON.stringify({ version: "2", prohibitions: [], enableFullCastTracking: false, allowedDeviations: [] }),
    });
    await createInitialRuntimeState({ bookDir, language: "zh" });
    await state.saveChapterIndex(book.id, []);
    const bankAtPlanning: Array<string | undefined> = [];
    vi.spyOn(PlannerAgent.prototype, "planChapter").mockImplementation(async (input) => {
      bankAtPlanning.push(await readFile(join(input.bookDir, TEXTURE_BANK_PATH), "utf-8").catch(() => undefined));
      throw Object.assign(new Error("planning reached"), { code: "PLANNING_REACHED" });
    });
    const run = () => new PipelineRunner({ projectRoot: root, client, model: model.id })
      .writeChapters(book.id, 1, { startChapterNumber: 1, externalContext: "写下一章" });
    return { run, bankAtPlanning };
  }

  it("writes a missing bank before the first chapter is planned and leaves an existing one alone", async () => {
    const { run, bankAtPlanning } = await runnerAtPlanning();
    const generate = vi.spyOn(ArchitectAgent.prototype, "generateTextureBank").mockResolvedValue("# 质感库\n\n## 物价\n- 一担干柴八文\n");
    await expect(run()).rejects.toMatchObject({ code: "PLANNING_REACHED" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(bankAtPlanning).toEqual(["# 质感库\n\n## 物价\n- 一担干柴八文\n"]);

    await writeStory({ "texture_bank.md": "## 物价\n- 作者自己改过的一条\n" });
    await expect(run()).rejects.toMatchObject({ code: "PLANNING_REACHED" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(bankAtPlanning[1]).toBe("## 物价\n- 作者自己改过的一条\n");
  });

  it("still plans the chapter when the bank cannot be written", async () => {
    const { run, bankAtPlanning } = await runnerAtPlanning();
    vi.spyOn(ArchitectAgent.prototype, "generateTextureBank").mockRejectedValue(Object.assign(new Error("model unavailable"), { code: "MODEL_UNAVAILABLE" }));
    await expect(run()).rejects.toMatchObject({ code: "PLANNING_REACHED" });
    expect(bankAtPlanning).toEqual([undefined]);
  });

  it("refuses a bank too thin to rotate or with nothing to ground it", async () => {
    await writeStory({ "book_rules.md": "下品养气丹一枚三钱银子。" });
    fetchWithProxyMock.mockImplementation(async () => reply("## 物价\n- 只有一条"));
    const architect = new ArchitectAgent({ client, model: model.id, projectRoot: root });
    await expect(architect.generateTextureBank({ book, bookDir })).rejects.toMatchObject({ code: "TEXTURE_BANK_INVALID" });
    await rm(join(bookDir, "story", "book_rules.md"));
    const calls = fetchWithProxyMock.mock.calls.length;
    await expect(architect.generateTextureBank({ book, bookDir })).rejects.toMatchObject({ code: "TEXTURE_BANK_UNGROUNDED" });
    expect(fetchWithProxyMock).toHaveBeenCalledTimes(calls);
  });
});
