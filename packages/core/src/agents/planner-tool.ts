import { Type } from "@sinclair/typebox";

export const ChapterMemoToolSchema = Type.Object({
  goal: Type.String({ minLength: 1, description: "One sentence naming the concrete change readers will see happen by the end of this chapter." }),
  body: Type.String({ minLength: 1, description: "Markdown. Start the first scene with the chosen opening action, then lay out the beats that lead to the visible result named in goal. Play out one or two scenes, pass over routine steps, and put figures and continuity constraints in the notes." }),
  threadRefs: Type.Array(Type.String({ minLength: 1, description: "An existing thread or hook id from the supplied context." })),
});
