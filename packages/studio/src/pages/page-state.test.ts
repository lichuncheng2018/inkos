import { describe, expect, it } from "vitest";
import {
  buildBookCreatePayload,
  defaultBookCreateForm,
  isBookCreateFormReady,
  waitForBookReady,
} from "./BookCreate";

describe("book creation miniflow", () => {
  it("preserves explicit Work metadata in the typed create payload", () => {
    const form = {
      ...defaultBookCreateForm("en"),
      title: " Night Harbor ",
      genre: { category: "Mystery", detail: " maritime " },
      targetChapters: "120",
      chapterWordCount: "2000",
      brief: " A harbor clerk follows a falsified cold-chain ledger. ",
    };
    expect(isBookCreateFormReady(form)).toBe(true);
    expect(buildBookCreatePayload(form, "en")).toEqual({
      title: "Night Harbor",
      genre: "Mystery/maritime",
      language: "en",
      targetChapters: 120,
      chapterWordCount: 2000,
      blurb: "A harbor clerk follows a falsified cold-chain ledger.",
    });
  });

  it("waits for a genre category before the form can be submitted", () => {
    const form = {
      ...defaultBookCreateForm("zh"),
      title: "宗门",
      genre: { category: "", detail: "宗门 加点" },
      brief: "简介",
    };
    expect(isBookCreateFormReady(form)).toBe(false);
    expect(isBookCreateFormReady({ ...form, genre: { category: "玄幻", detail: "宗门 加点" } })).toBe(true);
  });

  it("waits for the real Work artifact instead of treating task start as completion", async () => {
    let attempts = 0;
    await expect(waitForBookReady("fresh-book", {
      fetchBook: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("Book not found");
      },
      fetchStatus: async () => ({ status: "creating" }),
      delayMs: 0,
      waitImpl: async () => undefined,
    })).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  it("surfaces the host creation error", async () => {
    await expect(waitForBookReady("broken-book", {
      fetchBook: async () => { throw new Error("Book not found"); },
      fetchStatus: async () => ({ status: "error", error: "foundation artifact was not persisted" }),
      delayMs: 0,
      waitImpl: async () => undefined,
    })).rejects.toThrow("foundation artifact was not persisted");
  });
});
