/**
 * One craft Skill serves several workers: the planner, the prose writer, the
 * state settler, the reviewer. Handing all of them the whole method buries the
 * part each one needs. A Skill may therefore scope its sections with marker
 * lines:
 *
 *   <!-- audience: planner, reviewer -->
 *
 * Text before the first marker reaches every worker. A marker scopes what
 * follows to the named audiences until the next marker; `all` ends a scope. A
 * Skill without markers, or a worker without an audience, gets the whole body.
 */
const AUDIENCE_MARKER = /^[ \t]*<!--\s*audience:\s*([a-z][a-z0-9_, -]*?)\s*-->[ \t]*$/i;

function markerAudiences(line: string): Set<string> | undefined {
  const match = AUDIENCE_MARKER.exec(line.replace(/\r$/, ""));
  if (!match) return undefined;
  return new Set(match[1]!.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
}

export function hasSkillAudiences(body: string): boolean {
  return body.split("\n").some((line) => markerAudiences(line) !== undefined);
}

export function skillBodyForAudience(body: string, audience: string | undefined): string {
  if (!hasSkillAudiences(body)) return body;
  const reader = audience?.trim().toLowerCase();
  const kept: string[] = [];
  let scope: Set<string> | undefined;
  for (const line of body.split("\n")) {
    const next = markerAudiences(line);
    if (next) {
      scope = next.has("all") ? undefined : next;
      continue;
    }
    if (!reader || !scope || scope.has(reader)) kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
