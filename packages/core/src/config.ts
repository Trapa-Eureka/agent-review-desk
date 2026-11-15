import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RULES, type PolicyAction } from "./policy.js";

/**
 * Project configuration: `ard.config.json` in the project root. It is meant to be committed so a
 * team shares one policy. Personal data never goes here (that lives in the git-ignored `.ard/`).
 *
 *   {
 *     "approvals": true,                    // block risky actions until a human approves them
 *     "timeoutSeconds": 300,                // how long a blocked call waits before it is denied
 *     "rules": { "git-force-push": "deny", "package-publish": "allow" }
 *   }
 */
export const CONFIG_FILE = "ard.config.json";
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MIN_TIMEOUT_SECONDS = 5;
export const MAX_TIMEOUT_SECONDS = 3600;

export interface ArdConfig {
  approvals: boolean;
  timeoutSeconds: number;
  rules: Record<string, PolicyAction>;
  /** Problems found in the file. A broken config never crashes a hook: it falls back to defaults and says why. */
  warnings: string[];
}

const ACTIONS: readonly string[] = ["allow", "approve", "deny"];

export function configPath(root: string): string {
  return join(root, CONFIG_FILE);
}

export function defaultConfig(): ArdConfig {
  return { approvals: false, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, rules: {}, warnings: [] };
}

export function loadConfig(root: string): ArdConfig {
  const config = defaultConfig();
  const path = configPath(root);
  if (!existsSync(path)) return config;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    config.warnings.push(`${CONFIG_FILE} is not valid JSON (${(error as Error).message}); using defaults, approvals are OFF.`);
    return config;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    config.warnings.push(`${CONFIG_FILE} must contain a JSON object; using defaults, approvals are OFF.`);
    return config;
  }
  const raw = parsed as Record<string, unknown>;

  if (raw.approvals !== undefined) {
    if (typeof raw.approvals === "boolean") config.approvals = raw.approvals;
    else config.warnings.push(`"approvals" must be true or false; approvals are OFF.`);
  }

  if (raw.timeoutSeconds !== undefined) {
    const t = raw.timeoutSeconds;
    if (typeof t === "number" && Number.isFinite(t) && t >= MIN_TIMEOUT_SECONDS && t <= MAX_TIMEOUT_SECONDS) config.timeoutSeconds = Math.floor(t);
    else config.warnings.push(`"timeoutSeconds" must be a number from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}; using ${DEFAULT_TIMEOUT_SECONDS}.`);
  }

  if (raw.rules !== undefined) {
    if (typeof raw.rules !== "object" || raw.rules === null || Array.isArray(raw.rules)) {
      config.warnings.push(`"rules" must be an object of rule id -> "allow" | "approve" | "deny".`);
    } else {
      const known = new Set(DEFAULT_RULES.map((r) => r.id));
      for (const [id, action] of Object.entries(raw.rules as Record<string, unknown>)) {
        if (!known.has(id)) config.warnings.push(`Unknown rule id "${id}" ignored.`);
        else if (typeof action !== "string" || !ACTIONS.includes(action)) config.warnings.push(`Rule "${id}" must be "allow", "approve" or "deny"; keeping its default.`);
        else config.rules[id] = action as PolicyAction;
      }
    }
  }
  return config;
}

/** Set `approvals` in the config file, keeping everything else in it. Refuses to touch a file it cannot parse. */
export function setApprovals(root: string, enabled: boolean): { path: string; created: boolean; changed: boolean } {
  const path = configPath(root);
  const existed = existsSync(path);
  let data: Record<string, unknown> = {};
  if (existed) {
    const text = readFileSync(path, "utf8");
    if (text.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${path} is not valid JSON. Fix it first; ard will not overwrite a file it cannot parse.`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object. ard will not overwrite it.`);
      data = parsed as Record<string, unknown>;
    }
  }
  if (data.approvals === enabled) return { path, created: false, changed: false };
  data.approvals = enabled;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return { path, created: !existed, changed: true };
}
