import { BaseAgent } from "./base.js";
import {renderChapterDocument} from '../utils/chapter-document.js';
import type { BookConfig } from "../models/book.js";
import type { BookRules } from "../models/book-rules.js";
import { buildWriterSystemPrompt } from "./writer-prompts.js";
import { buildSettlerSystemPrompt, buildSettlerUserPrompt } from "./settler-prompts.js";
import { createSettlementToolSchema, normalizeSettlementSubmission, validateSettlementHookIds } from "./settler-tool.js";
import { readBookRules } from "./rules-reader.js";
import { readChapterHeading } from "../utils/chapter-splitter.js";
import { runWorkerAgent } from "../agent/worker-agent.js";
import type { ChapterIntent, ChapterMemo, ContextPackage } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { ChapterMeta } from "../models/chapter.js";
import { RuntimeStateDeltaSchema, type RuntimeStateDelta } from "../models/runtime-state.js";
import { buildLengthSpec, countChapterLength } from "../utils/length-metrics.js";
import {
  buildRuntimeStateArtifacts,
  buildRuntimeStateArtifactsFromSnapshot,
  loadRuntimeStateSnapshot,
  loadRuntimeStateSnapshotAtChapter,
  type RuntimeStateArtifacts,
} from "../state/runtime-state-store.js";
import type { RuntimeStateSnapshot } from "../state/state-reducer.js";
import { renderMemoAsNarrativeBlock, renderNarrativeSelectedContext } from "../utils/narrative-control.js";
import { previousChapterTail, renderWriterContext, selectWriterContext } from "../utils/writer-context.js";
import { readPreviousEndingExcerpt } from "../utils/planning-materials.js";
import { currentExecutionAuthorRequest } from "../harness/execution-evidence.js";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { commitAtomicFileSet, type AtomicFileWrite } from "../utils/atomic-file-set.js";
import {
  renderChapterSummariesProjection,
  renderCurrentStateProjection,
  renderHooksProjection,
} from "../state/state-projections.js";


export interface WriteChapterInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly externalContext?: string;
  readonly chapterIntent: string;
  readonly chapterMemo: ChapterMemo;
  readonly chapterIntentData?: ChapterIntent;
  readonly contextPackage: ContextPackage;
  readonly lengthSpec?: LengthSpec;
  readonly wordCountOverride?: number;
  readonly temperatureOverride?: number;
}

export interface SettleChapterStateInput {
  readonly book: BookConfig;
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly allowReapply?: boolean;
  readonly allowNewHooks?: boolean;
  readonly baselineChapter?: number;
  readonly chapterIntent: string;
  readonly contextPackage: ContextPackage;
  readonly validationFeedback?: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface WriteChapterOutput {
  readonly chapterNumber: number;
  readonly title: string;
  readonly content: string;
  readonly wordCount: number;
  readonly postSettlement: string;
  readonly runtimeStateDelta: RuntimeStateDelta;
  readonly runtimeStateSnapshot: RuntimeStateSnapshot;
  readonly updatedState: string;
  readonly updatedHooks: string;
  readonly updatedChapterSummaries: string;
  readonly runtimeStateApplied: boolean;
  readonly tokenUsage?: TokenUsage;
}

export class WriterAgent extends BaseAgent {
  get name(): string {
    return "writer";
  }

  private localize(language: "zh" | "en", messages: { zh: string; en: string }): string {
    return language === "en" ? messages.en : messages.zh;
  }

  private logInfo(language: "zh" | "en", messages: { zh: string; en: string }): void {
    this.ctx.logger?.info(this.localize(language, messages));
  }

  private logWarn(language: "zh" | "en", messages: { zh: string; en: string }): void {
    this.ctx.logger?.warn(this.localize(language, messages));
  }

