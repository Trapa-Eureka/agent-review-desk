import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ardDirFor, findProjectRoot, setApprovals } from "@ard/core";
import { CODEX_HOOK_EVENTS, CODEX_PRE_TOOL_TIMEOUT_SECONDS } from "./codex.js";
import { RECORD_TIMEOUT_SECONDS, containsArdHook, ensureGitignore, hooksOf, readSettings, shellQuote, stripArdHooks, type HookGroup, type InitResult, type Json } from "./init.js";

/** How ard recognizes the Codex hook entries it owns. */
export function isArdCodexHookCommand(command: unknown): boolean {
  return typeof command === "string" && /\bhook --agent codex\b/.test(command);
}

export interface InitCodexOptions {
  dir: string;
  /** Write a command that relies on `ard` being on PATH (safe to commit) instead of absolute paths to this checkout. */
  shared: boolean;
  remove: boolean;
  approvals?: boolean;
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InitCodexResult {
  root: string;
  hooksPath: string;
  action: "installed" | "updated" | "unchanged" | "removed" | "nothing-to-remove";
  command: string;
  gitignore: InitResult["gitignore"];
  /** The personal hooks file is kept out of `git status` through .git/info/exclude (never the committed .gitignore). */
  exclude: "added" | "already-present" | "skipped";
  approvals?: { path: string; enabled: boolean; changed: boolean };
  warnings: string[];
}

export function defaultCodexHookCommand(shared: boolean): string {
  if (shared) return "ard hook --agent codex";
  const script = realpathSync(process.argv[1] ?? "");
  return `${shellQuote(process.execPath)} ${shellQuote(script)} hook --agent codex`;
}

function addCodexHooks(settings: Json, command: string): void {
  const hooks = hooksOf(settings);
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event]! : [];
    // No matcher: every tool. PreToolUse may wait for a human, and Codex RUNS the command when a hook outlives its timeout
    // (verified), so this timeout must exceed the longest wait ard allows on Codex (CODEX_MAX_WAIT_SECONDS).
    const timeout = event === "PreToolUse" ? CODEX_PRE_TOOL_TIMEOUT_SECONDS : RECORD_TIMEOUT_SECONDS;
    const group: HookGroup = { hooks: [{ type: "command", command, timeout }] };
    hooks[event] = [...groups, group];
  }
  settings.hooks = hooks;
}

function excludeLocally(root: string, relativePath: string): InitCodexResult["exclude"] {
  const gitDir = join(root, ".git");
  if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return "skipped";
  const path = join(gitDir, "info", "exclude");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.split("\n").some((line) => line.trim() === relativePath)) return "already-present";
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${existing === "" || existing.endsWith("\n") ? "" : "\n"}# agent-review-desk: personal Codex hook file (absolute paths)\n${relativePath}\n`);
  return "added";
}

/**
 * `ard init --agent codex`: register ard's hooks for Codex in THIS project's `.codex/hooks.json` (never the global
 * ~/.codex/hooks.json, which would make ard record every Codex session in every folder). The user's own hooks stay
 * untouched, running it twice changes nothing, and a hooks file ard cannot parse is never overwritten.
 * Codex does not run a hook until the person has reviewed and trusted it (`/hooks` inside Codex), and asks again when it changes.
 */
export function runInitCodex(options: InitCodexOptions): InitCodexResult {
  const env = options.env ?? process.env;
  const root = findProjectRoot(options.dir);
  const hooksPath = join(root, ".codex", "hooks.json");
  const command = options.command ?? defaultCodexHookCommand(options.shared);
  const warnings: string[] = [];

  const settings = readSettings(hooksPath);
  const before = JSON.stringify(settings);
  const hadArd = containsArdHook(settings, isArdCodexHookCommand);

  if (options.remove) {
    stripArdHooks(settings, isArdCodexHookCommand);
    if (!hadArd) return { root, hooksPath, action: "nothing-to-remove", command, gitignore: "skipped", exclude: "skipped", warnings };
    writeFileSync(hooksPath, `${JSON.stringify(settings, null, 2)}\n`);
    return { root, hooksPath, action: "removed", command, gitignore: "skipped", exclude: "skipped", warnings };
  }

  // Config first: if ard.config.json cannot be parsed this throws before any hook is written.
  let approvalsResult: InitCodexResult["approvals"];
  if (options.approvals !== undefined) {
    const config = setApprovals(root, options.approvals);
    approvalsResult = { path: config.path, enabled: options.approvals, changed: config.changed };
  }

  stripArdHooks(settings, isArdCodexHookCommand);
  addCodexHooks(settings, command);
  const changed = JSON.stringify(settings) !== before;
  if (changed) {
    mkdirSync(dirname(hooksPath), { recursive: true });
    writeFileSync(hooksPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  mkdirSync(ardDirFor(root, env), { recursive: true, mode: 0o700 });
  const gitignore = ensureGitignore(root);
  const exclude = options.shared ? "skipped" : excludeLocally(root, ".codex/hooks.json");
  const result: InitCodexResult = { root, hooksPath, action: !changed ? "unchanged" : hadArd ? "updated" : "installed", command, gitignore, exclude, warnings };
  if (approvalsResult) result.approvals = approvalsResult;
  return result;
}
