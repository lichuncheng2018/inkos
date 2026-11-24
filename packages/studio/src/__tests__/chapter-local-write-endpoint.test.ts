import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialWorkManifestWrite, listChapterVersions, runWorkerAgent, saveSecrets } from "@actalk/inkos-core";
import { createStudioServer } from "../api/server.js";

vi.mock("@actalk/inkos-core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@actalk/inkos-core")>(),
  runWorkerAgent: vi.fn(),
}));

const initialText = "# 雨夜\n\n灯灭了。\n\n她往外走。\n";
const chapterUrl = "http://127.0.0.1/api/v1/books/rain/chapters/1";
const json = (method: "POST" | "PUT", body: unknown) => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const worker = vi.mocked(runWorkerAgent);

let root: string, bookDir: string, chapterPath: string;

beforeEach(async () => {
  worker.mockReset();
  root = await mkdtemp(join(tmpdir(), "inkos-local-writing-"));
  bookDir = join(root, "works", "rain", "source");
  chapterPath = join(bookDir, "chapters", "0001_雨夜.md");
  const { write } = createInitialWorkManifestWrite({ workId: "rain", title: "雨夜", profileId: "longform-novel", language: "zh", writes: [] });
  await mkdir(join(bookDir, "chapters"), { recursive: true });
  const date = "2026-11-18T00:00:00.000Z";
  await Promise.all([
    saveSecrets(root, { services: { openai: { apiKey: "fixture" }, "custom:Editing": { apiKey: "editing-fixture" } } }),
    writeFile(join(root, "inkos.json"), JSON.stringify({ name: "local-writing-test", version: "0.1.0", language: "zh", llm: { service: "openai", defaultModel: "test-model", services: [{ service: "openai", models: ["test-model"] }, { service: "custom", name: "Editing", baseUrl: "http://127.0.0.1:1/v1", models: ["local-editor-model"] }] } })),
    writeFile(join(root, write.relativePath), write.content),
    writeFile(join(bookDir, "book.json"), JSON.stringify({ id: "rain", title: "雨夜", platform: "local", genre: "xuanhuan", status: "active", targetChapters: 3, chapterWordCount: 500, language: "zh", createdAt: date, updatedAt: date })),
    writeFile(join(bookDir, "chapters", "index.json"), JSON.stringify([{ number: 1, title: "雨夜", wordCount: 10, createdAt: date, updatedAt: date, observations: [], provenance: "generated" }])),
    writeFile(chapterPath, initialText),
  ]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("chapter local writing API", () => {
  it("uses unsaved context and writes nothing until the existing chapter save runs", async () => {
    worker.mockResolvedValueOnce({ content: "  她摸到墙边，循着脚步声往前。  " } as Awaited<ReturnType<typeof runWorkerAgent>>);
    const app = createStudioServer({} as never, root);
    const res = await app.request(`${chapterUrl}/workspace/local-write`, json("POST", {
      before: "油灯灭了。\n\n", selection: "", after: "她往外走。", instruction: "补一句动作。",
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ text: "她摸到墙边，循着脚步声往前。" });
    expect(worker).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(worker.mock.calls[0]![2]);
    expect(prompt).toContain("油灯灭了。");
    expect(prompt).toContain("补一句动作。");
    expect(await readFile(chapterPath, "utf8")).toBe(initialText);
    expect(await listChapterVersions(bookDir, 1)).toEqual([]);

    const saved = "# 雨夜\n\n油灯灭了。\n\n她摸到墙边，循着脚步声往前。\n\n她往外走。\n";
    expect((await app.request(chapterUrl, json("PUT", { content: saved }))).status).toBe(200);
    expect(await readFile(chapterPath, "utf8")).toBe(saved);
    expect(await listChapterVersions(bookDir, 1)).toMatchObject([{ source: "manual" }]);
  });

  it("uses the saved local-writing route for both modes and returns to the default when removed", async () => {
    worker.mockResolvedValue({ content: "生成的正文。" } as Awaited<ReturnType<typeof runWorkerAgent>>);
    const app = createStudioServer({} as never, root);
    const settingsUrl = "http://127.0.0.1/api/v1/project/model-overrides";
    const url = `${chapterUrl}/workspace/local-write`;
    const overrides = { reviser: "whole-chapter-model", "chapter-local-write": "local-editor-model" };
    expect((await app.request(settingsUrl, json("PUT", { overrides }))).status).toBe(200);
    expect(await (await app.request(settingsUrl)).json()).toEqual({ overrides });

    for (const selection of ["", "改我"]) {
      const res = await app.request(url, json("POST", { before: "前", selection, after: "后" }));
      expect(res.status, await res.clone().text()).toBe(200);
      expect(worker.mock.lastCall?.[1]).toBe("local-editor-model");
      expect(worker.mock.lastCall?.[0]).toMatchObject({ service: "custom:Editing" });
    }

    expect((await app.request(settingsUrl, json("PUT", { overrides: { reviser: overrides.reviser } }))).status).toBe(200);
    const res = await app.request(url, json("POST", { before: "前", selection: "改我", after: "后" }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(worker.mock.lastCall?.[1]).toBe("test-model");
  });

  it("rejects invalid requests and missing chapters before asking the model", async () => {
    const app = createStudioServer({} as never, root);
    const url = `${chapterUrl}/workspace/local-write`;
    for (const selection of [null, "  ", "字".repeat(3001)]) {
      const res = await app.request(url, json("POST", { before: "前", selection, after: "后" }));
      expect(res.status).toBe(400);
    }
    const result = await app.request(url.replace("/chapters/1/", "/chapters/2/"), json("POST", { before: "前", selection: "改我", after: "后" }));
    expect(result.status).toBe(404);
    expect(worker).not.toHaveBeenCalled();
  });

  it("returns an error on blank model output or model failure without writing", async () => {
    worker.mockResolvedValueOnce({ content: "   " } as Awaited<ReturnType<typeof runWorkerAgent>>)
      .mockRejectedValueOnce(new Error("model unavailable"));
    const app = createStudioServer({} as never, root);
    const url = `${chapterUrl}/workspace/local-write`;
    const req = json("POST", { before: "前", selection: "改我", after: "后" });
    expect((await app.request(url, req)).status).toBe(502);
    expect((await app.request(url, req)).status).toBe(500);
    expect(await readFile(chapterPath, "utf8")).toBe(initialText);
    expect(await listChapterVersions(bookDir, 1)).toEqual([]);
  });
});
