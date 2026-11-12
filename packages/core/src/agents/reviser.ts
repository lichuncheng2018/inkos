import { BaseAgent } from "./base.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { Observation } from "../models/observation.js";
import type { ContextPackage } from "../models/input-governance.js";
import { countChapterLength, assertChapterLength, chapterLengthGap } from "../utils/length-metrics.js";
import { Type, type Static } from '@sinclair/typebox';
import { numberReviewSource } from '../models/observation.js';
import {textRangeEditContract,textSelectionEditContract,TextEditRangeSchema} from '../utils/text-range-edits.js';
import { ChapterRewriteToolSchema } from "./reviser-tool.js";
import {chapterDocumentBody} from '../utils/chapter-document.js';
import { renderNarrativeSelectedContext } from "../utils/narrative-control.js";
import { splitSourceLines } from "../utils/source-text.js";
import { recordExecutionEvidence } from "../harness/execution-evidence.js";
import type { LLMMessage, LLMResponse } from "../llm/provider.js";
import { parseChapterDraftText } from "./writer.js";

export type ReviseMode = "polish" | "rewrite" | "rework" | "anti-detect" | "spot-fix";

export const DEFAULT_REVISE_MODE: ReviseMode = "spot-fix";

/**
 * How revised prose leaves the model. Prose written into a tool-call argument
 * reads markedly more machine-like than the same request answered as plain
 * text, so long-form chapters take the text channel; the tool channel keeps
 * its exact field contract for callers that depend on it.
 */
export type ProseChannel = "tool" | "text";

const PROSE_ATTEMPTS = 3;

export interface ReviseOutput {
  readonly revisedContent: string;
  readonly wordCount: number;
  readonly tokenUsage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

export class ReviserAgent extends BaseAgent {
  get name(): string {
    return "reviser";
  }

  async reviseChapter(
    _bookDir: string,
    chapterContent: string,
    chapterNumber: number,
    observations: ReadonlyArray<Observation>,
    mode: ReviseMode = DEFAULT_REVISE_MODE,
    _genre?: string,
    options?: {
      readonly language: "zh" | "en";
      readonly chapterTitle?:string;
      readonly targetText?:string;
      readonly contextPackage: ContextPackage;
      readonly lengthSpec?: LengthSpec;
      /** Observe a complete source-bound candidate without adopting it. */
      readonly onCandidate?: (content: string) => Promise<void>;
      /**
       * When retries run out on length alone, return the complete attempt
       * nearest the range instead of failing. Only for callers that report
       * the remaining gap; a hard final-manuscript contract must not set it.
       */
      readonly keepNearestLength?: boolean;
      readonly proseChannel?: ProseChannel;
    },
  ): Promise<ReviseOutput> {
    if (!options) throw new Error("Reviser requires governed context and language.");
    const channel = options.proseChannel ?? "tool";
    const body=(content:string)=>options.chapterTitle===undefined?content:chapterDocumentBody(content,chapterNumber,options.chapterTitle,options.language);
    chapterContent=body(chapterContent);
    const isEnglish = options.language === "en";
    const observationList = observations.length > 0
      ? observations.map((issue) => [
          `- ${issue.code}: ${issue.summary}`,
          ...(issue.evidence.length > 0
            ? [`  ${isEnglish ? "Evidence" : "证据"}: ${issue.evidence.join("; ")}`]
            : []),
        ].join("\n")).join("\n")
      : (isEnglish ? "- Follow the user's explicit revision instruction in the governed context." : "- 按 governed context 中的用户明确修订要求执行。");
    const context = renderNarrativeSelectedContext(options.contextPackage.selectedContext, options.language);
    const lengthBlock = options.lengthSpec
      ? (isEnglish
          ? `\n## Length contract\n${JSON.stringify({...options.lengthSpec,currentCount:countChapterLength(chapterContent,options.lengthSpec.countingMode),unit:"words"})}`
          : `\n## 篇幅要求\n${JSON.stringify({...options.lengthSpec,currentCount:countChapterLength(chapterContent,options.lengthSpec.countingMode),unit:"正文非空白字符，含标点，不含标题"})}`)
      : "";
    const scoped = mode === "spot-fix" || options.targetText !== undefined;
    const systemPrompt = buildRevisionProtocol(mode, options.language, channel === "tool" ? "tool" : scoped ? "text-ranges" : "text-chapter");
    const source=mode==='spot-fix'?numberReviewSource(chapterContent):chapterContent;
    const userPrompt = isEnglish
      ? `Revise chapter ${chapterNumber}.\n\n## Observations or instruction\n${observationList}\n\n## Governed context\n${context}${lengthBlock}\n\n## Current chapter\n${source}`
      : `修订第${chapterNumber}章。\n\n## 观察或用户指令\n${observationList}\n\n## 权威上下文\n${context}${lengthBlock}\n\n## 当前章节\n${source}`;
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];
    const outputBudget = Math.min(this.ctx.client.defaults.maxTokens, Math.max(8192, Math.ceil((options.lengthSpec?.target ?? chapterContent.length) * 4) + 8192));
    const nearestSpec = options.keepNearestLength ? options.lengthSpec : undefined;
    const output = scoped
      ? await this.submitSpotFix(messages, chapterContent, outputBudget, options.lengthSpec,options.targetText,options.onCandidate,nearestSpec,channel==="text"?options.language:undefined)
      : channel === "text"
        ? await this.writeRewrite(messages, outputBudget, options.language, options.lengthSpec, body, nearestSpec, revisionTemperature(mode))
        : await this.submitRewrite(messages, outputBudget, options.lengthSpec,body,nearestSpec,revisionTemperature(mode));
    const wordCount = options.lengthSpec
      ? countChapterLength(output.revisedContent, options.lengthSpec.countingMode)
      : output.wordCount;
    return { ...output, wordCount };
  }

