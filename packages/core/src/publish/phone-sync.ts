import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chapterDocumentBody } from "../utils/chapter-document.js";
import {
  buildCloudLegadoBookSourceFile,
  buildLegadoBookFile,
  buildLegadoCatalogFile,
  buildLegadoChapterFile,
  phoneBookStorageKey,
  phoneLegadoBookPath,
  phoneLegadoBookUrl,
  phoneLegadoChapterPath,
  phoneLegadoChapterUrl,
  phoneLegadoSourceUrl,
  type LegadoBookCard,
} from "./phone-legado.js";
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

export type PhoneSyncPhase = "off" | "pending" | "syncing" | "synced" | "error" | "removing";

export interface PhoneSyncStatus {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly phase: PhoneSyncPhase;
  readonly legadoUrl?: string;
  /** Chapters currently mirrored in the cloud. */
  readonly chaptersSynced: number;
  /** Chapters uploaded or removed by the last push that changed anything. */
  readonly lastChanged?: number;
  readonly lastSyncedAt?: string;
  readonly error?: string;
  readonly retryAt?: string;
}

interface PhoneSyncInput {
  readonly projectRoot: string;
  readonly state: PhoneSyncState;
  readonly bookId: string;
  readonly logWarn?: (message: string) => void;
}

const BUCKET = "inkos-reader";
const STATE_FILE = "phone-reader.json";
const SOURCE_PATH = "legado.json";
const CATALOG_PATH = "legado/books.json";
const JSON_TYPE = "application/json; charset=utf-8";
const DEBOUNCE_MS = 1_500;
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
const RESUME_INTERVAL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_CONCURRENCY = 4;
const DELETE_BATCH_SIZE = 500;
const LIST_PAGE_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Local record of what the cloud holds. Local chapters are the source of truth;
// each push uploads only what differs from this record.
// ---------------------------------------------------------------------------

interface PhoneBookRecord {
  readonly enabled: boolean;
  /** chapter number -> hash of the chapter file in the cloud */
  readonly chapters: Readonly<Record<string, string>>;
  readonly toc?: string;
  readonly card?: LegadoBookCard;
  readonly contentUpdatedAt?: string;
  readonly lastSyncedAt?: string;
  readonly lastChanged?: number;
  readonly error?: string;
}

interface PhoneSyncFile {
  readonly version: 1;
  /** Supabase URL the hashes below were uploaded to. */
  readonly target?: string;
  readonly source?: string;
  readonly catalog?: string;
  readonly books: Readonly<Record<string, PhoneBookRecord>>;
}

const fileWrites = new Map<string, Promise<unknown>>();

function stateFilePath(projectRoot: string): string {
  return join(projectRoot, ".inkos", STATE_FILE);
}

