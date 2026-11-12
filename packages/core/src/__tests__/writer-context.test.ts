import { describe, expect, it } from "vitest";
import { previousChapterTail, renderWriterContext, selectWriterContext } from "../utils/writer-context.js";

const entry = (source: string, excerpt: string) => ({ source, reason: "selected", excerpt, protection: "compressible" as const });
const fact = (subject: string, object: string, from: number, until?: number) => entry(
  `runtime/current_state#${subject}`,
  [`subject: ${subject}`, "predicate: 持有", `object: ${object}`, `validFromChapter: ${from}`, ...(until === undefined ? [] : [`validUntilChapter: ${until}`])].join("\n"),
);
const memo = { goal: "陈平用养气丹换到柴房的钥匙", body: "### 展开｜柴房｜陈平、周茂\n周茂要价。", threadRefs: ["H2"] };

describe("writer context view", () => {
  const entries = [
    entry("runtime/chapter_memo", "memo text"),
    entry("story/style_guide.md", "style text"),
    entry("story/book_rules.md", "rules text"),
    entry("runtime/previous_chapter#ending", "previous ending"),
    entry("story/author_intent.md", "轻松好读"),
    fact("陈平", "养气丹一枚", 4),
    fact("陈平", "养气丹三枚", 2, 3),
    fact("周茂", "柴房钥匙", 4, 4),
    entry("story/roles/周茂.md", "周茂：杂役管事的侄子。"),
    entry("story/roles/钱贵.md", "钱贵：外门弟子。"),
    entry("story/outline/volume_map.md#a", "## 第1—3章 入门\n旧段落"),
    entry("story/outline/volume_map.md#b", "## 第4—6章 柴房\n当前段落"),
    entry("story/outline/story_frame.md", "世界：青石宗。"),
    entry("story/chapter_summaries.md#4", "陈平得了一枚\n养气丹。"),
    entry("runtime/referenced_hook#H2", "H2：柴房里的旧账本"),
    entry("story/pending_hooks.md#H2", "H2 duplicate"),
    entry("story/pending_hooks.md#H9", "H9：十年后的大比"),
    entry("research/notes.md", "杂项"),
  ];
  const view = selectWriterContext(entries, { chapterNumber: 5, memo });

  it("drops what the writer prompt renders itself and what this chapter cannot use", () => {
    const kept = Object.values(view).flat().map((item) => item.source);
    expect(kept).not.toContain("runtime/chapter_memo");
    expect(kept).not.toContain("story/style_guide.md");
    expect(kept).not.toContain("story/book_rules.md");
    expect(kept).not.toContain("runtime/previous_chapter#ending");
    // The memo names H2 and the referenced hook already carries it; H9 is a long-range plan.
    expect(view.threads.map((item) => item.source)).toEqual(["runtime/referenced_hook#H2"]);
    expect(view.direction.map((item) => item.source)).toEqual(["story/author_intent.md"]);
    expect(view.other.map((item) => item.source)).toEqual(["research/notes.md"]);
  });

  it("keeps facts that stand at the previous chapter and leaves out superseded ones", () => {
    expect(view.facts.map((item) => item.excerpt)).toEqual([
      expect.stringContaining("养气丹一枚"),
      expect.stringContaining("柴房钥匙"),
    ]);
  });

  it("narrows roles to the people the memo names and the outline to this chapter's stretch", () => {
    expect(view.roles.map((item) => item.source)).toEqual(["story/roles/周茂.md"]);
    expect(view.outline.map((item) => item.source)).toEqual(["story/outline/volume_map.md#b"]);
    const unnamed = selectWriterContext(entries, { chapterNumber: 5, memo: { ...memo, goal: "独自赶路", body: "路上无人。" } });
    expect(unnamed.roles).toHaveLength(2);
    const unranged = selectWriterContext([entry("story/outline/volume_map.md#x", "## 总纲\n没有章号")], { chapterNumber: 5, memo });
    expect(unranged.outline).toHaveLength(1);
  });

  it("renders facts as plain statements and only the sections that have content", () => {
    const rendered = renderWriterContext(view, "zh");
    expect(rendered).toContain("### 眼下的情况（截至上一章结束）\n- 陈平｜持有：养气丹一枚\n- 周茂｜持有：柴房钥匙");
    expect(rendered).toContain("### 前情\n- 第4章：陈平得了一枚 养气丹。");
    expect(rendered).toContain("### 本章要接的线\n- H2：柴房里的旧账本");
    expect(rendered).not.toContain("validFromChapter");
    expect(rendered).not.toContain("轻松好读");
    expect(renderWriterContext(selectWriterContext([], { chapterNumber: 1, memo }), "zh")).toBe("");
    expect(renderWriterContext(view, "en")).toContain("- 陈平 | 持有: 养气丹一枚");
  });
});

describe("previous chapter tail", () => {
  it("keeps whole closing paragraphs within the budget", () => {
    const body = ["第一段，很早的事。", "第二段，中间的事。", "第三段，最后的事。"].join("\n\n");
    expect(previousChapterTail(body, 20)).toBe("第二段，中间的事。\n\n第三段，最后的事。");
    expect(previousChapterTail(body, 5)).toBe("第三段，最后的事。");
    expect(previousChapterTail("甲。\r\n乙。", 100)).toBe("甲。\n\n乙。");
    expect(previousChapterTail(undefined)).toBe("");
  });
});
