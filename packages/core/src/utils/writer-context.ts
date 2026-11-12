import type { ChapterMemo, ContextPackage } from "../models/input-governance.js";

type ContextEntry = ContextPackage["selectedContext"][number];

/**
 * The governed context package is shared by the planner, settler and auditor,
 * who need the whole ledger. The prose writer works from the chapter memo, so
 * its view keeps what protects continuity and drops what it already receives
 * elsewhere or cannot use in this chapter.
 */
export interface WriterContextView {
  readonly direction: ReadonlyArray<ContextEntry>;
  readonly facts: ReadonlyArray<ContextEntry>;
  readonly roles: ReadonlyArray<ContextEntry>;
  readonly world: ReadonlyArray<ContextEntry>;
  readonly outline: ReadonlyArray<ContextEntry>;
  readonly history: ReadonlyArray<ContextEntry>;
  readonly threads: ReadonlyArray<ContextEntry>;
  readonly other: ReadonlyArray<ContextEntry>;
}

const DIRECTION_SOURCES = new Set(["story/author_intent.md", "story/current_focus.md"]);
/** Rendered by the writer prompt itself: the memo block, the style guide and the book rules. */
const WRITER_OWNED_SOURCES = new Set(["runtime/chapter_memo", "story/style_guide.md", "story/book_rules.md"]);

export function selectWriterContext(
  entries: ReadonlyArray<ContextEntry>,
  task: { readonly chapterNumber: number; readonly memo: Pick<ChapterMemo, "goal" | "body" | "threadRefs"> },
): WriterContextView {
  const memoText = `${task.memo.goal}\n${task.memo.body}`;
  const threadIds = new Set(task.memo.threadRefs);
  const view = {
    direction: [] as ContextEntry[], facts: [] as ContextEntry[], roles: [] as ContextEntry[], world: [] as ContextEntry[],
    outline: [] as ContextEntry[], history: [] as ContextEntry[], threads: [] as ContextEntry[], other: [] as ContextEntry[],
  };
  for (const entry of entries) {
    const source = entry.source;
    if (WRITER_OWNED_SOURCES.has(source) || source.startsWith("runtime/previous_chapter#")) continue;
    if (DIRECTION_SOURCES.has(source)) view.direction.push(entry);
    else if (source.startsWith("runtime/current_state#")) {
      if (!isSupersededFact(entry.excerpt, task.chapterNumber)) view.facts.push(entry);
    } else if (source.startsWith("story/roles/")) view.roles.push(entry);
    else if (source.startsWith("story/outline/volume_map.md")) view.outline.push(entry);
    else if (source.startsWith("story/outline/") || source === "story/parent_canon.md" || source === "story/fanfic_canon.md") view.world.push(entry);
    else if (source.startsWith("story/chapter_summaries.md#") || source.startsWith("story/volume_summaries.md#")) view.history.push(entry);
    else if (source.startsWith("runtime/referenced_hook#")) view.threads.push(entry);
    else if (source.startsWith("story/pending_hooks.md#")) {
      // Unreferenced hooks are long-range plans; the memo names the ones this chapter touches.
      const hookId = source.slice("story/pending_hooks.md#".length);
      if (threadIds.has(hookId) && !entries.some((other) => other.source === `runtime/referenced_hook#${hookId}`)) view.threads.push(entry);
    } else view.other.push(entry);
  }
  const namedRoles = view.roles.filter((entry) => memoText.includes(roleName(entry.source)));
  return {
    ...view,
    roles: namedRoles.length > 0 ? namedRoles : view.roles,
    outline: outlineSectionsForChapter(view.outline, task.chapterNumber),
  };
}

export function renderWriterContext(view: WriterContextView, language: "zh" | "en"): string {
  const isEn = language === "en";
  const raw = (entries: ReadonlyArray<ContextEntry>) => entries.map((entry) => (entry.excerpt ?? "").trim()).filter(Boolean).join("\n\n");
  const sections: Array<readonly [string, string]> = [
    [isEn ? "Where things stand (as of the previous chapter)" : "眼下的情况（截至上一章结束）",
      view.facts.map((entry) => renderFact(entry.excerpt, isEn)).filter(Boolean).join("\n")],
    [isEn ? "Characters" : "人物", raw(view.roles)],
    [isEn ? "World and setting" : "世界与设定", raw(view.world)],
    [isEn ? "This stretch of the outline" : "卷纲里的这一段", raw(view.outline)],
    [isEn ? "Earlier chapters" : "前情", view.history.map((entry) => renderHistory(entry, isEn)).filter(Boolean).join("\n")],
    [isEn ? "Threads this chapter touches" : "本章要接的线", view.threads.map((entry) => `- ${flatten(entry.excerpt)}`).join("\n")],
    [isEn ? "Other references" : "其他参考", raw(view.other)],
  ];
  return sections.filter(([, body]) => body.trim().length > 0).map(([title, body]) => `### ${title}\n${body}`).join("\n\n");
}

