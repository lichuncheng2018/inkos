import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { commitAtomicFileSet } from "../utils/atomic-file-set.js";

export interface SecretsFile {
  services: Record<string, { apiKey: string }>;
}

const SecretsFileSchema = z.object({
  services: z.record(z.string(), z.object({ apiKey: z.string().min(1) }).strict()).default({}),
}).strict();

const SECRETS_DIR = ".inkos";
const SECRETS_FILE = "secrets.json";

function secretsPath(projectRoot: string): string {
  return join(projectRoot, SECRETS_DIR, SECRETS_FILE);
}

function emptySecrets(): SecretsFile {
  return { services: {} };
}

function parseSecretsRaw(raw: string): SecretsFile {
  return SecretsFileSchema.parse(JSON.parse(raw));
}

function isMissingSecretsFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function envNameForService(service: string): string {
  return `${service.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_API_KEY`;
}

function keyFromSecretsOrEnv(secrets: SecretsFile, service: string): string | null {
  const entry = secrets.services[service];
  if (entry?.apiKey) return entry.apiKey;
  const fromEnv = process.env[envNameForService(service)];
  return fromEnv || null;
}

async function readSecretsRaw(projectRoot: string): Promise<SecretsFile> {
  try {
    return parseSecretsRaw(await readFile(secretsPath(projectRoot), "utf-8"));
  } catch (error) {
    if (isMissingSecretsFile(error)) return emptySecrets();
    throw error;
  }
}

export async function loadSecrets(projectRoot: string): Promise<SecretsFile> {
  return readSecretsRaw(projectRoot);
}

export function loadSecretsSync(projectRoot: string): SecretsFile {
  try {
    return parseSecretsRaw(readFileSync(secretsPath(projectRoot), "utf-8"));
  } catch (error) {
    if (isMissingSecretsFile(error)) return emptySecrets();
    throw error;
  }
}

export async function saveSecrets(
  projectRoot: string,
  secrets: SecretsFile,
): Promise<void> {
  const parsed = SecretsFileSchema.parse(secrets);
  await commitAtomicFileSet({
    rootDir: projectRoot,
    writes: [{
      relativePath: join(SECRETS_DIR, SECRETS_FILE),
      content: `${JSON.stringify(parsed, null, 2)}\n`,
    }],
  });
}

export async function getServiceApiKey(
  projectRoot: string,
  service: string,
): Promise<string | null> {
  return keyFromSecretsOrEnv(await loadSecrets(projectRoot), service);
}

export function getServiceApiKeySync(
  projectRoot: string,
  service: string,
): string | null {
  return keyFromSecretsOrEnv(loadSecretsSync(projectRoot), service);
}
