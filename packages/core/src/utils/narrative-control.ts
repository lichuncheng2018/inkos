import type { ChapterMemo, ContextPackage } from "../models/input-governance.js";

/**
 * Separate the planner's Notes section for the writer only. The persisted
 * memo, audit context and state settlement still see the complete plan.
 */
export function splitChapterMemoBody(body: string): { scenes: string; notes: string } {
  const text = body.replace(/\r\n?/g, "\n").trim();
  const heading = /^ {0,3}##[ \t]+(?:备注|Notes)[ \t]*#*[ \t]*$/im.exec(text);
  if (!heading) return { scenes: text, notes: "" };
  const rest = text.slice(heading.index + heading[0].length);
  const nextSection = rest.search(/^ {0,3}#{1,2}[ \t]+\S/m);
  const after = nextSection < 0 ? "" : rest.slice(nextSection).trim();
  return {
    scenes: [text.slice(0, heading.index).trim(), after].filter(Boolean).join("\n\n"),
    notes: (nextSection < 0 ? rest : rest.slice(0, nextSection)).trim(),
  };
}

export function renderMemoAsNarrativeBlock(
  memo: ChapterMemo,
  language: "zh" | "en" = "zh",
): { task: string; notes: string } {
  const isEn = language === "en";
  const sections: string[] = [];

  sections.push(`## ${isEn ? "Goal" : "目标"}\n- ${memo.goal}`);

  if (memo.threadRefs.length > 0) {
    const threads = memo.threadRefs.map((id) => `- ${id}`).join("\n");
    sections.push(`## ${isEn ? "Thread Refs" : "关联线索"}\n${threads}`);
  }

  const { scenes, notes } = splitChapterMemoBody(memo.body);
  if (scenes) sections.push(scenes);
  return { task: sections.join("\n\n"), notes };
}

export function buildNarrativeIntentBrief(
  chapterIntent: string,
  _language: "zh" | "en" = "zh",
): string {
  return chapterIntent.trim();
}

export function renderNarrativeSelectedContext(
  entries: ReadonlyArray<ContextPackage["selectedContext"][number]>,
  language: "zh" | "en" = "zh",
): string {
  const heading = language === "en" ? "Evidence" : "证据";
  const reasonLabel = language === "en" ? "reason" : "原因";
  const detailLabel = language === "en" ? "detail" : "细节";

  return entries
    .map((entry, index) => {
      const lines = [
        `### ${heading} ${index + 1}`,
        `- ${reasonLabel}: ${entry.reason}`,
        entry.excerpt ? `- ${detailLabel}: ${entry.excerpt}` : "",
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
}
