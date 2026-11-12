import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseAgent } from "../agents/base.js";
import { PlannerAgent } from "../agents/planner.js";
import { createLLMClient } from "../llm/provider.js";
import { assessMemoDensity, memoDensityFeedback } from "../utils/memo-density.js";

const client = createLLMClient({
  service: "custom", provider: "openai", configSource: "studio", model: "fixture", apiKey: "fixture",
  baseUrl: "http://127.0.0.1:9/v1", apiFormat: "chat", stream: false, thinkingBudget: 0, temperature: 0,
});

const sparseZh = `## 场次

### 展开｜试功台｜杜衡、何有成、梁伯年
- 杜衡掏出一枚聚气丹，说要当场突破。
- 何有成皱眉，说昨天他还差些火候。
- 梁伯年进门，问这一枚够不够。
- 杜衡说够，盘膝坐下把丹吞了。
- 测灵石亮到第七格，何有成手里的笔掉了。

### 带过
- 三天后，宗门里传开了这件事。

## 备注
- 杜衡此前练气六层，本章到七层。
- 聚气丹用掉一枚，还剩两枚。`;

const procedureBeat = "沈砚拿着资金流转记录追查现金出处，要求陈锋解释账户受限后为何另提直付，陈锋交出凭证和回执，接受停止替代支付，并要求她把能补正的材料与不能放款的原因当面分开，再去税务和街道报备、备案，等受理回执";
const denseZh = `## 场次

### 展开｜财务室｜陈锋、沈砚、周慧兰
- ${procedureBeat}。
- ${procedureBeat}，然后核验原件。
- ${procedureBeat}，对账之后签字盖章。
- 周慧兰把账本摊开。

## 备注
- 本章新增到账与支出均为零，代发仅是未执行指令，不能记作已经补发，现金已确认领取两万二千二百元，另外两户合计一万六千一百元的签收与此前取现来源仍待凭证核清，不倒补为冻结资金的合法旁路，也不虚构全厂可用现金余额，供应商欠款八百万元属于既有债务的一部分而非新增债务。`;

const sparseEn = `## Scenes

### Played out | The yard | Mara, Tobin
- Mara asks Tobin what the cart is worth.
- Tobin names a price twice what she has.
- Mara offers her mother's ring instead.
- Tobin bites it and takes the deal.

## Notes
- Mara starts with twelve coins and ends with twelve.`;

const denseEn = `## Scenes

### Played out | The bank | Mara, the clerk
- ${Array.from({ length: 3 }, () => "The clerk demands verification of the receipts and the signatures on the filing before approval, then asks Mara to reconcile the ledger against the invoices and to register the documentation with the audit office for compliance review").join(".\n- ")}.

## Notes
- Mara's balance does not change.`;

describe("memo density", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes short beats about people and flags long, procedure-laden ones", () => {
    expect(assessMemoDensity(sparseZh, "zh").dense).toBe(false);
    const dense = assessMemoDensity(denseZh, "zh");
    expect(dense.dense).toBe(true);
    expect(dense.longBeats).toHaveLength(3);
    expect(dense.paperwork.reduce((sum, [, count]) => sum + count, 0)).toBeGreaterThan(7);
    expect(dense.longNotes).toBe(1);

    const feedback = memoDensityFeedback(dense, "zh");
    expect(feedback).toContain("每条节拍一句短话");
    expect(feedback).toContain("手续和文书占满了场次");
    expect(feedback).toContain("备注每条一句");
  });

  it("measures English memos in words", () => {
    expect(assessMemoDensity(sparseEn, "en").dense).toBe(false);
    const dense = assessMemoDensity(denseEn, "en");
    expect(dense.dense).toBe(true);
    expect(memoDensityFeedback(dense, "en")).toContain("Procedure fills the scenes");
  });

  it("sends a dense memo back to the planner once and accepts the resubmission", async () => {
    const submissions: Array<string> = [];
    vi.spyOn(BaseAgent.prototype as never, "submitStructured" as never).mockImplementation((async (
      _messages: unknown,
      tool: { validate: (value: { goal: string; body: string; threadRefs: string[] }) => unknown },
    ) => {
      for (const body of [denseZh, denseZh]) {
        try {
          const result = tool.validate({ goal: "拿到七天", body, threadRefs: [] });
          submissions.push("accepted");
          return { result, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
        } catch (error) {
          submissions.push((error as Error & { code?: string }).code ?? "error");
        }
      }
      throw new Error("no submission accepted");
    }) as never);

    const memo = await new PlannerAgent({ client, model: "fixture", projectRoot: "." }).planChapterMemo({
      chapterNumber: 3,
      contextPackage: { chapter: 3, selectedContext: [] },
      language: "zh",
      lengthSpec: { target: 3000, countingMode: "zh_chars" },
    });
    expect(submissions).toEqual(["MEMO_TOO_DENSE", "accepted"]);
    expect(memo.body).toBe(denseZh);
  });

  it("accepts a memo that is not dense on the first submission", async () => {
    let calls = 0;
    vi.spyOn(BaseAgent.prototype as never, "submitStructured" as never).mockImplementation((async (
      _messages: unknown,
      tool: { validate: (value: { goal: string; body: string; threadRefs: string[] }) => unknown },
    ) => {
      calls += 1;
      return { result: tool.validate({ goal: "突破", body: sparseZh, threadRefs: [] }), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }) as never);

    const memo = await new PlannerAgent({ client, model: "fixture", projectRoot: "." }).planChapterMemo({
      chapterNumber: 1,
      contextPackage: { chapter: 1, selectedContext: [] },
      language: "zh",
      lengthSpec: { target: 2000, countingMode: "zh_chars" },
    });
    expect(calls).toBe(1);
    expect(memo.body).toBe(sparseZh);
  });
});
