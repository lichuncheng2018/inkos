import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { chapterDocumentBody } from "../utils/chapter-document.js";
import {
  buildCloudLegadoBookSourceFile,
  buildLegadoBookFile,
  buildLegadoCatalogFile,
  buildLegadoChapterFile,
  phoneLegadoBookUrl,
  phoneLegadoChapterUrl,
  phoneLegadoSourceUrl,
  type LegadoBookCard,
} from "./phone-legado.js";
import { buildPhoneReaderHtml, phoneReaderPublicUrl } from "./phone-reader-html.js";
import { loadPhoneSyncConfig, type PhoneSyncConfig } from "./phone-sync-config.js";

export interface PhoneSyncState {
  readonly bookDir: (bookId: string) => string;
  readonly loadBookConfig: (bookId: string) => Promise<{
    readonly id: string;
    readonly title: string;
    readonly genre?: string;
    readonly language?: string;
  }>;
  readonly loadChapterIndex: (bookId: string) => Promise<ReadonlyArray<{
    readonly number: number;
    readonly title?: string;
    readonly wordCount: number;
  }>>;
}

export interface PhoneSyncResult {
  readonly ok: boolean;
  readonly configured: boolean;
  readonly chaptersSynced: number;
  readonly readerUrl?: string;
  readonly legadoUrl?: string;
  readonly error?: string;
}

function displayChapterTitle(number: number, title: string, language: "zh" | "en"): string {
  const trimmed = title.trim();
  if (language === "en") {
    return /^Chapter\s+\d+/i.test(trimmed) ? trimmed : `Chapter ${number}: ${trimmed || "Untitled"}`;
  }
  return /^第\d+章/u.test(trimmed) ? trimmed : `第${number}章 ${trimmed || "正文"}`;
}

async function supabaseRequest(
  config: PhoneSyncConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("apikey", config.serviceRoleKey);
  headers.set("Authorization", `Bearer ${config.serviceRoleKey}`);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  return fetch(`${config.url}${path}`, { ...init, headers });
}

function networkErrorMessage(error: unknown): string {
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: { code?: string; message?: string } }).cause
    : undefined;
  const code = cause?.code ?? (error instanceof Error ? error.message : String(error));
  if (String(code).includes("ECONNRESET") || String(code).includes("fetch failed")) {
    return "这台电脑连不上 *.supabase.co（连接被重置）。家里手机先打开阅读链接试一下；公司网若一直被拦，需要给这个项目加国内能访问的自定义域名。";
  }
  return error instanceof Error ? error.message : String(error);
}

async function loadBookChapters(state: PhoneSyncState, bookId: string): Promise<{
  readonly book: {
    readonly id: string;
    readonly title: string;
    readonly genre?: string;
    readonly language: "zh" | "en";
  };
  readonly chapters: ReadonlyArray<{
    readonly book_id: string;
    readonly chapter_no: number;
    readonly title: string;
    readonly content: string;
    readonly word_count: number;
  }>;
}> {
  const book = await state.loadBookConfig(bookId);
  const language = book.language === "en" ? "en" : "zh";
  const index = await state.loadChapterIndex(bookId);
  const chaptersDir = join(state.bookDir(bookId), "chapters");
  const files = await readdir(chaptersDir).catch(() => [] as string[]);
  const chapters = [];
  for (const chapter of index) {
    const padded = String(chapter.number).padStart(4, "0");
    const file = files.find((name) => name.startsWith(`${padded}_`) && name.endsWith(".md"));
    if (!file) continue;
    const raw = await readFile(join(chaptersDir, file), "utf-8");
    const title = chapter.title?.trim() || "";
    chapters.push({
      book_id: bookId,
      chapter_no: chapter.number,
      title: displayChapterTitle(chapter.number, title, language),
      content: chapterDocumentBody(raw, chapter.number, title, language).trim(),
      word_count: chapter.wordCount,
    });
  }
  return {
    book: { id: bookId, title: book.title, genre: book.genre, language },
    chapters,
  };
}

export async function ensurePhoneReaderHost(config: PhoneSyncConfig): Promise<void> {
  const bucket = await supabaseRequest(config, "/storage/v1/bucket/inkos-reader");
  if (bucket.status === 400 || bucket.status === 404) {
    const created = await supabaseRequest(config, "/storage/v1/bucket", {
      method: "POST",
      body: JSON.stringify({ id: "inkos-reader", name: "inkos-reader", public: true }),
    });
    if (!created.ok && created.status !== 409) {
      throw new Error(`Unable to create storage bucket (${created.status}).`);
    }
  } else if (!bucket.ok) {
    throw new Error(`Unable to read storage bucket (${bucket.status}).`);
  }

  await uploadPublicObject(
    config,
    "inkos-reader/index.html",
    buildPhoneReaderHtml({
      supabaseUrl: config.url,
      publishableKey: config.publishableKey,
    }),
    "text/html; charset=utf-8",
  );
  await uploadPublicObject(
    config,
    "inkos-reader/legado.json",
    buildCloudLegadoBookSourceFile({ supabaseUrl: config.url }),
    "text/plain; charset=utf-8",
  );
}

