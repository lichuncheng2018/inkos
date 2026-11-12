import type { ActivatedSkillGuidance } from "../agent/skill-tool.js";
import type { WorkManifest, WorkProfile } from "../harness/contracts.js";
import type { AgentSkill, SkillResolutionResult } from "./types.js";

export function applyRequiredProfileSkills(
  resolution: SkillResolutionResult,
  profile: WorkProfile,
): SkillResolutionResult {
  const required = resolveProfileSkillActivations(resolution.availableSkills, profile);
  const used = new Map<string, AgentSkill>();
  for (const activation of required) used.set(activation.skill.id, activation.skill);
  for (const skill of resolution.usedSkills) used.set(skill.id, skill);
  return {
    ...resolution,
    usedSkills: [...used.values()],
    forcedSkillIds: [...new Set([...profile.requiredSkillIds, ...resolution.forcedSkillIds])],
  };
}

const WORK_CREATION_SKILLS: Readonly<Record<string, string>> = {
  fanfic: "inkos-fanfic-writing",
  continuation: "inkos-continuation-writing",
  spinoff: "inkos-spinoff-writing",
  imitation: "inkos-imitation-writing",
};

const PROSE_PROFILE_IDS: ReadonlySet<string> = new Set(["longform-novel", "short-fiction"]);

const CHINESE_GENRE_VOICE_SKILLS: ReadonlyArray<{ readonly genre: RegExp; readonly skillId: string }> = [
  { genre: /玄幻|修仙|仙侠|修真|高武|xuanhuan|xianxia|cultivation/i, skillId: "inkos-ziling-style" },
];

function genreVoiceSkillIds(work: WorkManifest): string[] {
  const genre = work.metadata.genre;
  if (typeof genre !== "string" || !PROSE_PROFILE_IDS.has(work.profileId) || !/^zh/i.test(work.language)) return [];
  return CHINESE_GENRE_VOICE_SKILLS.filter((voice) => voice.genre.test(genre)).map((voice) => voice.skillId);
}

export function requiredWorkSkillIds(work: WorkManifest | null): string[] {
  if (!work) return [];
  const creationKind = work.metadata.creationKind;
  const creationSkillId = typeof creationKind === "string" ? WORK_CREATION_SKILLS[creationKind] : undefined;
  return [...(creationSkillId ? [creationSkillId] : []), ...genreVoiceSkillIds(work)];
}

export function resolveWorkSkillActivations(
  availableSkills: ReadonlyArray<AgentSkill>,
  work: WorkManifest | null,
): ActivatedSkillGuidance[] {
  const requiredIds = requiredWorkSkillIds(work);
  if (requiredIds.length === 0) return [];
  const byId = new Map(availableSkills.map((skill) => [skill.id, skill]));
  const missing = requiredIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`Work "${work?.id}" requires unavailable skill(s): ${missing.join(", ")}`);
  }
  return requiredIds.map((id) => ({ skill: byId.get(id)!, resources: [] }));
}

export function applyRequiredWorkSkills(
  resolution: SkillResolutionResult,
  work: WorkManifest | null,
): SkillResolutionResult {
  const required = resolveWorkSkillActivations(resolution.availableSkills, work);
  if (required.length === 0) return resolution;
  const used = new Map(resolution.usedSkills.map((skill) => [skill.id, skill]));
  for (const activation of required) used.set(activation.skill.id, activation.skill);
  return {
    ...resolution,
    usedSkills: [...used.values()],
    forcedSkillIds: [...new Set([...resolution.forcedSkillIds, ...required.map((item) => item.skill.id)])],
  };
}

export function resolveProfileSkillActivations(
  availableSkills: ReadonlyArray<AgentSkill>,
  profile: WorkProfile,
  options: { readonly includeRecommended?: boolean } = {},
): ActivatedSkillGuidance[] {
  const byId = new Map(availableSkills.map((skill) => [skill.id, skill]));
  const missingRequired = profile.requiredSkillIds.filter((id) => !byId.has(id));
  if (missingRequired.length > 0) {
    throw new Error(
      `Profile "${profile.id}" requires unavailable skill(s): ${missingRequired.join(", ")}`,
    );
  }
  const ids = options.includeRecommended
    ? [...profile.requiredSkillIds, ...profile.recommendedSkillIds]
    : profile.requiredSkillIds;
  return [...new Set(ids)].flatMap((id) => {
    const skill = byId.get(id);
    return skill ? [{ skill, resources: [] }] : [];
  });
}

export function mergeActivatedSkillGuidance(
  ...groups: ReadonlyArray<ReadonlyArray<ActivatedSkillGuidance>>
): ActivatedSkillGuidance[] {
  const merged = new Map<string, ActivatedSkillGuidance>();
  for (const group of groups) {
    for (const activation of group) merged.set(activation.skill.id, activation);
  }
  return [...merged.values()];
}

export function activatedSkillIds(
  activations: ReadonlyArray<ActivatedSkillGuidance>,
): string[] {
  return activations.map((activation) => activation.skill.id);
}
