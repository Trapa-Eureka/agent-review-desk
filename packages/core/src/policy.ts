import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { findSecret, safeText } from "./redact.js";

/**
 * The policy engine: decides, from a tool call alone, whether the agent may proceed on its own
 * ("allow"), needs a human's OK first ("approve"), or is never allowed ("deny").
 *
 * It is a safety net that matches command text and file paths, not a sandbox: a wrapped or
 * obfuscated command can slip past it. Rules are intentionally few, readable and individually
 * overridable (see `ard.config.json`). The same shell patterns back the dev-time hook in
 * `.claude/hooks/block-dangerous.mjs`; keep the two in sync.
 */

export type PolicyAction = "allow" | "approve" | "deny";

export interface PolicyCall {
  toolName: string;
  toolInput: Record<string, unknown>;
  projectRoot: string;
}

export interface PolicyRule {
  id: string;
  description: string;
  /** What happens when the rule matches, unless the project overrides it. */
  defaultAction: Exclude<PolicyAction, "allow">;
  test: (call: PolicyCall) => boolean;
}

export interface PolicyMatch {
  id: string;
  description: string;
  action: PolicyAction;
}

export interface PolicyResult {
  /** The strictest action among the matches: deny > approve > allow. */
  action: PolicyAction;
  matches: PolicyMatch[];
}

const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const bashCommand = (call: PolicyCall): string | null => (call.toolName === "Bash" && typeof call.toolInput.command === "string" ? call.toolInput.command : null);

/** Absolute path a file tool wants to write, or null when this is not a file tool call. */
function targetPath(call: PolicyCall): string | null {
  if (!FILE_TOOLS.has(call.toolName)) return null;
  const raw = call.toolInput.file_path ?? call.toolInput.notebook_path;
  if (typeof raw !== "string" || raw === "") return null;
  return isAbsolute(raw) ? resolve(raw) : resolve(call.projectRoot, raw);
}

