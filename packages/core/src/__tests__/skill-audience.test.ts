import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasSkillAudiences, skillBodyForAudience } from "../skills/audience.js";
import { hydrateActivatedSkillGuidance } from "../agent/skill-tool.js";
import { loadAvailableAgentSkills } from "../skills/builtin-loader.js";

const scoped = [
  "# Craft",
  "",
  "Shared principle.",
  "",
  "<!-- audience: planner -->",
  "## Planning",
  "Plan scenes. Load `references/planning.md`.",
  "",
  "<!-- audience: writer, reviser -->",
  "## Prose",
  "Write scenes.",
  "",
  "<!-- audience: reviewer -->",
  "## Review",
  "List machine traces. Load `references/planning.md` and `references/review.md`.",
  "",
  "<!-- audience: all -->",
  "## Closing",
  "Applies to everyone.",
].join("\n");

describe("skill audience sections", () => {
  it("gives each worker the shared text and its own sections", () => {
    expect(hasSkillAudiences(scoped)).toBe(true);
    expect(skillBodyForAudience(scoped, "writer")).toBe(
      "# Craft\n\nShared principle.\n\n## Prose\nWrite scenes.\n\n## Closing\nApplies to everyone.",
    );
    const planner = skillBodyForAudience(scoped, "planner");
    expect(planner).toContain("## Planning");
    expect(planner).not.toContain("## Prose");
    expect(planner).not.toContain("machine traces");
    // A selector reads no scoped section, only what every worker shares.
    expect(skillBodyForAudience(scoped, "selector")).toBe("# Craft\n\nShared principle.\n\n## Closing\nApplies to everyone.");
  });

  it("keeps the whole method for a reader without an audience and never leaks marker lines", () => {
    const whole = skillBodyForAudience(scoped, undefined);
    expect(whole).toContain("## Planning");
    expect(whole).toContain("## Review");
    expect(whole).not.toContain("audience:");
    expect(skillBodyForAudience(scoped.replace(/\n/g, "\r\n"), "writer")).not.toContain("## Planning");
  });

  it("leaves a Skill without markers untouched", () => {
    const plain = "# Craft\n\n\n\nAll of it.";
    expect(hasSkillAudiences(plain)).toBe(false);
    expect(skillBodyForAudience(plain, "writer")).toBe(plain);
  });
});

describe("audience-scoped skill hydration", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "inkos-skill-audience-"));
    await mkdir(join(baseDir, "references"), { recursive: true });
    await writeFile(join(baseDir, "references", "planning.md"), "# Planning reference\nScenes carry the chapter goal.", "utf-8");
    await writeFile(join(baseDir, "references", "review.md"), "# Review reference\nMachine traces in prose scenes.", "utf-8");
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  const activation = (body: string) => [{
    skill: { id: "craft", name: "Craft", description: "Craft method.", body, source: "external" as const, baseDir },
    resources: [{ path: "references/review.md", body: "stale copy", charStart: 0, charEnd: 10 }],
  }];
  const paths = (hydrated: Awaited<ReturnType<typeof hydrateActivatedSkillGuidance>>) => hydrated![0]!.resources.map((resource) => resource.path);

  it("loads only the references a worker's own sections name", async () => {
    const query = "Write the scenes of this chapter and review machine traces";
    const writer = await hydrateActivatedSkillGuidance(activation(scoped), query, "writer");
    expect(writer![0]!.skill.body).not.toContain("## Review");
    // Neither the reference attached for another worker nor a task-text match comes back.
    expect(paths(writer)).toEqual([]);

    const planner = await hydrateActivatedSkillGuidance(activation(scoped), query, "planner");
    expect(paths(planner)).toEqual(["references/planning.md"]);

    const reviewer = await hydrateActivatedSkillGuidance(activation(scoped), query, "reviewer");
    expect(paths(reviewer)).toEqual(["references/planning.md", "references/review.md"]);
    expect(reviewer![0]!.resources[1]!.body).toContain("Machine traces");
  });

  it("keeps full-body behaviour for unmapped workers and unmarked Skills", async () => {
    const unmapped = await hydrateActivatedSkillGuidance(activation(scoped), "review machine traces", undefined);
    expect(unmapped![0]!.skill.body).toContain("## Planning");
    expect(unmapped![0]!.skill.body).not.toContain("audience:");
    expect(new Set(paths(unmapped))).toEqual(new Set(["references/planning.md", "references/review.md"]));

    const plain = "Plan scenes with `references/planning.md`.";
    const unmarked = await hydrateActivatedSkillGuidance(activation(plain), "review machine traces", "writer");
    expect(unmarked![0]!.skill.body).toBe(plain);
    expect(paths(unmarked)).toContain("references/planning.md");
  });
});

describe("built-in long-form skills by audience", () => {
  it("hands the prose writer the prose craft without planning, review or settlement material", async () => {
    const { skills } = await loadAvailableAgentSkills({ projectRoot: "" });
    const craft = skills.find((skill) => skill.id === "inkos-long-writing")!;
    const voice = skills.find((skill) => skill.id === "inkos-ziling-style")!;
    const [writer] = (await hydrateActivatedSkillGuidance([{ skill: craft, resources: [] }], "写下一章", "writer"))!;
    expect(writer!.skill.body).toContain("### 中文正文");
    expect(writer!.skill.body).not.toContain("## Chapter planning");
    expect(writer!.skill.body).not.toContain("## State settlement");
    expect(writer!.skill.body).not.toContain("中文正文里常见的机器痕迹");
    expect(writer!.resources).toEqual([]);

    const [settler] = (await hydrateActivatedSkillGuidance([{ skill: craft, resources: [] }], "写下一章", "settler"))!;
    expect(settler!.skill.body).toContain("## State settlement");
    expect(settler!.skill.body).not.toContain("### 中文正文");
    expect(settler!.resources.map((resource) => resource.path)).toEqual(["references/state-projection.md"]);

    const writerVoice = skillBodyForAudience(voice.body, "writer");
    expect(writerVoice).toContain("## 叙述口吻");
    expect(writerVoice).toContain("突破、瓶颈、悟法");
    expect(writerVoice).not.toContain("修炼用时间一笔带过");
    expect(writerVoice).not.toContain("## 审稿与修订");
    // Settlement records facts plainly; the comic voice has nothing to tell it.
    expect(skillBodyForAudience(voice.body, "settler")).not.toContain("## 招牌手法");
    const reviewerVoice = skillBodyForAudience(voice.body, "reviewer");
    expect(reviewerVoice).toContain("## 审稿与修订");
    expect(reviewerVoice).toContain("修仙质感");
  });

  it("leaves the check for a chapter told at one even temperature to the reviewer", async () => {
    const { skills } = await loadAvailableAgentSkills({ projectRoot: "" });
    const craft = skills.find((skill) => skill.id === "inkos-long-writing")!;

    expect(skillBodyForAudience(craft.body, "reviewer")).toContain("- Movement:");
    expect(skillBodyForAudience(craft.body, "writer")).not.toContain("- Movement:");
    expect(skillBodyForAudience(craft.body, "planner")).not.toContain("- Movement:");
  });
});
