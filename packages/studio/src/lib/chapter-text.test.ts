import { describe, expect, it } from "vitest";
import { chapterTextForPublish } from "./chapter-text";

describe("chapterTextForPublish", () => {
  it("strips the markdown heading marker so the chapter can be pasted for publishing", () => {
    expect(chapterTextForPublish("# 第16章 山河演武场\n\n午后的山河演武场没有旁观者。\n")).toBe(
      "第16章 山河演武场\n\n午后的山河演武场没有旁观者。",
    );
  });

  it("keeps chapters that already start without a markdown heading", () => {
    expect(chapterTextForPublish("第1章 内门较量\n\n顾长渊走进演武场。")).toBe(
      "第1章 内门较量\n\n顾长渊走进演武场。",
    );
  });

  it("returns an empty string for blank content", () => {
    expect(chapterTextForPublish("  \n")).toBe("");
  });
});
