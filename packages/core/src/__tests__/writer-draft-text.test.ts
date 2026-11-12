import { describe, expect, it } from "vitest";
import { parseChapterDraftText } from "../agents/writer.js";

describe("parseChapterDraftText", () => {
  it("takes the title from a numbered heading and keeps the prose intact", () => {
    expect(parseChapterDraftText("第1章 先把修为翻一倍\n\n第1日，子时。\n\n他数了两遍灵石。")).toEqual({
      title: "先把修为翻一倍",
      content: "第1日，子时。\n\n他数了两遍灵石。",
    });
    expect(parseChapterDraftText("# 第一章：翻倍\n\n正文。")).toEqual({ title: "翻倍", content: "正文。" });
    expect(parseChapterDraftText("Chapter 3: The Receipt\n\nMara returns it.")).toEqual({ title: "The Receipt", content: "Mara returns it." });
  });

  it("ignores a code fence, a one-line preamble and quote marks around the title", () => {
    expect(parseChapterDraftText("```markdown\n第2章 《灵草》\n\n正文。\n```")).toEqual({ title: "灵草", content: "正文。" });
    expect(parseChapterDraftText("以下是第2章：\n\n第2章 灵草\n\n正文。")).toEqual({ title: "灵草", content: "正文。" });
  });

  it("returns the whole text as prose when the draft has no heading", () => {
    expect(parseChapterDraftText("他推开门。\n\n门外下着雨。")).toEqual({ content: "他推开门。\n\n门外下着雨。" });
    expect(parseChapterDraftText("   ")).toEqual({ content: "" });
  });
});