  private async submitSpotFix(
    messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>,
    originalChapter: string,
    maxTokens: number,
    lengthSpec?: LengthSpec,
    targetText?:string,
    onCandidate?: (content: string) => Promise<void>,
    nearestSpec?: LengthSpec,
    /** When set, the replacement prose is answered as plain text in this language instead of tool fields. */
    textLanguage?: "zh" | "en",
  ): Promise<ReviseOutput> {
    let planUsage={promptTokens:0,completionTokens:0,totalTokens:0};
    let contract:ReturnType<typeof textRangeEditContract>|ReturnType<typeof textSelectionEditContract>;
    if(targetText!==undefined)contract=textSelectionEditContract(originalChapter,targetText);
    else{
    const plan=await this.submitStructured(messages,{
      name:'submit_chapter_edit_ranges',label:'Select chapter edit ranges',
      description:'Select the smallest non-overlapping inclusive source line ranges needed for the requested local changes. Do not submit prose or select unrelated passages.',
      parameters:Type.Object({ranges:Type.Array(TextEditRangeSchema,{minItems:1})},{additionalProperties:false}),
      validate:result=>{textRangeEditContract(originalChapter,result.ranges);return result;},
    },{temperature:0.3,maxTokens:Math.min(maxTokens,4096)});
    planUsage=plan.usage;
    contract=textRangeEditContract(originalChapter,plan.result.ranges);
    }
    const fixedContent=contract.apply(Object.fromEntries(contract.ranges.map(range=>[`range_${range.index}_content`, ''])));
    const fixedLength=lengthSpec?countChapterLength(fixedContent,lengthSpec.countingMode):undefined;
    const replacementBudget=lengthSpec&&fixedLength!==undefined?{
      countingMode:lengthSpec.countingMode,fixedContentLength:fixedLength,
      minimum:Math.max(0,(lengthSpec.minChapterLength??0)-fixedLength),
      ...(lengthSpec.maxChapterLength===undefined?{}:{maximum:lengthSpec.maxChapterLength-fixedLength}),
    }:undefined;
    if(replacementBudget?.maximum!==undefined&&replacementBudget.maximum<0)throw Object.assign(new Error('The protected text alone exceeds the chapter maximum. These edit ranges cannot satisfy both scope and length constraints.'),{code:'CHAPTER_EDIT_SCOPE_CONFLICT',replacementBudget});
    const nearest=nearestLengthAttempt<Record<string,string>>(nearestSpec);
    const accept=async(result:Record<string,string>)=>{
      const candidate=contract.apply(result);
      await onCandidate?.(candidate);
      nearest.observe(result,candidate);
      try{assertChapterLength(candidate,lengthSpec);}
      catch(error){
        const failure=error as Error&{code?:string;delivery?:object;adjustment?:object};
        if(failure.code!=='CHAPTER_LENGTH_OUT_OF_RANGE')throw error;
        const sourceLength=lengthSpec?countChapterLength(originalChapter,lengthSpec.countingMode):undefined;
        throw Object.assign(new Error(JSON.stringify({code:failure.code,...failure.delivery,adjustment:failure.adjustment,scope:'selected_ranges',replacementBudget,source:{length:sourceLength,unchangedByThisAttempt:true},candidateCommitted:false,instruction:'The rejected replacement has not changed the source chapter. Adjust only the selected replacement fields to their combined budget. Do not include or rewrite protected surrounding text.'})),{code:failure.code,delivery:failure.delivery,adjustment:failure.adjustment,replacementBudget});
      }
      return result;
    };
    const { result, usage } = textLanguage
      ? await this.writeRangeReplacements(messages,originalChapter,contract.ranges.map(range=>({
          index:range.index,content:range.content,
          start:'startOffset' in range?range.startOffset:splitSourceLines(originalChapter).slice(0,range.startLine-1).join('').length,
        })),replacementBudget,textLanguage,maxTokens,accept).catch(error=>nearest.recover(error))
      : await this.submitStructured([...messages,{role:'user',content:JSON.stringify({editableRanges:contract.ranges,replacementBudget,instruction:'Submit only replacement text in each range_N_content field. The replacement budget is shared by all fields, not per field. Keep the original trailing newline when present. The host preserves all source bytes outside the selected ranges.'})}], {
          name: "submit_chapter_range_replacements",
          label: "Submit chapter range replacements",
          description: "Submit replacement prose for each selected source range in its named field.",
          parameters: contract.parameters,
          validate: accept,
        }, { temperature: 0.3, maxTokens }).catch(error=>nearest.recover(error));
    const revisedContent = contract.apply(result);
    return {
      revisedContent,
      wordCount: revisedContent.length,
      tokenUsage:{promptTokens:planUsage.promptTokens+(usage?.promptTokens??0),completionTokens:planUsage.completionTokens+(usage?.completionTokens??0),totalTokens:planUsage.totalTokens+(usage?.totalTokens??0)},
    };
  }

