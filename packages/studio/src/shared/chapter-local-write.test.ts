import { describe, expect, it } from "vitest";
import { applyLocalWriting, captureLocalWritingTarget, makeLocalWritingRequest } from "./chapter-local-write.js";

describe("chapter local writing", () => {
  it("inserts a paragraph at the saved cursor without replacing surrounding text", () => {
    const draft = "他握紧纸条。\n\n她转身走进雨里。";
    const cursor = draft.indexOf("\n") + 1;
    const target = captureLocalWritingTarget(draft, cursor, cursor);
    expect(applyLocalWriting(draft, target, "街灯忽然灭了。")).toBe("他握紧纸条。\n\n街灯忽然灭了。\n\n她转身走进雨里。");
  });

  it("replaces only the selected occurrence and preserves surrounding newlines", () => {
    const draft = "她点了点头。\n\n她点了点头。\n\n下一段。";
    const start = draft.lastIndexOf("她点了点头。");
    const end = draft.indexOf("下一段。");
    const target = captureLocalWritingTarget(draft, start, end);
    expect(applyLocalWriting(draft, target, "她低低应了一声。")).toBe("她点了点头。\n\n她低低应了一声。\n\n下一段。");
  });

  it("maps browser textarea offsets without changing existing CRLFs", () => {
    const draft = "开头。\r\n\r\n选中我。\r\n\r\n结尾。";
    const target = captureLocalWritingTarget(draft, 5, 9);
    expect(applyLocalWriting(draft, target, "换成这句。")).toBe("开头。\r\n\r\n换成这句。\r\n\r\n结尾。");
  });

  it("rejects a stale snapshot or a blank response", () => {
    const draft = "原草稿。";
    const target = captureLocalWritingTarget(draft, 0, 1);
    expect(applyLocalWriting("其他草稿。", target, "新")).toBeNull();
    expect(applyLocalWriting(draft, target, " \n ")).toBeNull();
  });

  it("sends only nearby unsaved context and does not silently truncate a selection", () => {
    const before = "甲".repeat(2100) + "手改过的上一句。";
    const selection = "目标";
    const after = "手改过的下一句。" + "乙".repeat(2100);
    const draft = before + selection + after;
    expect(makeLocalWritingRequest(captureLocalWritingTarget(draft, before.length, before.length + selection.length), "  放慢一点  ")).toEqual({
      before: before.slice(-2000), selection, after: after.slice(0, 2000), instruction: "放慢一点",
    });
    expect(makeLocalWritingRequest(captureLocalWritingTarget(draft, 0, draft.length), "")).toBeNull();
    expect(makeLocalWritingRequest(captureLocalWritingTarget("甲  乙", 1, 3), "")).toBeNull();
  });
});
