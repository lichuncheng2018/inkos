export function quoteSessionTitle(title: string, maxLength = 80): string {
  const compact = title.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength).trimEnd()}…`;
}
