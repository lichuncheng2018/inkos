import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import { TEXTURE_BANK_PATH, parseTextureBank, renderTextureSample, sampleTextureBank } from "../utils/texture-bank.js";
import type { BookConfig } from "../models/book.js";
import type { LengthSpec } from "../models/length-governance.js";
import { buildLengthSpec } from "../utils/length-metrics.js";
import {
  ChapterIntentSchema,
  ChapterMemoSchema,
  type ChapterIntent,
  type ChapterMemo,
  type ContextPackage,
} from "../models/input-governance.js";
import { loadPlanningSeedMaterials, type PlanningSeedMaterials } from "../utils/planning-materials.js";
import { assessMemoDensity, memoDensityFeedback } from "../utils/memo-density.js";
import { ChapterMemoToolSchema } from "./planner-tool.js";
import {
  buildPlannerUserMessage,
  getPlannerMemoSystemPrompt,
  type ReaderPlanRevision,
} from "./planner-prompts.js";
import { ComposerAgent } from "./composer.js";

export interface PlanChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly externalContext?: string;
  readonly existingPlan?: PlanChapterOutput;
  readonly reviewMemo?: (memo: ChapterMemo, previousEnding?: string) => Promise<string>;
}

export interface PlanChapterOutput {
  readonly intent: ChapterIntent;
  readonly memo: ChapterMemo;
  readonly intentMarkdown: string;
  readonly plannerInputs: ReadonlyArray<string>;
  readonly runtimePath: string;
  readonly readerReviewed?: boolean;
}

interface PlanChapterMemoInput {
  readonly chapterNumber: number;
  readonly book?: Pick<BookConfig, "title" | "genre" | "platform">;
  readonly contextPackage: ContextPackage;
  readonly currentInstruction?: string;
  readonly textureSample?: string;
  readonly readerRevision?: ReaderPlanRevision;
  readonly language?: "zh" | "en";
  readonly lengthSpec: LengthSpec;
}

