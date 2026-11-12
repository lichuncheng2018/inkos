import type { ReaderSimulationInput, ReaderSimulationResult } from "../agents/reader-simulator.js";
import { ReaderSimulatorAgent } from "../agents/reader-simulator.js";
import { ReviserAgent } from "../agents/reviser.js";
import type { Observation } from "../models/observation.js";
import type { ContextPackage } from "../models/input-governance.js";
import type { LengthSpec } from "../models/length-governance.js";

export interface ReaderRevisionPassResult {
  readonly content: string;
  readonly summary: string;
  readonly observations: ReadonlyArray<Observation>;
  readonly simulationStatus: "completed" | "failed";
  readonly revisionStatus: "not-needed" | "completed" | "failed";
  readonly tokenUsage: ReaderSimulationResult["tokenUsage"];
}

export async function simulateAndReviseChapter(input: {
  readonly reader: ReaderSimulatorAgent;
  readonly reviser: ReviserAgent;
  readonly simulation: ReaderSimulationInput;
  readonly bookDir: string;
  readonly contextPackage: ContextPackage;
  readonly lengthSpec?: LengthSpec;
  readonly signal?: AbortSignal;
}): Promise<ReaderRevisionPassResult> {
  const originalContent = input.simulation.chapterContent;
  let simulation: ReaderSimulationResult;
  try {
    simulation = await input.reader.simulateChapter(input.simulation);
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    return {
      content: originalContent,
      summary: unavailableSummary(input.simulation.language, "simulation", error),
      observations: [readerUnavailableObservation("reader-simulation-unavailable", error, input.simulation.language)],
      simulationStatus: "failed",
      revisionStatus: "not-needed",
      tokenUsage: zeroUsage(),
    };
  }

  if (simulation.observations.length === 0) {
    return {
      content: originalContent,
      summary: simulation.summary,
      observations: [],
      simulationStatus: "completed",
      revisionStatus: "not-needed",
      tokenUsage: simulation.tokenUsage,
    };
  }

  try {
    const revisionObservations = simulation.observations.map((observation) => ({
      ...observation,
      evidence: [...observation.evidence, ...(observation.sourceRefs ?? []).map((reference) => reference.quote)],
    }));
    const revised = await input.reviser.reviseChapter(
      input.bookDir,
      originalContent,
      input.simulation.chapterNumber,
      revisionObservations,
      "spot-fix",
      input.simulation.genre,
      {
        language: input.simulation.language,
        chapterTitle: input.simulation.chapterTitle,
        contextPackage: input.contextPackage,
        lengthSpec: input.lengthSpec,
        proseChannel: "text",
      },
    );
    if (!revised.revisedContent.trim()) throw new Error("Reviser returned empty content");
    return {
      content: revised.revisedContent,
      summary: simulation.summary,
      observations: simulation.observations.map((observation) => ({
        ...observation,
        assessment: "observation" as const,
      })),
      simulationStatus: "completed",
      revisionStatus: "completed",
      tokenUsage: addUsage(simulation.tokenUsage, revised.tokenUsage),
    };
  } catch (error) {
    rethrowIfAborted(error, input.signal);
    return {
      content: originalContent,
      summary: unavailableSummary(input.simulation.language, "revision", error),
      observations: [
        ...simulation.observations,
        readerUnavailableObservation("reader-revision-unavailable", error, input.simulation.language),
      ],
      simulationStatus: "completed",
      revisionStatus: "failed",
      tokenUsage: simulation.tokenUsage,
    };
  }
}

export function readerUnavailableObservation(code: string, error: unknown, language: "zh" | "en"): Observation {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    code,
    category: "execution",
    assessment: "unavailable",
    summary: language === "en" ? `Reader workflow unavailable: ${reason}` : `读者模拟流程不可用：${reason}`,
    evidence: [],
  };
}

function unavailableSummary(language: "zh" | "en", stage: "simulation" | "revision", error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  if (language === "en") return `Reader ${stage} unavailable: ${reason}`;
  return stage === "simulation" ? `读者模拟不可用：${reason}` : `读者反馈修订不可用：${reason}`;
}

function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) signal.throwIfAborted();
  if (error instanceof Error && error.name === "AbortError") throw error;
}

function addUsage(
  left: ReaderSimulationResult["tokenUsage"],
  right?: ReaderSimulationResult["tokenUsage"],
): ReaderSimulationResult["tokenUsage"] {
  if (!right) return left;
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function zeroUsage(): ReaderSimulationResult["tokenUsage"] {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}
