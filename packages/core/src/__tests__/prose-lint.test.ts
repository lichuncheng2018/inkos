import { describe, expect, it } from "vitest";
import { lintChineseProse, proseLintObservations } from "../utils/prose-lint.js";
import { ObservationSchema } from "../models/observation.js";

const rules = (content: string) => lintChineseProse(content).map((finding) => finding.rule);
const chapter = (paragraphs: ReadonlyArray<string>) => `# 第3章 试药\n\n${paragraphs.join("\n\n")}\n`;

/** Twenty-four short paragraphs, half of them spoken, with uneven sentences. */
const lively = Array.from({ length: 12 }, (_, index) => [
  `老周把第${index + 1}筐炭往地上一墩，拍了拍手上的灰，冲他咧嘴。`,
  index % 2 === 0 ? "“还差几筐？”" : "“你倒是搭把手啊，愣着干啥！我这腰可经不起再来一趟了。”",
]).flat();

describe("Chinese prose lint", () => {
  it("reports nothing for a chapter carried by short spoken beats", () => {
    expect(lintChineseProse(chapter(lively))).toEqual([]);
    expect(lintChineseProse("")).toEqual([]);
  });

  it("quotes the sentence moulds and stock phrases it counts", () => {
    const findings = lintChineseProse([
      "他深吸一口气，心跳加速。这不是恐惧，而是兴奋。",
      "屋里没有灯，也没有人。他要的不是银子，而是一句准话。",
      "没有风，更没有声响。",
      "正想着，天色渐渐暗了下来。这就是他的全部家当。",
      "他的修仙之路才刚刚开始。",
    ].join("\n\n"));
    const byRule = new Map(findings.map((finding) => [finding.rule, finding]));
    expect([...byRule.keys()]).toEqual([
      "contrast-negation", "negation-run", "stock-reaction", "narrator-verdict", "empty-transition", "closing-formula",
    ]);
    expect(byRule.get("stock-reaction")!.quotes).toEqual(["他深吸一口气，心跳加速。"]);
    expect(byRule.get("contrast-negation")!.quotes).toEqual(["这不是恐惧，而是兴奋。", "他要的不是银子，而是一句准话。"]);
    expect(byRule.get("closing-formula")!.quotes).toEqual(["他的修仙之路才刚刚开始。"]);
  });

  it("does not count a turn of phrase a human author uses once", () => {
    expect(rules("他深吸一口气，推开了门。\n\n这不是恐惧，而是兴奋。\n\n屋里没有灯，也没有人。")).toEqual([]);
  });

  it("catches a contrast split into a denial and an assertion on separate lines", () => {
    const [finding] = lintChineseProse("陈平接过丹药，收进药瓶。\n\n不是多得了什么。\n\n是先前被人拿走的，终于回来了。");
    expect(finding).toMatchObject({ rule: "split-contrast", quotes: ["不是多得了什么。是先前被人拿走的，终于回来了。"] });
    // A plain denial followed by something else, and an answer to a question, are ordinary sentences.
    expect(rules("这不是他的包。周茂把包抢了回去。")).toEqual([]);
    expect(rules("“是你拿的？”\n\n“不是我。”\n\n“是他。”")).toEqual([]);
  });

  it("flags planning vocabulary and repeated account recitals in narration only", () => {
    const findings = lintChineseProse([
      "D21这一天，期初余额是十二点。",
      "他算了算，一共三块灵石、两枚丹药，花掉一块，还剩两块灵石。",
      "算下来，合计五点收益，投了三点，余下两点，另有一枚丹药。",
      "“本章的账，一共三块、两枚、五点。”老周念道。",
    ].join("\n\n"));
    const byRule = new Map(findings.map((finding) => [finding.rule, finding]));
    expect(byRule.get("planning-register")!.quotes).toEqual(["D21这一天，期初余额是十二点。"]);
    expect(byRule.get("ledger-recital")!.quotes).toHaveLength(2);
  });

  it("measures the shape of a chapter told without anyone speaking", () => {
    const solitary = Array.from({ length: 24 }, (_, index) =>
      `他引着丹田里的灵气沿经脉走了第${index + 1}个周天，暖流缓缓沉入气海，法力又凝实了一分，周身的气感也跟着清晰了几分。`);
    const findings = lintChineseProse(chapter(solitary));
    const byRule = new Map(findings.map((finding) => [finding.rule, finding]));
    expect(byRule.get("sparse-dialogue")!.summary).toContain("只占 0%");
    expect(byRule.get("sparse-dialogue")!.summary).toContain("连着 24 段没有对话");
    expect(byRule.get("inner-sensation")!.quotes).toHaveLength(3);
    expect(byRule.get("repeated-opening")!.summary).toContain("“他”连续 24 段");
    expect(byRule.has("long-paragraph")).toBe(false);
  });

  it("reports paragraphs that run long for serial prose", () => {
    const long = "他把院里的柴一根一根码齐，又去井边打了两桶水，顺手把灶膛里的灰掏干净，再把晾在竹竿上的旧衣裳收进屋里叠好，等到日头偏西才想起早上那半块饼还揣在怀里没有动过，便靠着墙根坐下来慢慢地啃完了它。";
    expect(long.length).toBeGreaterThan(80);
    const findings = lintChineseProse(chapter([...lively.slice(0, 20), long, long, long]));
    expect(findings.map((finding) => finding.rule)).toEqual(["long-paragraph"]);
    expect(findings[0]!.summary).toContain("3 段");
  });

  it("turns findings into observations the chapter index accepts, for Chinese works only", () => {
    const content = "他深吸一口气，心跳加速。\n\n他的修仙之路才刚刚开始。";
    const observations = proseLintObservations(content, "zh", "chapter-3");
    expect(observations.map((observation) => observation.code)).toEqual(["prose-lint/stock-reaction", "prose-lint/closing-formula"]);
    for (const observation of observations) {
      expect(() => ObservationSchema.parse(observation)).not.toThrow();
      expect(observation).toMatchObject({ category: "quality", assessment: "observation" });
      for (const reference of observation.sourceRefs ?? []) {
        expect(reference.sourceId).toBe("chapter-3");
        expect(content).toContain(reference.quote);
      }
    }
    expect(proseLintObservations(content, "en", "chapter-3")).toEqual([]);
    expect(proseLintObservations(chapter(lively), "zh")).toEqual([]);
  });
});