async function readSyncFile(projectRoot: string): Promise<PhoneSyncFile> {
  try {
    const parsed = JSON.parse(await readFile(stateFilePath(projectRoot), "utf-8")) as Partial<PhoneSyncFile> | null;
    if (parsed?.version === 1 && parsed.books && typeof parsed.books === "object") {
      const books: Record<string, PhoneBookRecord> = {};
      for (const [bookId, record] of Object.entries(parsed.books)) {
        if (!record || typeof record !== "object") continue;
        books[bookId] = { ...record, enabled: record.enabled === true, chapters: record.chapters ?? {} };
      }
      return { ...parsed, version: 1, books };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return { version: 1, books: {} };
}

async function writeSyncFile(projectRoot: string, file: PhoneSyncFile): Promise<void> {
  const path = stateFilePath(projectRoot);
  await mkdir(join(projectRoot, ".inkos"), { recursive: true });
  const tempPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function updateSyncFile(
  projectRoot: string,
  mutate: (file: PhoneSyncFile) => PhoneSyncFile,
): Promise<PhoneSyncFile> {
  const key = resolve(projectRoot);
  const run = (fileWrites.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const next = mutate(await readSyncFile(projectRoot));
      await writeSyncFile(projectRoot, next);
      return next;
    });
  fileWrites.set(key, run);
  return run;
}

function updateBookRecord(
  projectRoot: string,
  bookId: string,
  mutate: (record: PhoneBookRecord) => PhoneBookRecord,
): Promise<PhoneSyncFile> {
  return updateSyncFile(projectRoot, (file) => {
    const current = file.books[bookId];
    if (!current) return file;
    return { ...file, books: { ...file.books, [bookId]: mutate(current) } };
  });
}

/** A different Supabase project means nothing has been uploaded there yet. */
function retarget(file: PhoneSyncFile, url: string): PhoneSyncFile {
  if (file.target === url) return file;
  const books: Record<string, PhoneBookRecord> = {};
  for (const [bookId, record] of Object.entries(file.books)) {
    if (record.enabled) books[bookId] = { enabled: true, chapters: {} };
  }
  return { version: 1, target: url, books };
}

// ---------------------------------------------------------------------------
// Supabase Storage
// ---------------------------------------------------------------------------

interface StorageClient {
  ensureBucket(): Promise<void>;
  upload(path: string, body: string, contentType: string): Promise<void>;
  remove(paths: readonly string[]): Promise<void>;
  listChapterNumbers(bookId: string): Promise<number[]>;
}

interface StorageResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: string;
}

function createStorageClient(config: PhoneSyncConfig): StorageClient {
  // Bodies are always read so undici can hand the connection back to the pool.
  const request = async (path: string, init: RequestInit = {}): Promise<StorageResponse> => {
    const headers = new Headers(init.headers);
    headers.set("apikey", config.serviceRoleKey);
    headers.set("Authorization", `Bearer ${config.serviceRoleKey}`);
    if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
    const res = await fetch(`${config.url}${path}`, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };

  const isMissingBucket = (res: StorageResponse): boolean =>
    (res.status === 400 || res.status === 404) && /not\s*found/iu.test(res.text);

  return {
    async ensureBucket() {
      const bucket = await request(`/storage/v1/bucket/${BUCKET}`);
      if (bucket.ok) return;
      if (bucket.status !== 400 && bucket.status !== 404) {
        throw new Error(`Unable to read storage bucket (${bucket.status}).`);
      }
      const created = await request("/storage/v1/bucket", {
        method: "POST",
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
      });
      if (!created.ok && created.status !== 409) {
        throw new Error(`Unable to create storage bucket (${created.status}).`);
      }
    },

    async upload(path, body, contentType) {
      if (!body) throw new Error(`Refusing to upload empty storage object: ${path}`);
      const init = {
        headers: { "Content-Type": contentType, "cache-control": "no-cache", "x-upsert": "true" },
        body,
      };
      const objectPath = `/storage/v1/object/${BUCKET}/${path}`;
      const uploaded = await request(objectPath, { ...init, method: "POST" });
      if (uploaded.ok) return;
      const retry = await request(objectPath, { ...init, method: "PUT" });
      if (retry.ok) return;
      const detail = retry.text.slice(0, 160);
      throw new Error(`Unable to upload ${path} (POST ${uploaded.status}, PUT ${retry.status})${detail ? `: ${detail}` : "."}`);
    },

    async remove(paths) {
      for (let start = 0; start < paths.length; start += DELETE_BATCH_SIZE) {
        const res = await request(`/storage/v1/object/${BUCKET}`, {
          method: "DELETE",
          body: JSON.stringify({ prefixes: paths.slice(start, start + DELETE_BATCH_SIZE) }),
        });
        if (!res.ok && !isMissingBucket(res)) {
          throw new Error(`Unable to delete storage objects (${res.status}).`);
        }
      }
    },

    async listChapterNumbers(bookId) {
      const prefix = `legado/books/${phoneBookStorageKey(bookId)}/`;
      const numbers: number[] = [];
      for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
        const res = await request(`/storage/v1/object/list/${BUCKET}`, {
          method: "POST",
          body: JSON.stringify({ prefix, limit: LIST_PAGE_SIZE, offset }),
        });
        if (!res.ok) {
          if (isMissingBucket(res)) return numbers;
          throw new Error(`Unable to list storage objects (${res.status}).`);
        }
        const entries = JSON.parse(res.text) as Array<{ readonly name?: string }>;
        for (const entry of entries) {
          const match = /^(\d+)\.json$/u.exec(entry.name?.split("/").pop() ?? "");
          if (match) numbers.push(Number(match[1]));
        }
        if (entries.length < LIST_PAGE_SIZE) return numbers;
      }
    },
  };
}

function describeError(error: unknown): string {
  if ((error as { name?: unknown } | null)?.name === "TimeoutError") {
    return "连接 Supabase 超时，稍后会自动重试。";
  }
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: { code?: string } }).cause
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (cause?.code || message.includes("fetch failed")) {
    return `这台电脑连不上 *.supabase.co（${cause?.code ?? "fetch failed"}）。公司网络下需要开着代理，网络恢复后会自动补推。`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// Local snapshot
// ---------------------------------------------------------------------------

interface BookSnapshot {
  readonly card: LegadoBookCard;
  readonly chapters: ReadonlyArray<{ readonly number: number; readonly body: string; readonly hash: string }>;
  readonly manifest: Readonly<Record<string, string>>;
  readonly toc: { readonly body: string; readonly hash: string };
}

function digest(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 24);
}

