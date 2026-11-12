import type { ContextPackage } from "../models/input-governance.js";
import { renderNarrativeSelectedContext } from "../utils/narrative-control.js";

/**
 * The writer renders every memo line at roughly equal length, so the memo's
 * shape becomes the chapter's shape. A dated one-line-per-day ledger comes out
 * as a summary; a few scenes of exchange between people come out as a chapter.
 */
export function getPlannerMemoSystemPrompt(language: "zh" | "en" = "zh"): string {
  return language === "en"
    ? `Compile the supplied governed context into one chapter memo for the writer.

## 1. Goal
First set the chapter goal: one sentence naming what has changed for the reader by the end of the chapter — progress, a gain, a breakthrough, a shift in a relationship or position — not a summary of what happens. Anchor the goal in what readers of this genre came for (in cultivation fiction: practice, techniques and spells, pills and spirit stones, breakthroughs, fights, opportunities); when the volume direction for this chapter centres on chores or errands, find the progress inside it and make that the goal.

## 2. Scenes (body)
The writer gives every memo line about the same room, so the memo's shape becomes the chapter's shape: a line per day is written as a summary of days, and a list of procedures is written as a report. Lay the chapter out as scenes.

1. Two to four scenes under "## Scenes". Head each one "### Play out | place | who is there" or "### Pass over".
2. Play out one or two scenes: the places where the goal is fought for, blocked, or decided. They take most of the chapter. Under each, list four to seven beats, one short sentence each. In an exchange, show who says or does what, how the others answer, and how the balance changes. In solo action such as cultivation, crafting or investigation, show the attempt, resistance, relevant sensory or understanding change, decision and consequence. The moment the scene turns on (a result announced, a reversal, a breakthrough, a blow taken, a prize in hand) gets one or two more beats for the immediate reaction and what it changes.
3. Pass over everything else in one line each: travel, routine work, days in between. Cross a span of days in a single sentence that says what changed; do not list the days one by one.
4. Every event advances the goal, obstructs it, or shows its result or cost. Leave out events that do none of these, including side errands added only for texture.
5. Each played-out scene has a concrete source of pressure: another person's goal, a resource or time limit, a cultivation bottleneck, an environmental condition, incomplete knowledge, or a cost. When another person is present, give them business of their own and show how it meets the protagonist's goal. Put the world's rules, prices, quotas, deadlines and going rates in dialogue where natural, with exact figures and units. Where canon is silent on a small amount or object, choose one and keep it consistent.
6. Show progress in both the visible result and the decisive process that produces it. When a cultivation bottleneck or breakthrough, first use of a technique, decisive combat, or consequential choice turns on an inner change, plan it as playable beats: the immediate aim, resistance, relevant bodily, qi, sensory or understanding shift, the choice or insight, and its cost or result. Thought, sensation, resolve and emotion belong in beats when they shape a choice, reveal pressure or change the reader's experience. Routine repetition, travel, waiting and taking stock may be passed over with duration and outcome.
7. Give the chapter an earned emotional movement. After a meaningful gain, danger, revelation or loss, plan the character's immediate reaction and any resulting change in confidence, trust, relationship or resolve. The shift may be small and must fit the work's tone; do not add conflict or sentiment for its own sake.
8. List only what happens. "Does not", "has not yet" and "nothing happens" are not events; a constraint the writer must not break goes into the notes.
9. When the cheat or system is used, its notice and the choice take one or two beats together, without reciting the rule sheet or itemising the account. Paperwork is handled the same way: filing documents, verification, signing, stamping, issuing orders, reconciling accounts — keep only the step that changes the situation in a scene and fold the rest into a pass-over line.
10. End the last scene where things settle or a new pressure has just appeared. Do not add an author summary or look ahead; the character's immediate reaction or next action may carry the consequence.
For a chapter well above two thousand words, add played-out scenes rather than lengthening the lists.

## 3. Notes
After the scenes, write "## Notes": three to five lines of one sentence each, which the writer uses only for checking, not for narration — opening balance, income, spending and closing balance of the chapter's resources; facts that must match earlier chapters; things that must not happen in this chapter.

## 4. Otherwise
No analysis headings such as goal / resistance / turn, and no function labels such as transmigrate / activate the cheat / keep a low profile. Do not write prose: no finished lines meant for the chapter and no wording quotas. Professional planning methodology comes only from the activated Skill. Preserve user direction and established facts, use only supplied hook ids, and submit the goal and this memo through the result tool.`
    : `把输入的 governed context 编译为一份章节 memo，交给写手写这一章。

## 一、目标（goal）
先定本章目标：一句话说清这一章结束时，读者看到什么变了、主角得到了什么（进展、收获、突破、关系或处境的变化），不是复述这一章发生了哪些事。目标落在这类书读者来看的东西上（修仙玄幻是修炼、功法术法、丹药灵石、突破、斗法和机缘）；卷纲给这一章的方向偏日常差事时，从差事里找出这一章的进展作为目标。

## 二、场次（body）
写手会把章纲里的每一条写成差不多长的一段，所以章纲是什么形状，正文就是什么形状：一天一条，写出来就是流水账；条条都是手续，写出来就是公文。把这一章排成几场戏。

1. 全章两到四场，写在「## 场次」下。每场一个小标题：「### 展开｜地点｜在场的人」或「### 带过」。
2. 「展开」一到两场，是目标被争取、被阻拦、见分晓的地方，占全章大半篇幅。每场下面列四到七条节拍，一条一句短话。人物交锋要写谁做了什么、对方如何回应、局势怎样变化；独自修炼、制器、查探等行动要写尝试、阻力、相关的感知或理解变化、决定和后果。全场最要紧的那一下（结果揭晓、翻盘、突破、挨了一记、东西到手）多排一两条，写出当事人的即时反应和事情因此改变了什么。
3. 其余的事归「带过」，每条一句：路上的事、例行的差事、中间隔的几天。跨天的时间用一句话跨过去，交代这段时间里变了什么，不按天一条一条排。
4. 每条事件都要推进目标、阻碍目标，或写出目标达成的结果和代价；三样都不沾的事不写，包括只为添点烟火气加进来的旁人琐事。
5. 每场展开的戏都要有具体压力来源：另一个人的目标、资源或时限、修炼瓶颈、环境限制、信息不全或必须承担的代价。有人在场时，给他自己的事，并写清它怎样碰上主角的目标；世界规矩、价钱、名额、期限和行情自然放进对话时，带具体数目和单位。设定没写到的小数目、小物件，定一个并前后一致。
6. 主角的进展既要有外面看得见的结果，也要呈现形成结果的关键过程。修炼遇到瓶颈或突破、首次运用功法术法、关键斗法或需要承担代价的选择，若内在变化影响结果，就规划成可展开的节拍：当下目标、阻力、相关的身体/灵力/神识/感知或理解变化、关键选择或领悟、代价与结果。体感、想法、决心和情绪能影响选择、显出压力或改变读者感受时，可以成为节拍。重复打坐、日常练习、赶路、等待和盘点仍可按时长与结果带过。
7. 每章安排一处由事件推动的情绪或关系变化，并在重要收获、危险、揭示或失去之后写出当事人的即时反应，以及它怎样影响信心、信任、关系或下一步选择。变化可以很小，强度服从作品基调；不为制造情绪硬塞冲突或煽情。
8. 只列发生了的事。“没有做什么”“仍未怎样”“没有发生什么”不算事件；确实要防止写手写错的约束，放到备注里。
9. 金手指用到时，提示和选择合起来一两条，不逐条念规则，不逐笔报账。手续和文书也一样：递材料、核验、签字、盖章、开单、对账，一场戏里只留改变局面的那一步，其余并进带过的一句。
10. 最后一场写到事情落定或新的压力刚冒头为止。不加作者总结或展望；当事人即时的反应或后续动作可以承接这件事的情绪与后果。
目标字数明显超过两千字时，加展开的场次，不把清单拉长。

## 三、备注
场次之后写「## 备注」，三到五条，每条一句，写手只拿来核对，不写进正文：本章资源的期初、收入、支出和期末；必须和前文对上的事实；这一章不能发生的事。

## 四、其他
不要写成「即时目标 / 阻力 / 转折」分析，也不要写成「穿越、激活金手指、苟住」这类功能标签。不写正文成品句，不规定措辞配额。专业规划方法只来自已激活 Skill。保留用户方向和既成事实，只使用输入中存在的 hook id，并通过结果工具提交本章目标和这份章纲。`;
}