  private async submitRewrite(
    messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>,
    maxTokens: number,
    lengthSpec?: LengthSpec,
    normalizeContent:(content:string)=>string=content=>content,
    nearestSpec?: LengthSpec,
    temperature = 0.3,
  ): Promise<ReviseOutput> {
    const nearest=nearestLengthAttempt<Static<typeof ChapterRewriteToolSchema>>(nearestSpec);
    const { result, usage } = await this.submitStructured(messages, {
      name: "submit_revised_chapter",
      label: "Submit revised chapter",
      description: "Submit the complete revised chapter and addressed observations.",
      parameters: ChapterRewriteToolSchema,
      validate: result => {
        const revisedContent=normalizeContent(result.revisedContent);
        if(!revisedContent.trim())throw Object.assign(new Error('Submit chapter prose in addition to its title'),{code:'CHAPTER_BODY_EMPTY'});
        nearest.observe({...result,revisedContent},revisedContent);
        assertChapterLength(revisedContent,lengthSpec);
        return{...result,revisedContent};
      },
    }, { temperature, maxTokens }).catch(error=>nearest.recover(error));
    return {
      revisedContent: result.revisedContent,
      wordCount: result.revisedContent.length,
      ...(usage ? { tokenUsage: usage } : {}),
    };
  }

  /** The complete revised chapter, answered as plain text. */
  private async writeRewrite(
    messages: ReadonlyArray<LLMMessage>,
    maxTokens: number,
    language: "zh" | "en",
    lengthSpec: LengthSpec | undefined,
    normalizeContent: (content: string) => string,
    nearestSpec: LengthSpec | undefined,
    temperature: number,
  ): Promise<ReviseOutput> {
    const nearest = nearestLengthAttempt<string>(nearestSpec);
    const { result, usage } = await this.writeProse(messages, { temperature, maxTokens, language }, (reply) => {
      const revisedContent = normalizeContent(parseChapterDraftText(reply).content);
      if (!revisedContent.trim()) throw proseRejection("CHAPTER_BODY_EMPTY", language, "the reply contained no chapter prose", "回复里没有正文");
      nearest.observe(revisedContent, revisedContent);
      assertChapterLength(revisedContent, lengthSpec);
      return revisedContent;
    }).catch((error) => nearest.recover(error));
    return { revisedContent: result, wordCount: result.length, ...(usage ? { tokenUsage: usage } : {}) };
  }

