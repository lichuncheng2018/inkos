import { expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  createSettlementToolSchema,
  normalizeSettlementSubmission,
  validateSettlementHookIds,
} from "../agents/settler-tool.js";
import { actionFailureFacts } from "../harness/action-observation.js";

const chapterSummary = {
  title: "第一道路线被封之后",
  characters: "顾长渊",
  events: "完成换位撤离。",
  stateChanges: "形成可复述的动作链。",
  hookActivity: "hook-7 resolved",
  mood: "冷静",
  chapterType: "训练",
};

const completeHook = {
  hookId: "hook-7",
  startChapter: 15,
  type: "near-term",
  status: "resolved" as const,
  lastAdvancedChapter: 16,
  expectedPayoff: "完成多人连续封锁训练",
  notes: "本章兑现。",
};

it("fills omitted postSettlement and empty collections from a live settlement omission", () => {
  const normalized = normalizeSettlementSubmission({
    chapterSummary,
    factOps: {
      upsert: [{ subject: "顾长渊", predicate: "境界状态", object: "筑基初期" }],
    },
    hookOps: {
      upsert: [completeHook],
      resolve: ["hook-7"],
    },
  });
  expect(normalized).toMatchObject({
    postSettlement: "形成可复述的动作链。",
    factOps: { expire: [], upsert: [{ subject: "顾长渊" }] },
    hookOps: { mention: [], defer: [], resolve: ["hook-7"] },
    newHookCandidates: [],
  });
  expect(Value.Check(createSettlementToolSchema(), normalized)).toBe(true);
});

it("does not invent factOps or chapterSummary when those bodies are missing", () => {
  expect(normalizeSettlementSubmission({ hookOps: {} })).toMatchObject({
    hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
    newHookCandidates: [],
    postSettlement: "",
  });
  expect(Value.Check(createSettlementToolSchema(), normalizeSettlementSubmission({ hookOps: {} }))).toBe(false);
  expect(normalizeSettlementSubmission({ factOps: "upserted" })).toMatchObject({ factOps: "upserted" });
});

it("keeps an explicit postSettlement string", () => {
  const normalized = normalizeSettlementSubmission({
    postSettlement: "Host-authored note.",
    chapterSummary: { ...chapterSummary, stateChanges: "Different." },
    factOps: { upsert: [], expire: [] },
    hookOps: { upsert: [], mention: [], resolve: [], defer: [] },
  });
  expect(normalized).toMatchObject({ postSettlement: "Host-authored note." });
});

it("keeps schema issues on the host-facing failure envelope", () => {
  expect(actionFailureFacts(Object.assign(new Error("Structured result remained invalid after bounded correction attempts"), {
    code: "WORKER_RESULT_INVALID",
    resultTool: "submit_runtime_state_delta",
    attempts: 3,
    issues: [{ path: "/postSettlement", message: "Expected required property" }],
  }))).toMatchObject({
    code: "WORKER_RESULT_INVALID",
    resultTool: "submit_runtime_state_delta",
    attempts: 3,
    issues: [{ path: "/postSettlement" }],
  });
});

it("lists known ledger ids when hook operations invent identifiers", () => {
  const submitted = {
    hookOps: {
      upsert: [],
      mention: ["H19"],
      resolve: ["hook-19_心愿清单的引导"],
      defer: [],
    },
  };
  expect(() => validateSettlementHookIds(submitted, new Set(["hook-7", "donghuang-miju-chuancheng"]))).toThrow(
    /known ids: donghuang-miju-chuancheng, hook-7/,
  );
  try {
    validateSettlementHookIds(submitted, new Set(["hook-7"]));
  } catch (error) {
    expect(error).toMatchObject({ code: "WORKER_DOMAIN_INVALID" });
    expect(actionFailureFacts(error)).toMatchObject({
      code: "WORKER_DOMAIN_INVALID",
      message: expect.stringContaining("H19"),
    });
  }
});
