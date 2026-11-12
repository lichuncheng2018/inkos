import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@mariozechner/pi-ai";
import { createLLMClient } from "../llm/provider.js";
import { ReviserAgent } from "../agents/reviser.js";
import { buildLengthSpec } from "../utils/length-metrics.js";

const fetchWithProxyMock = vi.hoisted(() => vi.fn());

vi.mock("../utils/proxy-fetch.js", () => ({
  fetchWithProxy: fetchWithProxyMock,
}));

const model: Model<"openai-completions"> = {
  id: "test-model",
  name: "test-model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8192,
};

type RequestBody = {
  temperature?: number;
  tools?: unknown[];
  messages: Array<{ role: string; content: string }>;
};

const text = (content: string) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
const toolCall = (name: string, args: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{
  id: name, type: "function", function: { name, arguments: JSON.stringify(args) },
}] } }] }));

function reviser() {
  const client = createLLMClient({ provider: "openai", service: "custom", configSource: "studio", baseUrl: model.baseUrl, model: model.id, apiKey: "fixture", apiFormat: "chat", stream: false, temperature: 0, thinkingBudget: 0 });
  return new ReviserAgent({ client, model: model.id, projectRoot: "/tmp" });
}

/** Queue one response per model request and keep the request bodies. */
function serve(responses: ReadonlyArray<Response>): RequestBody[] {
  const requests: RequestBody[] = [];
  fetchWithProxyMock.mockImplementation(async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return responses[requests.length - 1]!;
  });
  return requests;
}

const userText = (request: RequestBody) => request.messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
const context = { chapter: 1, selectedContext: [] };

