import { BOOK_PLATFORM, defaultChapterLength, type Platform } from "@actalk/inkos-core";
export { waitForStudioBookReady } from "../lib/book-ready.js";
export type { StudioBookDetail, WaitForStudioBookReadyOptions } from "../lib/book-ready.js";

export interface StudioCreateBookBody {
  readonly title: string;
  readonly genre: string;
  readonly language?: string;
  readonly chapterWordCount?: number;
  readonly minChapterLength?: number;
  readonly maxChapterLength?: number;
  readonly targetChapters?: number;
  readonly blurb?: string;
}

export interface StudioBookConfigDraft {
  readonly id: string;
  readonly title: string;
  readonly platform: Platform;
  readonly genre: string;
  readonly status: "outlining";
  readonly targetChapters: number;
  readonly chapterWordCount: number;
  readonly minChapterLength?: number;
  readonly maxChapterLength?: number;
  readonly language: "zh" | "en";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function buildStudioBookConfig(body: StudioCreateBookBody, now: string): StudioBookConfigDraft {
  return {
    id: body.title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 30),
    title: body.title,
    platform: BOOK_PLATFORM,
    genre: body.genre,
    status: "outlining",
    targetChapters: body.targetChapters ?? 200,
    chapterWordCount: body.chapterWordCount ?? defaultChapterLength(body.language === "en" ? "en" : "zh"),
    ...(body.minChapterLength!==undefined?{minChapterLength:body.minChapterLength}:{}),
    ...(body.maxChapterLength!==undefined?{maxChapterLength:body.maxChapterLength}:{}),
    language: body.language === "en" ? "en" : "zh",
    createdAt: now,
    updatedAt: now,
  };
}
