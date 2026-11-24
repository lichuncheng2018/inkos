import { describe, expect, it } from "vitest";
import {
  buildDetectionConfig,
  buildModelOverrides,
  buildNotifyChannel,
  changeOverrideService,
  detectionDraftFromConfig,
  notifyDraftFromChannel,
  overrideDraftFromConfig,
} from "./project-settings-model";

describe("project settings form model", () => {
  it("round-trips both automatic and explicitly configured agent routes", () => {
    const overrides = {
      "reader-simulator": "legacy-model",
      "chapter-plan-reviewer": { service: "custom:办公账号", model: "same-id", apiKeyEnv: "READER_KEY", stream: false },
    };
    const drafts = Object.entries(overrides).map(([agent, value]) => overrideDraftFromConfig(agent, value));
    expect(drafts.map((row) => row.service)).toEqual(["", "custom:办公账号"]);
    expect(buildModelOverrides(drafts)).toEqual(overrides);
  });

  it("drops the old endpoint and credentials when an agent switches configured service", () => {
    const original = overrideDraftFromConfig("chapter-plan-reviewer", {
      model: "same-id", service: "custom:原账号", baseUrl: "https://old.example.com/v1",
      provider: "custom", apiKeyEnv: "OLD_READER_KEY", apiFormat: "anthropic", stream: false,
    });
    const switched = changeOverrideService(original, "custom:备用账号");
    expect(buildModelOverrides([switched])).toEqual({
      "chapter-plan-reviewer": { service: "custom:备用账号", model: "same-id" },
    });
    expect(buildModelOverrides([changeOverrideService(switched, "")])).toEqual({ "chapter-plan-reviewer": "same-id" });
  });

  it("preserves webhook event filters when round-tripping notification channels", () => {
    const draft = notifyDraftFromChannel({
      type: "webhook",
      url: "https://hooks.example.com/inkos",
      secret: "s1",
      events: ["chapter-complete", "pipeline-error"],
    });

    expect(buildNotifyChannel(draft)).toEqual({
      type: "webhook",
      url: "https://hooks.example.com/inkos",
      secret: "s1",
      events: ["chapter-complete", "pipeline-error"],
    });
  });

  it("honors detection.enabled=false instead of re-enabling the detector", () => {
    const draft = detectionDraftFromConfig({
      enabled: false,
      provider: "custom",
      apiUrl: "https://detector.example.com/api",
      apiKeyEnv: "DETECT_KEY",
      threshold: 0.7,
    });

    expect(draft.enabled).toBe(false);
    expect(buildDetectionConfig(draft)).toBeNull();
  });
});
