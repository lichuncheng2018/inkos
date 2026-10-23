import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import type { StateManager } from "@actalk/inkos-core";
import { ApiError } from "./errors.js";
import { isSafeBookId } from "./safety.js";
import {
  listLanIpv4Addresses,
  publicOriginFromRequest,
  resolveLegadoOrigin,
} from "./studio-host.js";

interface LegadoBookCard {
  readonly name: string;
  readonly author: string;
  readonly kind: string;
  readonly intro: string;
  readonly wordCount: string;
  readonly lastChapter: string;
  readonly bookUrl: string;
}

interface LegadoChapterCard {
  readonly name: string;
  readonly url: string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function chapterPlainBody(content: string): string {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  let cursor = 0;
  while (cursor < lines.length && !lines[cursor]!.trim()) cursor += 1;
  const heading = lines[cursor]?.trim() ?? "";
  if (/^#\s+(第\d+章|Chapter\s+\d+)/u.test(heading)) {
    cursor += 1;
    while (cursor < lines.length && !lines[cursor]!.trim()) cursor += 1;
  }
  return lines.slice(cursor).join("\n").trim();
}

export function chapterBodyToHtml(content: string): string {
  const body = chapterPlainBody(content);
  if (!body) return "<p></p>";
  return body
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
}

export function chapterDisplayName(number: number, title: string, language: "zh" | "en"): string {
  const trimmed = title.trim();
  if (language === "en") {
    return /^Chapter\s+\d+/i.test(trimmed) ? trimmed : `Chapter ${number}: ${trimmed || "Untitled"}`;
  }
  return /^第\d+章/u.test(trimmed) ? trimmed : `第${number}章 ${trimmed || "正文"}`;
}

function findChapterFile(files: readonly string[], chapterNumber: number): string | undefined {
  return files.find((file) => {
    const match = /^(\d+)_.*\.md$/u.exec(file);
    return match ? Number(match[1]) === chapterNumber : false;
  });
}

export function buildLegadoBookSource(origin: string): Record<string, unknown> {
  const base = origin.replace(/\/+$/u, "");
  const catalog = `${base}/api/v1/legado/books`;
  return {
    bookSourceName: "InkOS",
    bookSourceUrl: base,
    bookSourceGroup: "InkOS",
    bookSourceType: 0,
    bookSourceComment: "同一 WiFi 下阅读 InkOS 作品。Studio 关闭后只能看已缓存章节。",
    enabled: true,
    enabledExplore: true,
    exploreUrl: `作品::${catalog}`,
    searchUrl: `${catalog}?key={{key}}`,
    ruleExplore: {
      bookList: "$.books[*]",
      name: "$.name",
      author: "$.author",
      kind: "$.kind",
      intro: "$.intro",
      wordCount: "$.wordCount",
      lastChapter: "$.lastChapter",
      bookUrl: "$.bookUrl",
    },
    ruleSearch: {
      bookList: "$.books[*]",
      name: "$.name",
      author: "$.author",
      kind: "$.kind",
      intro: "$.intro",
      wordCount: "$.wordCount",
      lastChapter: "$.lastChapter",
      bookUrl: "$.bookUrl",
    },
    ruleBookInfo: {
      name: "$.name",
      author: "$.author",
      kind: "$.kind",
      intro: "$.intro",
      wordCount: "$.wordCount",
      lastChapter: "$.lastChapter",
    },
    ruleToc: {
      chapterList: "$.chapters[*]",
      chapterName: "$.name",
      chapterUrl: "$.url",
    },
    ruleContent: {
      content: "$.content",
    },
  };
}

async function loadBookCards(state: StateManager, origin: string, key = ""): Promise<LegadoBookCard[]> {
  const needle = key.trim().toLowerCase();
  const bookIds = await state.listBooks();
  const cards: LegadoBookCard[] = [];
  for (const bookId of bookIds) {
    try {
      const book = await state.loadBookConfig(bookId);
      if (needle && !book.title.toLowerCase().includes(needle) && !book.id.toLowerCase().includes(needle)) {
        continue;
      }
      const chapters = await state.loadChapterIndex(bookId).catch(() => []);
      const last = chapters.at(-1);
      const language = book.language === "en" ? "en" : "zh";
      cards.push({
        name: book.title,
        author: "InkOS",
        kind: book.genre,
        intro: book.status,
        wordCount: language === "en" ? `${chapters.length} ch` : `${chapters.length}章`,
        lastChapter: last ? chapterDisplayName(last.number, last.title, language) : "",
        bookUrl: `${origin}/api/v1/legado/books/${encodeURIComponent(book.id)}`,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return cards;
}

function requestOrigin(c: { req: { url: string; header: (name: string) => string | undefined } }): string {
  return resolveLegadoOrigin(
    publicOriginFromRequest(c.req.url, c.req.header("host")),
    listLanIpv4Addresses(),
  );
}

export function registerLegadoRoutes(app: Hono, state: StateManager): void {
  app.use("/api/v1/legado/books/:id/*", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });
  app.use("/api/v1/legado/books/:id", async (c, next) => {
    const bookId = c.req.param("id");
    if (!isSafeBookId(bookId)) {
      throw new ApiError(400, "INVALID_BOOK_ID", `Invalid book ID: "${bookId}"`);
    }
    await next();
  });

  app.get("/api/v1/legado.json", (c) => {
    const origin = requestOrigin(c);
    return c.json([buildLegadoBookSource(origin)]);
  });

  app.get("/api/v1/legado/books", async (c) => {
    const origin = requestOrigin(c);
    const books = await loadBookCards(state, origin, c.req.query("key") ?? "");
    return c.json({ books });
  });

  app.get("/api/v1/legado/books/:id/chapters/:num", async (c) => {
    const id = c.req.param("id");
    const num = Number.parseInt(c.req.param("num"), 10);
    if (!Number.isInteger(num) || num < 1) {
      return c.json({ error: "Invalid chapter number" }, 400);
    }
    const chaptersDir = join(state.bookDir(id), "chapters");
    try {
      const files = await readdir(chaptersDir);
      const match = findChapterFile(files, num);
      if (!match) return c.json({ error: "Chapter not found" }, 404);
      const raw = await readFile(join(chaptersDir, match), "utf-8");
      return c.json({ content: chapterBodyToHtml(raw) });
    } catch {
      return c.json({ error: "Chapter not found" }, 404);
    }
  });

  app.get("/api/v1/legado/books/:id", async (c) => {
    const id = c.req.param("id");
    const origin = requestOrigin(c);
    try {
      const book = await state.loadBookConfig(id);
      const chapters = await state.loadChapterIndex(id).catch(() => []);
      const language = book.language === "en" ? "en" : "zh";
      const last = chapters.at(-1);
      const toc: LegadoChapterCard[] = chapters.map((chapter) => ({
        name: chapterDisplayName(chapter.number, chapter.title, language),
        url: `${origin}/api/v1/legado/books/${encodeURIComponent(book.id)}/chapters/${chapter.number}`,
      }));
      return c.json({
        name: book.title,
        author: "InkOS",
        kind: book.genre,
        intro: book.status,
        wordCount: language === "en" ? `${chapters.length} ch` : `${chapters.length}章`,
        lastChapter: last ? chapterDisplayName(last.number, last.title, language) : "",
        chapters: toc,
      });
    } catch {
      return c.json({ error: `Book "${id}" not found` }, 404);
    }
  });
}
