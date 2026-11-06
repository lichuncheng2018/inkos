import { BaseAgent } from "./base.js";
import type { LengthSpec } from "../models/length-governance.js";
import type { Observation } from "../models/observation.js";
import type { ContextPackage } from "../models/input-governance.js";
import { countChapterLength, assertChapterLength } from "../utils/length-metrics.js";
import { Type } from '@sinclair/typebox';
import { numberReviewSource } from '../models/observation.js';
import {textRangeEditContract,textSelectionEditContract,TextEditRangeSchema} from '../utils/text-range-edits.js';
import { ChapterRewriteToolSchema } from "./reviser-tool.js";
import {chapterDocumentBody} from '../utils/chapter-document.js';
import { renderNarrativeSelectedContext } from "../utils/narrative-control.js";

export type ReviseMode = "polish" | "rewrite" | "rework" | "anti-detect" | "spot-fix";

export const DEFAULT_REVISE_MODE: ReviseMode = "rewrite";

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
    },
  ): Promise<ReviseOutput> {
    if (!options) throw new Error("Reviser requires governed context and language.");
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
    const systemPrompt = buildRevisionProtocol(mode, options.language);
    const source=mode==='spot-fix'?numberReviewSource(chapterContent):chapterContent;
    const userPrompt = isEnglish
      ? `Revise chapter ${chapterNumber}.\n\n## Observations or instruction\n${observationList}\n\n## Governed context\n${context}${lengthBlock}\n\n## Current chapter\n${source}`
      : `修订第${chapterNumber}章。\n\n## 观察或用户指令\n${observationList}\n\n## 权威上下文\n${context}${lengthBlock}\n\n## 当前章节\n${source}`;
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];
    const outputBudget = Math.min(this.ctx.client.defaults.maxTokens, Math.max(8192, Math.ceil((options.lengthSpec?.target ?? chapterContent.length) * 4) + 8192));
    const output = mode === "spot-fix" || options.targetText!==undefined
      ? await this.submitSpotFix(messages, chapterContent, outputBudget, options.lengthSpec,options.targetText,options.onCandidate)
      : await this.submitRewrite(messages, outputBudget, options.lengthSpec,body);
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
    const { result, usage } = await this.submitStructured([...messages,{role:'user',content:JSON.stringify({editableRanges:contract.ranges,replacementBudget,instruction:'Submit only replacement text in each range_N_content field. The replacement budget is shared by all fields, not per field. Keep the original trailing newline when present. The host preserves all source bytes outside the selected ranges.'})}], {
      name: "submit_chapter_range_replacements",
      label: "Submit chapter range replacements",
      description: "Submit replacement prose for each selected source range in its named field.",
      parameters: contract.parameters,
      validate: async result => {
        const candidate=contract.apply(result);
        await onCandidate?.(candidate);
        try{assertChapterLength(candidate,lengthSpec);}
        catch(error){
          const failure=error as Error&{code?:string;delivery?:object};
          if(failure.code!=='CHAPTER_LENGTH_OUT_OF_RANGE')throw error;
          const sourceLength=lengthSpec?countChapterLength(originalChapter,lengthSpec.countingMode):undefined;
          throw Object.assign(new Error(JSON.stringify({code:failure.code,...failure.delivery,scope:'selected_ranges',replacementBudget,source:{length:sourceLength,unchangedByThisAttempt:true},candidateCommitted:false,instruction:'The rejected replacement has not changed the source chapter. Adjust only the selected replacement fields to their combined budget. Do not include or rewrite protected surrounding text.'})),{code:failure.code,delivery:failure.delivery,replacementBudget});
        }
        return result;
      },
    }, { temperature: 0.3, maxTokens });
    const revisedContent = contract.apply(result);
    return {
      revisedContent,
      wordCount: revisedContent.length,
      tokenUsage:{promptTokens:planUsage.promptTokens+usage.promptTokens,completionTokens:planUsage.completionTokens+usage.completionTokens,totalTokens:planUsage.totalTokens+usage.totalTokens},
    };
  }

  private async submitRewrite(
    messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>,
    maxTokens: number,
    lengthSpec?: LengthSpec,
    normalizeContent:(content:string)=>string=content=>content,
  ): Promise<ReviseOutput> {
    const { result, usage } = await this.submitStructured(messages, {
      name: "submit_revised_chapter",
      label: "Submit revised chapter",
      description: "Submit the complete revised chapter and addressed observations.",
      parameters: ChapterRewriteToolSchema,
      validate: result => {
        const revisedContent=normalizeContent(result.revisedContent);
        if(!revisedContent.trim())throw Object.assign(new Error('Submit chapter prose in addition to its title'),{code:'CHAPTER_BODY_EMPTY'});
        assertChapterLength(revisedContent,lengthSpec);
        return{...result,revisedContent};
      },
    }, { temperature: 0.3, maxTokens });
    return {
      revisedContent: result.revisedContent,
      wordCount: result.revisedContent.length,
      tokenUsage: usage,
    };
  }
}

function buildRevisionProtocol(mode: ReviseMode, language: "zh" | "en"): string {
  const modes: Record<ReviseMode, { readonly en: string; readonly zh: string }> = {
    polish: { en: "Edit wording only; keep facts, events, characters, and causality.", zh: "只改文字表面，保持事实、事件、人物和因果。" },
    rewrite: { en: "Rewrite the affected passages; rewrite the whole chapter only when the instruction spans it.", zh: "重写受影响段落；只有要求跨越整章时才重写整章。" },
    rework: { en: "Scenes and conflict may be restructured within the supplied authority.", zh: "可在输入权威范围内重构场景与冲突。" },
    "anti-detect": { en: "Change wording only while preserving story facts and causality.", zh: "只调整文字表面，保持剧情事实和因果。" },
    "spot-fix": { en: "Select only the source line ranges needed for the local request, then replace those ranges while preserving surrounding text.", zh: "先选择局部请求涉及的原文行范围，再替换这些范围，保留范围外正文。" },
  };
  const expressionContract = language === "en"
    ? "Source wording is not style authority. Apply the user's target style first, then the Work's style guide, then the active Skill's defaults. Preserve an old voice only when the user has explicitly chosen it. A prose-only revision may change narration, emotional expression, inner speech, sentence structure and paragraphing throughout the requested scope without changing story facts. Planning, inventory and validation language constrain facts; they are not prose templates."
    : "原文措辞不是文风权威。表达优先服从用户指定的目标文风，其次是作品文风指南，再其次是已激活 Skill 的默认表达；只有用户明确选定的旧口吻才需要保留。只改文字也允许在请求范围内重写叙述、情感表达、心理活动、句式和分段，同时保持剧情事实。规划、账本与验收用语约束事实，不作为正文表达模板。";
  return language === "en"
    ? `Revise with the activated professional Skill and governed context. ${modes[mode].en}\n\n${expressionContract}\n\nSubmit the result through the required tool.`
    : `按已激活的专业 Skill 和 governed context 修订。${modes[mode].zh}\n\n${expressionContract}\n\n通过指定结果工具提交。`;
}
