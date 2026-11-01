import { describe, expect, it } from "vitest";
import { chaptersNewestFirst } from "./chapter-list";

describe("chaptersNewestFirst", () => {
  it("returns later chapters first without mutating the source", () => {
    const chapters = [{ number: 1 }, { number: 2 }, { number: 3 }];
    expect(chaptersNewestFirst(chapters).map((chapter) => chapter.number)).toEqual([3, 2, 1]);
    expect(chapters.map((chapter) => chapter.number)).toEqual([1, 2, 3]);
  });
});
