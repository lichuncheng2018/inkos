import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInitialWorkManifestWrite } from "@actalk/inkos-core";
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
    await rm(root, { recursive: true, force: true });
  });

  it("reports the reader as unconfigured without secrets", async () => {
    const app = createStudioServer({} as never, root);
    const res = await app.request("http://127.0.0.1/api/v1/books/rain-dock/phone-reader");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false, ok: false });
  });

  it("returns a public reader URL once secrets exist", async () => {
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, ".inkos", "supabase.json"), JSON.stringify({
      url: "https://example.supabase.co/",
      publishableKey: "pub",
      serviceRoleKey: "srv",
    }));
    const app = createStudioServer({} as never, root);
    const res = await app.request("http://127.0.0.1/api/v1/books/rain-dock/phone-reader");
    expect(await res.json()).toEqual({
      configured: true,
      ok: true,
      readerUrl: "https://example.supabase.co/storage/v1/object/public/inkos-reader/index.html#rain-dock",
      legadoUrl: "https://example.supabase.co/storage/v1/object/public/inkos-reader/legado.json",
    });
  });
});