  async writeChapter(input: WriteChapterInput): Promise<WriteChapterOutput> {
    const { book, bookDir, chapterNumber } = input;

    const [styleGuide, runtimeSnapshot, previousChapter] = await Promise.all([
      this.readFileOrDefault(join(bookDir, "story/style_guide.md")),
      loadRuntimeStateSnapshot(bookDir),
      readPreviousEndingExcerpt(bookDir, chapterNumber),
    ]);

    const parsedBookRules = await readBookRules(bookDir);
    const bookRules = parsedBookRules.rules;
    const bookRulesBody = parsedBookRules.body;

    const resolvedLanguage = book.language;
    const targetWords = input.lengthSpec?.target ?? input.wordCountOverride ?? book.chapterWordCount;
    const resolvedLengthSpec = input.lengthSpec ?? buildLengthSpec(targetWords, resolvedLanguage, book);
    if (!input.chapterIntent || !input.chapterMemo || !input.contextPackage) {
      throw new Error("Writer requires governed chapter intent, memo, and context package.");
    }
    // ── Phase 1: Creative writing (temperature 0.7) ──
    const creativeSystemPrompt = buildWriterSystemPrompt(
      book, bookRules, bookRulesBody, styleGuide,
      resolvedLanguage,
      resolvedLengthSpec,
    );

    const creativeUserPrompt = this.buildGovernedUserPrompt({
      chapterNumber,
      chapterMemo: input.chapterMemo,
      chapterIntentData: input.chapterIntentData,
      contextPackage: input.contextPackage,
      externalContext: input.externalContext,
      previousChapter,
      lengthSpec: resolvedLengthSpec,
      language: book.language,
    });

    const creativeTemperature = input.temperatureOverride ?? 0.7;

    this.logInfo(resolvedLanguage, {
      zh: `阶段 1：创作正文（第${chapterNumber}章）`,
      en: `Phase 1: creative writing for chapter ${chapterNumber}`,
    });

    // Prose written into a tool-call argument reads markedly more machine-like than the same request answered as plain text.
    const creativeResponse = await this.chat(
      [
        { role: "system", content: creativeSystemPrompt },
        { role: "user", content: creativeUserPrompt },
      ],
      { temperature: creativeTemperature },
    );
    const draft = parseChapterDraftText(creativeResponse.content);
    if (!draft.content) {
      throw Object.assign(new Error("Writer returned no chapter prose."), { code: "CHAPTER_BODY_EMPTY" });
    }
    const titled = draft.title
      ? { title: draft.title, usage: undefined }
      : await this.titleUntitledDraft(draft.content, resolvedLanguage);
    const creativeUsage: TokenUsage = {
      promptTokens: creativeResponse.usage.promptTokens + (titled.usage?.promptTokens ?? 0),
      completionTokens: creativeResponse.usage.completionTokens + (titled.usage?.completionTokens ?? 0),
      totalTokens: creativeResponse.usage.totalTokens + (titled.usage?.totalTokens ?? 0),
    };
    const creative = {
      title: titled.title,
      content: draft.content,
      wordCount: countChapterLength(draft.content, resolvedLengthSpec.countingMode),
    };

    // ── Phase 2: State settlement (temperature 0.3) ──
    this.logInfo(resolvedLanguage, {
      zh: `阶段 2：状态结算（第${chapterNumber}章，${creative.wordCount}字）`,
      en: `Phase 2: state settlement for chapter ${chapterNumber} (${creative.wordCount} words)`,
    });
    const settleResult = await this.settle({
      book,
      bookDir,
      bookRules,
      language: resolvedLanguage,
      chapterNumber,
      title: creative.title,
      content: creative.content,
      chapterIntent: input.chapterIntent,
      contextPackage: input.contextPackage,
      validationFeedback: undefined,
      baselineSnapshot: runtimeSnapshot,
    });
    const settlement = settleResult.settlement;
    const settleUsage = settleResult.usage;
    const runtimeStateArtifacts = await this.buildRuntimeStateArtifactsIfPresent(
      bookDir,
      settlement.runtimeStateDelta,
      resolvedLanguage,
      chapterNumber,
    );
    const resolvedRuntimeStateDelta = runtimeStateArtifacts?.resolvedDelta ?? settlement.runtimeStateDelta;

    // ── Merge into WriteChapterOutput ──
    const tokenUsage: TokenUsage = {
      promptTokens: creativeUsage.promptTokens + settleUsage.promptTokens,
      completionTokens: creativeUsage.completionTokens + settleUsage.completionTokens,
      totalTokens: creativeUsage.totalTokens + settleUsage.totalTokens,
    };

    return {
      chapterNumber,
      title: creative.title,
      content: creative.content,
      wordCount: creative.wordCount,
      postSettlement: settlement.postSettlement,
      runtimeStateDelta: resolvedRuntimeStateDelta,
      runtimeStateSnapshot: runtimeStateArtifacts.snapshot,
      updatedState: runtimeStateArtifacts.currentStateMarkdown,
      updatedHooks: runtimeStateArtifacts.hooksMarkdown,
      updatedChapterSummaries: runtimeStateArtifacts.chapterSummariesMarkdown,
      runtimeStateApplied: true,
      tokenUsage,
    };
  }

