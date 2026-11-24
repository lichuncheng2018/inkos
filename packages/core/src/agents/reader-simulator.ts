import { Value } from "@sinclair/typebox/value";
import { BaseAgent } from "./base.js";
import { SourcedReviewIndexToolSchema } from "./review-tool.js";
import type { Observation } from "../models/observation.js";
import { numberReviewSource } from "../models/observation.js";

export interface ReaderSimulationInput {
  readonly storyTitle: string;
  readonly genre?: string;
  readonly platform?: string;
  readonly chapterNumber: number;
  readonly chapterTitle: string;
  readonly chapterContent: string;
  readonly previousChapterSummary?: string;
  readonly language: "zh" | "en";
}

export interface ReaderSimulationResult {
  readonly summary: string;
  readonly observations: ReadonlyArray<Observation>;
  readonly tokenUsage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export class ReaderSimulatorAgent extends BaseAgent {
  get name(): string {
    return "reader-simulator";
  }

  async simulateChapter(input: ReaderSimulationInput): Promise<ReaderSimulationResult> {
    const isEnglish = input.language === "en";
    const sourceId = `chapter-${input.chapterNumber}`;
    const observationExample = JSON.stringify({
      code: "weak-payoff",
      assessment: "issue",
      summary: isEnglish ? "Describe the issue and its effect on the reader." : "说明具体问题及其对读者的影响。",
      sourceRefs: [{ sourceId, startLine: 1, endLine: 1 }],
    });
    const systemPrompt = isEnglish
      ? `Simulate one target-platform reader encountering this chapter after the supplied previous-chapter context. You know only the story title, genre, platform, prior chapter context, and this chapter. Do not infer outlines, future events, private canon, or author requests.
First identify what the chapter makes the reader wait for and the first line where the reader can see the result. Check whether the chapter gives the decisive moment, the character's response and the changed situation enough room. If procedure or backstory delays it, cite the stretch to compress. When a result is only announced, point to where the reader could see its effect. Quiet chapters can deliver a small but felt change.
For repeated stakes, explanations or summaries, cite both the first telling and the repetition and say which lines can be condensed or cut. A later detail can earn its place by affecting a choice, revealing pressure or changing how the result feels.
Prioritize major pacing and payoff issues over small wording fixes. Also consider comprehension, emotional engagement and the ending. Return only actionable issues with exact lines from the current chapter and their effect on this reader. Do not invent canon, demand changes based on taste, rewrite prose, or cite the previous chapter.
Every entry in observations must be an object like ${observationExample}. Replace the example line numbers with the actual inclusive ranges from this chapter. Include at least one range per issue. Omit any issue you cannot cite. If none remain, submit observations as [].`
      : `模拟一位符合题材和平台的目标读者。你只知道书名、题材、平台、前章内容和当前章节。不要推测大纲、后续事件、未公开的设定或作者要求。
先找本章让读者等着看什么，以及读者在哪一行第一次亲眼看到结果。检查关键一幕、人物当场反应和局势的变化各有没有写到位。如果流程或补叙把兑现拖晚了，指出可以缩短的连续行段。如果结果只靠转述交代，指出哪一幕可以让读者看到它造成的变化。舒缓章也可以兑现一个能感受到的小变化。
同一利害、解释或结论讲多遍时，同时引用首次出现和重复的行号，说清哪段可以合并或删减。有些细节会改变选择、显出压力或让结果更有分量，评估时要保留它的作用。
优先报实质的节奏和兑现问题，再看理解、情绪投入和章尾吸引力。每条只报有本章准确行号依据、能执行的改动和它对读者的影响。不要编设定、拿个人口味当缺陷、直接改写正文或引用前章。
observations 中每条都必须是形如 ${observationExample} 的对象。用本章的实际起止行号替换示例行号，每条至少引用一个范围。省略无法引证的问题，没有可提交的问题时将 observations 设为 []。`;
    const userPrompt = JSON.stringify({
      story: {
        title: input.storyTitle,
        ...(input.genre ? { genre: input.genre } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
      },
      previousChapterSummary: input.previousChapterSummary ?? "",
      chapter: {
        number: input.chapterNumber,
        title: input.chapterTitle,
        sourceId,
        numberedLines: numberReviewSource(input.chapterContent),
      },
    });
    const { result, usage } = await this.submitSourcedReview(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      new Map([[sourceId, input.chapterContent]]),
      {
        name: "submit_reader_simulation",
        label: isEnglish ? "Submit reader feedback" : "提交读者反馈",
        description: isEnglish ? "Submit actionable, source-backed reader feedback." : "提交有正文依据、可执行的读者反馈。",
        normalize: (submission) => {
          if (!submission || typeof submission !== "object" || !("observations" in submission) || !Array.isArray(submission.observations)) {
            return submission;
          }
          const schema = SourcedReviewIndexToolSchema.properties.observations.items;
          const observations = submission.observations.filter((observation) => Value.Check(schema, observation));
          // Give the worker a chance to correct the submission when no actionable finding survives.
          return observations.some((observation) => observation.assessment === "issue" && observation.sourceRefs.length > 0)
            ? { ...submission, observations }
            : submission;
        },
      },
      {
        temperature: 0.35,
        maxTokens: Math.min(4096, this.ctx.client.defaults.maxTokens),
        professionalGuidance: false,
        includeAuthorRequest: false,
      },
    );

    const observations = result.observations
      .filter((observation) => observation.assessment === "issue")
      .map((observation, index) => ({
        ...observation,
        code: `reader-${observation.code.trim() || index + 1}`,
        category: "quality" as const,
        assessment: "issue" as const,
      }));
    return { summary: result.summary, observations, tokenUsage: usage };
  }
}