  /** Replacement prose answered as plain text; the host binds each passage back to its source span. */
  private async writeRangeReplacements(
    messages: ReadonlyArray<LLMMessage>,
    source: string,
    spans: ReadonlyArray<SourceSpan>,
    budget: ReplacementBudget | undefined,
    language: "zh" | "en",
    maxTokens: number,
    accept: (replacements: Record<string, string>) => Promise<Record<string, string>>,
  ): Promise<{ readonly result: Record<string, string>; readonly usage: LLMResponse["usage"] }> {
    return this.writeProse(
      [...messages, { role: "user", content: rangeRewriteRequest(source, spans, budget, language) }],
      // Replacement prose is new writing; it takes the writer's temperature.
      { temperature: 0.7, maxTokens, language },
      (reply) => accept(bindRangeReplies(reply, source, spans, language)),
    );
  }

  /** Plain-text prose turns. A rejected draft goes back with the reason, as a rejected tool result would. */
  private async writeProse<T>(
    messages: ReadonlyArray<LLMMessage>,
    options: { readonly temperature: number; readonly maxTokens: number; readonly language: "zh" | "en" },
    accept: (reply: string) => T | Promise<T>,
  ): Promise<{ readonly result: T; readonly usage: LLMResponse["usage"] }> {
    const turns: LLMMessage[] = [...messages];
    let usage: LLMResponse["usage"] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let failure: unknown;
    let lengthFailure: unknown;
    for (let attempt = 0; attempt < PROSE_ATTEMPTS; attempt++) {
      const response = await this.chat(turns, { temperature: options.temperature, maxTokens: options.maxTokens });
      usage = {
        promptTokens: usage.promptTokens + response.usage.promptTokens,
        completionTokens: usage.completionTokens + response.usage.completionTokens,
        totalTokens: usage.totalTokens + response.usage.totalTokens,
      };
      try {
        return { result: await accept(response.content), usage };
      } catch (error) {
        this.ctx.signal?.throwIfAborted();
        failure = error;
        const code = (error as { code?: string }).code;
        if (code === "CHAPTER_LENGTH_OUT_OF_RANGE") lengthFailure = error;
        recordExecutionEvidence("worker-result-invalid", { code: code ?? "WORKER_DOMAIN_INVALID", worker: this.name, channel: "text", attempt: attempt + 1 });
        if (response.content.trim()) turns.push({ role: "assistant", content: response.content });
        turns.push({ role: "user", content: rejectionNotice(error, options.language) });
      }
    }
    // A complete draft that missed only on length is the one a caller may still keep.
    throw lengthFailure ?? failure;
  }
}

type SourceSpan = { readonly index: number; readonly content: string; readonly start: number };
type ReplacementBudget = { readonly countingMode: LengthSpec["countingMode"]; readonly minimum: number; readonly maximum?: number };

const PASSAGE_MARKER = /^[ \t]*(?:【\s*第?\s*(\d+)\s*处\s*】|\[\s*Passage\s+(\d+)\s*\])[ \t]*[:：]?[ \t]*$/iu;
/** Shorter lines (a beat, an ellipsis, a sound) can legitimately repeat next to themselves. */
const ECHO_MIN_CHARS = 12;

function proseRejection(code: string, language: "zh" | "en", en: string, zh: string): Error {
  return Object.assign(new Error(language === "en" ? en : zh), { code, notice: language === "en" ? en : zh });
}

/** The nearest non-empty lines on one side of a span. A partial line is kept: the replacement joins it. */
function nearbyLines(text: string, count: number): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return count < 0 ? lines.slice(count) : lines.slice(0, count);
}

