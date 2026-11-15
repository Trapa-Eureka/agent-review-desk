import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot, openProject } from "@ard/core";

export const DEFAULT_PORT = 4777;
export const HOST = "127.0.0.1";

/** Folder of the built review UI: `ARD_WEB_DIR`, or `apps/web` of the source checkout this CLI was built in. */
export function resolveWebDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ARD_WEB_DIR && env.ARD_WEB_DIR !== "") return resolve(env.ARD_WEB_DIR);
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/web");
}

/** A human-readable reason the UI cannot be started from `webDir`, or null if it can. */
export function webProblem(webDir: string): string | null {
  if (!existsSync(join(webDir, "package.json"))) return `The review UI was not found at ${webDir}. Run ard from a built checkout of agent-review-desk, or set ARD_WEB_DIR.`;
  if (!existsSync(join(webDir, ".next", "BUILD_ID"))) return `The review UI is not built yet. In the agent-review-desk folder run: pnpm build`;
  if (!existsSync(nextBin(webDir))) return `Next.js is not installed for the review UI. In the agent-review-desk folder run: pnpm install`;
  return null;
}

const nextBin = (webDir: string) => join(webDir, "node_modules", "next", "dist", "bin", "next");

export function portIsFree(port: number, host: string = HOST): Promise<boolean> {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once("error", () => resolvePort(false));
    probe.listen(port, host, () => probe.close(() => resolvePort(true)));
  });
}

export interface ReviewOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  port: number;
  log: (line: string) => void;
}

/**
 * Start the review UI for this project and keep running until it is stopped.
 *
 * The UI can approve actions an agent is waiting on, so it is locked down: it listens on 127.0.0.1
 * only, and every launch generates a fresh random token that the browser must present (the printed
 * link carries it once and the UI then keeps it in a cookie).
 */
export async function runReview(options: ReviewOptions): Promise<number> {
  const { env, port, log } = options;
  const root = findProjectRoot(options.cwd);
  const webDir = resolveWebDir(env);
  const problem = webProblem(webDir);
  if (problem) {
    log(`ard review: ${problem}`);
    return 1;
  }
  if (!(await portIsFree(port))) {
    log(`ard review: port ${port} is already in use. Pick another with --port <number>.`);
    return 1;
  }

  // Create/upgrade the database and import existing recordings now, so the first page load is instant
  // and any problem shows up here rather than in the browser.
  openProject(root, env).repo.close();

  const token = randomBytes(24).toString("hex");
  const child = spawn(process.execPath, [nextBin(webDir), "start", "-H", HOST, "-p", String(port)], {
    cwd: webDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...env, NODE_ENV: "production", ARD_PROJECT_DIR: root, ARD_UI_TOKEN: token, ARD_UI_PORT: String(port) },
  });

  log(`ard review: project ${root}`);
  log(`ard review: open  http://${HOST}:${port}/?token=${token}`);
  log("ard review: this link is private to you and changes every time. Press Ctrl-C to stop.");

  const stop = (signal: NodeJS.Signals) => () => child.kill(signal);
  const onInt = stop("SIGINT");
  const onTerm = stop("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return new Promise<number>((resolveExit) => {
    child.once("error", (error) => {
      log(`ard review: could not start the UI: ${error.message}`);
      resolveExit(1);
    });
    child.once("close", (code, signal) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolveExit(code ?? (signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1));
    });
  });
}
