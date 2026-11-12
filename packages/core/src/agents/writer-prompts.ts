import type { BookConfig } from "../models/book.js";
import type { BookRules } from "../models/book-rules.js";
import type { LengthSpec } from "../models/length-governance.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

/** Writer protocol. Narrative craft comes from the active long-writing Skill. */
export function buildWriterSystemPrompt(
  book: BookConfig,
  bookRules: BookRules | null,
  bookRulesBody: string,
  styleGuide: string,
  languageOverride?: "zh" | "en",
  lengthSpec?: LengthSpec,
): string {
  const language = languageOverride ?? book.language;
  const resolvedLength = lengthSpec ?? buildLengthSpec(book.chapterWordCount, language);
  const sections = language === "en"
    ? [
        `Write one chapter for the active ${book.genre} Work on ${book.platform} using the activated professional Skills.`,
        governedContract("en"),
        lengthContract(resolvedLength, "en"),
        narrativePersonContract(bookRules, "en"),
        protagonistContract(bookRules, "en"),
        authorityBlock("Book rules", bookRulesBody),
        authorityBlock("Style guide", styleGuide),
      ]
    : [
        `按已激活的专业 Skill 为当前${book.genre}作品写一章。平台：${book.platform}。`,
        governedContract("zh"),
        lengthContract(resolvedLength, "zh"),
        narrativePersonContract(bookRules, "zh"),
        protagonistContract(bookRules, "zh"),
        authorityBlock("本书规则", bookRulesBody),
        authorityBlock("文风指南", styleGuide),
      ];
  return sections.filter(Boolean).join("\n\n");
}

function governedContract(language: "zh" | "en"): string {
  return language === "en"
    ? `## Authority
The current chapter instruction and the chapter memo govern this chapter. Established facts, explicit prohibitions and the setting in the reference notes remain binding. The outline is a fallback only where the memo is silent. Realize the memo requirements through events and outcomes. Planning, inventory and validation wording is not a prose template: express it using the active style guidance without reciting its checklist. Do not duplicate or rename an existing narrative promise.

## Voice
The narration has one voice. Take it from the first of these that speaks to the point, and use the later ones only for what the earlier ones leave open, never as a second voice alongside: a style request the author made this turn; the style agreed in the author intent; the style guide; style clauses in the book rules; the activated voice Skill; the general writing Skill's defaults.`
    : `## 权威顺序
本章指令和章纲决定本章任务；既成事实、显式禁令和写作参考里的设定必须保持一致。卷纲只在章纲没有覆盖的地方作为兜底。章纲的要求通过事件与结果落地；规划、账本和验收用语不作为正文模板，应按当前文风要求自然表达，不照抄核对清单。不要为同一承诺重复开 hook，也不要改名既有叙事承诺。

## 文风来源
全章只用一套叙述口吻，按下面的顺序取：用户这一轮亲口提的文风要求；作者意图里的文风约定；文风指南；本书规则里的文风条款；已激活的文风 Skill；通用写作 Skill 的默认表达。靠前的有明确约定时，靠后的只补它没说到的地方，不并用两套口吻。`;
}

function lengthContract(spec: LengthSpec, language: "zh" | "en"): string {
  return language === "en"
    ? `## Length\nUser target: ${spec.target} words. Preserve scene completeness instead of padding or cutting mechanically.`
    : `## 字数\n用户目标：${spec.target} 字。保持场景完整，不要机械注水或裁切。`;
}

function narrativePersonContract(bookRules: BookRules | null, language: "zh" | "en"): string {
  const person = bookRules?.narrativePerson;
  if (!person) return "";
  if (language === "en") return `## Narrative person\n${person}; this durable constraint overrides model defaults.`;
  return `## 叙事人称\n${person}；该持久约束优先于模型默认。`;
}

function protagonistContract(bookRules: BookRules | null, language: "zh" | "en"): string {
  const protagonist = bookRules?.protagonist;
  if (!protagonist) return "";
  const separator = language === "en" ? ", " : "、";
  const locks = protagonist.personalityLock.join(separator);
  const boundaries = protagonist.behavioralConstraints.join(language === "en" ? "; " : "；");
  const prohibitions = bookRules.prohibitions.join(language === "en" ? "; " : "；");
  return language === "en"
    ? `## Protagonist authority\nName: ${protagonist.name}\nPersonality: ${locks || "(none)"}\nBehavioral constraints: ${boundaries || "(none)"}\nBook prohibitions: ${prohibitions || "(none)"}`
    : `## 主角权威\n名字：${protagonist.name}\n性格锁：${locks || "（无）"}\n行为约束：${boundaries || "（无）"}\n本书禁忌：${prohibitions || "（无）"}`;
}

function authorityBlock(title: string, body: string | undefined): string {
  const trimmed = body?.trim();
  if (!trimmed) return "";
  return `## ${title}\n${trimmed}`;
}