function rangeRewriteRequest(
  source: string,
  spans: ReadonlyArray<SourceSpan>,
  budget: ReplacementBudget | undefined,
  language: "zh" | "en",
): string {
  const english = language === "en";
  const passages = spans.map((span, position) => {
    const before = nearbyLines(source.slice(0, span.start), -2).join("\n");
    const after = nearbyLines(source.slice(span.start + span.content.length), 2).join("\n");
    return (english
      ? [
          `[Passage ${position + 1}]`,
          before && `Before it (stays as it is):\n${before}`,
          `Rewrite this:\n${span.content.trim()}`,
          after && `After it (stays as it is):\n${after}`,
        ]
      : [
          `【第${position + 1}处】`,
          before && `上文（不改）：\n${before}`,
          `原文（重写这一段）：\n${span.content.trim()}`,
          after && `下文（不改）：\n${after}`,
        ]).filter(Boolean).join("\n\n");
  });
  const current = budget
    ? countChapterLength(spans.map((span) => span.content).join("\n"), budget.countingMode)
    : undefined;
  const bounds = budget && (english
    ? [budget.minimum > 0 ? `at least ${budget.minimum}` : "", budget.maximum !== undefined ? `at most ${budget.maximum}` : ""].filter(Boolean).join(" and ")
    : [budget.minimum > 0 ? `不少于${budget.minimum}字` : "", budget.maximum !== undefined ? `不多于${budget.maximum}字` : ""].filter(Boolean).join("、"));
  const several = spans.length > 1;
  return english
    ? [
        `## ${several ? `${spans.length} passages` : "The passage"} to rewrite`,
        ...passages,
        "## How to answer",
        [
          "- Write only the prose that replaces what is marked for rewriting, as plain text: no explanation, heading, quotation wrapper or code fence, and do not copy in the text before or after it.",
          ...(several ? [`- Put a line reading [Passage N] before each one and give all ${spans.length} in order.`] : []),
          "- The replacement reads as if written in one sitting with the text around it: the same narrator, sentences and paragraphs of about the same size, joining the last line before it and the first line after it. Do not repeat what those lines already tell.",
          "- Facts, figures, names and events stay. Text quoted verbatim in the story, such as system notices, stays word for word.",
          `- Length: about that of the original unless the request says otherwise${current === undefined ? "." : ` (the original ${several ? "passages come" : "comes"} to ${current} ${budget!.countingMode === "en_words" ? "words" : "characters"})${bounds ? `; the replacement in total: ${bounds}.` : "."}`}`,
        ].join("\n"),
      ].join("\n\n")
    : [
        `## 要重写的地方${several ? `（共${spans.length}处）` : ""}`,
        ...passages,
        "## 交稿要求",
        [
          "- 只写用来替换“原文”的正文，直接写：不解释，不加标题、引号包裹或代码块，上文和下文不要抄进来。",
          ...(several ? [`- 每一处前面单独一行写【第N处】，按顺序把${spans.length}处给全。`] : []),
          "- 写出来要像和上文、下文一口气写下来的：同一个叙述口气，句子长短和分段疏密相近，接得上上文最后一句和下文第一句；上文下文已经交代过的事不再说一遍。",
          "- 事实、数字、人名和事件不变；系统提示这类在故事里原样出现的文字逐字保留。",
          `- 篇幅：请求没有另外要求时和原文相当${current === undefined ? "。" : `（原文${several ? "这几处合计" : ""}${current}${budget!.countingMode === "en_words" ? "词" : "字"}）${bounds ? `；替换文字合计${bounds}。` : "。"}`}`,
        ].join("\n"),
      ].join("\n\n");
}

