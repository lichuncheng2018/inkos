/**
 * A book's genre is stored as one string: a top-level category, optionally followed by
 * "/" and the author's own sub-genre words, e.g. "玄幻/宗门 加点 系统".
 */
export interface GenreParts {
  readonly category: string;
  readonly detail: string;
}

const GENRE_CATEGORIES_ZH: ReadonlyArray<string> = [
  "玄幻",
  "仙侠修真",
  "都市",
  "都市高武",
  "历史",
  "科幻",
  "悬疑灵异",
  "武侠",
  "游戏竞技",
  "军事",
  "末世",
  "古代言情",
  "现代言情",
  "幻想言情",
  "其他",
];

const GENRE_CATEGORIES_EN: ReadonlyArray<string> = [
  "Fantasy",
  "Cultivation",
  "Progression",
  "Sci-fi",
  "Urban fantasy",
  "Mystery",
  "Thriller",
  "Horror",
  "Romance",
  "Historical",
  "Other",
];

const GENRE_SEPARATOR = "/";

export function genreCategoriesForLanguage(language: "zh" | "en"): ReadonlyArray<string> {
  return language === "en" ? GENRE_CATEGORIES_EN : GENRE_CATEGORIES_ZH;
}

export function splitGenre(genre: string | undefined, categories: ReadonlyArray<string>): GenreParts {
  const value = genre?.trim() ?? "";
  if (!value || value.toLowerCase() === "other") return { category: "", detail: "" };
  const category = [...categories]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => value === candidate || value.startsWith(`${candidate}${GENRE_SEPARATOR}`));
  if (!category) return { category: "", detail: value };
  return { category, detail: value.slice(category.length + GENRE_SEPARATOR.length).trim() };
}

export function joinGenre(parts: GenreParts): string {
  const category = parts.category.trim();
  if (!category) return "";
  const detail = parts.detail.trim().replace(/^\/+/, "").trim();
  return detail ? `${category}${GENRE_SEPARATOR}${detail}` : category;
}
