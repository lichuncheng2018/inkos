import { BaseAgent } from "./base.js";
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
    const systemPrompt = isEnglish
      ? "Simulate one target-platform reader encountering this chapter after the supplied previous-chapter context. You know only the story title, genre, platform, prior chapter context, and this chapter. Do not use or infer from outlines, future events, private canon, author requests, or information a reader has not seen. Judge only comprehension, pacing, emotional engagement, chapter payoff, and the ending hook. Return only concrete, actionable issues supported by the current chapter. Do not invent canon, demand changes based only on taste, rewrite prose, or cite the previous chapter. Every issue must cite exact numbered lines from the current chapter and explain its effect on this reader. An empty observations array is valid."
      : "模拟一位符合题材和平台的目标读者，在读过前章内容后阅读本章。你只知道书名、题材、平台、前章内容和当前章节。不要使用或推测大纲、后续事件、未向读者公开的设定、作者要求或其他读者尚未看到的信息。只评估理解是否顺畅、节奏、情绪投入、本章回报和结尾吸引力。只提出当前正文能够支持且可以执行的具体问题，不要臆造设定，不要把个人口味当作缺陷，也不要直接改写正文或引用前章。每条问题都必须引用当前章节的准确行号，并说明它对读者体验的影响。observations 为空是合法结果。";
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