/** Split a plain-text reply into one replacement per span and fit each to the bytes around its span. */
function bindRangeReplies(
  reply: string,
  source: string,
  spans: ReadonlyArray<SourceSpan>,
  language: "zh" | "en",
): Record<string, string> {
  const text = reply.replace(/\r\n?/g, "\n").trim().replace(/^```[^\n]*\n([\s\S]*?)\n?```$/u, "$1");
  const marked = new Map<number, string[]>();
  const unmarked: string[] = [];
  let current = unmarked;
  for (const line of text.split("\n")) {
    const marker = PASSAGE_MARKER.exec(line);
    if (!marker) { current.push(line); continue; }
    current = [];
    marked.set(Number(marker[1] ?? marker[2]), current);
  }
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const separator = /\S[ \t]*\r?\n[ \t]*\r?\n/.test(source) ? eol + eol : eol;
  const missing: number[] = [];
  const replacements = spans.map((span, position) => {
    const lines = marked.get(position + 1) ?? (spans.length === 1 && marked.size === 0 ? unmarked : []);
    const before = nearbyLines(source.slice(0, span.start), -2);
    const after = nearbyLines(source.slice(span.start + span.content.length), 2);
    const paragraphs = lines.map((line) => line.trim()).filter(Boolean);
    // A model sometimes hands the surrounding lines back along with its replacement.
    const echoes = (line: string | undefined, context: string[]) => line !== undefined && line.length >= ECHO_MIN_CHARS && context.includes(line);
    while (paragraphs.length > 1 && echoes(paragraphs[0], before)) paragraphs.shift();
    while (paragraphs.length > 1 && echoes(paragraphs.at(-1), after)) paragraphs.pop();
    if (paragraphs.length === 0) missing.push(position + 1);
    const core = span.content.trim();
    const lead = span.content.slice(0, span.content.indexOf(core));
    const tail = span.content.slice(lead.length + core.length);
    const indent = /[ \t\u3000]*$/u.exec(lead)![0];
    return [`range_${span.index}_content`, lead + paragraphs.join(separator + indent) + tail] as const;
  });
  if (missing.length > 0) {
    throw spans.length === 1
      ? proseRejection("WORKER_RESULT_INVALID", language, "the reply contained no replacement prose", "回复里没有替换正文")
      : proseRejection(
          "WORKER_RESULT_INVALID", language,
          `no replacement was found for passage ${missing.join(", ")}; each one needs its own [Passage N] line before it`,
          `没有找到第${missing.join("、")}处的替换正文；每一处前面要单独一行写【第N处】`,
        );
  }
  return Object.fromEntries(replacements);
}

/** What a rejected plain-text draft is told; the figures replace the JSON a tool result would carry. */
function rejectionNotice(error: unknown, language: "zh" | "en"): string {
  const failure = error as {
    code?: string; notice?: string; message?: string;
    delivery?: { measurements?: { count?: number; countingMode?: string } };
    adjustment?: { change?: "shorten" | "expand"; atLeast?: number };
    replacementBudget?: ReplacementBudget;
  };
  const english = language === "en";
  let reason = failure.notice ?? failure.message ?? String(error);
  if (failure.code === "CHAPTER_LENGTH_OUT_OF_RANGE" && failure.adjustment?.atLeast !== undefined) {
    const count = failure.delivery?.measurements?.count;
    const words = failure.delivery?.measurements?.countingMode === "en_words";
    const shorter = failure.adjustment.change === "shorten";
    reason = english
      ? `with it the chapter would come to ${count} ${words ? "words" : "characters"}; write at least ${failure.adjustment.atLeast} ${shorter ? "fewer" : "more"}`
      : `用上它全章是${count}${words ? "词" : "字"}，至少要${shorter ? "少" : "多"}写${failure.adjustment.atLeast}${words ? "词" : "字"}`;
  }
  return english
    ? `That draft was not used and the chapter is unchanged: ${reason}. Write it again in full under the same requirements.`
    : `这一稿没有采用，原章没有改动：${reason}。按同样的要求重新完整写一遍。`;
}

/** Tracks the attempt nearest the range; inert without a spec, so length failures propagate. */
function nearestLengthAttempt<T>(spec: LengthSpec | undefined) {
  let nearest: { readonly result: T; readonly gap: number } | undefined;
  return {
    observe(result: T, content: string): void {
      if (!spec) return;
      const gap = chapterLengthGap(countChapterLength(content, spec.countingMode), spec);
      if (!nearest || gap < nearest.gap) nearest = { result, gap };
    },
    recover(error: unknown): { readonly result: T; readonly usage?: undefined } {
      if ((error as { code?: string }).code !== "CHAPTER_LENGTH_OUT_OF_RANGE" || !nearest) throw error;
      return { result: nearest.result };
    },
  };
}

/** With the whole source in context, a low temperature mostly reproduces its sentences. */
function revisionTemperature(mode: ReviseMode): number {
  return mode === "rewrite" || mode === "rework" || mode === "anti-detect" ? 0.7 : 0.3;
}