describe("reviser plain-text prose channel", () => {
  beforeEach(() => { fetchWithProxyMock.mockReset(); });

  it("answers a selected passage as plain text and keeps every byte around it", async () => {
    const selected = "他把三枚铜钱排在桌上，先数一遍，再数一遍，待确认无误，便收入袖中。";
    const original = `掌柜的把秤一撂。\n\n“就这些？”\n\n${selected}\n\n门外有人咳了一声。\n`;
    const requests = serve([text("他把铜钱往桌上一拍。\n“三枚，一个子儿不少。”")]);
    const result = await reviser().reviseChapter("/tmp", original, 1, [{
      code: "ZHUQUE-SUSPECTED-1", assessment: "issue", category: "quality", summary: "这一段被判成疑似机器写作。", evidence: [selected],
    }], "spot-fix", undefined, { language: "zh", contextPackage: context, targetText: selected, proseChannel: "text" });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.tools ?? []).toHaveLength(0);
    expect(requests[0]!.temperature).toBe(0.7);
    const system = requests[0]!.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
    expect(system).toContain("先按已激活 Skill 的修订方法找出每一处读着像机器写的具体原因");
    expect(system).toContain("不放进工具参数");
    expect(system).not.toContain("通过指定结果工具提交");
    const request = userText(requests[0]!);
    expect(request).toContain(`上文（不改）：\n掌柜的把秤一撂。\n“就这些？”`);
    expect(request).toContain(`原文（重写这一段）：\n${selected}`);
    expect(request).toContain("下文（不改）：\n门外有人咳了一声。");
    // The chapter separates paragraphs with a blank line; the reply used single newlines.
    expect(result.revisedContent).toBe("掌柜的把秤一撂。\n\n“就这些？”\n\n他把铜钱往桌上一拍。\n\n“三枚，一个子儿不少。”\n\n门外有人咳了一声。\n");
  });

  it("binds several marked passages to their ranges and drops surrounding lines handed back", async () => {
    const original = [
      "第一段写得像一份清单，逐条列出规矩。",
      "中间这一段没有人标出来，照原样留着。",
      "第三段把账又念了一遍，一文不差地念。",
      "结尾这一段也照原样留着，不许改动。",
    ].join("\n") + "\n";
    const requests = serve([
      toolCall("submit_chapter_edit_ranges", { ranges: [{ startLine: 3, endLine: 3 }, { startLine: 1, endLine: 1 }] }),
      text("好的，重写如下。\n\n【第1处】\n老周把规矩说了个大概。\n中间这一段没有人标出来，照原样留着。\n\n【第2处】\n“还剩七文。”他把钱袋系紧。"),
    ]);
    const result = await reviser().reviseChapter("/tmp", original, 1, [], "spot-fix", undefined, { language: "zh", contextPackage: context, proseChannel: "text" });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.tools).toHaveLength(1);
    expect(requests[1]!.tools ?? []).toHaveLength(0);
    const request = userText(requests[1]!);
    expect(request).toContain("## 要重写的地方（共2处）");
    expect(request).toContain("每一处前面单独一行写【第N处】");
    expect(result.revisedContent).toBe([
      "老周把规矩说了个大概。",
      "中间这一段没有人标出来，照原样留着。",
      "“还剩七文。”他把钱袋系紧。",
      "结尾这一段也照原样留着，不许改动。",
    ].join("\n") + "\n");
  });

  it("sends an incomplete draft back with the reason and uses the corrected one", async () => {
    const original = "甲段要改。\n乙段不动。\n丙段要改。\n";
    const requests = serve([
      toolCall("submit_chapter_edit_ranges", { ranges: [{ startLine: 1, endLine: 1 }, { startLine: 3, endLine: 3 }] }),
      text("新甲段。"),
      text("【第1处】\n新甲段。\n【第2处】\n新丙段。"),
    ]);
    const candidates: string[] = [];
    const result = await reviser().reviseChapter("/tmp", original, 1, [], "spot-fix", undefined, {
      language: "zh", contextPackage: context, proseChannel: "text", onCandidate: async (content) => { candidates.push(content); },
    });

    expect(requests).toHaveLength(3);
    const retry = requests[2]!.messages;
    expect(retry.at(-2)).toMatchObject({ role: "assistant", content: "新甲段。" });
    expect(retry.at(-1)!.content).toContain("这一稿没有采用，原章没有改动");
    // An unmarked reply cannot be assigned to either passage.
    expect(retry.at(-1)!.content).toContain("没有找到第1、2处的替换正文");
    expect(candidates).toEqual(["新甲段。\n乙段不动。\n新丙段。\n"]);
    expect(result.revisedContent).toBe("新甲段。\n乙段不动。\n新丙段。\n");
  });

  it("states the length gap in words and keeps the nearest complete rewrite", async () => {
    const attempts = ["one two three four five six seven", "```\nChapter 1: Kept\n\none two three four five six\n```", "one two three four five six seven eight nine"];
    const requests = serve(attempts.map((attempt) => text(attempt)));
    const spec = buildLengthSpec(4, "en", { minChapterLength: 3, maxChapterLength: 4 });
    const options = { language: "en" as const, contextPackage: context, lengthSpec: spec, chapterTitle: "Kept", proseChannel: "text" as const };
    const result = await reviser().reviseChapter("/tmp", "alpha beta gamma delta epsilon", 1, [], "rewrite", undefined, { ...options, keepNearestLength: true });

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => (request.tools ?? []).length === 0)).toBe(true);
    expect(requests[0]!.temperature).toBe(0.7);
    expect(requests[0]!.messages.find((message) => message.role === "system")!.content).toContain("Reply with the complete revised chapter as plain prose");
    expect(requests[1]!.messages.at(-1)!.content).toContain("the chapter would come to 7 words; write at least 3 fewer");
    expect(result).toMatchObject({ revisedContent: "one two three four five six", wordCount: 6 });

    serve(attempts.map((attempt) => text(attempt)));
    await expect(reviser().reviseChapter("/tmp", "alpha beta gamma delta epsilon", 1, [], "rewrite", undefined, options))
      .rejects.toMatchObject({ code: "CHAPTER_LENGTH_OUT_OF_RANGE" });
  });
});
