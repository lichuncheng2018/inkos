import type { BookConfig } from "../models/book.js";
import type { ChapterMemo, ContextPackage } from "../models/input-governance.js";
import { renderNarrativeSelectedContext } from "../utils/narrative-control.js";

export interface ReaderPlanRevision {
  readonly draft: ChapterMemo;
  readonly feedback: string;
}

/**
 * The writer renders every memo line at roughly equal length, so the memo's
 * shape becomes the chapter's shape. A dated one-line-per-day ledger comes out
 * as a summary; a few scenes of exchange between people come out as a chapter.
 */
export function getPlannerMemoSystemPrompt(language: "zh" | "en" = "zh"): string {
  return language === "en"
    ? `Compile the supplied governed context into one chapter memo for the writer.

## 1. Reader experience and goal
Decide these in order before laying out the scenes:
1. What the reader most wants to see now. Name a specific action, encounter or discovery that pays into this book's promise or follows from the pressure of the last chapter. Choose it for this book and this point in the story.
2. Where to start. Pick the moment that puts that interest in play and put the action in the first beat of the first scene. When the author specifies the opening, start with that event. Supply only the earlier facts needed to understand the action when they become relevant.
3. What result in this chapter the reader will see. First set the chapter goal as one sentence naming the concrete change the scenes deliver by the end: a result demonstrated, a choice with a consequence, a loss, or a shift in knowledge, trust or position. Give even a quiet chapter a change the reader can experience. If a larger result needs more time, show a completed step that materially changes the situation now. An intention or the start of routine work cannot stand in for an outcome the chapter is meant to deliver.

Use the author's current instruction to decide what opens and what resolves here. It takes precedence over the proposed sequence of unwritten events in the volume outline and genre defaults. Keep established events, hard constraints and causal prerequisites intact. Reveal a premise or show its first use as soon as this story calls for it; the chapter number alone does not determine when.

## 2. Scenes (body)
The writer gives every memo line about the same room, so the memo's shape becomes the chapter's shape: a line per day is written as a summary of days, and a list of procedures is written as a report. Lay the chapter out as scenes.

1. Two to four scenes under "## Scenes". Head each one "### Play out | place | who is there" or "### Pass over".
2. Play out one or two scenes, giving the most room to the choice, clash, or test that decides the goal. Use short beats only where the situation or a character's response changes. Show just enough setup for the reader to understand what is at stake, then move to the decisive attempt. Plan the evidence the reader sees or hears, the character's immediate reaction, and what they can do differently now. A concrete obstacle, a changed decision, or a cost can earn more room than a routine step.
3. Pass over everything else in one line each: travel, routine work, days in between. Before the decisive attempt, keep only the conditions that affect whether or how it can happen. Place background, explanations and follow-up that do not affect the attempt after the first visible result, where they bear on a decision. Cross a span of days in a single sentence that says what changed.
4. Every event advances the goal, obstructs it, or shows its result or cost. Leave out events that do none of these, including side errands added only for texture.
5. Each played-out scene has a concrete source of pressure: another person's goal, a resource or time limit, a cultivation bottleneck, an environmental condition, incomplete knowledge, or a cost. When another person is present, give them business of their own and show how it meets the protagonist's goal. Put the world's rules, prices, quotas, deadlines and going rates in dialogue where natural, with exact figures and units. Where canon is silent on a small amount or object, choose one and keep it consistent.
6. Show progress in both the visible result and the decisive process that produces it. When a cultivation bottleneck or breakthrough, first use of a technique, decisive combat, or consequential choice turns on an inner change, plan it as playable beats: the immediate aim, resistance, relevant bodily, qi, sensory or understanding shift, the choice or insight, and its cost or result. Thought, sensation, resolve and emotion belong in beats when they shape a choice, reveal pressure or change the reader's experience. Routine repetition, travel, waiting and taking stock may be passed over with duration and outcome.
7. Give the chapter an earned emotional movement. After a meaningful gain, danger, revelation or loss, plan the character's immediate reaction and any resulting change in confidence, trust, relationship or resolve. The shift may be small and must fit the work's tone; do not add conflict or sentiment for its own sake.
8. List only what happens. "Does not", "has not yet" and "nothing happens" are not events; a constraint the writer must not break goes into the notes.
9. When the cheat or system is used, its notice and the choice take one or two beats together, without reciting the rule sheet or itemising the account. Paperwork is handled the same way: filing documents, verification, signing, stamping, issuing orders, reconciling accounts — keep only the step that changes the situation in a scene and fold the rest into a pass-over line.
10. End the last scene where things settle or a new pressure has just appeared. Do not add an author summary or look ahead; the character's immediate reaction or next action may carry the consequence.

## 3. Notes
After the scenes, write "## Notes": three to five lines of one sentence each, which the writer uses only for checking, not for narration — opening balance, income, spending and closing balance of the chapter's resources; facts that must match earlier chapters; things that must not happen in this chapter.

## 4. Otherwise
Before submitting, check the actual first beat and the scene that delivers the goal. If the memo still opens on setup ahead of the chosen moment or stops before the promised result, rework the scene order. Write events, not analysis headings such as goal / resistance / turn or bare labels such as transmigrate / activate the cheat / keep a low profile. Do not write prose: no finished lines meant for the chapter and no wording quotas. Preserve user direction and established facts, use only supplied hook ids, and submit the goal and this memo through the result tool.`
    : `把输入的 governed context 编译为一份章节 memo，交给写手写这一章。

## 一、本章的读者体验与目标（goal）
列场次前，依次确定三件事：
1. 读者最想看什么。从本书的核心卖点、前一章留下的张力或作者当章要求里，选此刻值得在场看到的一个动作、交锋或发现。结合这本书眼下的处境来选。
2. 从哪一幕开始。找到能立刻让这份期待生效的时刻，把当时的具体动作放在首场第一拍。作者指定的开场事件就在这里发生。读者理解眼前行动所需的前情，用到时再补。
3. 当章结果是什么。先定本章目标，用一句话写出章内会呈现的具体变化，例如当场证实的结果、选择带来的后果、一次失去，或认知、信任和处境的变化。舒缓章也可以兑现一个有分量的小变化。大结果需要更久时，把已能完成、会改变局势的一步放到本章。若本章承诺解决或证明什么，排到实际发生为止，别收在答应、准备或刚开始做。

本章开场和结算范围以作者当前的明确要求为准，优先于卷纲里未写成正文的场次顺序和题材惯例。保留既成事实、硬约束及确有必要的因果前置条件。核心能力或悬念何时展示，由本书的卖点和当下剧情决定，章号本身不决定展示时点。

## 二、场次（body）
写手会把章纲里的每一条写成差不多长的一段，所以章纲是什么形状，正文就是什么形状：一天一条，写出来就是流水账；条条都是手续，写出来就是公文。把这一章排成几场戏。

1. 全章两到四场，写在「## 场次」下。每场一个小标题：「### 展开｜地点｜在场的人」或「### 带过」。
2. 「展开」一到两场，把最多篇幅留给决定章目标的交锋、选择或验证。只给局势或人物反应有变化的地方排节拍，一条一句短话。交代清眼下的利害就进入关键尝试。排出读者能亲眼看见或听见的结果、人物当场的反应，以及他下一步能做的事因此有什么不同。真正的阻力、临场改主意或付出的代价值得多写几拍。
3. 其余的事归「带过」，每条一句：路上的事、例行的差事、中间隔的几天。关键尝试之前只留决定这一步能不能做、怎么做的条件。其余背景、解释和交接等到第一次看见结果以后，有下一步决定用得上时再写。跨天用一句话交代变了什么。
4. 每条事件都要推进目标、阻碍目标，或写出目标达成的结果和代价；三样都不沾的事不写，包括只为添点烟火气加进来的旁人琐事。
5. 每场展开的戏都要有具体压力来源：另一个人的目标、资源或时限、修炼瓶颈、环境限制、信息不全或必须承担的代价。有人在场时，给他自己的事，并写清它怎样碰上主角的目标；世界规矩、价钱、名额、期限和行情自然放进对话时，带具体数目和单位。设定没写到的小数目、小物件，定一个并前后一致。
6. 主角的进展既要有外面看得见的结果，也要呈现形成结果的关键过程。修炼遇到瓶颈或突破、首次运用功法术法、关键斗法或需要承担代价的选择，若内在变化影响结果，就规划成可展开的节拍：当下目标、阻力、相关的身体/灵力/神识/感知或理解变化、关键选择或领悟、代价与结果。体感、想法、决心和情绪能影响选择、显出压力或改变读者感受时，可以成为节拍。重复打坐、日常练习、赶路、等待和盘点仍可按时长与结果带过。
7. 每章安排一处由事件推动的情绪或关系变化，并在重要收获、危险、揭示或失去之后写出当事人的即时反应，以及它怎样影响信心、信任、关系或下一步选择。变化可以很小，强度服从作品基调；不为制造情绪硬塞冲突或煽情。
8. 只列发生了的事。“没有做什么”“仍未怎样”“没有发生什么”不算事件；确实要防止写手写错的约束，放到备注里。
9. 金手指用到时，提示和选择合起来一两条，不逐条念规则，不逐笔报账。手续和文书也一样：递材料、核验、签字、盖章、开单、对账，一场戏里只留改变局面的那一步，其余并进带过的一句。
10. 最后一场写到事情落定或新的压力刚冒头为止。不加作者总结或展望；当事人即时的反应或后续动作可以承接这件事的情绪与后果。

## 三、备注
场次之后写「## 备注」，三到五条，每条一句，写手只拿来核对，不写进正文：本章资源的期初、收入、支出和期末；必须和前文对上的事实；这一章不能发生的事。

## 四、其他
提交前检查首场第一拍和兑现目标的那一幕。如果开场还在为选定事件铺垫，或章末还在等待当章结果，先重排场次。写具体发生的事，不用「即时目标 / 阻力 / 转折」分析或「穿越、激活金手指、苟住」之类标签代替事件。不写正文成品句，不规定措辞配额。保留用户方向和既成事实，只使用输入中存在的 hook id，并通过结果工具提交本章目标和这份章纲。`;
}

