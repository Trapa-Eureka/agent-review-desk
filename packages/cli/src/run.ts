import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { constants as osConstants } from "node:os";
import type { ArdEvent, FileChangeEvent } from "@ard/schema";
import { changesSince, gitHead, takeSnapshot } from "./git.js";
import { LIMITS, appendEvent, ardDirFor, baseFields, eventsPathFor, findProjectRoot, safeText, toProjectPath } from "@ard/core";

export interface RunOptions {
  /** The wrapped command line, e.g. ["claude"] or ["codex", "--model", "x"]. */
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Receives the one-line summary printed after the run (defaults to stderr). */
  log?: (line: string) => void;
}

/** Friendly agent names for the programs we know; anything else is recorded under its program name. */
export function agentNameFor(program: string): string {
  const name = basename(program);
  if (name === "claude") return "claude-code";
  return name;
}

function fileChangeEvents(ctx: Parameters<typeof baseFields>[0], deltas: ReturnType<typeof changesSince>): FileChangeEvent[] {
  return deltas.map((delta) => {
    const event: FileChangeEvent = { ...baseFields(ctx), type: "file_change", path: delta.path, operation: delta.operation };
    let truncated = false;
    if (delta.patch !== undefined) {
      const c = safeText(delta.patch, LIMITS.text);
      event.patch = c.text;
      truncated ||= c.truncated;
    }
    if (delta.newText !== undefined) {
      const c = safeText(delta.newText, LIMITS.text);
      event.newText = c.text;
      truncated ||= c.truncated;
    }
    if (truncated) event.truncated = true;
    return event;
  });
}

/**
 * Run `argv` as a child process with the terminal attached, and record the run:
 * session_start -> (file changes found via git) -> session_end.
 * Returns the exit code the `ard` process itself should exit with.
 *
 * Limits, by design: the wrapper cannot see inside the agent, so it only knows which files changed
 * (via git), not which commands ran or why. Files ignored by git (like .env) are invisible to it.
 * Use the agent's hooks (`ard init`) for the detailed view; both can be active at once.
 */
export async function runWrapped(options: RunOptions): Promise<number> {
  const { argv, cwd } = options;
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const [program, ...args] = argv;
  if (!program) throw new Error("no command given. Usage: ard run -- <agent> [args...]");

  const root = findProjectRoot(cwd);
  const eventsPath = eventsPathFor(root, env);
  const sessionId = randomUUID();
  const ctx = { sessionId, agent: agentNameFor(program), cwd };
  const started = Date.now();

  const snapshot = takeSnapshot(root);
  appendEvent(eventsPath, { ...baseFields(ctx), type: "session_start", capture: "wrapper", argv: argv.map((a) => safeText(a, 1000).text), gitHead: gitHead(root) });

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }>((resolve) => {
    const child = spawn(program, args, { cwd, stdio: "inherit", env: { ...env, ARD_SESSION_ID: sessionId } });
    // The terminal sends Ctrl-C to both processes; the child decides what to do, we stay alive to finish recording.
    const onInt = () => {};
    const onTerm = () => child.kill("SIGTERM");
    const onHup = () => child.kill("SIGHUP");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    process.on("SIGHUP", onHup);
    const done = (result: { code: number | null; signal: NodeJS.Signals | null; spawnError?: Error }) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      process.off("SIGHUP", onHup);
      resolve(result);
    };
    child.once("error", (spawnError) => done({ code: null, signal: null, spawnError }));
    child.once("close", (code, signal) => done({ code, signal }));
  });

  let changes = 0;
  if (snapshot && !outcome.spawnError) {
    // ard's own data folder is never "the agent's work" (and would otherwise record the log inside the log).
    const ownDir = toProjectPath(ardDirFor(root, env), root);
    const exclude = isAbsolute(ownDir) ? [] : [ownDir];
    const events = fileChangeEvents(ctx, changesSince(snapshot, root, { exclude }));
    for (const event of events) appendEvent(eventsPath, event);
    changes = events.length;
  }

  const exitCode = outcome.spawnError ? 127 : outcome.code ?? (outcome.signal ? 128 + (osConstants.signals[outcome.signal] ?? 0) : 1);
  const end: ArdEvent = {
    ...baseFields(ctx),
    type: "session_end",
    capture: "wrapper",
    exitCode: outcome.spawnError ? 127 : outcome.code,
    signal: outcome.signal,
    durationMs: Date.now() - started,
  };
  appendEvent(eventsPath, end);

  if (outcome.spawnError) log(`ard: could not start "${program}": ${outcome.spawnError.message}`);
  log(`ard: session ${sessionId} recorded${snapshot ? ` (${changes} file change${changes === 1 ? "" : "s"})` : " (not a git repository: file changes not tracked)"}`);
  return exitCode;
}
