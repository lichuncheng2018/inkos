import { describe, expect, it } from "vitest";
import { quoteSessionTitle } from "./session-label";

describe("quoteSessionTitle", () => {
  it("keeps a short title unchanged", () => {
    expect(quoteSessionTitle("第三章修订")).toBe("第三章修订");
  });

  it("collapses whitespace and truncates a pasted prompt used as the session title", () => {
    const title = Array.from({ length: 40 }, () => "审查观察").join("\n");
    const quoted = quoteSessionTitle(title);
    expect(quoted.endsWith("…")).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(81);
    expect(quoted.includes("\n")).toBe(false);
  });
});