  /** Ask only for a title so a draft that omitted its heading keeps its prose unchanged. */
  private async titleUntitledDraft(
    content: string,
    language: "zh" | "en",
  ): Promise<{ readonly title: string; readonly usage: TokenUsage }> {
    const response = await runWorkerAgent(this.ctx.client, this.ctx.model, [
      {
        role: "system",
        content: language === "en"
          ? "Give the chapter a short, plain title. Reply with the title only, without a chapter number or quotes."
          : "给这一章起一个简短直白的章名。只回复章名本身，不带章节序号和引号。",
      },
      { role: "user", content: content.slice(0, 4000) },
    ], { temperature: 0.3, maxTokens: 64, signal: this.ctx.signal });
    const line = response.content.trim().split("\n")[0] ?? "";
    const title = cleanDraftTitle(readChapterHeading(line)?.title || line);
    return { title: title || (language === "en" ? "Untitled" : "无题"), usage: response.usage };
  }

  async settleChapterState(input: SettleChapterStateInput): Promise<WriteChapterOutput> {
    const runtimeSnapshot = await (input.baselineChapter === undefined
        ? loadRuntimeStateSnapshot(input.bookDir)
        : loadRuntimeStateSnapshotAtChapter({
            bookDir: input.bookDir,
            chapterNumber: input.baselineChapter,
            language: input.book.language,
          }));

    const parsedBookRules = await readBookRules(input.bookDir);
    const bookRules = parsedBookRules.rules;
    const resolvedLanguage = input.book.language;

    const settleResult = await this.settle({
      book: input.book,
      bookDir: input.bookDir,
      bookRules,
      language: resolvedLanguage,
      chapterNumber: input.chapterNumber,
      title: input.title,
      content: input.content,
      chapterIntent: input.chapterIntent,
      contextPackage: input.contextPackage,
      validationFeedback: input.validationFeedback,
      baselineSnapshot: runtimeSnapshot,
      allowNewHooks: input.allowNewHooks,
    });
    const settlement = settleResult.settlement;
    const runtimeStateArtifacts = await this.buildRuntimeStateArtifactsIfPresent(
      input.bookDir,
      settlement.runtimeStateDelta,
      resolvedLanguage,
      input.chapterNumber,
      input.allowReapply,
      input.baselineChapter,
      input.allowNewHooks,
    );

    return {
      chapterNumber: input.chapterNumber,
      title: input.title,
      content: input.content,
      wordCount: countChapterLength(
        input.content,
        resolvedLanguage === "en" ? "en_words" : "zh_chars",
      ),
      postSettlement: settlement.postSettlement,
      runtimeStateDelta: runtimeStateArtifacts?.resolvedDelta ?? settlement.runtimeStateDelta,
      runtimeStateSnapshot: runtimeStateArtifacts.snapshot,
      updatedState: runtimeStateArtifacts.currentStateMarkdown,
      updatedHooks: runtimeStateArtifacts.hooksMarkdown,
      updatedChapterSummaries: runtimeStateArtifacts.chapterSummariesMarkdown,
      runtimeStateApplied: true,
      tokenUsage: settleResult.usage,
    };
  }

