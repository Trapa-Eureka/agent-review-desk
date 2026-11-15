// Shared helpers for tests only. Not part of the CLI's runtime.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonl, type ArdEvent } from "@ard/schema";

/** Fake secrets are assembled at runtime so this repo never contains a secret-shaped literal. */
export const fake = {
  anthropic: "sk-" + "ant-" + "a".repeat(40),
  github: "ghp_" + "b".repeat(36),
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END " + "RSA PRIVATE KEY-----",
};

/** A fresh temp directory; `cleanup` removes it. */
export function makeTmp(prefix = "ard-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Environment for tests: the real one minus anything that could redirect ard's data. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of ["ARD_DIR", "ARD_SESSION_ID", "CLAUDE_PROJECT_DIR"]) if (!(key in extra)) delete env[key];
  return env;
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
}

/** A git repository with one commit containing `tracked.txt`. */
export function makeGitRepo(): { dir: string; cleanup: () => void } {
  const tmp = makeTmp("ard-repo-");
  git(tmp.dir, "init", "-q");
  writeFileSync(join(tmp.dir, "tracked.txt"), "line one\n");
  git(tmp.dir, "add", "tracked.txt");
  git(tmp.dir, "commit", "-q", "-m", "init");
  return tmp;
}

/** A directory that looks like a project root (has a `.git` folder) without needing git itself. */
export function makeFakeProject(): { dir: string; cleanup: () => void } {
  const tmp = makeTmp("ard-proj-");
  mkdirSync(join(tmp.dir, ".git"));
  return tmp;
}

export function readEvents(projectDir: string): ArdEvent[] {
  const file = join(projectDir, ".ard", "events.jsonl");
  if (!existsSync(file)) return [];
  const { events, errors } = parseJsonl(readFileSync(file, "utf8"));
  if (errors.length > 0) throw new Error(`events.jsonl has invalid lines: ${JSON.stringify(errors)}`);
  return events;
}
