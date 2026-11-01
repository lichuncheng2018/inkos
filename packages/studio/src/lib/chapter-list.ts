export function chaptersNewestFirst<T>(chapters: ReadonlyArray<T>): T[] {
  return [...chapters].reverse();
}
