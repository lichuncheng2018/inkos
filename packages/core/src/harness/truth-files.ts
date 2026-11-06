const SAFE_TRUTH_FLAT_FILE_NAMES = new Set([
  "author_intent.md",
  "current_focus.md",
  "book_rules.md",
  "style_guide.md",
  "parent_canon.md",
  "fanfic_canon.md",
  "current_state.md",
  "pending_hooks.md",
  "chapter_summaries.md",
]);

const SAFE_TRUTH_OUTLINE_FILE_NAMES = new Set([
  "outline/story_frame.md",
  "outline/volume_map.md",
]);

const SAFE_ROLE_TRUTH_FILE_RE = /^roles\/(主要角色|次要角色|major|minor)\/[^/\\]+\.md$/u;

const ALLOWED_TRUTH_FILES = [
  ...SAFE_TRUTH_FLAT_FILE_NAMES,
  ...SAFE_TRUTH_OUTLINE_FILE_NAMES,
  "roles/主要角色/<name>.md",
  "roles/次要角色/<name>.md",
].join(", ");

/** Returns the story-relative truth file name. A leading source/story/ prefix names the same file. */
export function assertSafeTruthFileName(fileName: string): string {
  const trimmed = fileName.trim().replace(/^(?:source\/)?story\//u, "");
  const withExtension = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
  const lower = withExtension.toLowerCase();
  if (
    !trimmed
    || withExtension.startsWith("/")
    || withExtension.includes("\\")
    || withExtension.includes("\0")
    || withExtension.includes("..")
  ) {
    throw invalidTruthFileName(fileName);
  }
  if (SAFE_TRUTH_FLAT_FILE_NAMES.has(lower)) return lower;
  if (SAFE_TRUTH_OUTLINE_FILE_NAMES.has(lower)) return lower;
  if (SAFE_ROLE_TRUTH_FILE_RE.test(withExtension)) return withExtension;
  throw invalidTruthFileName(fileName);
}

function invalidTruthFileName(fileName: string): Error {
  return Object.assign(new Error(
    `Invalid truth file name: ${JSON.stringify(fileName)}. Allowed: ${ALLOWED_TRUTH_FILES}. `
    + "book_rules.json is generated from bookRulesData when book_rules.md is replaced; keep other world or system rules in book_rules.md or outline/story_frame.md.",
  ), { code: "TRUTH_FILE_NAME_INVALID" });
}