/**
 * The closing paragraphs of the previous chapter, cut at a paragraph boundary.
 * Without them the writer knows the prior chapter only as settled facts and
 * cannot continue its last beat or its voice.
 */
export function previousChapterTail(body: string | undefined, maxChars = 1200): string {
  const paragraphs = (body ?? "").replace(/\r\n?/g, "\n").split(/\n\s*\n|\n/).map((line) => line.trim()).filter(Boolean);
  const tail: string[] = [];
  let length = 0;
  for (let index = paragraphs.length - 1; index >= 0; index -= 1) {
    const paragraph = paragraphs[index]!;
    if (tail.length > 0 && length + paragraph.length > maxChars) break;
    tail.unshift(paragraph);
    length += paragraph.length;
  }
  return tail.join("\n\n");
}

/** A fact stays active through its validUntilChapter; the state behind chapter N stands at chapter N-1. */
function isSupersededFact(excerpt: string | undefined, chapterNumber: number): boolean {
  const until = /^validUntilChapter:\s*(\d+)\s*$/m.exec(excerpt ?? "");
  return until !== null && Number(until[1]) < chapterNumber - 1;
}

function renderFact(excerpt: string | undefined, isEn: boolean): string {
  const text = excerpt ?? "";
  // The composer serialises each fact as "field: value" lines; a value may itself span lines.
  const fields = new Map<string, string>();
  let current: string | undefined;
  for (const line of text.split("\n")) {
    const start = /^(subject|predicate|object|validFromChapter|validUntilChapter):\s?(.*)$/.exec(line);
    if (start) {
      current = start[1]!;
      fields.set(current, start[2]!);
    } else if (current) fields.set(current, `${fields.get(current)}\n${line}`);
  }
  const subject = fields.get("subject")?.trim(), predicate = fields.get("predicate")?.trim(), object = fields.get("object")?.trim();
  if (!subject || !object) return text.trim() ? `- ${flatten(text)}` : "";
  return isEn
    ? `- ${subject}${predicate ? ` | ${predicate}` : ""}: ${flatten(object)}`
    : `- ${subject}${predicate ? `｜${predicate}` : ""}：${flatten(object)}`;
}

function renderHistory(entry: ContextEntry, isEn: boolean): string {
  const chapter = /^story\/chapter_summaries\.md#(\d+)$/.exec(entry.source)?.[1];
  const text = flatten(entry.excerpt);
  if (!text) return "";
  if (!chapter) return `- ${text}`;
  return isEn ? `- Chapter ${chapter}: ${text}` : `- 第${chapter}章：${text}`;
}

function flatten(text: string | undefined): string {
  return (text ?? "").replace(/\s*\n\s*/g, " ").trim();
}

function roleName(source: string): string {
  return source.slice(source.lastIndexOf("/") + 1).replace(/\.md$/u, "");
}

/** Keep the outline sections whose heading range covers this chapter; an outline without chapter ranges is kept whole. */
function outlineSectionsForChapter(entries: ReadonlyArray<ContextEntry>, chapterNumber: number): ReadonlyArray<ContextEntry> {
  const covering = entries.filter((entry) => {
    const range = headingChapterRange(entry.excerpt);
    return range !== undefined && range.start <= chapterNumber && chapterNumber <= range.end;
  });
  return covering.length > 0 ? covering : entries;
}

function headingChapterRange(excerpt: string | undefined): { readonly start: number; readonly end: number } | undefined {
  const heading = (excerpt ?? "").split("\n", 1)[0] ?? "";
  const match = /第\s*(\d+)\s*(?:[—–\-~～至到]+\s*(\d+)\s*)?章/u.exec(heading)
    ?? /chapters?\s*(\d+)(?:\s*(?:[—–\-~]+|to)\s*(\d+))?/iu.exec(heading);
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  return end >= start ? { start, end } : undefined;
}
