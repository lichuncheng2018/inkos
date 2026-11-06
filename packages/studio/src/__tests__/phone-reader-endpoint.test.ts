import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialWorkManifestWrite, waitForPhoneSyncIdle } from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";

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

async function writeSupabaseConfig(root: string): Promise<void> {
  await mkdir(join(root, ".inkos"), { recursive: true });
  await writeFile(join(root, ".inkos", "supabase.json"), JSON.stringify({
    url: "https://example.supabase.co/",
    publishableKey: "pub",
    serviceRoleKey: "srv",
  }));
}

function fakeStorage() {
  const objects = new Map<string, string>();
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = decodeURIComponent(url.pathname);
    const method = (init?.method ?? "GET").toUpperCase();
    const objectPrefix = "/storage/v1/object/inkos-reader/";
    if (path.startsWith(objectPrefix) && (method === "POST" || method === "PUT")) {
      objects.set(path.slice(objectPrefix.length), String(init?.body));
      return Response.json({});
    }
    if (path === "/storage/v1/object/inkos-reader" && method === "DELETE") {
      for (const name of (JSON.parse(String(init?.body)) as { prefixes: string[] }).prefixes) objects.delete(name);
      return Response.json([]);
    }
    if (path === "/storage/v1/object/list/inkos-reader") return Response.json([]);
    return Response.json({ id: "inkos-reader" });
  };
  return { objects, fetchImpl };
}

const LEGADO_URL = "https://example.supabase.co/storage/v1/object/public/inkos-reader/legado.json";

describe("phone reader endpoint", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-phone-api-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "phone-project",
      version: "2.0.0",
      language: "zh",
      llm: { model: "test-model", provider: "openai" },
      notify: [],
    }));
    await writeLongformBook(root, "rain-dock", "旧码头");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });

  it("reports the reader as unconfigured without secrets", async () => {
    const app = createStudioServer({} as never, root);
    const res = await app.request("http://127.0.0.1/api/v1/books/rain-dock/phone-reader");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, enabled: false, phase: "off", chaptersSynced: 0 });
  });

  it("returns the Legado source URL once secrets exist, before the book is turned on", async () => {
    await writeSupabaseConfig(root);
    const app = createStudioServer({} as never, root);
    const res = await app.request("http://127.0.0.1/api/v1/books/rain-dock/phone-reader");
    expect(await res.json()).toEqual({
      configured: true,
      enabled: false,
      phase: "off",
      legadoUrl: LEGADO_URL,
      chaptersSynced: 0,
    });
  });

  it("turns phone reading on, pushes the book, and removes it when turned off", async () => {
    await writeSupabaseConfig(root);
    const storage = fakeStorage();
    vi.stubGlobal("fetch", storage.fetchImpl);
    const app = createStudioServer({} as never, root);

    const enabled = await app.request("http://127.0.0.1/api/v1/books/rain-dock/phone-reader", { method: "POST" });
    expect(await enabled.json()).toMatchObject({ configured: true, enabled: true, legadoUrl: LEGADO_URL });
    await waitForPhoneSyncIdle(root);
    expect(JSON.parse(storage.objects.get("legado/books/rain-dock/1.json") ?? "null")).toEqual({ content: "雨水落在旧码头。" });

    const status = await app.request("http://127.0.0.1/api/v1/books/rain-dock/phone-reader");
    expect(await status.json()).toMatchObject({ enabled: true, phase: "synced", chaptersSynced: 1, lastChanged: 1 });

    const disabled = await app.request("http://127.0.0.1/api/v1/books/rain-dock/phone-reader", { method: "DELETE" });
    expect(await disabled.json()).toMatchObject({ enabled: false });
    await waitForPhoneSyncIdle(root);
    expect(storage.objects.has("legado/books/rain-dock/1.json")).toBe(false);
    expect(JSON.parse(storage.objects.get("legado/books.json") ?? "null")).toEqual({ books: [] });
  });
});
