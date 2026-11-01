import { Type } from "@sinclair/typebox";

const HookRecordToolSchema = Type.Object({
  hookId: Type.String(),
  startChapter: Type.Integer({ minimum: 0 }),
  type: Type.String(),
  status: Type.Union([
    Type.Literal("open"),
    Type.Literal("progressing"),
    Type.Literal("deferred"),
    Type.Literal("resolved"),
    Type.Literal("superseded"),
  ]),
  lastAdvancedChapter: Type.Integer({ minimum: 0 }),
  expectedPayoff: Type.String(),
  notes: Type.String(),
  dependsOn: Type.Optional(Type.Array(Type.String())),
  paysOffInArc: Type.Optional(Type.String()),
});

const ChapterSummaryToolSchema = Type.Object({
  title: Type.String(),
  characters: Type.String(),
  events: Type.String(),
  stateChanges: Type.String(),
  hookActivity: Type.String(),
  mood: Type.String(),
  chapterType: Type.String(),
});

const StateFactToolSchema = Type.Object({
  subject: Type.String({ minLength: 1, description: "Stable entity or scope the fact describes." }),
  predicate: Type.String({ minLength: 1, description: "Natural-language relation or state name." }),
  object: Type.String({ minLength: 1, description: "Value explicitly established by the chapter." }),
});

const StateFactSelectorToolSchema = Type.Object({
  subject: Type.String({ minLength: 1 }),
  predicate: Type.String({ minLength: 1 }),
  object: Type.Optional(Type.String({ minLength: 1 })),
});

export const SettlementToolSchema = Type.Object({
  postSettlement: Type.String({
    description: "Concise account of the state changes grounded in this chapter. If omitted, the host copies chapterSummary.stateChanges or events.",
  }),
  factOps: Type.Object({
    upsert: Type.Array(StateFactToolSchema, { description: "Facts made current by this chapter.", default: [] }),
    expire: Type.Array(StateFactSelectorToolSchema, {
      description: "Previously active facts explicitly ended or superseded by this chapter. Submit [] when none expired.",
      default: [],
    }),
  }),
  hookOps: Type.Object({
    upsert: Type.Array(HookRecordToolSchema, {
      description: "Full updates for existing hook ids. Use superseded only when current author-approved foundation or revision explicitly withdraws the premise; cite that authority in notes and preserve the original hook content. Absence from a chapter is not withdrawal. Never invent an id here or withdraw a resolved hook.",
      default: [],
    }),
    mention: Type.Array(Type.String(), { description: "Exact existing hook ids mentioned without changing status. Submit [] when none.", default: [] }),
    resolve: Type.Array(Type.String(), { description: "Exact existing hook ids resolved by this chapter. Submit [] when none.", default: [] }),
    defer: Type.Array(Type.String(), { description: "Exact existing hook ids explicitly deferred by this chapter. Submit [] when none.", default: [] }),
  }),
  newHookCandidates: Type.Array(Type.Object({
    type: Type.String({ minLength: 1 }),
    expectedPayoff: Type.String({ minLength: 1 }),
    notes: Type.String(),
  }), { description: "Brand-new unresolved promises. Do not assign a hook id; the host assigns the canonical id. Submit [] when none.", default: [] }),
  chapterSummary: ChapterSummaryToolSchema,
});

export function createSettlementToolSchema(allowNewHooks = true) {
  return Type.Object({
    ...SettlementToolSchema.properties,
    newHookCandidates: Type.Array(SettlementToolSchema.properties.newHookCandidates.items, {
      description: allowNewHooks ? "New unresolved promises without assigned ids. Submit [] when none." : "This recovery preserves existing hook ids. Submit an empty array; new hooks are not permitted.",
      default: [],
      ...(allowNewHooks ? {} : { maxItems: 0 }),
    }),
  });
}

const KNOWN_HOOK_ID_LIMIT = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultArray(record: Record<string, unknown>, key: string): void {
  if (record[key] === undefined) record[key] = [];
}

function settlementNarrative(chapterSummary: unknown): string {
  if (!isRecord(chapterSummary)) return "";
  for (const key of ["stateChanges", "events", "hookActivity"] as const) {
    const value = chapterSummary[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Fill omitted empty collections and a missing postSettlement string.
 * Models often drop [] fields and skip postSettlement after emitting chapterSummary.
 * Do not invent factOps, chapterSummary, or hook record bodies.
 */
export function normalizeSettlementSubmission(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = { ...value };

  if (isRecord(next.factOps)) {
    const factOps = { ...next.factOps };
    defaultArray(factOps, "upsert");
    defaultArray(factOps, "expire");
    next.factOps = factOps;
  }

  if (next.hookOps === undefined) {
    next.hookOps = { upsert: [], mention: [], resolve: [], defer: [] };
  } else if (isRecord(next.hookOps)) {
    const hookOps = { ...next.hookOps };
    defaultArray(hookOps, "upsert");
    defaultArray(hookOps, "mention");
    defaultArray(hookOps, "resolve");
    defaultArray(hookOps, "defer");
    next.hookOps = hookOps;
  }

  if (next.newHookCandidates === undefined) next.newHookCandidates = [];

  if (next.postSettlement === undefined) {
    next.postSettlement = settlementNarrative(next.chapterSummary);
  }

  return next;
}

export function validateSettlementHookIds<T extends {
  readonly hookOps: {
    readonly upsert: ReadonlyArray<{ readonly hookId: string }>;
    readonly mention: ReadonlyArray<string>;
    readonly resolve: ReadonlyArray<string>;
    readonly defer: ReadonlyArray<string>;
  };
}>(value: T, knownHookIds: ReadonlySet<string>): T {
  const submittedIds = [
    ...value.hookOps.upsert.map((hook) => hook.hookId),
    ...value.hookOps.mention,
    ...value.hookOps.resolve,
    ...value.hookOps.defer,
  ];
  const unknown = [...new Set(submittedIds.filter((hookId) => !knownHookIds.has(hookId)))];
  if (unknown.length > 0) {
    const known = [...knownHookIds].sort();
    const shown = known.slice(0, KNOWN_HOOK_ID_LIMIT);
    const extra = known.length > shown.length ? ` (${known.length - shown.length} more)` : "";
    throw Object.assign(new Error(
      `Unknown hook id(s): ${unknown.join(", ")}. Existing hook operations accept only ids from the supplied ledger`
      + (shown.length ? `; known ids: ${shown.join(", ")}${extra}` : "")
      + "; submit a newHookCandidate for a new promise.",
    ), { code: "WORKER_DOMAIN_INVALID" });
  }
  return value;
}