function displayChapterTitle(number: number, title: string, language: "zh" | "en"): string {
  const trimmed = title.trim();
  if (language === "en") {
    return /^Chapter\s+\d+/i.test(trimmed) ? trimmed : `Chapter ${number}: ${trimmed || "Untitled"}`;
  }
  return /^第\d+章/u.test(trimmed) ? trimmed : `第${number}章 ${trimmed || "正文"}`;
}

async function loadBookSnapshot(state: PhoneSyncState, config: PhoneSyncConfig, bookId: string): Promise<BookSnapshot> {
  const book = await state.loadBookConfig(bookId);
  const language = book.language === "en" ? "en" : "zh";
  const index = [...await state.loadChapterIndex(bookId)].sort((a, b) => a.number - b.number);
  const chaptersDir = join(state.bookDir(bookId), "chapters");
  const files = await readdir(chaptersDir).catch(() => [] as string[]);
  const chapters: Array<{ number: number; title: string; content: string }> = [];
  for (const chapter of index) {
    const padded = String(chapter.number).padStart(4, "0");
    const file = files.find((name) => name.startsWith(`${padded}_`) && name.endsWith(".md"));
    if (!file) continue;
    const raw = await readFile(join(chaptersDir, file), "utf-8");
    const title = chapter.title?.trim() || "";
    chapters.push({
      number: chapter.number,
      title: displayChapterTitle(chapter.number, title, language),
      content: chapterDocumentBody(raw, chapter.number, title, language).trim(),
    });
  }

  const card: LegadoBookCard = {
    name: book.title,
    author: "InkOS",
    kind: book.genre ?? "",
    intro: book.title,
    wordCount: language === "en" ? `${chapters.length} ch` : `${chapters.length}章`,
    lastChapter: chapters.at(-1)?.title ?? "",
    bookUrl: phoneLegadoBookUrl(config.url, bookId),
  };
  const chapterFiles = chapters.map((chapter) => {
    const body = buildLegadoChapterFile(chapter.content);
    return { number: chapter.number, body, hash: digest(body) };
  });
  const toc = buildLegadoBookFile({
    ...card,
    chapters: chapters.map((chapter) => ({
      name: chapter.title,
      url: phoneLegadoChapterUrl(config.url, bookId, chapter.number),
    })),
  });
  return {
    card,
    chapters: chapterFiles,
    manifest: Object.fromEntries(chapterFiles.map((chapter) => [String(chapter.number), chapter.hash])),
    toc: { body: toc, hash: digest(toc) },
  };
}