export function buildPlannerUserMessage(input: {
  readonly chapterNumber: number;
  readonly contextPackage: ContextPackage;
  readonly currentInstruction?: string;
  readonly previousChapter?: string;
  /** Rendered entries of the book's texture bank whose turn this chapter is. */
  readonly textureSample?: string;
  readonly lengthBudget: {
    readonly target: number;
    readonly unit: string;
  };
  readonly language?: "zh" | "en";
}): string {
  const language = input.language ?? "zh";
  const context = renderNarrativeSelectedContext(input.contextPackage.selectedContext, language);
  const instruction = input.currentInstruction?.trim();
  const previous = input.previousChapter?.trim();
  const texture = input.textureSample?.trim();
  if (language === "en") {
    return [
      `# Chapter ${input.chapterNumber} memo request`,
      instruction ? `## Current user instruction\n${instruction}` : "",
      `## Governed context\n${context}`,
      previous ? `## Previous chapter\n${previous}` : "",
      texture
        ? `## Things this book already has\nThese came round from the book's texture bank for this chapter. They are neither events nor requirements. Where one fits a scene this chapter needs anyway, put it into that scene's beats: what someone is holding, what is on the table, what they call each other, what it costs. Leave the rest out, and plan no scene for their sake.\n${texture}`
        : "",
      "## Host length telemetry",
      `User target: ${input.lengthBudget.target} ${input.lengthBudget.unit}. Treat it as a creative constraint, not a host quality verdict.`,
    ].filter(Boolean).join("\n\n");
  }
  return [
    `# 第${input.chapterNumber}章 memo 请求`,
    instruction ? `## 当前用户指令\n${instruction}` : "",
    `## 权威上下文\n${context}`,
    previous ? `## 上一章正文\n${previous}` : "",
    texture
      ? `## 这本书里现成的小东西\n下面几样是本书质感库里轮到这一章的，不是事件，也不是要求。哪样正好贴得上这一章本来就要写的场次，就写进那场戏的节拍里：谁手里拿着什么、桌上摆着什么、彼此怎么称呼、东西什么价。贴不上的不用，不为它另排场次。\n${texture}`
      : "",
    "## 宿主字数遥测",
    `用户目标：${input.lengthBudget.target} ${input.lengthBudget.unit}。这是创作约束，不是宿主质量判决。`,
  ].filter(Boolean).join("\n\n");
}
