import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { phoneBookStorageKey } from "../publish/phone-legado.js";
import {
  disablePhoneSync,
  enablePhoneSync,
  queuePhoneSync,
  readPhoneSyncStatus,
  waitForPhoneSyncIdle,
  type PhoneSyncState,
} from "../publish/phone-sync.js";

const SUPABASE_KEY_PATTERN = /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/;

class FakeStorage {
  readonly objects = new Map<string, string>();
  requests: string[] = [];
  bucket = false;
  failWhen: ((key: string) => boolean) | null = null;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = decodeURIComponent(url.pathname);
    const objectPrefix = "/storage/v1/object/inkos-reader/";
    const key = path.startsWith(objectPrefix) ? path.slice(objectPrefix.length) : "";
    if (key && this.failWhen?.(key)) {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }
    this.requests.push(`${method} ${key || path}`);

    if (path === "/storage/v1/bucket/inkos-reader") {
      return this.bucket ? json(200, { id: "inkos-reader" }) : json(400, { error: "Bucket not found" });
    }
    if (path === "/storage/v1/bucket" && method === "POST") {
      this.bucket = true;
      return json(200, { name: "inkos-reader" });
    }
    if (path === "/storage/v1/object/list/inkos-reader") {
      const { prefix } = JSON.parse(String(init?.body)) as { prefix: string };
      const names = [...this.objects.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length))
        .filter((name) => !name.includes("/"));
      return json(200, names.map((name) => ({ name })));
    }
    if (path === "/storage/v1/object/inkos-reader" && method === "DELETE") {
      const { prefixes } = JSON.parse(String(init?.body)) as { prefixes: string[] };
      for (const name of prefixes) this.objects.delete(name);
      return json(200, []);
    }
    if (key && (method === "POST" || method === "PUT")) {
      if (!this.bucket) return json(400, { error: "Bucket not found" });
      if (!SUPABASE_KEY_PATTERN.test(key)) return json(400, { error: "InvalidKey", message: `Invalid key: ${key}` });
      this.objects.set(key, String(init?.body));
      return json(200, { Key: `inkos-reader/${key}` });
    }
    return json(404, { error: "not handled" });
  };

  read<T>(key: string): T {
    return JSON.parse(this.objects.get(key) ?? "null") as T;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface ChapterSeed {
  readonly number: number;
  readonly title: string;
  readonly body: string;
}

async function writeBook(root: string, bookId: string, title: string, chapters: readonly ChapterSeed[]): Promise<void> {
  const source = join(root, "works", bookId, "source");
  await rm(join(source, "chapters"), { recursive: true, force: true });
  await mkdir(join(source, "chapters"), { recursive: true });
  await writeFile(join(source, "book.json"), JSON.stringify({ id: bookId, title, genre: "xianxia", language: "zh" }));
  await writeFile(join(source, "chapters", "index.json"), JSON.stringify(chapters.map((chapter) => ({
    number: chapter.number,
    title: chapter.title,
    wordCount: chapter.body.length,
  }))));
  for (const chapter of chapters) {
    const file = `${String(chapter.number).padStart(4, "0")}_${chapter.title}.md`;
    await writeFile(join(source, "chapters", file), `# 第${chapter.number}章 ${chapter.title}\n\n${chapter.body}\n`);
  }
}

function fileState(root: string): PhoneSyncState {
  const source = (bookId: string) => join(root, "works", bookId, "source");
  return {
    bookDir: source,
    loadBookConfig: async (bookId) => JSON.parse(await readFile(join(source(bookId), "book.json"), "utf-8")),
    loadChapterIndex: async (bookId) => JSON.parse(await readFile(join(source(bookId), "chapters", "index.json"), "utf-8")),
  };
}

const BOOK_ID = "测试导入";
const KEY = phoneBookStorageKey(BOOK_ID);
const TWO_CHAPTERS: readonly ChapterSeed[] = [
  { number: 1, title: "雨夜", body: "雨水落在旧码头。" },
  { number: 2, title: "旧港", body: "潮声一直没停。" },
];

describe("phone sync", () => {
  const savedEnv = {
    url: process.env.INKOS_SUPABASE_URL,
    publishable: process.env.INKOS_SUPABASE_PUBLISHABLE_KEY,
    service: process.env.INKOS_SUPABASE_SERVICE_ROLE_KEY,
  };
  let root: string;
  let state: PhoneSyncState;
  let storage: FakeStorage;

  const push = async () => {
    queuePhoneSync({ projectRoot: root, state, bookId: BOOK_ID, delayMs: 0 });
    await waitForPhoneSyncIdle(root);
  };

  const enableAndWait = async () => {
    await enablePhoneSync({ projectRoot: root, state, bookId: BOOK_ID });
    await waitForPhoneSyncIdle(root);
  };

  beforeEach(async () => {
    delete process.env.INKOS_SUPABASE_URL;
    delete process.env.INKOS_SUPABASE_PUBLISHABLE_KEY;
    delete process.env.INKOS_SUPABASE_SERVICE_ROLE_KEY;
    root = await mkdtemp(join(tmpdir(), "inkos-phone-sync-"));
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, ".inkos", "supabase.json"), JSON.stringify({
      url: "https://example.supabase.co",
      publishableKey: "pub",
      serviceRoleKey: "srv",
    }));
    await writeBook(root, BOOK_ID, "测试导入", TWO_CHAPTERS);
    state = fileState(root);
    storage = new FakeStorage();
    vi.stubGlobal("fetch", storage.fetch);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
    restoreEnv("INKOS_SUPABASE_URL", savedEnv.url);
    restoreEnv("INKOS_SUPABASE_PUBLISHABLE_KEY", savedEnv.publishable);
    restoreEnv("INKOS_SUPABASE_SERVICE_ROLE_KEY", savedEnv.service);
  });

  it("leaves books alone until phone reading is turned on", async () => {
    await push();
    expect(storage.requests).toEqual([]);
    expect(await readPhoneSyncStatus({ projectRoot: root, bookId: BOOK_ID })).toEqual({
      configured: true,
      enabled: false,
      phase: "off",
      legadoUrl: "https://example.supabase.co/storage/v1/object/public/inkos-reader/legado.json",
      chaptersSynced: 0,
    });
  });

  it("turning phone reading on pushes the book source, chapters, contents and bookshelf", async () => {
    const started = await enablePhoneSync({ projectRoot: root, state, bookId: BOOK_ID });
    expect(started).toMatchObject({ configured: true, enabled: true });
    await waitForPhoneSyncIdle(root);

    expect([...storage.objects.keys()].sort()).toEqual([
      "legado.json",
      "legado/books.json",
      `legado/books/${KEY}.json`,
      `legado/books/${KEY}/1.json`,
      `legado/books/${KEY}/2.json`,
    ]);
    expect(storage.read(`legado/books/${KEY}/2.json`)).toEqual({ content: "潮声一直没停。" });
    const toc = storage.read<{ chapters: Array<{ name: string; url: string }> }>(`legado/books/${KEY}.json`);
    expect(toc.chapters.map((chapter) => chapter.name)).toEqual(["第1章 雨夜", "第2章 旧港"]);
    expect(toc.chapters[0]!.url).toBe(
      `https://example.supabase.co/storage/v1/object/public/inkos-reader/legado/books/${KEY}/1.json`,
    );
    const shelf = storage.read<{ books: Array<{ name: string; lastChapter: string }> }>("legado/books.json");
    expect(shelf.books).toEqual([expect.objectContaining({ name: "测试导入", lastChapter: "第2章 旧港" })]);
    expect(await readPhoneSyncStatus({ projectRoot: root, bookId: BOOK_ID })).toMatchObject({
      enabled: true,
      phase: "synced",
      chaptersSynced: 2,
      lastChanged: 2,
    });
  });

  it("pushes only what changed after that", async () => {
    await enableAndWait();

    storage.requests = [];
    await writeBook(root, BOOK_ID, "测试导入", [TWO_CHAPTERS[0]!, { ...TWO_CHAPTERS[1]!, body: "潮声停了。" }]);
    await push();
    expect(storage.requests).toEqual([`POST legado/books/${KEY}/2.json`]);
    expect(storage.read(`legado/books/${KEY}/2.json`)).toEqual({ content: "潮声停了。" });

    storage.requests = [];
    const three = [TWO_CHAPTERS[0]!, { ...TWO_CHAPTERS[1]!, body: "潮声停了。" }, { number: 3, title: "离港", body: "船走了。" }];
    await writeBook(root, BOOK_ID, "测试导入", three);
    await push();
    expect(storage.requests).toEqual([
      `POST legado/books/${KEY}/3.json`,
      `POST legado/books/${KEY}.json`,
      "POST legado/books.json",
    ]);

    storage.requests = [];
    await writeBook(root, BOOK_ID, "测试导入", three.slice(1));
    await push();
    expect(storage.requests).toEqual([
      `POST legado/books/${KEY}.json`,
      "DELETE /storage/v1/object/inkos-reader",
      "POST legado/books.json",
    ]);
    expect(storage.objects.has(`legado/books/${KEY}/1.json`)).toBe(false);
    expect(await readPhoneSyncStatus({ projectRoot: root, bookId: BOOK_ID })).toMatchObject({
      phase: "synced",
      chaptersSynced: 2,
      lastChanged: 1,
    });

    storage.requests = [];
    await push();
    expect(storage.requests).toEqual([]);
  });

  it("keeps finished uploads when the network drops and catches up afterwards", async () => {
    storage.failWhen = (key) => key.endsWith("/2.json");
    await enableAndWait();

    const failed = await readPhoneSyncStatus({ projectRoot: root, bookId: BOOK_ID });
    expect(failed.phase).toBe("error");
    expect(failed.error).toContain("ECONNRESET");
    expect(failed.retryAt).toBeDefined();
    expect(storage.objects.has(`legado/books/${KEY}/1.json`)).toBe(true);

    storage.failWhen = null;
    storage.requests = [];
    await push();
    expect(storage.requests).toEqual([
      `POST legado/books/${KEY}/2.json`,
      `POST legado/books/${KEY}.json`,
      "POST legado/books.json",
    ]);
    const recovered = await readPhoneSyncStatus({ projectRoot: root, bookId: BOOK_ID });
    expect(recovered).toMatchObject({ phase: "synced", chaptersSynced: 2 });
    expect(recovered.error).toBeUndefined();
  });

  it("a manual push also clears chapter files the record does not know about", async () => {
    await enableAndWait();
    storage.objects.set(`legado/books/${KEY}/9.json`, JSON.stringify({ content: "旧稿" }));

    await enableAndWait();
    expect(storage.objects.has(`legado/books/${KEY}/9.json`)).toBe(false);
    expect(storage.objects.has(`legado/books/${KEY}/2.json`)).toBe(true);
  });

  it("turning phone reading off removes the book from the cloud and the bookshelf", async () => {
    await enableAndWait();

    await disablePhoneSync({ projectRoot: root, state, bookId: BOOK_ID });
    await waitForPhoneSyncIdle(root);
    expect([...storage.objects.keys()].sort()).toEqual(["legado.json", "legado/books.json"]);
    expect(storage.read("legado/books.json")).toEqual({ books: [] });
    expect(await readPhoneSyncStatus({ projectRoot: root, bookId: BOOK_ID })).toMatchObject({ enabled: false, phase: "off" });

    storage.requests = [];
    await push();
    expect(storage.requests).toEqual([]);
  });

  it("removes a deleted book from the cloud on the next push", async () => {
    await enableAndWait();

    await rm(join(root, "works", BOOK_ID), { recursive: true, force: true });
    await push();
    expect([...storage.objects.keys()].sort()).toEqual(["legado.json", "legado/books.json"]);
    expect(await readPhoneSyncStatus({ projectRoot: root, bookId: BOOK_ID })).toMatchObject({ enabled: false, phase: "off" });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