async function bookDirectoryExists(state: PhoneSyncState, bookId: string): Promise<boolean> {
  try {
    return (await stat(state.bookDir(bookId))).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function forEachLimit<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed && cursor < items.length) {
      const item = items[cursor++]!;
      try {
        await task(item);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}

// ---------------------------------------------------------------------------
// One push for one book
// ---------------------------------------------------------------------------

async function publishCatalog(
  projectRoot: string,
  storage: StorageClient,
  file: PhoneSyncFile,
  force: boolean,
): Promise<void> {
  const cards = Object.values(file.books)
    .filter((record) => record.enabled && record.card)
    .sort((a, b) => (b.contentUpdatedAt ?? "").localeCompare(a.contentUpdatedAt ?? ""))
    .map((record) => record.card!);
  if (cards.length === 0 && file.catalog === undefined) return;
  const body = buildLegadoCatalogFile(cards);
  const hash = digest(body);
  if (!force && file.catalog === hash) return;
  await storage.upload(CATALOG_PATH, body, JSON_TYPE);
  await updateSyncFile(projectRoot, (current) => ({ ...current, catalog: hash }));
}

async function removeBookFromCloud(
  projectRoot: string,
  storage: StorageClient,
  bookId: string,
  record: PhoneBookRecord,
): Promise<void> {
  const file = record.enabled
    ? await updateBookRecord(projectRoot, bookId, (current) => ({ ...current, enabled: false }))
    : await readSyncFile(projectRoot);
  await publishCatalog(projectRoot, storage, file, false);
  const numbers = new Set(Object.keys(record.chapters).map(Number));
  for (const number of await storage.listChapterNumbers(bookId)) numbers.add(number);
  await storage.remove([
    phoneLegadoBookPath(bookId),
    ...[...numbers].map((number) => phoneLegadoChapterPath(bookId, number)),
  ]);
  await updateSyncFile(projectRoot, (current) => {
    if (current.books[bookId]?.enabled !== false) return current;
    const books = { ...current.books };
    delete books[bookId];
    return { ...current, books };
  });
}

async function runPhoneJob(projectRoot: string, state: PhoneSyncState, bookId: string, force: boolean): Promise<void> {
  const config = await loadPhoneSyncConfig(projectRoot);
  if (!config) return;
  let file = await readSyncFile(projectRoot);
  if (file.target !== config.url) file = await updateSyncFile(projectRoot, (current) => retarget(current, config.url));
  const record = file.books[bookId];
  if (!record) return;

  const storage = createStorageClient(config);
  if (!record.enabled || !(await bookDirectoryExists(state, bookId))) {
    await removeBookFromCloud(projectRoot, storage, bookId, record);
    return;
  }

  const snapshot = await loadBookSnapshot(state, config, bookId);
  const source = buildCloudLegadoBookSourceFile({ supabaseUrl: config.url });
  const sourceHash = digest(source);
  const sourceStale = force || file.source !== sourceHash;
  if (sourceStale) {
    await storage.ensureBucket();
    await storage.upload(SOURCE_PATH, source, "text/plain; charset=utf-8");
    await updateSyncFile(projectRoot, (current) => ({ ...current, source: sourceHash }));
  }

  const localNumbers = new Set(snapshot.chapters.map((chapter) => chapter.number));
  const changed = snapshot.chapters.filter((chapter) => force || record.chapters[String(chapter.number)] !== chapter.hash);
  const stale = new Set(Object.keys(record.chapters).map(Number).filter((number) => !localNumbers.has(number)));
  if (force) {
    for (const number of await storage.listChapterNumbers(bookId)) {
      if (!localNumbers.has(number)) stale.add(number);
    }
  }

  const uploaded: Record<string, string> = {};
  try {
    await forEachLimit(changed, UPLOAD_CONCURRENCY, async (chapter) => {
      await storage.upload(phoneLegadoChapterPath(bookId, chapter.number), chapter.body, JSON_TYPE);
      uploaded[String(chapter.number)] = chapter.hash;
    });
  } catch (error) {
    if (Object.keys(uploaded).length > 0) {
      await updateBookRecord(projectRoot, bookId, (current) => ({
        ...current,
        chapters: { ...current.chapters, ...uploaded },
      }));
    }
    throw error;
  }

  // Table of contents goes up after its chapters and before stale chapters disappear,
  // so the phone never sees an entry without content.
  const tocStale = force || record.toc !== snapshot.toc.hash;
  if (tocStale) await storage.upload(phoneLegadoBookPath(bookId), snapshot.toc.body, JSON_TYPE);
  if (stale.size > 0) {
    await storage.remove([...stale].map((number) => phoneLegadoChapterPath(bookId, number)));
  }

  const pushed = changed.length + stale.size;
  const touched = pushed > 0 || tocStale || sourceStale;
  const now = new Date().toISOString();
  const latest = touched || record.error || !record.card
    ? await updateBookRecord(projectRoot, bookId, (current) => {
        const { error: _error, ...rest } = current;
        return {
          ...rest,
          chapters: snapshot.manifest,
          toc: snapshot.toc.hash,
          card: snapshot.card,
          contentUpdatedAt: pushed > 0 || tocStale ? now : current.contentUpdatedAt ?? now,
          lastSyncedAt: touched ? now : current.lastSyncedAt,
          lastChanged: touched ? pushed : current.lastChanged,
        };
      })
    : await readSyncFile(projectRoot);
  await publishCatalog(projectRoot, storage, latest, force);
}

// ---------------------------------------------------------------------------
// Per-project queue: one push at a time, bursts of changes coalesce, failures retry.
// ---------------------------------------------------------------------------

type ChangeListener = (bookId: string) => void;

const queues = new Map<string, PhoneSyncQueue>();
const listeners = new Map<string, Set<ChangeListener>>();
const pendingChecks = new Map<string, Set<Promise<void>>>();

function trackCheck(projectRoot: string, check: Promise<void>): void {
  const key = resolve(projectRoot);
  const set = pendingChecks.get(key) ?? new Set<Promise<void>>();
  set.add(check);
  pendingChecks.set(key, set);
  void check.finally(() => set.delete(check));
}

function emitChange(projectKey: string, bookId: string): void {
  for (const listener of listeners.get(projectKey) ?? []) {
    try {
      listener(bookId);
    } catch {
      // Listeners only mirror status to the UI.
    }
  }
}

class PhoneSyncQueue {
  state: PhoneSyncState;
  logWarn?: (message: string) => void;
  private readonly timers = new Map<string, { readonly handle: NodeJS.Timeout; readonly dueAt: number; readonly force: boolean }>();
  private readonly ready = new Map<string, boolean>();
  private readonly rerun = new Map<string, boolean>();
  private readonly failures = new Map<string, number>();
  private running: string | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly projectRoot: string, private readonly projectKey: string, state: PhoneSyncState) {
    this.state = state;
  }

  schedule(bookId: string, options: { readonly delayMs: number; readonly force?: boolean; readonly keepAlive?: boolean }): void {
    const existing = this.timers.get(bookId);
    const force = (options.force ?? false) || (existing?.force ?? false);
    if (existing) clearTimeout(existing.handle);
    this.timers.delete(bookId);
    if (options.delayMs <= 0) {
      this.enqueue(bookId, force);
      return;
    }
    const handle = setTimeout(() => {
      this.timers.delete(bookId);
      this.enqueue(bookId, force);
    }, options.delayMs);
    if (options.keepAlive === false) handle.unref();
    this.timers.set(bookId, { handle, dueAt: Date.now() + options.delayMs, force });
    emitChange(this.projectKey, bookId);
  }

  activity(bookId: string): { readonly running: boolean; readonly queued: boolean; readonly retryAt?: number } {
    return {
      running: this.running === bookId,
      queued: this.ready.has(bookId) || this.rerun.has(bookId) || this.timers.has(bookId),
      retryAt: this.timers.get(bookId)?.dueAt,
    };
  }

  whenIdle(): Promise<void> {
    if (!this.running && this.ready.size === 0) return Promise.resolve();
    return new Promise((resolveIdle) => this.idleWaiters.push(resolveIdle));
  }

  private enqueue(bookId: string, force: boolean): void {
    if (this.running === bookId) {
      this.rerun.set(bookId, force || (this.rerun.get(bookId) ?? false));
    } else {
      this.ready.set(bookId, force || (this.ready.get(bookId) ?? false));
    }
    emitChange(this.projectKey, bookId);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.ready.entries().next();
    if (next.done) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolveIdle of waiters) resolveIdle();
      return;
    }
    const [bookId, force] = next.value;
    this.ready.delete(bookId);
    this.running = bookId;
    emitChange(this.projectKey, bookId);
    try {
      await runPhoneJob(this.projectRoot, this.state, bookId, force);
      this.failures.delete(bookId);
    } catch (error) {
      const message = describeError(error);
      this.logWarn?.(`phone-sync: ${bookId}: ${message}`);
      await updateBookRecord(this.projectRoot, bookId, (record) => ({ ...record, error: message })).catch(() => undefined);
      const attempt = (this.failures.get(bookId) ?? 0) + 1;
      this.failures.set(bookId, attempt);
      if (!this.rerun.has(bookId)) {
        const delayMs = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1]!;
        this.schedule(bookId, { delayMs, keepAlive: false });
      }
    } finally {
      this.running = null;
      const rerun = this.rerun.get(bookId);
      if (rerun !== undefined) {
        this.rerun.delete(bookId);
        this.ready.set(bookId, rerun);
      }
      emitChange(this.projectKey, bookId);
      void this.pump();
    }
  }
}

