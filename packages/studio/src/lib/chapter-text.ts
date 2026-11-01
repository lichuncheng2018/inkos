export function chapterTextForPublish(content: string): string {
  const normalized = content.replaceAll("\r\n", "\n").trim();
  if (!normalized) return "";
  const newline = normalized.indexOf("\n");
  const firstLine = newline === -1 ? normalized : normalized.slice(0, newline);
  const heading = /^#\s+(.*)$/u.exec(firstLine);
  if (!heading) return normalized;
  const title = heading[1]!.trim();
  if (newline === -1) return title;
  const body = normalized.slice(newline + 1).replace(/^\n+/u, "");
  return body ? `${title}\n\n${body}` : title;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Some browsers expose clipboard.writeText but still reject it; fall back below.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("copy failed");
}
