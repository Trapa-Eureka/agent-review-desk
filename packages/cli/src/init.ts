import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLAUDE_HOOK_EVENTS } from "./hook.js";
import { MAX_TIMEOUT_SECONDS, ardDirFor, findProjectRoot, setApprovals } from "@ard/core";

export interface InitOptions {
  /** Directory `ard init` was run in; the project root is found from here. */
  dir: string;
  /** Write to the committed .claude/settings.json instead of the personal, git-ignored settings.local.json. */
  shared: boolean;
  /** Remove ard's hooks instead of installing them. */
  remove: boolean;
  /** true / false: switch pre-approval of risky actions on / off in ard.config.json. undefined: leave it alone. */
  approvals?: boolean;
  /** Override the hook command (tests). */
  command?: string;
  env?: NodeJS.ProcessEnv;
}

export interface InitResult {
  root: string;
  settingsPath: string;
  action: "installed" | "updated" | "unchanged" | "removed" | "nothing-to-remove";
  command: string;
  gitignore: "added" | "already-present" | "skipped";
  /** Present when --approvals / --no-approvals was given. */
  approvals?: { path: string; enabled: boolean; changed: boolean };
  warnings: string[];
}

type Json = Record<string, unknown>;
interface HookEntry {
  type?: unknown;
  command?: unknown;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: unknown;
  hooks?: unknown;
  [key: string]: unknown;
}

/** How ard recognizes the hook entries it owns. The `--agent claude-code` flag is part of every ard hook command. */
export function isArdHookCommand(command: unknown): boolean {
  return typeof command === "string" && /\bhook --agent claude-code\b/.test(command);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_/.:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shared file is committed, so it must not contain machine-specific paths: it relies on `ard`
 * being on PATH. The personal file pins absolute paths to this node and this CLI, so it works even
 * when ard is not installed globally (e.g. running from a source checkout).
 */
export function defaultHookCommand(shared: boolean): string {
  if (shared) return "ard hook --agent claude-code";
  const script = realpathSync(process.argv[1] ?? "");
  return `${shellQuote(process.execPath)} ${shellQuote(script)} hook --agent claude-code`;
}

function readSettings(path: string): Json {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON. Fix it first; ard will not overwrite a file it cannot parse.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object. ard will not overwrite it.`);
  }
  return parsed as Json;
}

function hooksOf(settings: Json): Record<string, HookGroup[]> {
  const hooks = settings.hooks;
  return typeof hooks === "object" && hooks !== null && !Array.isArray(hooks) ? (hooks as Record<string, HookGroup[]>) : {};
}

function groupHooks(group: HookGroup): HookEntry[] {
  return Array.isArray(group.hooks) ? (group.hooks as HookEntry[]) : [];
}

function containsArdHook(settings: Json): boolean {
  return Object.values(hooksOf(settings)).some((groups) => Array.isArray(groups) && groups.some((g) => groupHooks(g).some((h) => isArdHookCommand(h.command))));
}

/** Remove ard-owned hook entries in place, leaving everything else (the user's own hooks) untouched. */
function stripArdHooks(settings: Json): void {
  const hooks = hooksOf(settings);
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const original = groupHooks(group);
      const remaining = original.filter((h) => !isArdHookCommand(h.command));
      // Drop a group only when removing ard's entries is what emptied it; never touch groups that were already empty.
      if (remaining.length > 0 || original.length === 0) kept.push({ ...group, hooks: remaining });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
}

/** Recording hooks finish in milliseconds; 10 s is a generous ceiling. */
export const RECORD_TIMEOUT_SECONDS = 10;
/**
 * PreToolUse may wait for a human. Its timeout MUST exceed the longest wait ard allows
 * (MAX_TIMEOUT_SECONDS): if Claude Code killed the hook first, it would treat that as a non-blocking
 * error and the risky call would run unapproved. ard enforces the real deadline itself.
 */
export const PRE_TOOL_TIMEOUT_SECONDS = MAX_TIMEOUT_SECONDS + 60;

function addArdHooks(settings: Json, command: string): void {
  const hooks = hooksOf(settings);
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event]! : [];
    const toolEvent = event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure";
    const timeout = event === "PreToolUse" ? PRE_TOOL_TIMEOUT_SECONDS : RECORD_TIMEOUT_SECONDS;
    const group: HookGroup = { ...(toolEvent ? { matcher: "*" } : {}), hooks: [{ type: "command", command, timeout }] };
    hooks[event] = [...groups, group];
  }
  settings.hooks = hooks;
}

function ensureGitignore(root: string): InitResult["gitignore"] {
  if (!existsSync(join(root, ".git"))) return "skipped";
  const path = join(root, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/^\s*\/?\.ard\/?\s*$/m.test(existing)) return "already-present";
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${prefix}${existing === "" ? "" : "\n"}# agent-review-desk: local recordings (code, commands, possibly secrets)\n.ard/\n`);
  return "added";
}

export function runInit(options: InitOptions): InitResult {
  const env = options.env ?? process.env;
  const root = findProjectRoot(options.dir);
  const claudeDir = join(root, ".claude");
  const sharedPath = join(claudeDir, "settings.json");
  const localPath = join(claudeDir, "settings.local.json");
  const settingsPath = options.shared ? sharedPath : localPath;
  const otherPath = options.shared ? localPath : sharedPath;
  const command = options.command ?? defaultHookCommand(options.shared);
  const warnings: string[] = [];

  if (!existsSync(join(root, ".git")) && !existsSync(join(root, ".ard"))) {
    warnings.push(`${root} is not a git repository; using it as the project root anyway.`);
  }

  const settings = readSettings(settingsPath);
  const before = JSON.stringify(settings);
  const hadArd = containsArdHook(settings);

  if (options.remove) {
    stripArdHooks(settings);
    if (!hadArd) return { root, settingsPath, action: "nothing-to-remove", command, gitignore: "skipped", warnings };
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    return { root, settingsPath, action: "removed", command, gitignore: "skipped", warnings };
  }

  // Update the config first: if ard.config.json is unparsable this throws before any hook is written,
  // so init never leaves a half-finished setup behind.
  let approvalsResult: InitResult["approvals"];
  if (options.approvals !== undefined) {
    const config = setApprovals(root, options.approvals);
    approvalsResult = { path: config.path, enabled: options.approvals, changed: config.changed };
  }

  stripArdHooks(settings);
  addArdHooks(settings, command);
  const changed = JSON.stringify(settings) !== before;
  if (changed) {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  // Claude Code merges hooks from every settings file, so ard hooks in both files would run twice.
  try {
    if (containsArdHook(readSettings(otherPath))) {
      warnings.push(`ard hooks are also registered in ${otherPath}. Claude Code runs hooks from both files, so every event would be recorded twice. Remove one with: ard init --remove${options.shared ? "" : " --shared"}`);
    }
  } catch {
    // The other file is unreadable; it is not ours to judge here.
  }

  mkdirSync(ardDirFor(root, env), { recursive: true, mode: 0o700 });
  const gitignore = ensureGitignore(root);
  const action = !changed ? "unchanged" : hadArd ? "updated" : "installed";
  const result: InitResult = { root, settingsPath, action, command, gitignore, warnings };
  if (approvalsResult) result.approvals = approvalsResult;
  return result;
}
