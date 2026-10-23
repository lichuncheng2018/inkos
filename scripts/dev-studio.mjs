/**
 * Start InkOS Studio for local development (Vite HMR + API).
 * Windows-friendly — no bash env-prefix in package scripts required.
 */
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const studioRoot = join(repoRoot, "packages", "studio");
const projectRoot = resolve(process.env.INKOS_PROJECT_ROOT ?? repoRoot);
const apiPort = process.env.INKOS_STUDIO_PORT ?? "4569";
const apiHost = process.env.INKOS_STUDIO_HOST?.trim() || "0.0.0.0";
const uiPort = process.env.INKOS_STUDIO_UI_PORT ?? "4567";
const uiUrl = `http://localhost:${uiPort}`;
const isWin = process.platform === "win32";
const pnpmBin = isWin ? "pnpm.cmd" : "pnpm";
const cliEntry = join(repoRoot, "packages", "cli", "dist", "index.js");
const coreEntry = join(repoRoot, "packages", "core", "dist", "index.js");
const buildMarkers = [coreEntry, cliEntry];

const children = [];

function log(message) {
  console.log(`[dev-studio] ${message}`);
}

function resolvePackageBin(pkgName, relPath) {
  const candidates = [
    join(studioRoot, "node_modules", pkgName, relPath),
    join(repoRoot, "node_modules", pkgName, relPath),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    console.error(`[dev-studio] Missing ${pkgName} (${relPath}). Run pnpm install first.`);
    process.exit(1);
  }
  return found;
}

function spawnNode(name, script, args, extraEnv = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: studioRoot,
    env: {
      ...process.env,
      ...extraEnv,
      INKOS_STUDIO_PORT: apiPort,
      INKOS_STUDIO_HOST: apiHost,
      ...(name === "api" ? { INKOS_PROJECT_ROOT: projectRoot } : {}),
    },
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      log(`${name} stopped (${signal})`);
      return;
    }
    if (code && code !== 0) {
      log(`${name} exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });

  children.push({ name, child });
  return child;
}

function runPnpmSync(args, cwd = repoRoot) {
  const result = spawnSync(pnpmBin, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: isWin,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function workspaceNeedsBuild() {
  return buildMarkers.some((path) => !existsSync(path));
}

function ensureWorkspaceReady() {
  if (!existsSync(join(repoRoot, "node_modules"))) {
    log("node_modules missing — running pnpm install...");
    runPnpmSync(["install"]);
  }
  if (!workspaceNeedsBuild()) return;
  log("Workspace not built — running pnpm build (first run may take a minute)...");
  runPnpmSync(["build"]);
  if (workspaceNeedsBuild()) {
    console.error("[dev-studio] Build finished but expected outputs are still missing.");
    process.exit(1);
  }
}

function ensureInkOSProject() {
  if (existsSync(join(projectRoot, "inkos.json"))) return;
  log(`No inkos.json in ${projectRoot} — running inkos init...`);
  const result = spawnSync(process.execPath, [cliEntry, "init"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function shutdown(exitCode = 0) {
  for (const { child } of children) {
    if (child.killed || child.exitCode !== null) continue;
    if (isWin) {
      spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { shell: true, stdio: "ignore" });
    } else {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(exitCode), 300).unref();
}

function openBrowser(url) {
  if (process.env.INKOS_DEV_STUDIO_NO_OPEN === "1") return;
  const cmd = isWin ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = isWin ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", shell: false, detached: true }).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

ensureWorkspaceReady();
ensureInkOSProject();

log(`Project root: ${projectRoot}`);
log(`UI  → ${uiUrl}  (Vite, hot reload)`);
log(`API → http://${apiHost}:${apiPort}  (Legado 书源见 API 启动日志)`);
log("Press Ctrl+C to stop both processes.\n");

const tsxCli = resolvePackageBin("tsx", "dist/cli.mjs");
const viteCli = resolvePackageBin("vite", "bin/vite.js");
spawnNode("api", tsxCli, ["watch", "src/api/index.ts"]);
spawnNode("client", viteCli, ["--host", "--port", String(uiPort)]);

setTimeout(() => openBrowser(uiUrl), 2500).unref();
