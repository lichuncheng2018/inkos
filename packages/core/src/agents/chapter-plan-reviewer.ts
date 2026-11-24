import { Type, type Static } from "@sinclair/typebox";
import { BaseAgent } from "./base.js";
import { SourcedReviewIndexToolSchema } from "./review-tool.js";
import { recordExecutionEvidence } from "../harness/execution-evidence.js";
import type { BookConfig } from "../models/book.js";
import type { ChapterMemo } from "../models/input-governance.js";
import { numberReviewSource, resolveObservationSources } from "../models/observation.js";
import { splitChapterMemoBody } from "../utils/narrative-control.js";
import { sourceLineBodies } from "../utils/source-text.js";
import { previousChapterTail } from "../utils/writer-context.js";

const ChapterPlanReviewToolSchema = Type.Object({
  premiseOpeningLine: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], {
    description: "In chapter one, the later eligible event that shows the distinctive premise if the drafted opening is routine setup and the prerequisites can be briefly backfilled. Otherwise return null.",
  }),
  openingLine: Type.Integer({ minimum: 1, description: "The numbered event from eligibleOpeningLines that should be the first beat on the page." }),
  ...SourcedReviewIndexToolSchema.properties,
});

export class ChapterPlanReviewerAgent extends BaseAgent {
  get name(): string {
    return "chapter-plan-reviewer";
  }

  async reviewPlan(input: {
    readonly book: Pick<BookConfig, "title" | "genre" | "platform" | "language">;
    readonly memo: ChapterMemo;
    readonly previousEnding?: string;
  }): Promise<string> {
    const { book, memo } = input;
    const isEnglish = book.language === "en";
    const { scenes } = splitChapterMemoBody(memo.body);
    const sourceId = `chapter-${memo.chapter}-plan`;
    const lines = sourceLineBodies(scenes)
      .map((text, index) => ({ number: index + 1, text: text.trim() }))
      .filter(({ text }) => text && !text.startsWith("#"));
    const beats = lines.filter(({ text }) => /^(?:[-*+]|\d+[.)])\s+/u.test(text));
    const openingBeats = new Map((beats.length ? beats : lines).map(({ number, text }) => [number, text]));
    const firstBeat = openingBeats.keys().next().value;
    if (firstBeat === undefined) return "";

