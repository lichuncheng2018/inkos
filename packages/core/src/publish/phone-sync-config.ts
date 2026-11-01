import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PhoneSyncConfig {
  readonly url: string;
  readonly publishableKey: string;
  readonly serviceRoleKey: string;
}

function asNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function fromParts(url: string | null, publishableKey: string | null, serviceRoleKey: string | null): PhoneSyncConfig | null {
  if (!url || !publishableKey || !serviceRoleKey) return null;
  return {
    url: url.replace(/\/+$/u, ""),
    publishableKey,
    serviceRoleKey,
  };
}

export async function loadPhoneSyncConfig(projectRoot: string): Promise<PhoneSyncConfig | null> {
  const fromEnv = fromParts(
    asNonEmpty(process.env.INKOS_SUPABASE_URL),
    asNonEmpty(process.env.INKOS_SUPABASE_PUBLISHABLE_KEY),
    asNonEmpty(process.env.INKOS_SUPABASE_SERVICE_ROLE_KEY),
  );
  if (fromEnv) return fromEnv;

  try {
    const raw = JSON.parse(await readFile(join(projectRoot, ".inkos", "supabase.json"), "utf-8")) as Record<string, unknown>;
    return fromParts(
      asNonEmpty(raw.url),
      asNonEmpty(raw.publishableKey ?? raw.anonKey),
      asNonEmpty(raw.serviceRoleKey),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