function queueFor(projectRoot: string, state: PhoneSyncState, logWarn?: (message: string) => void): PhoneSyncQueue {
  const key = resolve(projectRoot);
  let queue = queues.get(key);
  if (!queue) {
    queue = new PhoneSyncQueue(projectRoot, key, state);
    queues.set(key, queue);
  }
  queue.state = state;
  if (logWarn) queue.logWarn = logWarn;
  return queue;
}

async function loadConfigQuietly(projectRoot: string, logWarn?: (message: string) => void): Promise<PhoneSyncConfig | null> {
  try {
    return await loadPhoneSyncConfig(projectRoot);
  } catch (error) {
    logWarn?.(`phone-sync: ${describeError(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Push a book's local changes to the phone if the book has phone reading turned on. */
export function queuePhoneSync(input: PhoneSyncInput & { readonly delayMs?: number }): void {
  trackCheck(input.projectRoot, (async () => {
    if (!(await loadConfigQuietly(input.projectRoot, input.logWarn))) return;
    const file = await readSyncFile(input.projectRoot);
    if (!file.books[input.bookId]) return;
    queueFor(input.projectRoot, input.state, input.logWarn)
      .schedule(input.bookId, { delayMs: input.delayMs ?? DEBOUNCE_MS });
  })().catch((error) => input.logWarn?.(`phone-sync: ${describeError(error)}`)));
}

/** Turn phone reading on for a book and push a full copy right away. */
export async function enablePhoneSync(input: PhoneSyncInput): Promise<PhoneSyncStatus> {
  const config = await loadPhoneSyncConfig(input.projectRoot);
  if (!config) return { configured: false, enabled: false, phase: "off", chaptersSynced: 0 };
  await updateSyncFile(input.projectRoot, (current) => {
    const file = retarget(current, config.url);
    const existing: PhoneBookRecord = file.books[input.bookId] ?? { enabled: true, chapters: {} };
    const { error: _error, ...record } = existing;
    return { ...file, books: { ...file.books, [input.bookId]: { ...record, enabled: true } } };
  });
  queueFor(input.projectRoot, input.state, input.logWarn).schedule(input.bookId, { delayMs: 0, force: true });
  return readPhoneSyncStatus(input);
}

/** Turn phone reading off for a book and remove it from the phone bookshelf. */
export async function disablePhoneSync(input: PhoneSyncInput): Promise<PhoneSyncStatus> {
  const config = await loadPhoneSyncConfig(input.projectRoot);
  if (!config) return { configured: false, enabled: false, phase: "off", chaptersSynced: 0 };
  const file = await updateBookRecord(input.projectRoot, input.bookId, (current) => {
    const { error: _error, ...record } = current;
    return { ...record, enabled: false };
  });
  if (file.books[input.bookId]) {
    queueFor(input.projectRoot, input.state, input.logWarn).schedule(input.bookId, { delayMs: 0 });
  }
  return readPhoneSyncStatus(input);
}

export async function readPhoneSyncStatus(input: {
  readonly projectRoot: string;
  readonly bookId: string;
}): Promise<PhoneSyncStatus> {
  const config = await loadPhoneSyncConfig(input.projectRoot);
  if (!config) return { configured: false, enabled: false, phase: "off", chaptersSynced: 0 };
  const legadoUrl = phoneLegadoSourceUrl(config.url);
  const file = await readSyncFile(input.projectRoot);
  const record = file.target === config.url ? file.books[input.bookId] : retarget(file, config.url).books[input.bookId];
  if (!record) return { configured: true, enabled: false, phase: "off", legadoUrl, chaptersSynced: 0 };

  const activity = queues.get(resolve(input.projectRoot))?.activity(input.bookId);
  const phase: PhoneSyncPhase = !record.enabled
    ? "removing"
    : activity?.running
      ? "syncing"
      : record.error
        ? "error"
        : activity?.queued || !record.lastSyncedAt
          ? "pending"
          : "synced";
  return {
    configured: true,
    enabled: record.enabled,
    phase,
    legadoUrl,
    chaptersSynced: Object.keys(record.chapters).length,
    ...(record.lastChanged !== undefined ? { lastChanged: record.lastChanged } : {}),
    ...(record.lastSyncedAt ? { lastSyncedAt: record.lastSyncedAt } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(activity?.retryAt && !activity.running ? { retryAt: new Date(activity.retryAt).toISOString() } : {}),
  };
}

/**
 * Long-running hosts (Studio) call this once: it catches up on startup, rechecks
 * every few minutes for edits made outside the hooked paths, and reports changes.
 */
export function startPhoneSyncService(input: {
  readonly projectRoot: string;
  readonly state: PhoneSyncState;
  readonly onChange?: (bookId: string) => void;
  readonly logWarn?: (message: string) => void;
  readonly intervalMs?: number;
}): () => void {
  const key = resolve(input.projectRoot);
  const onChange = input.onChange;
  if (onChange) {
    const set = listeners.get(key) ?? new Set<ChangeListener>();
    set.add(onChange);
    listeners.set(key, set);
  }
  const resume = () => {
    void (async () => {
      if (!(await loadConfigQuietly(input.projectRoot, input.logWarn))) return;
      const file = await readSyncFile(input.projectRoot);
      const queue = queueFor(input.projectRoot, input.state, input.logWarn);
      for (const bookId of Object.keys(file.books)) {
        if (!queue.activity(bookId).running) queue.schedule(bookId, { delayMs: DEBOUNCE_MS, keepAlive: false });
      }
    })().catch((error) => input.logWarn?.(`phone-sync: ${describeError(error)}`));
  };
  resume();
  const timer = setInterval(resume, input.intervalMs ?? RESUME_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    if (onChange) listeners.get(key)?.delete(onChange);
  };
}

/** Resolves once no push is running or waiting to start immediately; delayed retries are not awaited. */
export async function waitForPhoneSyncIdle(projectRoot: string): Promise<void> {
  const key = resolve(projectRoot);
  await Promise.all([...(pendingChecks.get(key) ?? [])]);
  await queues.get(key)?.whenIdle();
}