export function buildPlannerUserMessage(input: {
  readonly chapterNumber: number;
  readonly book?: Pick<BookConfig, "title" | "genre" | "platform">;
  readonly contextPackage: ContextPackage;
  readonly currentInstruction?: string;
  readonly previousChapter?: string;
  /** Rendered entries of the book's texture bank whose turn this chapter is. */
  readonly textureSample?: string;
  readonly readerRevision?: ReaderPlanRevision;
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
  const revision = input.readerRevision;
  const book = input.book ? JSON.stringify({ title: input.book.title, genre: input.book.genre, platform: input.book.platform }) : "";
  const firstChapter = input.chapterNumber === 1;
  if (language === "en") {
    return [
      `# Chapter ${input.chapterNumber} memo request`,
      instruction ? `## Current user instruction\n${instruction}` : "",
      book ? `## Book\n${book}` : "",
      firstChapter
        ? "## Choosing the opening of chapter one\nCompare the first event in the outline with the earliest beat that puts the book's distinctive premise or central question in play. Choose the strongest understandable action for the first beat, unless the author explicitly chose a different opening. The chronology in a proposed outline keeps the cause and effect true. It does not require showing every prerequisite in order. Let readers learn routine setup when the opening action needs it, and show the immediate result within the chapter."
        : "",
      `## Governed context\n${context}`,
      previous ? `## Previous chapter\n${previous}` : "",
      revision
        ? `## First plan and reader feedback\nSubmit a revised complete memo. When the reader selects an opening event, put it in the first beat if it is compatible with the author's current direction, required events and established facts. Briefly backfill prerequisites after entering the scene. Preserve the draft's constraints where they still apply.\n\nDraft goal: ${revision.draft.goal}\n\n${revision.draft.body}\n\n### Reader feedback\n${revision.feedback}`
        : "",
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
    book ? `## 作品资料\n${book}` : "",
    firstChapter
      ? "## 第1章的切入点\n比较卷纲最先列的事件和本章最早让独特卖点或核心疑问发生作用的动作。作者未明确指定另一种开场时，选读者容易理解、也最值得继续看的那个动作作为首拍。卷纲的时间顺序用来保全因果，正文可以从关键时刻进入。例行试验、前史和准备在需要时简短补叙，让读者当章看见眼前事件的结果。"
      : "",
    `## 权威上下文\n${context}`,
    previous ? `## 上一章正文\n${previous}` : "",
    revision
      ? `## 首版章策与读者反馈\n提交重排后的完整章策。读者指定了开场事件时，只要符合作者当前要求、必写事件与既成事实，就把它放进首场第一拍，入场后简短补叙所需前情。沿用原章策中仍适用的约束。\n\n原目标：${revision.draft.goal}\n\n${revision.draft.body}\n\n### 读者反馈\n${revision.feedback}`
      : "",
    texture
      ? `## 这本书里现成的小东西\n下面几样是本书质感库里轮到这一章的，不是事件，也不是要求。哪样正好贴得上这一章本来就要写的场次，就写进那场戏的节拍里：谁手里拿着什么、桌上摆着什么、彼此怎么称呼、东西什么价。贴不上的不用，不为它另排场次。\n${texture}`
      : "",
    "## 宿主字数遥测",
    `用户目标：${input.lengthBudget.target} ${input.lengthBudget.unit}。这是创作约束，不是宿主质量判决。`,
  ].filter(Boolean).join("\n\n");
}
