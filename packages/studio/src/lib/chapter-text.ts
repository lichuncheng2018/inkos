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

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Long async work (e.g. cloud sync) often expires user activation; fall back below.
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}