    const system = isEnglish
      ? `Read this chapter plan as a prospective reader using only the book information, preceding chapter's ending, and visible scene beats. Compare the drafted opening against the strongest later entry moment. Choose the exact first beat from eligibleOpeningLines and return its number in openingLine, even if there are no other issues. In chapter one, first identify an event that brings the book's distinctive premise onto the page. Ask whether the drafted opening would still happen the same way if that premise were removed. If it would, and a later event brings the premise into play with prerequisites that can be briefly backfilled, choose that later event over the routine setup. The earliest event in time need not be the first on the page. If the book is building a deliberate mystery, choose the action that puts the central question in play.
For chapter one, if the current opening is routine setup independent of the book's premise and a later premise event can be shown up front, return that event in premiseOpeningLine. This specific finding takes precedence over openingLine. First contact, a sudden discovery, or the appearance of what makes the book distinctive already puts the premise in play. In that case keep that entry moment and let its consequence pay off later in the chapter. Use null when the opening already puts the premise in play, no eligible premise event is available, or this is a later chapter.
Then check what meaningful result the chapter delivers and what question the ending leaves. If it sets up an immediate problem and stops at accepting the task or starting work, identify the missing visible consequence. Report up to two material issues, citing the exact numbered scene lines and the change to make. Openings, choices, relationship changes, and other quiet outcomes can work without a cliffhanger. Use existing events and their prerequisites. Leave observations empty when no other issue warrants reordering.`
      : `按目标读者的视角读章策，只依据作品资料、上章结尾和本章可见节拍。先比较当前开场和后面最值得直接切入的事件，再从 eligibleOpeningLines 指定一个真正的首拍，在 openingLine 返回准确行号。即便没有其他问题，也必须选首拍。第1章先找出独特卖点真正出现在纸面上的动作，再问：去掉这本书的独特设定，原开场是否还会照样发生？若会，而后面有卖点实际出场的动作，且前提可以简短补叙，就选后者作首拍。普通故障或测试的流程顺畅，也照此判断。作品有意留谜时，选能把核心疑问摆到读者眼前的动作。
首章如果开场只是普通铺垫，后面已有可直接切入的卖点事件，在 premiseOpeningLine 单独填那个事件的准确行号。这一项优先于 openingLine。主角首次遭遇、发现或启动作品独有的事物，已经让卖点登场。这种开场保留首拍，效果随后在章内兑现。开场已体现卖点，或后面没有可直接切入的事件，或正在审查后续章节，则填 null。
再判断当章有什么可见的变化、章尾留下什么具体问题。若眼前难题只写到接任务或开始做，指出缺了哪项可见结果。最多报告两处需要改动的问题，每条引用准确的场次行号并给出具体改法。一次选择、认知或关系变化都可以是安静章的结果。沿用已有事件及其因果前提，避免编造情节、强加悬念或挑正文措辞。其他场次顺畅时，observations 可以为空。`;
    const user = JSON.stringify({
      book: { title: book.title, genre: book.genre, platform: book.platform },
      chapterNumber: memo.chapter,
      previousEnding: previousChapterTail(input.previousEnding),
      eligibleOpeningLines: [...openingBeats.keys()],
      plan: { sourceId, numberedLines: numberReviewSource(scenes) },
    });
    const sources = new Map([[sourceId, scenes]]);
    const resolveFindings = (observations: Static<typeof ChapterPlanReviewToolSchema>["observations"]) =>
      resolveObservationSources(observations.map((item) => ({ ...item, evidence: [] })), sources);
    const { result } = await this.submitStructured(
      [{ role: "system", content: system }, { role: "user", content: user }],
      {
        name: "submit_chapter_plan_review",
        label: isEnglish ? "Review chapter plan as a reader" : "盲读章策",
        description: isEnglish ? "Choose the first beat and submit sourced feedback on the scene plan." : "指定开场首拍并提交有章策依据的反馈。",
        parameters: ChapterPlanReviewToolSchema,
        validate: (submitted) => {
          if (!openingBeats.has(submitted.openingLine)) {
            throw new Error("openingLine must be one of the event lines in eligibleOpeningLines.");
          }
          if (memo.chapter === 1 && submitted.premiseOpeningLine !== null && !openingBeats.has(submitted.premiseOpeningLine)) {
            throw new Error("premiseOpeningLine must be null or one of the event lines in eligibleOpeningLines.");
          }
          resolveFindings(submitted.observations);
          return submitted;
        },
      },
      {
        temperature: 0.35,
        maxTokens: Math.min(4096, this.ctx.client.defaults.maxTokens),
        professionalGuidance: false,
        includeAuthorRequest: false,
      },
    );

    const selectedOpening = memo.chapter === 1 ? result.premiseOpeningLine ?? result.openingLine : result.openingLine;
    recordExecutionEvidence("chapter-plan-opening", {
      chapterNumber: memo.chapter, originalOpeningLine: firstBeat, selectedOpeningLine: selectedOpening,
    });
    const opening = selectedOpening === firstBeat ? "" : isEnglish
      ? `Open on the action at line ${selectedOpening}. Make it the first beat and fold the earlier setup into brief context as needed.\n> ${openingBeats.get(selectedOpening)}`
      : `首场第一拍从第${selectedOpening}行的动作开始。前置情节所需的信息放到读者用得着的地方简短补叙。\n> ${openingBeats.get(selectedOpening)}`;
    const findings = resolveFindings(result.observations)
      .filter((issue) => issue.assessment === "issue" && issue.summary.trim())
      .slice(0, 2)
      .map((issue) => [issue.summary.trim(), ...issue.sourceRefs.map((ref) => `> ${ref.quote}`)].join("\n"));
    return [opening, ...findings].filter(Boolean).join("\n\n");
  }
}
