export interface CloudLegadoSourceInput {
  readonly supabaseUrl: string;
  readonly publishableKey?: string;
}

export interface LegadoBookCard {
  readonly name: string;
  readonly author: string;
  readonly kind: string;
  readonly intro: string;
  readonly wordCount: string;
  readonly lastChapter: string;
  readonly bookUrl: string;
}

export interface LegadoChapterCard {
  readonly name: string;
  readonly url: string;
}

function originOf(supabaseUrl: string): string {
  return supabaseUrl.replace(/\/+$/u, "");
}

export function phoneLegadoSourceUrl(supabaseUrl: string): string {
  return `${originOf(supabaseUrl)}/storage/v1/object/public/inkos-reader/legado.json`;
}

export function phoneLegadoDir(supabaseUrl: string): string {
  return `${originOf(supabaseUrl)}/storage/v1/object/public/inkos-reader/legado`;
}

export function phoneLegadoCatalogUrl(supabaseUrl: string): string {
  return `${phoneLegadoDir(supabaseUrl)}/books.json`;
}

export function phoneLegadoBookUrl(supabaseUrl: string, bookId: string): string {
  return `${phoneLegadoDir(supabaseUrl)}/books/${encodeURIComponent(bookId)}.json`;
}

export function phoneLegadoChapterUrl(supabaseUrl: string, bookId: string, chapterNo: number): string {
  return `${phoneLegadoDir(supabaseUrl)}/books/${encodeURIComponent(bookId)}/${chapterNo}.json`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function chapterBodyToHtml(content: string): string {
  const body = content.replaceAll("\r\n", "\n").trim();
  if (!body) return "<p></p>";
  return body
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
}

export function buildCloudLegadoBookSource(input: CloudLegadoSourceInput): Record<string, unknown> {
  const catalog = phoneLegadoCatalogUrl(input.supabaseUrl);
  const listRule = {
    bookList: "$.books[*]",
    name: "$.name",
    author: "$.author",
    kind: "$.kind",
    intro: "$.intro",
    wordCount: "$.wordCount",
    lastChapter: "$.lastChapter",
    bookUrl: "$.bookUrl",
  };
  return {
    bookSourceName: "InkOS",
    bookSourceUrl: phoneLegadoDir(input.supabaseUrl),
    bookSourceGroup: "InkOS",
    bookSourceType: 0,
    bookSourceComment: "写完一章会推到云端。打开这本书后下拉刷新目录即可看到新章。",
    enabled: true,
    enabledExplore: true,
    exploreUrl: `作品::${catalog}`,
    searchUrl: catalog,
    ruleExplore: listRule,
    ruleSearch: listRule,
    ruleBookInfo: {
      name: "$.name",
      author: "$.author",
      kind: "$.kind",
      intro: "$.intro",
      wordCount: "$.wordCount",
      lastChapter: "$.lastChapter",
    },
    ruleToc: {
      chapterList: "$.chapters[*]",
      chapterName: "$.name",
      chapterUrl: "$.url",
    },
    ruleContent: {
      content: "@json:$.content",
    },
  };
}

export function buildCloudLegadoBookSourceFile(input: CloudLegadoSourceInput): string {
  return JSON.stringify([buildCloudLegadoBookSource(input)]);
}

export function buildLegadoCatalogFile(books: readonly LegadoBookCard[]): string {
  return JSON.stringify({ books });
}

export function buildLegadoBookFile(input: {
  readonly name: string;
  readonly author: string;
  readonly kind: string;
  readonly intro: string;
  readonly wordCount: string;
  readonly lastChapter: string;
  readonly chapters: readonly LegadoChapterCard[];
}): string {
  return JSON.stringify(input);
}

export function buildLegadoChapterFile(content: string): string {
  return JSON.stringify({ content });
}
