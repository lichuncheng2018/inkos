import type { LengthCountingMode, LengthSpec } from "../models/length-governance.js";

export type LengthLanguage = "zh" | "en";

// Per-chapter length default in the book's native unit: Chinese counts characters (3000字),
// English counts words (~2000 ≈ a 3000-char chapter). One cross-language number would mis-scale —
// 3000 read as English words runs ~50% long, and the hard-range guard then force-expands correct chapters.
export const DEFAULT_CHAPTER_LENGTH_ZH = 3000;
export const DEFAULT_CHAPTER_LENGTH_EN = 2000;

export function defaultChapterLength(language: LengthLanguage = "zh"): number {
  return language === "en" ? DEFAULT_CHAPTER_LENGTH_EN : DEFAULT_CHAPTER_LENGTH_ZH;
}

export function countChapterLength(
  content: string,
  countingMode: LengthCountingMode,
): number {
  const normalized = stripMarkdownMetadata(content);

  if (countingMode === "en_words") {
    const words = normalized.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g);
    return words?.length ?? 0;
  }

  return normalized.replace(/\s+/g, "").length;
}

export function resolveLengthCountingMode(
  language: LengthLanguage = "zh",
): LengthCountingMode {
  return language === "en" ? "en_words" : "zh_chars";
}

export function formatLengthCount(
  count: number,
  countingMode: LengthCountingMode,
): string {
  return countingMode === "en_words" ? `${count} words` : `${count}字`;
}

export function buildLengthSpec(
  target: number,
  language: LengthLanguage = "zh",
  bounds: { readonly minChapterLength?: number; readonly maxChapterLength?: number } = {},
): LengthSpec {
  return {
    target: targetWithinBounds(target, bounds.minChapterLength, bounds.maxChapterLength),
    countingMode: resolveLengthCountingMode(language),
    ...(bounds.minChapterLength!==undefined?{minChapterLength:bounds.minChapterLength}:{}),
    ...(bounds.maxChapterLength!==undefined?{maxChapterLength:bounds.maxChapterLength}:{}),
  };
}

/** Explicit bounds are the hard contract; a stale or per-call target outside them would contradict it. */
function targetWithinBounds(target: number, min?: number, max?: number): number {
  if (min !== undefined && max !== undefined && (target < min || target > max)) return Math.round((min + max) / 2);
  if (min !== undefined && target < min) return min;
  if (max !== undefined && target > max) return max;
  return target;
}

/** Explicit author bounds are hard checks; an approximate target alone is not. */
export function chapterLengthDelivery(count: number, spec: LengthSpec) {
  if(spec.minChapterLength===undefined&&spec.maxChapterLength===undefined)return undefined;
  const issues: Array<{code:string;actual:number;minimum?:number;maximum?:number}>=[];
  if((spec.minChapterLength!==undefined&&count<spec.minChapterLength)
    ||(spec.maxChapterLength!==undefined&&count>spec.maxChapterLength))issues.push({
      code:"CHAPTER_LENGTH_OUT_OF_RANGE",actual:count,minimum:spec.minChapterLength,maximum:spec.maxChapterLength,
    });
  return {status:issues.length?"needs_revision" as const:"checks_passed" as const,
    measurements:{count,countingMode:spec.countingMode},target:spec,issues};
}

/** Distance from the explicit range in native units; 0 when inside it or unbounded. */
export function chapterLengthGap(count: number, spec: LengthSpec): number {
  return Math.max(0, (spec.minChapterLength ?? 0) - count, count - (spec.maxChapterLength ?? Infinity));
}

export function assertChapterLength(content: string, spec?: LengthSpec): void {
  if(!spec)return;
  const count=countChapterLength(content,spec.countingMode);
  const delivery=chapterLengthDelivery(count,spec);
  if(!delivery?.issues.length)return;
  // Models estimate length poorly; give the exact change instead of the range alone.
  const adjustment=spec.maxChapterLength!==undefined&&count>spec.maxChapterLength
    ?{change:"shorten" as const,atLeast:count-spec.maxChapterLength,towardTarget:Math.max(0,count-spec.target)}
    :{change:"expand" as const,atLeast:chapterLengthGap(count,spec),towardTarget:Math.max(0,spec.target-count)};
  throw Object.assign(new Error(JSON.stringify({
    code:"CHAPTER_LENGTH_OUT_OF_RANGE",...delivery,adjustment,
    instruction:"Revise the complete chapter into the explicit length range, preserving core events and causal continuity.",
  })),{code:"CHAPTER_LENGTH_OUT_OF_RANGE",delivery,adjustment});
}

function stripMarkdownMetadata(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "").split("\n");
  const proseLines: string[] = [];
  let index = 0;

  if (lines[index]?.trim() === "---") {
    index += 1;
    while (index < lines.length && lines[index]?.trim() !== "---") {
      index += 1;
    }
    if (index < lines.length) {
      index += 1;
    }
  }

  let inFence = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      continue;
    }
    if (trimmed === "---" || trimmed === "...") {
      continue;
    }

    proseLines.push(line);
  }

  return proseLines.join("\n");
}
