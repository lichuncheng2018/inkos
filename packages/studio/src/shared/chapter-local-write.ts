export const CHAPTER_LOCAL_WRITE_AGENT = "chapter-local-write";

export const LOCAL_CONTEXT_LIMIT = 2000;
export const LOCAL_SELECTION_LIMIT = 3000;
export const LOCAL_INSTRUCTION_LIMIT = 1000;

export interface LocalWritingRequest {
  readonly before: string;
  readonly selection: string;
  readonly after: string;
  readonly instruction?: string;
}

export interface LocalWritingTarget {
  readonly draft: string;
  readonly start: number;
  readonly end: number;
}

const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, "\n");

export function captureLocalWritingTarget(draft: string, start: number, end: number): LocalWritingTarget {
  // Textarea selection offsets count CRLF as one character, even in an untouched draft read from disk.
  for (const { index } of draft.matchAll(/\r\n/g)) {
    if (index >= end) break;
    if (index < start) start++;
    end++;
  }
  const selection = draft.slice(start, end);
  if (selection.trim()) {
    // Keep any paragraph separators picked up by the selection outside the replacement.
    start += selection.length - selection.trimStart().length;
    end -= selection.length - selection.trimEnd().length;
  }
  return { draft, start, end };
}

export function makeLocalWritingRequest(target: LocalWritingTarget, note: string): LocalWritingRequest | null {
  const { draft, start, end } = target;
  const instruction = note.trim();
  const request = {
    before: draft.slice(Math.max(0, start - LOCAL_CONTEXT_LIMIT), start),
    selection: draft.slice(start, end),
    after: draft.slice(end, end + LOCAL_CONTEXT_LIMIT),
    ...(instruction && { instruction }),
  };
  return isLocalWritingRequest(request) ? request : null;
}

export function isLocalWritingRequest(value: unknown): value is LocalWritingRequest {
  if (!value || typeof value !== "object") return false;
  const { before, selection, after, instruction } = value as Partial<LocalWritingRequest>;
  return typeof before === "string" && before.length <= LOCAL_CONTEXT_LIMIT
    && typeof after === "string" && after.length <= LOCAL_CONTEXT_LIMIT
    && typeof selection === "string" && selection.length <= LOCAL_SELECTION_LIMIT
    && (selection === "" || selection.trim().length > 0)
    && (instruction === undefined || (typeof instruction === "string" && instruction.length <= LOCAL_INSTRUCTION_LIMIT));
}

export function applyLocalWriting(currentDraft: string, target: LocalWritingTarget, result: string): string | null {
  const { draft, start, end } = target;
  const text = result.trim();
  if (currentDraft !== draft || !text) return null;

  const newline = draft.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const updatedText = normalizeNewlines(text).replace(/\n/g, newline);
  if (start !== end) return before + updatedText + after;

  const leftBreaks = normalizeNewlines(before).match(/\n+$/)?.[0].length ?? 0;
  const rightBreaks = normalizeNewlines(after).match(/^\n+/)?.[0].length ?? 0;
  const paddingLeft = before.trim() ? newline.repeat(Math.max(0, 2 - leftBreaks)) : "";
  const paddingRight = after.trim() ? newline.repeat(Math.max(0, 2 - rightBreaks)) : "";
  return before + paddingLeft + updatedText + paddingRight + after;
}
