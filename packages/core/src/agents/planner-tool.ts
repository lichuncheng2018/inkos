import { Type } from "@sinclair/typebox";

export const ChapterMemoToolSchema = Type.Object({
  goal: Type.String({ minLength: 1, description: "One sentence: what has changed for the reader by the end of the chapter. Not a summary of events." }),
  body: Type.String({ minLength: 1, description: "Markdown. Scenes that each advance, obstruct, or pay off the goal: one or two played out as short beats of exchange between people; the rest passed over in a line each; then notes the writer uses only for checking figures and continuity." }),
  threadRefs: Type.Array(Type.String({ minLength: 1, description: "An existing thread or hook id from the supplied context." })),
});
