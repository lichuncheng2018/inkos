/**
 * A book's own small furniture: what things cost, what people eat and carry,
 * how they address one another, what they say. Asked for a detail particular
 * to this place with nothing to draw on, a model invents a plausible generic
 * one, and a different one each chapter. The bank is written once per book
 * and kept as a file the author can edit; each chapter's planner is offered a
 * few entries in rotation, so the same particulars come back and the pick is
 * the host's, not the model's likeliest.
 */
export const TEXTURE_BANK_PATH = "story/texture_bank.md";

export interface TextureEntry {
  readonly section: string;
  readonly text: string;
}

/** Headings name a section, list items are its entries; anything else is commentary. */
export function parseTextureBank(markdown: string): TextureEntry[] {
  const entries: TextureEntry[] = [];
  let section = "";
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    const item = /^\s*(?:[-*+]|\d+[.、)])\s+(.+?)\s*$/u.exec(line);
    if (item) entries.push({ section, text: item[1]! });
  }
  return entries;
}

/**
 * The entries offered to one chapter. Sections are interleaved so a sample
 * spans several kinds, and the window moves with the chapter number: the same
 * chapter always gets the same sample, and every entry comes round before any
 * repeats.
 */
export function sampleTextureBank(
  entries: ReadonlyArray<TextureEntry>,
  chapterNumber: number,
  count = 4,
): TextureEntry[] {
  if (entries.length <= count) return [...entries];
  const sections = new Map<string, TextureEntry[]>();
  for (const entry of entries) sections.set(entry.section, [...(sections.get(entry.section) ?? []), entry]);
  const interleaved: TextureEntry[] = [];
  const depth = Math.max(...[...sections.values()].map((items) => items.length));
  for (let index = 0; index < depth; index += 1) {
    for (const items of sections.values()) if (items[index]) interleaved.push(items[index]!);
  }
  const start = (Math.max(1, chapterNumber) - 1) * count;
  return Array.from({ length: count }, (_, offset) => interleaved[(start + offset) % interleaved.length]!);
}

export function renderTextureSample(sample: ReadonlyArray<TextureEntry>, language: "zh" | "en"): string {
  return sample
    .map((entry) => (entry.section
      ? (language === "en" ? `- [${entry.section}] ${entry.text}` : `- 〔${entry.section}〕${entry.text}`)
      : `- ${entry.text}`))
    .join("\n");
}