  private async settle(params: {
    readonly book: BookConfig;
    readonly bookDir: string;
    readonly bookRules: BookRules | null;
    readonly language: "zh" | "en";
    readonly chapterNumber: number;
    readonly title: string;
    readonly content: string;
    readonly chapterIntent: string;
    readonly contextPackage: ContextPackage;
    readonly validationFeedback?: string;
    readonly baselineSnapshot: RuntimeStateSnapshot;
    readonly allowNewHooks?: boolean;
  }): Promise<{
    settlement: {
      readonly postSettlement: string;
      readonly runtimeStateDelta: RuntimeStateDelta;
      readonly updatedState: string;
      readonly updatedHooks: string;
    };
    usage: TokenUsage;
  }> {
    const resolvedLang = params.language;
    this.logInfo(resolvedLang, {
      zh: `阶段 2：把第${params.chapterNumber}章事实投影到运行时状态`,
      en: `Phase 2: projecting chapter ${params.chapterNumber} facts into runtime state`,
    });
    const systemPrompt = buildSettlerSystemPrompt(params.book, params.bookRules, resolvedLang);
    const governedControlBlock = this.buildSettlerGovernedControlBlock(
      params.chapterIntent,
      params.contextPackage,
      resolvedLang,
    );
    const userPrompt = buildSettlerUserPrompt({
      chapterNumber: params.chapterNumber,
      title: params.title,
      content: params.content,
      governedControlBlock,
      validationFeedback: params.validationFeedback,
      language: resolvedLang,
    }) + `\n\n## Settlement baseline\nApply the delta to this exact baseline. Existing hook operations may name only its hook IDs. Later projections in retrieved context are references, not the baseline to be mutated.\n${JSON.stringify({ chapter: params.baselineSnapshot.manifest.lastAppliedChapter, currentState: params.baselineSnapshot.currentState, hooks: params.baselineSnapshot.hooks, allowNewHooks: params.allowNewHooks ?? true })}`;
    const knownHookIds = new Set(params.baselineSnapshot.hooks.hooks.map((hook) => hook.hookId));
    const { result, usage } = await this.submitStructured(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      {
        name: "submit_runtime_state_delta",
        label: resolvedLang === "en" ? "Submit runtime state delta" : "提交运行时状态变更",
        description: resolvedLang === "en"
          ? "Submit only chapter-grounded incremental state changes. The host owns the chapter number."
          : "只提交正文有证据的增量状态变更；章节号由宿主持有。",
        parameters: createSettlementToolSchema(params.allowNewHooks),
        normalize: normalizeSettlementSubmission,
        validate: (value) => validateSettlementHookIds(value, knownHookIds),
      },
      // Settlement runs under the writer but reads the state method, not the prose craft.
      { temperature: 0.3, maxTokens: Math.min(16384, this.ctx.client.defaults.maxTokens), skillAudience: "settler" },
    );
    const runtimeStateDelta = RuntimeStateDeltaSchema.parse({
      chapter: params.chapterNumber,
      factOps: {
        upsert: result.factOps.upsert,
        expire: result.factOps.expire,
      },
      hookOps: {
        upsert: result.hookOps.upsert,
        mention: result.hookOps.mention,
        resolve: result.hookOps.resolve,
        defer: result.hookOps.defer,
      },
      newHookCandidates: result.newHookCandidates,
      chapterSummary: {
        chapter: params.chapterNumber,
        title: result.chapterSummary.title,
        characters: result.chapterSummary.characters,
        events: result.chapterSummary.events,
        stateChanges: result.chapterSummary.stateChanges,
        hookActivity: result.chapterSummary.hookActivity,
        mood: result.chapterSummary.mood,
        chapterType: result.chapterSummary.chapterType,
      },
    });

    return {
      settlement: {
        postSettlement: result.postSettlement,
        runtimeStateDelta,
        updatedState: "",
        updatedHooks: "",
      },
      usage,
    };
  }
  async saveChapter(
    bookDir: string,
    output: WriteChapterOutput,
    language: "zh" | "en" = "zh",
    chapterIndex?: ReadonlyArray<ChapterMeta>,
  ): Promise<void> {
    const chaptersDir = join(bookDir, "chapters");
    await mkdir(chaptersDir, { recursive: true });

    const paddedNum = String(output.chapterNumber).padStart(4, "0");
    const filename = `${paddedNum}_${this.sanitizeFilename(output.title)}.md`;
    let existingChapterFiles: string[] = [];
    try {
      existingChapterFiles = await readdir(chaptersDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const supersededChapterFiles = existingChapterFiles
      .filter((file) => file.startsWith(`${paddedNum}_`) && file.endsWith(".md") && file !== filename);

    const chapterContent = renderChapterDocument(output.chapterNumber,output.title,output.content,language);
    const runtimeStateArtifacts = await this.resolveRuntimeStateArtifactsForOutput(
      bookDir,
      output,
      language,
    );
    const chapterSummariesMarkdown = runtimeStateArtifacts.chapterSummariesMarkdown;

    const writes: AtomicFileWrite[] = [
      { relativePath: join("chapters", filename), content: chapterContent },
      {
        relativePath: join("story", "current_state.md"),
        content: runtimeStateArtifacts.currentStateMarkdown,
      },
      {
        relativePath: join("story", "pending_hooks.md"),
        content: runtimeStateArtifacts.hooksMarkdown,
      },
    ];

    writes.push({
      relativePath: join("story", "chapter_summaries.md"),
      content: chapterSummariesMarkdown,
    });

    const runtimeStateSnapshot = runtimeStateArtifacts.snapshot;
    writes.push(
        {
          relativePath: join("story", "state", "manifest.json"),
          content: JSON.stringify(runtimeStateSnapshot.manifest, null, 2),
        },
        {
          relativePath: join("story", "state", "current_state.json"),
          content: JSON.stringify(runtimeStateSnapshot.currentState, null, 2),
        },
        {
          relativePath: join("story", "state", "hooks.json"),
          content: JSON.stringify(runtimeStateSnapshot.hooks, null, 2),
        },
        {
          relativePath: join("story", "state", "chapter_summaries.json"),
          content: JSON.stringify(runtimeStateSnapshot.chapterSummaries, null, 2),
        },
    );

    const snapshotRoot = join("story", "snapshots", String(output.chapterNumber));
    writes.push(
      { relativePath: join(snapshotRoot, "current_state.md"), content: runtimeStateArtifacts.currentStateMarkdown },
      { relativePath: join(snapshotRoot, "pending_hooks.md"), content: runtimeStateArtifacts.hooksMarkdown },
      { relativePath: join(snapshotRoot, "chapter_summaries.md"), content: chapterSummariesMarkdown },
      { relativePath: join(snapshotRoot, "state", "manifest.json"), content: JSON.stringify(runtimeStateSnapshot.manifest, null, 2) },
      { relativePath: join(snapshotRoot, "state", "current_state.json"), content: JSON.stringify(runtimeStateSnapshot.currentState, null, 2) },
      { relativePath: join(snapshotRoot, "state", "hooks.json"), content: JSON.stringify(runtimeStateSnapshot.hooks, null, 2) },
      { relativePath: join(snapshotRoot, "state", "chapter_summaries.json"), content: JSON.stringify(runtimeStateSnapshot.chapterSummaries, null, 2) },
    );
    if (chapterIndex) {
      writes.push({
        relativePath: join("chapters", "index.json"),
        content: `${JSON.stringify(chapterIndex, null, 2)}\n`,
      });
    }

    await commitAtomicFileSet({
      rootDir: bookDir,
      writes,
      deletes: supersededChapterFiles.map((file) => join("chapters", file)),
    });
  }

  private buildGovernedUserPrompt(params: {
    readonly chapterNumber: number;
    readonly chapterMemo: ChapterMemo;
    readonly chapterIntentData?: ChapterIntent;
    readonly contextPackage: ContextPackage;
    readonly externalContext?: string;
    readonly previousChapter?: string;
    readonly lengthSpec: LengthSpec;
    readonly language?: "zh" | "en";
  }): string {
    const language = params.language ?? "zh";
    const isEn = language === "en";
    // The shared context package is the planner's and auditor's ledger. The
    // writer gets its own view: no duplicate memo or style guide, no superseded
    // facts or far-future plans, rendered as plain notes instead of evidence records.
    const view = selectWriterContext(params.contextPackage.selectedContext, {
      chapterNumber: params.chapterNumber,
      memo: params.chapterMemo,
    });
    // The user's steering docs (author_intent = long-term direction, current_focus =
    // short-term focus) land as a prominent, binding block near the top.
    const direction = view.direction
      .filter((entry) => entry.excerpt?.trim())
      .map((entry) => {
        const longTerm = entry.source === "story/author_intent.md";
        const label = isEn
          ? (longTerm ? "Author intent (long-term)" : "Current focus (near-term)")
          : (longTerm ? "作者意图（长期）" : "当前焦点（近期）");
        return `### ${label}\n${entry.excerpt!.trim()}`;
      })
      .join("\n\n");
    const reference = renderWriterContext(view, language);
    const previousTail = previousChapterTail(params.previousChapter);
    const memo = renderMemoAsNarrativeBlock(params.chapterMemo, params.chapterIntentData, language);
    const lengthRequirementBlock = this.buildLengthRequirementBlock(params.lengthSpec, language);

    if (isEn) {
      return [
        `Write chapter ${params.chapterNumber}.`,
        this.buildChapterContextBlock(params.externalContext, language),
        direction ? `## User direction (overrides model defaults — must follow)\n${direction}` : "",
        reference
          ? `## Reference notes\nA ledger that keeps the chapter consistent: established facts, characters, setting and earlier events. Stay consistent with it wherever the chapter touches it; do not narrate it. Its bookkeeping and audit phrasing ("did not happen", "not recorded", opening and closing balances) is not prose style and must not leak into the narration.\n\n${reference}`
          : "",
        previousTail
          ? `## End of the previous chapter\nThis chapter continues from here. Pick up its time, place and whatever the characters were in the middle of. It is already written; do not retell it.\n\n${previousTail}`
          : "",
        `## Chapter memo\nThe memo decides what this chapter contains.\n\n${memo}`,
        `How to use the memo:
- Scenes marked "play out" are written as scenes happening now, with people talking and acting, and take most of the chapter. Lines marked "pass over" are told in a sentence or two.
- "Notes" keep numbers and continuity right. Mention a figure only where the story uses it; do not walk through the ledger, and do not narrate things that did not happen. Boundaries in the notes ("X does not mean Y", "must not be written as Z") are for getting the chapter right; do not have characters say them aloud to set the record straight.
- When paperwork comes up, pass it in a sentence: who hands what to whom and how they take it. Do not read the documents out item by item.
- The memo is a list of events, not a paragraph plan: do not write one paragraph per item. Give each moment the room its weight deserves.`,
        `${lengthRequirementBlock}
- Output the chapter directly: the first line is "Chapter ${params.chapterNumber}: Title", then a blank line, then the prose. Add no commentary, preamble or notes.`,
      ].filter(Boolean).join("\n\n");
    }

    return [
      `请写第${params.chapterNumber}章。`,
      this.buildChapterContextBlock(params.externalContext, language),
      direction ? `## 用户方向（优先于模型默认，必须遵循）\n${direction}` : "",
      reference
        ? `## 写作参考\n这是防止写错用的底账：既成事实、人物、设定和前情。写到相关处与它一致即可，不必写进正文；底账里记账、核对式的说法（“未发生”“不登记”“期初期末”之类）不是正文的写法，不要带进叙述。\n\n${reference}`
        : "",
      previousTail
        ? `## 上一章结尾\n本章从这里接着往下写：时间、地点和人物手上的事要接得上。这段已经写过，不要复述。\n\n${previousTail}`
        : "",
      `## 本章章纲\n章纲决定这一章写什么。\n\n${memo}`,
      `章纲怎么用：
- 标「展开」的场次写成当场发生的戏，人物来回说话、做事，占掉全章大部分篇幅；标「带过」的一两句交代完就走。
- 「备注」只用来保证数字和前后一致：正文用到哪个数就提哪个数，不逐笔交代，也不写“没有发生什么”。备注里“某事不等于某事”“不能写成什么”这类边界，照着写对就行，不要让人物说出来替谁澄清。
- 手续和文件写到时一句带过：谁把什么交给谁、对方怎么接，不逐条念文件内容。
- 章纲是事件清单，不是分段提纲：不要一条写一段，按场面的轻重自己分配篇幅和分段。`,
      `${lengthRequirementBlock}
- 直接输出本章：第一行写“第${params.chapterNumber}章 标题”，空一行后写正文；不要输出任何说明、前言或备注。`,
    ].filter(Boolean).join("\n\n");
  }

  private buildChapterContextBlock(externalContext: string | undefined, language: "zh" | "en"): string {
    const trimmed = externalContext?.trim();
    if (!trimmed) return "";
    // In a hosted session the instruction is the coordinator's elaboration of
    // the author's request. Voice it adds on its own must not outrank the Work's
    // current style direction; the author's own words still do.
    const authorRequest = currentExecutionAuthorRequest()?.trim();
    const delegated = Boolean(authorRequest) && authorRequest !== trimmed;
    if (language === "en") {
      return `## Per-chapter instruction (highest priority)
${trimmed}

${delegated
    ? "This is the direct instruction for the current chapter, relayed from the author's request (authorRequest). If it specifies a chapter title, use that title exactly. Keep continuity, but do not replace this instruction with the outline fallback. Statements about voice or style count only where the author's own request makes them; otherwise the voice follows the current user direction and style guide below."
    : "Obey this direct instruction for the current chapter. If it specifies a chapter title, use that title exactly. Keep continuity, but do not replace this instruction with the outline fallback."}`;
    }
    return `## 本章指令（最高优先级）
${trimmed}

${delegated
    ? "这是本章的直接指令，由宿主根据用户原话（authorRequest）转述。若其中指定章节标题，标题必须原样使用。保持连续性，但不要用卷纲兜底替换这条指令。其中关于文风、口吻的说法，用户原话里也提了才算数；原话没提文风时，文风以下方「用户方向」和文风指南的现行约定为准。"
    : "这是用户对当前章节的直接指令。若其中指定章节标题，标题必须原样使用。保持连续性，但不要用卷纲兜底替换这条指令。"}`;
  }

  private buildSettlerGovernedControlBlock(
    chapterIntent: string,
    contextPackage: ContextPackage,
    language: "zh" | "en",
  ): string {
    const selectedContext = renderNarrativeSelectedContext(contextPackage.selectedContext, language)
      .replace(/^### /gm, "- ");

    if (language === "en") {
      return `\n## Chapter Control Inputs
${chapterIntent}

### Selected Context
${selectedContext || "- none"}\n`;
    }

    return `\n## 本章控制输入
${chapterIntent}

### 已选上下文
${selectedContext || "- none"}\n`;
  }

  private buildLengthRequirementBlock(lengthSpec: LengthSpec, language: "zh" | "en"): string {
    const bounds=[
      ...(lengthSpec.minChapterLength!==undefined?[`Minimum: ${lengthSpec.minChapterLength}`]:[]),
      ...(lengthSpec.maxChapterLength!==undefined?[`Maximum: ${lengthSpec.maxChapterLength}`]:[]),
    ];
    if (language === "en") {
      return `Requirements:
- User target length: ${lengthSpec.target} words
- ${bounds.join("; ") || "No additional hard range specified."} (words)
- Keep the scene complete; do not pad or cut mechanically`;
    }

    return `要求：
- 用户目标字数：${lengthSpec.target}字
- ${bounds.join("; ") || "未指定额外硬性范围"}；中文按正文非空白字符计数，含标点，不含标题
- 保持场景完整，不要机械注水或裁切`;
  }

  private async readFileOrDefault(path: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  private normalizeRuntimeStateDeltaChapter(
    delta: RuntimeStateDelta,
    authoritativeChapterNumber: number,
  ): RuntimeStateDelta {
    const hookOps = delta.hookOps ?? {
      upsert: [],
      mention: [],
      resolve: [],
      defer: [],
    };
    let changed = delta.chapter !== authoritativeChapterNumber;
    const normalizedUpserts = hookOps.upsert.map((hook) => {
      const startChapter = Math.min(hook.startChapter, authoritativeChapterNumber);
      const lastAdvancedChapter = Math.min(hook.lastAdvancedChapter, authoritativeChapterNumber);
      if (startChapter !== hook.startChapter || lastAdvancedChapter !== hook.lastAdvancedChapter) {
        changed = true;
      }
      if (startChapter === hook.startChapter && lastAdvancedChapter === hook.lastAdvancedChapter) {
        return hook;
      }
      return {
        ...hook,
        startChapter,
        lastAdvancedChapter,
      };
    });

    if (delta.chapterSummary?.chapter !== undefined && delta.chapterSummary.chapter !== authoritativeChapterNumber) {
      changed = true;
    }
    if (!changed) {
      return delta;
    }

    return {
      ...delta,
      chapter: authoritativeChapterNumber,
      hookOps: {
        ...hookOps,
        upsert: normalizedUpserts,
      },
      chapterSummary: delta.chapterSummary
        ? {
            ...delta.chapterSummary,
            chapter: authoritativeChapterNumber,
          }
        : undefined,
    };
  }

  private async buildRuntimeStateArtifactsIfPresent(
    bookDir: string,
    delta: RuntimeStateDelta,
    language: "zh" | "en",
    authoritativeChapterNumber?: number,
    allowReapply?: boolean,
    baselineChapter?: number,
    allowNewHooks?: boolean,
  ): Promise<RuntimeStateArtifacts> {
    const safeDelta = authoritativeChapterNumber === undefined
      ? delta
      : this.normalizeRuntimeStateDeltaChapter(delta, authoritativeChapterNumber);
    if (baselineChapter === undefined) {
      return buildRuntimeStateArtifacts({
        bookDir,
        delta: safeDelta,
        language,
        allowReapply,
        allowNewHooks,
      });
    }
    const snapshot = await loadRuntimeStateSnapshotAtChapter({
      bookDir,
      chapterNumber: baselineChapter,
      language,
    });
    return buildRuntimeStateArtifactsFromSnapshot({
      snapshot,
      delta: safeDelta,
      language,
      allowReapply,
      allowNewHooks,
    });
  }

  private async resolveRuntimeStateArtifactsForOutput(
    bookDir: string,
    output: WriteChapterOutput,
    language: "zh" | "en",
  ): Promise<RuntimeStateArtifacts> {
    const safeDelta = this.normalizeRuntimeStateDeltaChapter(
      output.runtimeStateDelta,
      output.chapterNumber,
    );
    if (
      safeDelta === output.runtimeStateDelta
      && output.runtimeStateSnapshot
      && output.updatedChapterSummaries
      && output.updatedState
      && output.updatedHooks
    ) {
      return {
        snapshot: output.runtimeStateSnapshot,
        resolvedDelta: safeDelta,
        currentStateMarkdown: output.updatedState,
        hooksMarkdown: output.updatedHooks,
        chapterSummariesMarkdown: output.updatedChapterSummaries,
      };
    }

    return buildRuntimeStateArtifacts({
      bookDir,
      delta: safeDelta,
      language,
    });
  }

  private sanitizeFilename(title: string): string {
    return title
      .replace(/[/\\?%*:|"<>]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 50);
  }
}

/** Split a plain-text draft into its numbered heading title and prose; title is absent when the draft has no heading. */
export function parseChapterDraftText(text: string): { readonly title?: string; readonly content: string } {
  const unfenced = text.replace(/\r\n?/g, "\n").trim().replace(/^```[^\n]*\n([\s\S]*?)\n?```$/u, "$1");
  const lines = unfenced.split("\n");
  const headingOf = (line: string) => readChapterHeading(line.trim().replace(/^\*\*(.+)\*\*$/u, "$1"));
  let start = lines.findIndex((line) => line.trim().length > 0);
  if (start < 0) return { content: "" };
  if (!headingOf(lines[start]!) && /[:：]$/u.test(lines[start]!.trim())) {
    const next = lines.findIndex((line, index) => index > start && line.trim().length > 0);
    if (next >= 0 && headingOf(lines[next]!)) start = next;
  }
  const heading = headingOf(lines[start]!);
  const content = (heading ? lines.slice(start + 1) : lines.slice(start)).join("\n").trim();
  const title = heading ? cleanDraftTitle(heading.title) : "";
  return title ? { title, content } : { content };
}

function cleanDraftTitle(title: string): string {
  return title.trim().replace(/^[《「“"']+|[》」”"']+$/gu, "").trim();
}

