import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialWorkManifestWrite } from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";
import { chapterBodyToHtml, chapterDisplayName } from "../api/legado.js";

const LAN = "http://192.168.1.8:4569";

async function writeLongformBook(root: string, id: string, title: string): Promise<void> {
  const initial = createInitialWorkManifestWrite({
    workId: id,
    title,
    profileId: "longform-novel",
    language: "zh",
    writes: [],
  });
  const source = join(root, "works", id, "source");
  await mkdir(join(source, "chapters"), { recursive: true });
  await writeFile(join(root, initial.write.relativePath), initial.write.content);
  await writeFile(join(source, "book.json"), JSON.stringify({
    id,
    title,
    platform: "local",
    genre: "xuanhuan",
    status: "active",
    targetChapters: 3,
    chapterWordCount: 500,
    language: "zh",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
  }));
  await writeFile(join(source, "chapters", "index.json"), JSON.stringify([{
    number: 1,
    title: "雨夜",
    wordCount: 8,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    observations: [],
    provenance: "generated",
  }]));
  await writeFile(join(source, "chapters", "0001_雨夜.md"), "# 第1章 雨夜\n\n雨水落在旧码头。\n");
}

describe("Legado LAN endpoints", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-legado-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "legado-project",
      version: "2.0.0",
      language: "zh",
      llm: { model: "test-model", provider: "openai" },
      notify: [],
    }));
    await writeLongformBook(root, "rain-dock", "旧码头");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves an importable book source and chapter catalog on the LAN", async () => {
    const app = createStudioServer({} as never, root, { hostname: "0.0.0.0" });
    const sourceRes = await app.request(`${LAN}/api/v1/legado.json`);
    const sources = await sourceRes.json() as Array<{
      bookSourceUrl: string;
      searchUrl: string;
      exploreUrl: string;
      ruleToc: { chapterUrl: string };
    }>;
    const booksRes = await app.request(`${LAN}/api/v1/legado/books`);
    const books = await booksRes.json() as { books: Array<{ name: string; bookUrl: string }> };
    const detailRes = await app.request(books.books[0]!.bookUrl);
    const detail = await detailRes.json() as { name: string; chapters: Array<{ name: string; url: string }> };
    const chapterRes = await app.request(detail.chapters[0]!.url);
    const chapter = await chapterRes.json() as { content: string };

    expect({
      sourceStatus: sourceRes.status,
      sourceUrl: sources[0]?.bookSourceUrl,
      searchUsesCatalog: sources[0]?.searchUrl.includes("/api/v1/legado/books"),
      books: books.books.map((book) => book.name),
      chapterName: detail.chapters[0]?.name,
      chapterHtml: chapter.content,
      publicDnsBlocked: (await app.request("http://untrusted.example/api/v1/legado.json")).status,
    }).toEqual({
      sourceStatus: 200,
      sourceUrl: LAN,
      searchUsesCatalog: true,
      books: ["旧码头"],
      chapterName: "第1章 雨夜",
      chapterHtml: "<p>雨水落在旧码头。</p>",
      publicDnsBlocked: 403,
    });
  });

  it("keeps loopback Studio from answering LAN book-source imports", async () => {
    const app = createStudioServer({} as never, root);
    expect((await app.request(`${LAN}/api/v1/legado.json`)).status).toBe(403);
  });

  it("formats chapter titles and strips markdown headings from reader HTML", () => {
    expect(chapterDisplayName(1, "雨夜", "zh")).toBe("第1章 雨夜");
    expect(chapterBodyToHtml("# 第1章 雨夜\n\n雨水落在旧码头。\n")).toBe("<p>雨水落在旧码头。</p>");
  });
});