async function publishLegadoCatalog(
  config: PhoneSyncConfig,
  book: {
    readonly id: string;
    readonly title: string;
    readonly genre?: string;
    readonly language: "zh" | "en";
  },
  chapters: ReadonlyArray<{
    readonly chapter_no: number;
    readonly title: string;
    readonly content: string;
  }>,
): Promise<void> {
  const language = book.language;
  const last = chapters.at(-1);
  const card: LegadoBookCard = {
    name: book.title,
    author: "InkOS",
    kind: book.genre ?? "",
    intro: book.title,
    wordCount: language === "en" ? `${chapters.length} ch` : `${chapters.length}章`,
    lastChapter: last?.title ?? "",
    bookUrl: phoneLegadoBookUrl(config.url, book.id),
  };
  const existing = await supabaseRequest(config, "/storage/v1/object/public/inkos-reader/legado/books.json");
  let books: LegadoBookCard[] = [card];
  if (existing.ok) {
    try {
      const parsed = JSON.parse(await existing.text()) as { books?: LegadoBookCard[] };
      const previous = parsed.books?.filter((item) => item.bookUrl !== card.bookUrl) ?? [];
      books = [...previous, card];
    } catch {
      books = [card];
    }
  }
  await uploadPublicObject(
    config,
    "inkos-reader/legado/books.json",
    buildLegadoCatalogFile(books),
    "application/json; charset=utf-8",
  );
  await uploadPublicObject(
    config,
    `inkos-reader/legado/books/${book.id}.json`,
    buildLegadoBookFile({
      ...card,
      chapters: chapters.map((chapter) => ({
        name: chapter.title,
        url: phoneLegadoChapterUrl(config.url, book.id, chapter.chapter_no),
      })),
    }),
    "application/json; charset=utf-8",
  );
  for (const chapter of chapters) {
    await uploadPublicObject(
      config,
      `inkos-reader/legado/books/${book.id}/${chapter.chapter_no}.json`,
      buildLegadoChapterFile(chapter.content),
      "application/json; charset=utf-8",
    );
  }
}

async function uploadPublicObject(
  config: PhoneSyncConfig,
  path: string,
  body: string,
  contentType: string,
): Promise<void> {
  if (!body) {
    throw new Error(`Refusing to upload empty storage object: ${path}`);
  }
  const headers = {
    "Content-Type": contentType,
    "cache-control": "no-cache",
    "x-upsert": "true",
  };
  const objectPath = `/storage/v1/object/${path}`;
  const uploaded = await supabaseRequest(config, objectPath, {
    method: "POST",
    headers,
    body,
  });
  if (uploaded.ok) return;
  const retry = await supabaseRequest(config, objectPath, {
    method: "PUT",
    headers,
    body,
  });
  if (!retry.ok) {
    throw new Error(`Unable to upload ${path} (POST ${uploaded.status}, PUT ${retry.status}).`);
  }
}

export async function syncBookToSupabase(input: {
  readonly projectRoot: string;
  readonly state: PhoneSyncState;
  readonly bookId: string;
}): Promise<PhoneSyncResult> {
  const config = await loadPhoneSyncConfig(input.projectRoot);
  if (!config) {
    return { ok: false, configured: false, chaptersSynced: 0, error: "Supabase is not configured." };
  }
  const publicUrls = {
    readerUrl: phoneReaderPublicUrl(config.url, input.bookId),
    legadoUrl: phoneLegadoSourceUrl(config.url),
  };
  try {
    const { book, chapters } = await loadBookChapters(input.state, input.bookId);
    const bookRes = await supabaseRequest(
      config,
      "/rest/v1/inkos_books?on_conflict=id",
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          id: book.id,
          title: book.title,
          genre: book.genre ?? null,
          language: book.language,
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!bookRes.ok) {
      const body = await bookRes.text();
      if (bookRes.status === 404 || body.includes("schema cache") || body.includes("inkos_books")) {
        return {
          ok: false,
          configured: true,
          chaptersSynced: 0,
          error: "需要先在 Supabase SQL 编辑器执行 supabase/phone-reader.sql。",
          ...publicUrls,
        };
      }
      throw new Error(`Book upsert failed (${bookRes.status}): ${body.slice(0, 240)}`);
    }

    if (chapters.length > 0) {
      const chapterRes = await supabaseRequest(
        config,
        "/rest/v1/inkos_chapters?on_conflict=book_id,chapter_no",
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(chapters.map((chapter) => ({
            ...chapter,
            updated_at: new Date().toISOString(),
          }))),
        },
      );
      if (!chapterRes.ok) {
        throw new Error(`Chapter upsert failed (${chapterRes.status}): ${(await chapterRes.text()).slice(0, 240)}`);
      }
    }

    await ensurePhoneReaderHost(config);
    await publishLegadoCatalog(config, book, chapters);
    return {
      ok: true,
      configured: true,
      chaptersSynced: chapters.length,
      ...publicUrls,
    };
  } catch (error) {
    return {
      ok: false,
      configured: true,
      chaptersSynced: 0,
      ...publicUrls,
      error: networkErrorMessage(error),
    };
  }
}

export function queuePhoneSync(input: {
  readonly projectRoot: string;
  readonly state: PhoneSyncState;
  readonly bookId: string;
  readonly logWarn?: (message: string) => void;
}): void {
  void syncBookToSupabase(input).then((result) => {
    if (!result.ok) input.logWarn?.(`phone-sync: ${result.error ?? "failed"}`);
  });
}