/** Path relative to the project root with forward slashes, or null when it is outside the project. */
function insideProject(abs: string, root: string): string | null {
  const rel = relative(resolve(root), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return rel === "" ? "" : null;
  return rel.split(sep).join("/");
}

function writtenText(call: PolicyCall): string {
  const input = call.toolInput;
  const parts: unknown[] = [input.content, input.new_string, input.new_source];
  if (Array.isArray(input.edits)) for (const edit of input.edits) parts.push((edit as { new_string?: unknown })?.new_string);
  return parts.filter((p): p is string => typeof p === "string").join("\n");
}

const RM_RECURSIVE = /\brm\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\b|\brm\s+--recursive\b/;
const BROAD_RM_TARGET = /(?:^|\s)(?:\/|\/\*|~\/?|~\/\*|\$HOME\/?|\$\{HOME\}\/?|\.\.\/?|\.\/?\*?|\*|\/(?:Users|home|etc|usr|var|bin|sbin|System|Library|Volumes)(?:\/\S*)?)(?=\s|$)/;

const TEMP_DIRS = [...new Set([resolve(tmpdir()), "/tmp", "/private/tmp", "/var/tmp"])];
const isTempPath = (abs: string) => TEMP_DIRS.some((dir) => abs === dir || abs.startsWith(`${dir}/`));

export const DEFAULT_RULES: readonly PolicyRule[] = [
  // ---- shell commands ----
  {
    id: "rm-recursive-broad",
    description: "Recursive delete (rm -rf) of a broad target such as /, ~, $HOME, .., * or a top-level system folder",
    defaultAction: "approve",
    test: (c) => {
      const cmd = bashCommand(c);
      return cmd !== null && RM_RECURSIVE.test(cmd) && BROAD_RM_TARGET.test(cmd);
    },
  },
  {
    id: "git-force-push",
    description: "git push --force / -f / --force-with-lease / +refspec",
    defaultAction: "approve",
    test: (c) => /\bgit\s+push\b[^;&|\n]*(?:--force(?!-with-lease)\b|\s-f\b|--force-with-lease\b|\s\+\S+)/.test(bashCommand(c) ?? ""),
  },
  {
    id: "git-discard-work",
    description: "git reset --hard, git clean -f, git checkout ., git restore . (discards uncommitted work)",
    defaultAction: "approve",
    test: (c) => {
      const cmd = bashCommand(c) ?? "";
      return /\bgit\s+reset\s+--hard\b/.test(cmd) || /\bgit\s+clean\s+-[a-zA-Z]*f/.test(cmd) || /\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$)/.test(cmd) || /\bgit\s+restore\s+(?:--\S+\s+)*\.(?:\s|$)/.test(cmd);
    },
  },
  {
    id: "git-stage-secrets",
    description: "Staging secret or data files in git (git add -f, .env, .ard, database files, keys)",
    defaultAction: "approve",
    test: (c) => {
      const cmd = bashCommand(c) ?? "";
      return (
        /\bgit\s+add\b[^;&|\n]*(?:\s-f\b|--force\b)/.test(cmd) ||
        /\bgit\s+add\b[^;&|\n]*(?:\.env(?!\.(?:example|sample)\b)(?:\.[\w-]+)?(?=\s|$)|\.ard\b|\.(?:db|sqlite3?|pem|key)\b|id_rsa|id_ed25519)/.test(cmd)
      );
    },
  },
  {
    id: "destructive-sql",
    description: "DROP TABLE/DATABASE/SCHEMA, TRUNCATE TABLE, or DELETE FROM without WHERE",
    defaultAction: "approve",
    test: (c) => {
      const cmd = bashCommand(c) ?? "";
      return /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i.test(cmd) || /\bTRUNCATE\s+TABLE\b/i.test(cmd) || /\bDELETE\s+FROM\s+\w+\s*(?:;|"|'|$)/i.test(cmd);
    },
  },
  {
    id: "pipe-to-shell",
    description: "Downloads a script and runs it directly (curl | sh)",
    defaultAction: "approve",
    test: (c) => /\b(?:curl|wget)\b[^|;\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/.test(bashCommand(c) ?? ""),
  },
  {
    id: "system-wide-change",
    description: "System-wide permission/ownership change (chmod -R, chown -R on /), raw disk writes, mkfs",
    defaultAction: "approve",
    test: (c) => {
      const cmd = bashCommand(c) ?? "";
      return /\bchmod\s+-R\s+[0-7]*7[0-7]*\s+\//.test(cmd) || /\bchown\s+-R\b[^;&|\n]*\s\/(?:\s|$)/.test(cmd) || /\bdd\b[^;&|\n]*\bof=\/dev\//.test(cmd) || /\bmkfs(?:\.\w+)?\b/.test(cmd) || />\s*\/dev\/(?:sd|disk|nvme)/.test(cmd);
    },
  },
  {
    id: "package-publish",
    description: "npm/pnpm/yarn publish",
    defaultAction: "approve",
    test: (c) => /\b(?:npm|pnpm|yarn)\s+publish\b/.test(bashCommand(c) ?? ""),
  },
  {
    id: "secret-in-command",
    description: "The command contains an API key, token or private key",
    defaultAction: "approve",
    test: (c) => {
      const cmd = bashCommand(c);
      return cmd !== null && findSecret(cmd) !== null;
    },
  },
  {
    id: "delete-ard-data",
    description: "Deleting or overwriting ard's own recordings (.ard/, the database, events.jsonl)",
    defaultAction: "deny",
    test: (c) => {
      const cmd = bashCommand(c) ?? "";
      return /\b(?:rm|mv|truncate)\b[^;&|\n]*(?:\.ard\b|\.(?:db|sqlite3?)\b|events\.jsonl)/.test(cmd) || />\s*\S*(?:\.ard\/|events\.jsonl)/.test(cmd);
    },
  },

  // ---- file edits ----
  {
    id: "write-secret-file",
    description: "Writing a .env, key or certificate file",
    defaultAction: "approve",
    test: (c) => {
      const abs = targetPath(c);
      if (!abs) return false;
      const name = basename(abs);
      return (/^\.env(\..+)?$/.test(name) && !/\.(example|sample)$/.test(name)) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(abs) || /^id_(rsa|ed25519|ecdsa)(\.pub)?$/.test(name);
    },
  },
  {
    id: "write-secret-content",
    description: "The text being written contains an API key, token or private key",
    defaultAction: "approve",
    test: (c) => targetPath(c) !== null && findSecret(writtenText(c)) !== null,
  },
  {
    id: "write-outside-project",
    description: "Writing a file outside the project folder (temporary folders are exempt)",
    defaultAction: "approve",
    test: (c) => {
      const abs = targetPath(c);
      return abs !== null && insideProject(abs, c.projectRoot) === null && !isTempPath(abs);
    },
  },
  {
    id: "write-protected-path",
    description: "Editing .git internals or ard's own data folder (.ard/) with a file tool",
    defaultAction: "deny",
    test: (c) => {
      const abs = targetPath(c);
      if (!abs) return false;
      const rel = insideProject(abs, c.projectRoot);
      return rel !== null && (/(^|\/)\.git(\/|$)/.test(rel) || /(^|\/)\.ard(\/|$)/.test(rel) || /\.(db|sqlite3?)(-wal|-shm|-journal)?$/i.test(rel));
    },
  },
];

const STRICTNESS: Record<PolicyAction, number> = { allow: 0, approve: 1, deny: 2 };

/** Run every rule against the call. `overrides` maps a rule id to a different action (e.g. "allow" to switch it off). */
export function evaluatePolicy(call: PolicyCall, overrides: Record<string, PolicyAction> = {}, rules: readonly PolicyRule[] = DEFAULT_RULES): PolicyResult {
  const matches: PolicyMatch[] = [];
  let action: PolicyAction = "allow";
  for (const rule of rules) {
    if (!rule.test(call)) continue;
    const effective = overrides[rule.id] ?? rule.defaultAction;
    if (effective === "allow") continue;
    matches.push({ id: rule.id, description: rule.description, action: effective });
    if (STRICTNESS[effective] > STRICTNESS[action]) action = effective;
  }
  return { action, matches };
}

/** One redacted line describing what the agent wants to do, for the approval screen. */
export function summarizeCall(call: PolicyCall): string {
  const cmd = bashCommand(call);
  if (cmd !== null) return safeText(`Bash: ${cmd.replace(/\s+/g, " ").trim()}`, 300).text;
  const abs = targetPath(call);
  if (abs !== null) {
    const rel = insideProject(abs, call.projectRoot);
    return safeText(`${call.toolName} ${rel ?? abs}`, 300).text;
  }
  return call.toolName;
}
