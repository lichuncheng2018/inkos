import { describe, expect, it } from "vitest";
import { DEFAULT_REVISE_MODE } from "../agents/reviser.js";
import { getPlannerMemoSystemPrompt } from "../agents/planner-prompts.js";
import { createBuiltInWorkProfileRegistry } from "../harness/builtin-profiles.js";
import { buildHarnessSystemPrompt } from "../harness/system-prompt.js";
import { createReviseChapterTool, createWriteChaptersTool } from "../harness/tools/longform-production.js";

describe("longform high-score generation and revision path", () => {
  it("plans concrete events and delegates prose cleanup to the writing pipeline without extra revision calls", () => {
    expect(DEFAULT_REVISE_MODE).toBe("spot-fix");
    expect(getPlannerMemoSystemPrompt("zh")).toContain("先定本章目标");
    expect(getPlannerMemoSystemPrompt("zh")).toContain("每条事件都要推进目标、阻碍目标");
    expect(getPlannerMemoSystemPrompt("zh")).not.toContain("其余写当天的活计");
    expect(getPlannerMemoSystemPrompt("zh")).toContain("手续和文书也一样");
    expect(getPlannerMemoSystemPrompt("zh")).toContain("三到五条，每条一句");
    expect(getPlannerMemoSystemPrompt("zh")).toContain("写出当事人的即时反应和事情因此改变了什么");
    expect(getPlannerMemoSystemPrompt("zh")).not.toContain("章纲里不排体内感受、心理活动和感想");
    expect(getPlannerMemoSystemPrompt("zh")).toContain("突破、首次运用功法术法");
    expect(getPlannerMemoSystemPrompt("zh")).toContain("每章安排一处由事件推动的情绪或关系变化");
    expect(getPlannerMemoSystemPrompt("zh")).toContain("独自修炼、制器、查探等行动");
    expect(getPlannerMemoSystemPrompt("en")).toContain("In solo action such as cultivation");
    expect(getPlannerMemoSystemPrompt("en")).toContain("First set the chapter goal");
    expect(getPlannerMemoSystemPrompt("en")).toContain("Every event advances the goal, obstructs it");
    expect(getPlannerMemoSystemPrompt("en")).toContain("Paperwork is handled the same way");
    expect(getPlannerMemoSystemPrompt("en")).toContain("immediate reaction and what it changes");
    expect(getPlannerMemoSystemPrompt("en")).toContain("decisive process that produces it");
    expect(getPlannerMemoSystemPrompt("en")).toContain("Give the chapter an earned emotional movement");

    const registry = createBuiltInWorkProfileRegistry();
    const longform = buildHarnessSystemPrompt({
      profile: registry.require("longform-novel"),
      work: null,
      language: "zh",
    });
    expect(longform).toContain("不要为了清掉观察或 needs_revision 自动调用 revise_chapter");
    expect(longform).toContain("审稿后执行一轮去 AI 味");
    expect(longform).not.toContain("写完一章后保持初稿");
    expect(longform).toContain("mode 必须是 spot-fix");
    expect(longform).toContain("朱雀");
    expect(buildHarnessSystemPrompt({
      profile: registry.require("longform-novel"),
      work: null,
      language: "en",
    })).toContain("do not call revise_chapter to clear observations");
    expect(buildHarnessSystemPrompt({
      profile: registry.require("longform-novel"),
      work: null,
      language: "en",
    })).toContain("one semantic prose cleanup after review");
    expect(buildHarnessSystemPrompt({
      profile: registry.require("short-fiction"),
      work: null,
      language: "zh",
    })).not.toContain("## 长篇正文");

    const pipeline = {} as never;
    expect(createWriteChaptersTool(pipeline, "book").description).toContain("do not follow it with revise_chapter unless the user asked");
    expect(createWriteChaptersTool(pipeline, "book").description).toContain("semantic prose cleanup after review");
    expect(createReviseChapterTool(pipeline, "book").description).toContain("Default mode is spot-fix");
    expect(createReviseChapterTool(pipeline, "book").description).toContain("AIGC/Zhuque");
  });
});
