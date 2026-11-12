import type { Observation } from "../models/observation.js";

/**
 * What can be measured about a finished Chinese chapter without a model: the
 * stock phrases and sentence moulds that read as machine-written, and the
 * shape of the chapter (who speaks, how long the paragraphs run, how much of
 * it happens inside one body). A prompt that lists such patterns tends to get
 * their near neighbours back, so they are counted after the draft exists and
 * reported as observations for the author. Nothing is rewritten.
 */
export interface ProseLintFinding {
  readonly rule: string;
  readonly summary: string;
  /** Exact excerpts of the chapter, in order of appearance. */
  readonly quotes: ReadonlyArray<string>;
}

interface Paragraph {
  readonly text: string;
  /** Someone speaks in it. */
  readonly spoken: boolean;
}

const MAX_QUOTES = 5;
/** Serial prose on a phone screen: published chapters in this form rarely pass sixty characters a paragraph. */
const LONG_PARAGRAPH = 80;
const VERY_LONG_PARAGRAPH = 150;

const SENTENCE = /[^。！？!?…\n]+[。！？!?…]*/g;
const QUOTATION = /[“「『"]/;

const CONTRAST = /(?:不是|并非)[^，。！？!?；\n]{1,24}，?而是|不是[^，。！？!?；\n]{1,10}，是[^，。！？!?；\n]{1,14}/;
/** The same contrast broken over two sentences: a short denial, then the assertion as a line of its own. */
const DENIAL = /^(?:这|那|他|她|倒|也|可|但|并)?(?:不是|并非)[^，。！？!?；]{1,16}。$/;
const ASSERTION = /^(?:而)?是[^。！？!?]{1,30}[。！]$/;
const NEGATION_RUN = /没有[^，。！？!?；\n]{1,14}，(?:也|更)?没有[^，。！？!?；\n]{1,14}/;
const SAME_AS_BEFORE = /还是(?:这|那)[^，。！？!?\n]{1,6}，[^，。！？!?\n]{1,6}还是(?:这|那)/;

const STOCK_REACTION = new RegExp([
  "心跳(?:加速|加快|漏了一拍|如鼓)",
  "深吸(?:了)?一口气",
  "倒吸(?:了)?一口(?:凉|冷)气",
  "嘴角(?:露出|勾起|扬起|浮现|浮起|泛起)(?:了)?一(?:丝|抹)",
  "眼前一亮",
  "猛地睁开(?:了)?(?:眼|双眼|眼睛)",
  "愣住了",
  "强迫自己冷静",
  "眼中闪过一(?:丝|抹)(?:复杂|异色|讶异|惊讶|惊异|诧异|不易察觉)",
  "瞳孔(?:一缩|骤缩|微缩|猛地一缩)",
  "呼吸一滞",
  "指节(?:发白|泛白)",
  "喉结(?:滚动|上下滚动|动了动)",
  "心(?:中|头|里)(?:一凛|一沉|一紧|一震|五味杂陈)",
  "如释重负",
  "头痛欲裂",
].join("|"), "g");

const NARRATOR_VERDICT = new RegExp([
  "就这些了",
  "这就是(?:他|她)(?:的)?全部",
  "算得明明白白",
  "这下有盼头了",
  "一切都(?:不一样|变)了",
  "仅此而已",
].join("|"), "g");

const EMPTY_TRANSITION = /正想着[，,]|不知(?:不觉)?过了多久|时间一分一秒地?(?:过去|流逝)|天色(?:渐渐|慢慢)(?:暗|黑)了下来/g;

const PLANNING_REGISTER = /(?<![A-Za-z0-9])D\d{1,3}(?![A-Za-z0-9])|期初|期末|未发生|不登记|不推定|本章|章纲/g;

const CLOSING_FORMULA = /才刚刚开始|只是(?:个|一个)?开始|路还(?:很)?长|日子还长|拭目以待|新的篇章|暗流涌动|山雨欲来|风雨欲来/;

const AMOUNT = /[零一二两三四五六七八九十百千万\d]+(?:块|枚|点|粒|文|颗|株|斤|担|桶|钱|两银)/g;
const TALLY = /还剩|剩下|余下|一共|合计|总共|共计|加起来|算下来|拢共|统共|结余|余额/;

const INNER_BODY = /丹田|经脉|气海|周天|灵气|灵力|真气|法力|气流|暖流|热流|气感/g;

export function lintChineseProse(content: string): ProseLintFinding[] {
  const paragraphs = splitParagraphs(content);
  if (paragraphs.length === 0) return [];
  const narration = paragraphs.filter((paragraph) => !paragraph.spoken);
  const sentences = paragraphs.flatMap((paragraph) => paragraph.text.match(SENTENCE) ?? []).map((sentence) => sentence.trim());
  const characters = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
  const findings: ProseLintFinding[] = [];
  const add = (rule: string, quotes: ReadonlyArray<string>, summary: string): void => {
    findings.push({ rule, summary, quotes: quotes.slice(0, MAX_QUOTES) });
  };
  const count = (rule: string, found: ReadonlyArray<string> | Matches, summary: (found: number) => string, minimum = 1): void => {
    const quotes = "quotes" in found ? found.quotes : found;
    const hits = "hits" in found ? found.hits : found.length;
    if (hits >= minimum) add(rule, quotes, summary(hits));
  };

  count("contrast-negation", sentences.filter((sentence) => CONTRAST.test(sentence)),
    (found) => `“不是……而是……”式对照 ${found} 处。`, 2);
  count("split-contrast", sentences
    .map((sentence, index) => DENIAL.test(sentence) && ASSERTION.test(sentences[index + 1] ?? "") ? `${sentence}${sentences[index + 1]}` : "")
    .filter(Boolean),
  (found) => `“不是……。是……。”拆成两句的对照 ${found} 处。`);
  count("negation-run", sentences.filter((sentence) => NEGATION_RUN.test(sentence)),
    (found) => `“没有……，没有……”式排比 ${found} 处。`, 2);
  count("parallel-repeat", sentences.filter((sentence) => SAME_AS_BEFORE.test(sentence)),
    (found) => `“……还是这……，……还是这……”式重复 ${found} 处。`);
  count("stock-reaction", matches(paragraphs, STOCK_REACTION),
    (found) => `现成的情绪套话 ${found} 处。`, 2);
  count("narrator-verdict", matches(narration, NARRATOR_VERDICT),
    (found) => `替读者下结论的复述句 ${found} 处。`);
  count("empty-transition", matches(narration, EMPTY_TRANSITION),
    (found) => `空过场 ${found} 处：时间过去了，没有带出变化。`);
  count("planning-register", matches(narration, PLANNING_REGISTER),
    (found) => `规划或账本用语进了正文 ${found} 处。`);
  count("ledger-recital", narration
    .filter((paragraph) => TALLY.test(paragraph.text) && (paragraph.text.match(AMOUNT)?.length ?? 0) >= 3)
    .map((paragraph) => paragraph.text),
  (found) => `整段报账的叙述 ${found} 段。同一笔账说一次就够。`, 2);

  const runs = repeatedOpenings(paragraphs);
  if (runs.length > 0) {
    add("repeated-opening", runs.map((run) => run.quote),
      `连续多段用同一个词起笔：${runs.map((run) => `“${run.opening}”连续 ${run.length} 段`).join("，")}。`);
  }

  const closing = paragraphs.slice(-2).filter((paragraph) => CLOSING_FORMULA.test(paragraph.text));
  if (closing.length > 0) add("closing-formula", closing.map((paragraph) => paragraph.text), "章末停在套话式的总结或展望上。");

  // The chapter's shape. Only judged once there is enough text to have one.
  if (paragraphs.length < 20) return findings;

  const spokenShare = (paragraphs.length - narration.length) / paragraphs.length;
  const silence = longestNarrationRun(paragraphs);
  if (spokenShare < 0.15) {
    add("sparse-dialogue", [paragraphs[silence.start]!.text],
      `有人开口的段落只占 ${percent(spokenShare)}，最长连着 ${silence.length} 段没有对话。这一章主要靠叙述撑着，容易读成概述。`);
  }

  const inner = narration
    .map((paragraph) => ({ text: paragraph.text, hits: paragraph.text.match(INNER_BODY)?.length ?? 0 }))
    .filter((paragraph) => paragraph.hits > 0);
  const innerDensity = 1000 * inner.reduce((sum, paragraph) => sum + paragraph.hits, 0) / characters;
  if (innerDensity >= 4) {
    add("inner-sensation", [...inner].sort((left, right) => right.hits - left.hits).slice(0, 3).map((paragraph) => paragraph.text),
      `行功和体内感受的用词每千字 ${innerDensity.toFixed(1)} 处。修炼的过程交代用时和结果就够，篇幅留给人和事。`);
  }

  const long = paragraphs.filter((paragraph) => paragraph.text.length > LONG_PARAGRAPH);
  const longest = Math.max(0, ...long.map((paragraph) => paragraph.text.length));
  if (long.length / paragraphs.length >= 0.1 || longest > VERY_LONG_PARAGRAPH) {
    add("long-paragraph", long.map((paragraph) => paragraph.text),
      `超过 ${LONG_PARAGRAPH} 字的段落 ${long.length} 段（占 ${percent(long.length / paragraphs.length)}），最长 ${longest} 字。`);
  }

  const lengths = sentences.map((sentence) => sentence.length);
  if (lengths.length >= 40) {
    const mean = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    const spread = Math.sqrt(lengths.reduce((sum, length) => sum + (length - mean) ** 2, 0) / lengths.length) / mean;
    if (spread < 0.5) {
      add("even-sentences", [],
        `句子长短很齐：平均 ${mean.toFixed(0)} 字，起伏小（离散系数 ${spread.toFixed(2)}）。长短句交替、对话里的短句能把节奏拉开。`);
    }
  }

  return findings;
}

export function proseLintObservations(
  content: string,
  language: string,
  sourceId?: string,
): Observation[] {
  if (!/^zh/i.test(language)) return [];
  return lintChineseProse(content).map((finding) => ({
    code: `prose-lint/${finding.rule}`,
    summary: finding.summary,
    evidence: finding.quotes.map(excerpt),
    category: "quality" as const,
    assessment: "observation" as const,
    ...(sourceId && finding.quotes.length > 0
      ? { sourceRefs: finding.quotes.map((quote) => ({ sourceId, quote })) }
      : {}),
  }));
}

function splitParagraphs(content: string): Paragraph[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#/.test(line) && !/^第[零一二三四五六七八九十百千\d]+章(?:\s|$)/.test(line))
    .map((text) => ({ text, spoken: QUOTATION.test(text) }));
}

interface Matches {
  /** The sentence around each match, once per sentence. */
  readonly quotes: ReadonlyArray<string>;
  /** Every occurrence; one sentence can stack several. */
  readonly hits: number;
}

function matches(paragraphs: ReadonlyArray<Paragraph>, pattern: RegExp): Matches {
  const quotes: string[] = [];
  let hits = 0;
  for (const paragraph of paragraphs) {
    for (const sentence of paragraph.text.match(SENTENCE) ?? []) {
      const found = sentence.match(pattern)?.length ?? 0;
      if (found === 0) continue;
      hits += found;
      quotes.push(sentence.trim());
    }
  }
  return { quotes, hits };
}

function longestNarrationRun(paragraphs: ReadonlyArray<Paragraph>): { start: number; length: number } {
  let best = { start: 0, length: 0 };
  let start = 0;
  for (let index = 0; index <= paragraphs.length; index += 1) {
    if (index < paragraphs.length && !paragraphs[index]!.spoken) continue;
    if (index - start > best.length) best = { start, length: index - start };
    start = index + 1;
  }
  return best;
}

function repeatedOpenings(paragraphs: ReadonlyArray<Paragraph>): Array<{ opening: string; length: number; quote: string }> {
  const runs: Array<{ opening: string; length: number; quote: string }> = [];
  let start = 0;
  for (let index = 1; index <= paragraphs.length; index += 1) {
    if (index < paragraphs.length && openingWord(paragraphs[index]!) === openingWord(paragraphs[start]!)) continue;
    const opening = openingWord(paragraphs[start]!);
    if (opening && index - start >= 4) runs.push({ opening, length: index - start, quote: paragraphs[start]!.text });
    start = index;
  }
  return runs;
}

function openingWord(paragraph: Paragraph): string | undefined {
  if (QUOTATION.test(paragraph.text[0] ?? "")) return undefined;
  if (/^[他她它]/.test(paragraph.text)) return paragraph.text[0];
  return /^[\u4e00-\u9fff]{2}/.exec(paragraph.text)?.[0];
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function excerpt(quote: string): string {
  return quote.length > 80 ? `${quote.slice(0, 78)}……` : quote;
}