/** A book without a texture bank plans from the governed context alone. */
async function readTextureBank(bookDir: string): Promise<string> {
  try {
    return await readFile(join(bookDir, TEXTURE_BANK_PATH), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * The model submits the semantic plan through a typed Pi tool. The host owns
 * chapter identity and persists a readable projection separately.
 */
export class PlannerAgent extends BaseAgent {
  get name(): string {
    return "planner";
  }

  async planChapter(input: PlanChapterInput): Promise<PlanChapterOutput> {
    const storyDir = join(input.bookDir, "story");
    const runtimeDir = join(storyDir, "runtime");
    await mkdir(runtimeDir, { recursive: true });

    const seedMaterials = await loadPlanningSeedMaterials({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
    });
    let prepared: ReturnType<PlannerAgent["prepareMemoInput"]> | undefined;
    const prepare = () => prepared ??= this.prepareMemoInput(input, seedMaterials);
    const existing = input.existingPlan;
    let memo = existing?.memo ?? await this.planChapterMemo((await prepare()).request);
    let readerReviewed = false;
    if (input.reviewMemo) {
      const isEnglish = input.book.language === "en";
      try {
        const feedback = await input.reviewMemo(memo, seedMaterials.previousEndingExcerpt);
        this.ctx.signal?.throwIfAborted();
        if (feedback.trim()) {
          this.log?.info(isEnglish ? "Reworking the chapter plan once from reader feedback." : "根据读者反馈重排一次章策。");
          const { request } = await prepare();
          memo = await this.planChapterMemo({ ...request, readerRevision: { draft: memo, feedback } });
        }
        readerReviewed = true;
      } catch (error) {
        this.ctx.signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        const reason = error instanceof Error ? error.message : String(error);
        this.log?.warn(isEnglish ? `Chapter plan review could not be applied; using the original plan: ${reason}` : `章策读者审查未能应用，沿用原章策：${reason}`);
      }
    }
    this.ctx.signal?.throwIfAborted();
    if (existing && memo === existing.memo) return readerReviewed ? { ...existing, readerReviewed: true } : existing;

    const intent = ChapterIntentSchema.parse({ chapter: input.chapterNumber, goal: memo.goal });
    const runtimePath = join(runtimeDir, `chapter-${String(input.chapterNumber).padStart(4, "0")}.intent.md`);
    const intentMarkdown = this.renderIntentMarkdown(intent, memo);
    await writeFile(runtimePath, intentMarkdown, "utf-8");
    return {
      intent,
      memo,
      intentMarkdown,
      plannerInputs: (await prepare()).plannerInputs,
      runtimePath,
      ...(readerReviewed ? { readerReviewed: true } : {}),
    };
  }

  private async prepareMemoInput(input: PlanChapterInput, seedMaterials: PlanningSeedMaterials): Promise<{
    readonly request: PlanChapterMemoInput;
    readonly plannerInputs: ReadonlyArray<string>;
  }> {
    // Books created from a brief start with author_intent.md holding the same text.
    const brief = seedMaterials.brief.trim();
    const distinctBrief = brief && brief !== seedMaterials.authorIntent.trim() ? brief : "";
    const taskGoal = [...new Set([
      input.externalContext,
      seedMaterials.currentFocus,
      seedMaterials.authorIntent,
      distinctBrief,
    ].map((value) => value?.trim()).filter(Boolean))].join("\n\n")
      || (input.book.language === "en"
        ? `Continue chapter ${input.chapterNumber} from the current Work state.`
        : `根据当前作品状态续写第${input.chapterNumber}章。`);
    const selected = await new ComposerAgent(this.ctx).selectTaskContext({
      bookDir: input.bookDir,
      chapterNumber: input.chapterNumber,
      goal: taskGoal,
      language: input.book.language,
    });
    // taskGoal only steers source selection; the instruction, focus and intent
    // already reach the memo request as their own inputs.
    const governed = selected.selectedContext.filter((entry) => entry.source !== "runtime/chapter_memo");
    const directionEnd = governed.findIndex((entry) => entry.source === "story/author_intent.md") + 1;
    const contextPackage: ContextPackage = {
      ...selected,
      selectedContext: [
        ...governed.slice(0, directionEnd),
        ...(distinctBrief
          ? [{
              source: "story/brief.md",
              reason: "Original creation brief. Where it differs from author intent or current focus, those documents take precedence.",
              excerpt: distinctBrief,
              protection: "protected" as const,
            }]
          : []),
        ...governed.slice(directionEnd),
        ...(seedMaterials.previousEndingExcerpt
          ? [{
              source: `runtime/previous_chapter#${input.chapterNumber - 1}`,
              reason: "Previous chapter text required for chapter transition planning.",
              excerpt: seedMaterials.previousEndingExcerpt,
              protection: "protected" as const,
            }]
          : []),
      ],
    };
    const textureSample = renderTextureSample(
      sampleTextureBank(parseTextureBank(await readTextureBank(input.bookDir)), input.chapterNumber),
      input.book.language,
    );
    const plannerInputs = [
      ...contextPackage.selectedContext.map((entry) => entry.source),
      ...(textureSample ? [TEXTURE_BANK_PATH] : []),
    ];

    return {
      plannerInputs,
      request: {
        chapterNumber: input.chapterNumber,
        book: input.book,
        contextPackage,
        currentInstruction: input.externalContext,
        textureSample,
        language: input.book.language,
        lengthSpec: buildLengthSpec(input.book.chapterWordCount, input.book.language),
      },
    };
  }

  /** Compile the governed context into a typed semantic chapter memo. */
  async planChapterMemo(input: PlanChapterMemoInput): Promise<ChapterMemo> {
    const language = input.language ?? "zh";

    const userMessage = buildPlannerUserMessage({
      chapterNumber: input.chapterNumber,
      book: input.book,
      contextPackage: input.contextPackage,
      currentInstruction: input.currentInstruction,
      textureSample: input.textureSample,
      readerRevision: input.readerRevision,
      lengthBudget: {
        target: input.lengthSpec.target,
        unit: input.lengthSpec.countingMode === "en_words" ? "words" : "字",
      },
      language,
    });

    const systemPrompt = getPlannerMemoSystemPrompt(language);

    // One correction only: a memo that is still dense on resubmission is used as is.
    let densityChecked = false;
    const { result } = await this.submitStructured(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      {
        name: "submit_chapter_memo",
        label: "Submit chapter memo",
        description: "Submit the complete semantic chapter plan for host persistence.",
        parameters: ChapterMemoToolSchema,
        validate: (submitted) => {
          if (densityChecked) return submitted;
          densityChecked = true;
          const report = assessMemoDensity(submitted.body, language);
          if (report.dense) throw Object.assign(new Error(memoDensityFeedback(report, language)), { code: "MEMO_TOO_DENSE" });
          return submitted;
        },
      },
      { temperature: 0.7, maxTokens: this.ctx.client.defaults.maxTokens },
    );
    return ChapterMemoSchema.parse({
      chapter: input.chapterNumber,
      goal: result.goal,
      body: result.body,
      threadRefs: result.threadRefs,
    });
  }

  private renderIntentMarkdown(
    intent: ChapterIntent,
    memo: ChapterMemo,
  ): string {
    const memoBody = memo.body.trim();
    const threadRefsLine = memo.threadRefs.length > 0
      ? memo.threadRefs.map((id) => `- ${id}`).join("\n")
      : "- (none)";

    return [
      "# Chapter Intent",
      "",
      "## Goal",
      intent.goal,
      "",
      "## Chapter Memo",
      "### Thread Refs",
      threadRefsLine,
      "",
      "### Body",
      memoBody,
    ].join("\n");
  }
}