function buildRevisionProtocol(
  mode: ReviseMode,
  language: "zh" | "en",
  delivery: "tool" | "text-ranges" | "text-chapter" = "tool",
): string {
  const modes: Record<ReviseMode, { readonly en: string; readonly zh: string }> = {
    polish: { en: "Edit wording only; keep facts, events, characters, and causality.", zh: "只改文字表面，保持事实、事件、人物和因果。" },
    rewrite: { en: "Rewrite the affected passages; rewrite the whole chapter only when the instruction spans it. Write rewritten passages anew from the source facts instead of reusing source sentences, except text that must stay verbatim such as system prompts.", zh: "重写受影响段落；只有要求跨越整章时才重写整章。重写的段落以原文为事实来源重新写出，不沿用原句；系统提示等必须逐字保留的内容除外。" },
    rework: { en: "Scenes and conflict may be restructured within the supplied authority. Write restructured passages anew from the source facts instead of reusing source sentences, except text that must stay verbatim such as system prompts.", zh: "可在输入权威范围内重构场景与冲突。重构的部分以原文为事实来源重新写出，不沿用原句；系统提示等必须逐字保留的内容除外。" },
    "anti-detect": { en: "Preserve story facts and causality while restating every sentence: vary sentence shape, word order, wording and paragraphing, and keep no source sentence except text that must stay verbatim such as system prompts.", zh: "保持剧情事实和因果，逐句换一种说法重新写：句式、语序、用词和分段都要变化，不保留原句；系统提示等必须逐字保留的内容除外。" },
    "spot-fix": { en: "Select only the source line ranges needed for the local request, then replace those ranges while preserving surrounding text. If the request flags passages as machine-like or suspected, first find what makes each one read that way, using the activated Skill's revision method, and repair that cause where it sits rather than rewording around it. The result is what the character is doing, seeing, or saying right now — not a ledger, rule sheet, or later projection — and keeps facts, numbers, names, and events.", zh: "先选择局部请求涉及的原文行范围，再替换这些范围，保留范围外正文。若请求标出检测为机器或疑似的段落，先按已激活 Skill 的修订方法找出每一处读着像机器写的具体原因，在原处对症重写，不是换个说法绕过去。写出来是人物此刻在做什么、看见什么、跟谁说话，不要写成流水账、规则清单或事后推演；事实、数字、人名和事件保持不变。" },
  };
  const deliveries = {
    tool: { en: "Submit the result through the required tool.", zh: "通过指定结果工具提交。" },
    "text-ranges": {
      en: "Line ranges are selected through the tool. The replacement prose is written out as plain text in the form the request asks for, never inside tool arguments.",
      zh: "行范围用工具选定；替换的正文直接写成文字，按随后的交稿要求给出，不放进工具参数。",
    },
    "text-chapter": {
      en: "Reply with the complete revised chapter as plain prose, beginning at its first sentence: no title, commentary, markup or code fence.",
      zh: "直接写出修订后的整章正文，从正文第一句开始：不带章名、说明、标记或代码块。",
    },
  } as const;
  const expressionContract = language === "en"
    ? "Source wording is not style authority. Apply the user's target style first, then the Work's style guide, then the active Skill's defaults. Preserve an old voice only when the user has explicitly chosen it. A prose-only revision may change narration, emotional expression, inner speech, sentence structure and paragraphing throughout the requested scope without changing story facts. Planning, inventory and validation language constrain facts; they are not prose templates."
    : "原文措辞不是文风权威。表达优先服从用户指定的目标文风，其次是作品文风指南，再其次是已激活 Skill 的默认表达；只有用户明确选定的旧口吻才需要保留。只改文字也允许在请求范围内重写叙述、情感表达、心理活动、句式和分段，同时保持剧情事实。规划、账本与验收用语约束事实，不作为正文表达模板。";
  return language === "en"
    ? `Revise with the activated professional Skill and governed context. ${modes[mode].en}\n\n${expressionContract}\n\n${deliveries[delivery].en}`
    : `按已激活的专业 Skill 和 governed context 修订。${modes[mode].zh}\n\n${expressionContract}\n\n${deliveries[delivery].zh}`;
}
