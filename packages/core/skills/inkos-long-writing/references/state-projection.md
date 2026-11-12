# Chapter fact and state projection

## Observe explicit change

Extract only what the chapter establishes. Track character action and physical state, location, resources, relationship movement, emotion, information boundaries, plot promises, time progression, and who is present. Prefer a precise fact over an abstract summary. An implication may remain an unresolved narrative promise, but it is not a completed event.

## Write for the next reader

The planner and the writer of later chapters read these records and pick up their wording. A record written like an audit note comes back as prose that reads like one. State each fact, and each line of the chapter summary, as a plain statement of what is now true, in the story's own vocabulary: who holds what and how much, where someone is, what condition a skill or a body is in, who knows what, what is owed and to whom.

- One fact, one short statement. Give the value. Leave out how it was verified, which passage confirmed it, and how it was calculated.
- Record what happened and what is now the case. Do not append what did not happen: "has not yet", "nothing was", "is not recorded as", "is not merged with", "do not infer". When the story turns on something still missing — a debt unpaid, a pill unswallowed, a question nobody answered — state the present condition it leaves ("still holds one pill", "owes the steward two taels"), not a denial.
- The memo's notes and prohibitions guard the chapter while it is written. They are not facts; do not copy them into the state.
- An amount is the current amount with its unit. Opening balance, income, spending and closing balance are reconciled once, in the settlement account, not repeated inside each fact.
- Where the chapter stops is a place and a condition, not a list of things the character has not done.

## Project incrementally

Update the supplied runtime state instead of rebuilding it from scratch. Preserve unrelated facts and stable IDs. Character knowledge is scoped to what each person witnessed or learned. If the chapter stops at a threshold, the state must not move the character beyond it. Outline material is planning context, not evidence that an event happened.

## Hook identity and lifecycle

- Reuse an existing hook ID whenever the new wording continues the same unresolved promise, even if names, numbers, evidence form, or phrasing change.
- A mention repeats or recalls a hook without changing facts, risk, scope, relationships, or understanding. It does not advance `lastAdvancedChapter`.
- An advance adds evidence, changes risk or scope, alters a relationship, or changes what a reader or character can conclude.
- Resolve only when the chapter answers or invalidates the promise. Defer only when the story explicitly moves it into the background.
- When current author-approved foundation or a scoped revision explicitly withdraws a promise's premise, update that existing hook to `superseded`, citing the withdrawal authority in notes. Preserve its ID, original premise and historical progression. This is withdrawn planning, not an in-story payoff or postponement. Never infer withdrawal merely because a hook is absent from this chapter; never withdraw resolved history. Superseded entries remain archival records and must not be treated as active promises or required future events.
- Create a candidate only when no existing hook represents the new unresolved promise. Use `immediate`, `near-term`, `mid-arc`, `slow-burn`, or `endgame` for payoff timing.

## Numeric and cast state

When a resource system exists, every explicit delta must reconcile opening value plus change to closing value. When full-cast tracking is enabled, record present characters, mentioned absent characters, relationship changes, and information boundaries.
