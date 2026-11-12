import { describe, expect, it } from "vitest";
import { genreCategoriesForLanguage, joinGenre, splitGenre } from "./genre";

const zh = genreCategoriesForLanguage("zh");

describe("genre category and detail", () => {
  it("joins a category with the author's own words", () => {
    expect(joinGenre({ category: "玄幻", detail: " 宗门 加点 系统 " })).toBe("玄幻/宗门 加点 系统");
    expect(joinGenre({ category: "都市", detail: "" })).toBe("都市");
    expect(joinGenre({ category: "都市", detail: "/工业科技" })).toBe("都市/工业科技");
    expect(joinGenre({ category: "", detail: "宗门" })).toBe("");
  });

  it("splits a stored genre back into the category and the rest", () => {
    expect(splitGenre("玄幻/宗门 加点 系统", zh)).toEqual({ category: "玄幻", detail: "宗门 加点 系统" });
    expect(splitGenre("都市/工业科技/重生强国", zh)).toEqual({ category: "都市", detail: "工业科技/重生强国" });
    expect(splitGenre("都市高武/灵气复苏", zh)).toEqual({ category: "都市高武", detail: "灵气复苏" });
    expect(splitGenre("仙侠修真", zh)).toEqual({ category: "仙侠修真", detail: "" });
  });

  it("leaves a genre outside the categories for the author to place, and treats other as unset", () => {
    expect(splitGenre("传统玄幻/系统修仙", zh)).toEqual({ category: "", detail: "传统玄幻/系统修仙" });
    expect(splitGenre("other", zh)).toEqual({ category: "", detail: "" });
    expect(splitGenre(undefined, zh)).toEqual({ category: "", detail: "" });
  });
});
