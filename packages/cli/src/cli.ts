import { readFileSync } from "node:fs";
import { SCHEMA_VERSION } from "@ard/schema";
import { runLogin, runLogout, runWhoami, type AccountIo } from "./cloud/account.js";
import { CloudHttpError, resolveServer, type CloudFetch } from "./cloud/client.js";
import { runSync } from "./cloud/sync.js";
import { handleClaudeHook } from "./hook.js";
import { runInit } from "./init.js";
import { DEFAULT_PORT, runReview } from "./review.js";
import { runWrapped } from "./run.js";

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  readStdin: () => Promise<string>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Network, clock and waiting are injectable so the cloud commands can be tested without a server or real delays. */
  fetch?: CloudFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export const defaultIo = (): Io => ({
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  readStdin: async () => {
    if (process.stdin.isTTY) return "";
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data;
  },
  cwd: process.cwd(),
  env: process.env,
});

const accountIo = (io: Io): AccountIo => ({
  out: io.out,
  err: io.err,
  env: io.env,
  fetch: io.fetch ?? (globalThis.fetch as unknown as CloudFetch),
  sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  now: io.now ?? (() => new Date()),
});

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const HELP = `ard — record what AI coding agents do, so you can review and approve it

Usage:
  ard init [--approvals | --no-approvals] [--shared] [--remove] [--dir <path>]
      Register ard's hooks for Claude Code in this project and create the local .ard/ folder.
      Default writes .claude/settings.local.json (personal, git-ignored, absolute paths).
      --approvals     block risky actions (force push, rm -rf ~, secrets, ...) until you approve
                      them in the review UI. Writes "approvals": true to ard.config.json.
      --no-approvals  turn that off again
      --shared        write .claude/settings.json instead (committed; needs 'ard' on PATH)
      --remove        remove ard's hooks again (recordings in .ard/ are kept)

  ard review [--port <number>]
      Open the review UI for this project: sessions, diffs, commands, and the approve/reject buttons.
      Prints a private link (127.0.0.1 only, new token each time). Default port ${DEFAULT_PORT}.

  ard run -- <agent> [args...]
      Run an agent (e.g. claude, codex) and record the session and the files it changed (via git).
      Works with any program; it does not need hooks.

  ard hook --agent claude-code
      Used by Claude Code, not by you: reads a hook event on stdin and appends it to .ard/events.jsonl.
      It exits 2 (block) only when approvals are on and a risky action was denied or not approved;
      every other problem exits 0 so the recorder can never break the agent.

Team workspace (the paid Team plan; point ARD_CLOUD_URL at your Agent Review Desk Cloud, or pass --server):
  ard login [--server <url>]
      Sign in. Shows a short code and a link; you confirm in the browser (SSO and 2FA work as usual).
  ard logout [--server <url>]
      Revoke this machine's token and forget it.
  ard whoami [--server <url>]
      Who you are signed in as, your organizations and their plan.
  ard sync [--org <slug>] [--dry-run] [--yes] [--server <url>]
      Upload what was recorded since the last sync to your team's workspace. The first upload to an
      organization needs --yes: it sends command output and file diffs to another computer.
      --dry-run shows what would be sent and sends nothing.

Recordings are written to .ard/events.jsonl and indexed in .ard/data.db (set ARD_DIR to use another folder).
Project settings live in ard.config.json (committed): approvals, timeoutSeconds, per-rule overrides.
Your login token is stored in ~/.config/ard/credentials.json (owner-only; set ARD_CONFIG_DIR to move it).
`;

function takeFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function takeValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  args.splice(i, value === undefined ? 1 : 2);
  return value;
}

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(HELP);
      return 0;

    case "--version":
    case "-v":
      io.out(`ard ${version()} (event schema v${SCHEMA_VERSION})`);
      return 0;

    case "init": {
      const args = [...rest];
      const shared = takeFlag(args, "--shared");
      const remove = takeFlag(args, "--remove");
      const on = takeFlag(args, "--approvals");
      const off = takeFlag(args, "--no-approvals");
      const dir = takeValue(args, "--dir") ?? io.cwd;
      if (args.length > 0) {
        io.err(`ard init: unknown argument: ${args.join(" ")}`);
        return 2;
      }
      if (on && off) {
        io.err("ard init: --approvals and --no-approvals cannot be used together");
        return 2;
      }
      try {
        const approvals = on ? true : off ? false : undefined;
        const result = runInit({ dir, shared, remove, ...(approvals === undefined ? {} : { approvals }), env: io.env });
        for (const warning of result.warnings) io.err(`warning: ${warning}`);
        if (result.action === "removed") io.out(`Removed ard hooks from ${result.settingsPath}. Recordings in .ard/ were kept.`);
        else if (result.action === "nothing-to-remove") io.out(`No ard hooks found in ${result.settingsPath}.`);
        else {
          io.out(`ard hooks ${result.action} in ${result.settingsPath}`);
          io.out(`  hook command: ${result.command}`);
          io.out(`  recordings:   ${result.root}/.ard/events.jsonl`);
          io.out(`  .gitignore:   ${result.gitignore === "added" ? "added .ard/" : result.gitignore === "already-present" ? ".ard/ already ignored" : "skipped (not a git repository)"}`);
          if (result.approvals) {
            io.out(`  approvals:    ${result.approvals.enabled ? "ON" : "off"} (${result.approvals.path}${result.approvals.changed ? "" : ", unchanged"})`);
            if (result.approvals.enabled) io.out('  Risky actions will now wait for you. Run "ard review" to approve or reject them.');
          }
          io.out("Restart Claude Code (or open /hooks) for the new hooks to take effect.");
        }
        return 0;
      } catch (error) {
        io.err(`ard init: ${(error as Error).message}`);
        return 1;
      }
    }

    case "hook": {
      // A recorder must never break the agent it observes, so every problem exits 0. The one exception is
      // deliberate: exit 2 makes Claude Code BLOCK the tool call, and that is returned only when approvals
      // are on and the action was denied, rejected, timed out, or could not be put to a human.
      try {
        const args = [...rest];
        const agent = takeValue(args, "--agent");
        if (agent !== "claude-code") {
          io.err(`ard hook: --agent must be "claude-code" (got ${agent ?? "nothing"}). This command is meant to be called by Claude Code.`);
          return 0;
        }
        const result = await handleClaudeHook(await io.readStdin(), io.env, io.cwd);
        if (result.message) io.err(result.message);
        return result.exitCode;
      } catch (error) {
        io.err(`ard hook: not recorded: ${(error as Error).message}`);
        return 0;
      }
    }

    case "review": {
      const args = [...rest];
      const portText = takeValue(args, "--port");
      if (args.length > 0) {
        io.err(`ard review: unknown argument: ${args.join(" ")}`);
        return 2;
      }
      const port = portText === undefined ? DEFAULT_PORT : Number(portText);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        io.err("ard review: --port must be a whole number from 1024 to 65535");
        return 2;
      }
      try {
        return await runReview({ cwd: io.cwd, env: io.env, port, log: io.err });
      } catch (error) {
        io.err(`ard review: ${(error as Error).message}`);
        return 1;
      }
    }

    case "run": {
      const args = rest[0] === "--" ? rest.slice(1) : rest;
      if (args.length === 0) {
        io.err("ard run: no command given. Usage: ard run -- <agent> [args...]");
        return 2;
      }
      try {
        return await runWrapped({ argv: args, cwd: io.cwd, env: io.env, log: io.err });
      } catch (error) {
        io.err(`ard run: ${(error as Error).message}`);
        return 1;
      }
    }

    case "login":
    case "logout":
    case "whoami":
    case "sync": {
      const args = [...rest];
      const serverFlag = takeValue(args, "--server");
      const org = command === "sync" ? takeValue(args, "--org") : undefined;
      const dryRun = command === "sync" ? takeFlag(args, "--dry-run") : false;
      const yes = command === "sync" ? takeFlag(args, "--yes") : false;
      if (args.length > 0) {
        io.err(`ard ${command}: unknown argument: ${args.join(" ")}`);
        return 2;
      }
      try {
        const server = resolveServer(io.env, serverFlag);
        const account = accountIo(io);
        if (command === "login") return await runLogin(account, server);
        if (command === "logout") return await runLogout(account, server);
        if (command === "whoami") return await runWhoami(account, server);
        return await runSync(account, { cwd: io.cwd, server, ...(org === undefined ? {} : { org }), yes, dryRun });
      } catch (error) {
        io.err(`ard ${command}: ${error instanceof CloudHttpError || error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    }

    default:
      io.err(`ard: unknown command "${command}". Run "ard --help".`);
      return 2;
  }
}
