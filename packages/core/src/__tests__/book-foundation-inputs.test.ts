import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProposeActionTool } from "../agent/agent-tools.js";
import { ArchitectAgent } from "../agents/architect.js";
import { createBookFoundationTool } from "../harness/tools/longform-production.js";
import { ActionPayloadSchema } from "../interaction/action-envelope.js";
import { createLLMClient } from "../llm/provider.js";
import { BookConfigSchema, type BookConfig } from "../models/book.js";
import { PipelineRunner, type InitBookOptions } from "../pipeline/runner.js";

function fakePipeline() {
  const initBook = vi.fn(async (_book: unknown, _options: InitBookOptions) => {});
  const pipeline = {
    runWithAgentContext: async (_context: unknown, task: () => Promise<unknown>) => task(),
    initBook,
  } as unknown as PipelineRunner;
  return { pipeline, initBook };
}

describe("create_book foundation inputs", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tempProject(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inkos-book-inputs-"));
    roots.push(root);
    return root;
  }

  it("passes an uploaded brief verbatim and appends the confirmed chat requests", async () => {
    const root = await tempProject();
    await mkdir(join(root, ".inkos/uploads/session"), { recursive: true });
    const brief = "# 创作简报\n主角在 2001 年春接手濒临破产的机械厂。";
    await writeFile(join(root, ".inkos/uploads/session/1-1-brief.md"), `${brief}\n`);
    const { pipeline, initBook } = fakePipeline();

    await createBookFoundationTool(pipeline, {
      projectRoot: root,
      actionPayload: ActionPayloadSchema.parse({
        createBook: { title: "重生2001", briefPath: ".inkos/uploads/session/1-1-brief.md" },
      }),
    }).execute("create", { instruction: "目标平台改为起点。", genre: "年代工业" });

    expect(initBook.mock.calls[0]![1]).toEqual({
      externalContext: `${brief}\n\n## 建书对话补充\n目标平台改为起点。`,
    });
  });

  it("only reads briefs that were uploaded to the chat", async () => {
    const root = await tempProject();
    await mkdir(join(root, ".inkos/uploads/session"), { recursive: true });
    await writeFile(join(root, ".inkos/secrets.json"), "{\"services\":{\"custom\":\"sk-secret\"}}");
    await writeFile(join(root, ".inkos/uploads/session/notes.json"), "{}");
    const { pipeline, initBook } = fakePipeline();

    for (const briefPath of [
      ".inkos/secrets.json",
      ".inkos/uploads/../secrets.json",
      "../outside.md",
      ".inkos/uploads/session/notes.json",
    ]) {
      await expect(createBookFoundationTool(pipeline, { projectRoot: root })
        .execute("create", { instruction: "Create", title: "Story", genre: "mystery", briefPath }))
        .rejects.toMatchObject({ code: "BRIEF_PATH_INVALID" });
    }
    expect(initBook).not.toHaveBeenCalled();
  });

  it("seeds supplied control documents instead of copying the brief into author intent", async () => {
    const { pipeline, initBook } = fakePipeline();

    await createBookFoundationTool(pipeline, {
      authorIntent: "# 作者意图\n长期方向。\n",
      currentFocus: "  ",
    }).execute("create", { instruction: "完整简报", title: "Story", genre: "mystery" });

    expect(initBook.mock.calls[0]![1]).toEqual({
      externalContext: "完整简报",
      authorIntent: "# 作者意图\n长期方向。",
    });
  });

  it("refuses to create a book whose genre nobody stated instead of filing it under a placeholder", async () => {
    const { pipeline, initBook } = fakePipeline();
    const tool = createBookFoundationTool(pipeline);

    expect(tool.parameters.required).toContain("genre");
    for (const genre of [undefined, "", "   "]) {
      await expect(tool.execute("create", { instruction: "完整简报", title: "Story", genre } as never))
        .rejects.toMatchObject({ code: "BOOK_GENRE_REQUIRED" });
    }
    expect(initBook).not.toHaveBeenCalled();
  });

  it("hands the stated genre to the foundation and writes every book for 番茄小说", async () => {
    const { pipeline, initBook } = fakePipeline();
    const tool = createBookFoundationTool(pipeline, {
      actionPayload: { createBook: { title: "Story", genre: "玄幻修仙", platform: "起点中文网" } },
    });

    expect(Object.keys(tool.parameters.properties)).not.toContain("platform");
    await tool.execute("create", { instruction: "完整简报", title: "Story", genre: " 玄幻修仙 " });

    expect(initBook.mock.calls[0]![0]).toMatchObject({ genre: "玄幻修仙", platform: "番茄小说" });
  });

  it("reads an older book.json on another platform as 番茄小说", () => {
    const book = BookConfigSchema.parse({
      id: "old", title: "Old", platform: "other", genre: "other", status: "active",
      targetChapters: 10, chapterWordCount: 3000, language: "zh",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(book.platform).toBe("番茄小说");
  });

  it("only offers a create_book confirmation that names the genre", async () => {
    const tool = createProposeActionTool("zh", { allowedActions: ["create_book"] });
    const proposal = { action: "create_book", title: "创建《Story》", summary: "建立长篇基础设定。", instruction: "完整简报" };

    expect(tool.parameters.properties.createBook.required).toContain("genre");
    await expect(tool.execute("propose", { ...proposal, createBook: { title: "Story" } }))
      .rejects.toThrow("createBook.genre");
    const accepted = await tool.execute("propose", { ...proposal, createBook: { title: "Story", genre: "都市重生" } });
    expect(accepted.details).toMatchObject({ action: "create_book", actionPayload: { createBook: { title: "Story", genre: "都市重生" } } });
  });

  it("persists supplied control documents next to the verbatim brief", async () => {
    const root = await tempProject();
    vi.spyOn(ArchitectAgent.prototype, "generateFoundation").mockResolvedValue({
      storyFrame: "# 故事框架\n主角接手濒临破产的机械厂。",
      volumeMap: "# 第一卷\n救厂与第一桶金。",
      roles: [{ tier: "major", name: "陆峥", content: "技术骨干，想保住工厂。" }],
      bookRules: "# 本书规则\n金手指不直接给钱。",
      bookRulesData: { version: "2", prohibitions: ["金手指不直接给钱"], enableFullCastTracking: false, allowedDeviations: [] },
      pendingHooks: "",
      initialHooks: [],
    });
    const client = createLLMClient({
      service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture",
      baseUrl: "http://127.0.0.1:9/v1", apiFormat: "chat", stream: false, thinkingBudget: 0, temperature: 0,
    });
    const now = new Date().toISOString();
    const book: BookConfig = {
      id: "factory", title: "Factory", genre: "年代工业", platform: "tomato", status: "outlining",
      targetChapters: 300, chapterWordCount: 3000, language: "zh", createdAt: now, updatedAt: now,
    };

    await new PipelineRunner({ client, model: "fixture", projectRoot: root }).initBook(book, {
      externalContext: "# 创作简报\n完整设定与卷纲。",
      authorIntent: "# 作者意图\n长期方向。",
      currentFocus: "# 当前聚焦\n\n## 当前重点\n第 1 章修好进口液压机。",
    });

    const story = join(root, "works/factory/source/story");
    expect(await readFile(join(story, "brief.md"), "utf8")).toBe("# 创作简报\n完整设定与卷纲。");
    expect(await readFile(join(story, "author_intent.md"), "utf8")).toBe("# 作者意图\n长期方向。\n");
    expect(await readFile(join(story, "current_focus.md"), "utf8")).toBe("# 当前聚焦\n\n## 当前重点\n第 1 章修好进口液压机。\n");
  });
});
