import { defaultRun, findProjectRoot, openProject, type RunFn, type SessionSummary } from "@ard/core";

/**
 * Use the review you already did locally to gate and describe a GitHub pull request, with no GitHub Actions and no server:
 * the GitHub CLI (`gh`), logged in as you, posts a COMMIT STATUS (which branch protection can require) and a PR comment.
 *
 *  - The status says whether the agent sessions behind the branch were approved in `ard review`.
 *  - The comment lists them: counts and decisions only, never code or command output (a PR can be public).
 *
 * Honest limits: anyone with write access can post a status too, so this stops an ACCIDENTAL merge, not a determined one;
 * a status belongs to one commit, so it must be posted again after each push; and "which sessions belong to this PR"
 * is a guess unless you name them (--session).
 */

export const MARKER = "<!-- agent-review-desk -->";
export const DEFAULT_CONTEXT = "ard/review";

export class PrError extends Error {}

export interface PullRequest {
  number: number;
  headSha: string;
  baseRef: string;
  url: string;
  repo: string; // owner/name
}

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF = /^[A-Za-z0-9._/-]+$/;
const CONTEXT = /^[A-Za-z0-9._/-]{1,80}$/;

export const isValidContext = (value: string): boolean => CONTEXT.test(value);

const firstLine = (text: string): string => text.trim().split("\n")[0]?.slice(0, 240) ?? "";

function ghFailure(what: string, result: { stderr: string; error?: Error }): PrError {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return new PrError("The GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com and run `gh auth login`.");
  const detail = firstLine(result.stderr);
  // Permission first: a 403 message can mention "token" without the login being the problem.
  const hint = /403|forbidden|not accessible|must have|permission/i.test(detail) ? " You need write access to this repository." : /auth login|not logged|authenticat|bad credentials|401/i.test(detail) ? " Run `gh auth login`." : "";
  return new PrError(`${what}${detail ? `: ${detail}` : "."}${hint}`);
}

/** The pull request to act on: the one for the current branch, or --pr. Every value that later goes into a command or a path is validated here. */
export function resolvePullRequest(run: RunFn, cwd: string, pr?: string): PullRequest {
  if (pr !== undefined && !/^\d{1,9}$/.test(pr)) throw new PrError("--pr must be a pull request number.");
  const view = run("gh", ["pr", "view", ...(pr ? [pr] : []), "--json", "number,headRefOid,baseRefName,url"], undefined, cwd);
  if (view.error || view.status !== 0) throw ghFailure("Could not find the pull request" + (pr ? ` #${pr}` : " for this branch (is it pushed, and is a PR open?)"), view);
  const repoView = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], undefined, cwd);
  if (repoView.error || repoView.status !== 0) throw ghFailure("Could not tell which repository this is", repoView);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(view.stdout) as Record<string, unknown>;
  } catch {
    throw new PrError("The GitHub CLI returned something unexpected for the pull request.");
  }
  const repo = repoView.stdout.trim();
  const number = data.number;
  const headSha = data.headRefOid;
  const baseRef = data.baseRefName;
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || typeof headSha !== "string" || !SHA.test(headSha) || typeof baseRef !== "string" || !REF.test(baseRef) || baseRef.startsWith("-") || !REPO.test(repo)) {
    throw new PrError("The pull request details from GitHub were not in the expected form.");
  }
  return { number, headSha, baseRef, url: typeof data.url === "string" ? data.url : "", repo };
}

/** When this branch left its base: the commit time of the merge base. */
export function branchStartedAt(run: RunFn, cwd: string, baseRef: string): string {
  if (!REF.test(baseRef) || baseRef.startsWith("-")) throw new PrError("Unsafe base branch name.");
  for (const candidate of [`origin/${baseRef}`, baseRef]) {
    const base = run("git", ["merge-base", "HEAD", candidate], undefined, cwd);
    const sha = base.stdout.trim();
    if (base.status === 0 && SHA.test(sha)) {
      const shown = run("git", ["show", "-s", "--format=%cI", sha], undefined, cwd);
      const at = shown.stdout.trim();
      if (shown.status === 0 && !Number.isNaN(Date.parse(at))) return at;
    }
  }
  throw new PrError(`Could not find where this branch left "${baseRef}". Name the sessions yourself with --session <id>.`);
}

export type ReviewState = "success" | "failure" | "pending";

export interface ReviewSummary {
  state: ReviewState;
  description: string;
  total: number;
  approved: number;
  rejected: number;
  unreviewed: number;
}

export function summarizeReview(sessions: SessionSummary[]): ReviewSummary {
  const total = sessions.length;
  const approved = sessions.filter((s) => s.review?.decision === "approved").length;
  const rejected = sessions.filter((s) => s.review?.decision === "rejected").length;
  const unreviewed = total - approved - rejected;
  const plural = (n: number) => `${n} agent session${n === 1 ? "" : "s"}`;
  let state: ReviewState;
  let description: string;
  if (total === 0) {
    state = "success";
    description = "No agent sessions recorded for this branch";
  } else if (rejected > 0) {
    state = "failure";
    description = `${rejected} of ${plural(total)} rejected${unreviewed > 0 ? `, ${unreviewed} not reviewed` : ""}`;
  } else if (unreviewed > 0) {
    state = "pending";
    description = `${unreviewed} of ${plural(total)} still ${unreviewed === 1 ? "needs" : "need"} review`;
  } else {
    state = "success";
    description = `All ${plural(total)} approved`;
  }
  return { state, description: description.slice(0, 140), total, approved, rejected, unreviewed };
}

/** How a session relates to the files the pull request changes. */
export type Relevance = "touches" | "unknown" | "unrelated";

export interface ClassifiedSession {
  session: SessionSummary;
  relevance: Relevance;
  /** How many of the PR's files this session changed. */
  overlap: number;
}

/**
 * Which of these sessions belong to the pull request? The ones that changed at least one of the PR's files ("touches"). A
 * session that recorded NO file change at all ("unknown": a read-only session, or an agent whose hooks cannot see edits,
 * like Codex) is kept, because dropping a session we cannot judge would let unreviewed work through. A session that changed
 * only files OUTSIDE the PR ("unrelated") is left out, and the commands say so.
 *
 * `prefix` is the project's folder inside the repository ("" when the project is the repository root), because the PR lists
 * paths from the repository root and the recordings list them from the project root.
 */
export function classifySessions(sessions: SessionSummary[], prFiles: ReadonlySet<string>, prefix: string, cwd: string, env: NodeJS.ProcessEnv): ClassifiedSession[] {
  const { repo } = openProject(findProjectRoot(cwd), env);
  try {
    return sessions.map((session) => {
      const paths = new Set<string>();
      for (const event of repo.sessionEvents(session.id)) if (event.type === "file_change") paths.add(event.path);
      if (paths.size === 0) return { session, relevance: "unknown" as const, overlap: 0 };
      let overlap = 0;
      for (const path of paths) if (!path.startsWith("/") && prFiles.has(`${prefix}${path}`)) overlap++;
      return { session, relevance: overlap > 0 ? ("touches" as const) : ("unrelated" as const), overlap };
    });
  } finally {
    repo.close();
  }
}

/** The files the pull request changes, as GitHub lists them (every page), or null when they cannot be read. */
export function pullRequestFiles(run: RunFn, cwd: string, pr: PullRequest): Set<string> | null {
  if (!REPO.test(pr.repo)) return null;
  const result = run("gh", ["api", "--paginate", `repos/${pr.repo}/pulls/${pr.number}/files`, "--jq", ".[].filename"], undefined, cwd);
  if (result.error || result.status !== 0) return null;
  const files = result.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "" && l.length <= 1000);
  return files.length > 0 ? new Set(files) : null;
}

/** Where the project sits inside its git repository ("" at the top, otherwise "sub/dir/"). */
export function repositoryPrefix(run: RunFn, root: string): string {
  const result = run("git", ["rev-parse", "--show-prefix"], undefined, root);
  const prefix = result.stdout.trim();
  return result.status === 0 && /^[^\n]*$/.test(prefix) && !prefix.startsWith("/") ? prefix : "";
}

export interface SelectOptions {
  /** Sessions named by hand. */
  sessions?: string[];
  /** Otherwise: sessions that started at or after this time. */
  since?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function selectSessions(options: SelectOptions): SessionSummary[] {
  const { repo } = openProject(findProjectRoot(options.cwd), options.env);
  try {
    if (options.sessions && options.sessions.length > 0) {
      return options.sessions.map((id) => {
        const found = repo.getSession(id);
        if (!found) throw new PrError(`No session "${id}" in this project.`);
        return found;
      });
    }
    const since = options.since ? Date.parse(options.since) : 0;
    return repo.listSessions(1000).filter((s) => Date.parse(s.startedAt) >= since).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  } finally {
    repo.close();
  }
}

const cell = (text: string): string => text.replace(/[|\r\n]+/g, " ").slice(0, 120);

/** The PR comment. Counts and decisions only: no code, no command output, no paths. */
export function buildComment(pr: Pick<PullRequest, "number">, sessions: SessionSummary[], summary: ReviewSummary, leftOut = 0): string {
  const headline = summary.state === "success" ? (summary.total === 0 ? "No agent sessions were recorded for this branch." : "Every agent session behind this branch was reviewed and approved.") : summary.state === "failure" ? "At least one agent session behind this branch was **rejected**." : "Some agent sessions behind this branch have **not been reviewed yet**.";
  const rows = sessions.map((s) => {
    const review = s.review ? `${s.review.decision} on ${s.review.at.slice(0, 10)}${s.review.note ? ` — “${cell(s.review.note)}”` : ""}` : "not reviewed";
    const blocked = s.blocked > 0 ? `${s.blocked} blocked` : "";
    return `| ${cell(s.agent)} | ${s.startedAt.slice(0, 16).replace("T", " ")} | ${s.counts.toolCalls} | ${s.counts.commands} | ${s.counts.fileChanges} | ${[review, blocked].filter(Boolean).join("; ")} |`;
  });
  return [
    MARKER,
    "### Agent review",
    "",
    headline,
    "",
    ...(rows.length > 0 ? ["| Agent | Started (UTC) | Tool calls | Commands | File changes | Review |", "|---|---|---|---|---|---|", ...rows, ""] : []),
    ...(leftOut > 0 ? [`${leftOut} other agent session${leftOut === 1 ? "" : "s"} recorded since the branch started ${leftOut === 1 ? "was" : "were"} left out because ${leftOut === 1 ? "it" : "they"} changed only files outside this pull request.`, ""] : []),
    `<sub>Posted from a local \`ard pr-comment\` run for #${pr.number}. This lists counts and review decisions only, never code or command output. The reviews were made on the author's machine.</sub>`,
    "",
  ].join("\n");
}

export interface StatusInput {
  state: ReviewState;
  description: string;
  context: string;
}

/** Post a commit status for the PR's head commit. */
export function postStatus(run: RunFn, cwd: string, pr: PullRequest, status: StatusInput): void {
  if (!SHA.test(pr.headSha) || !REPO.test(pr.repo)) throw new PrError("Unsafe pull request details.");
  if (!isValidContext(status.context)) throw new PrError("The status name may only contain letters, digits, . _ / - (at most 80 characters).");
  const body = JSON.stringify({ state: status.state, context: status.context, description: status.description.slice(0, 140) });
  const result = run("gh", ["api", "-X", "POST", `repos/${pr.repo}/statuses/${pr.headSha}`, "--input", "-"], body, cwd);
  if (result.error || result.status !== 0) throw ghFailure("GitHub did not accept the status", result);
}

/** Create the comment, or update the one this tool wrote earlier (only ever one of YOUR OWN comments). */
export function upsertComment(run: RunFn, cwd: string, pr: PullRequest, body: string): "created" | "updated" {
  if (!REPO.test(pr.repo)) throw new PrError("Unsafe repository name.");
  const me = run("gh", ["api", "user", "--jq", ".login"], undefined, cwd);
  const login = me.stdout.trim();
  if (me.error || me.status !== 0 || !/^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(login)) throw ghFailure("Could not tell who you are logged in as", me);
  const found = run("gh", ["api", "--paginate", `repos/${pr.repo}/issues/${pr.number}/comments`, "--jq", `.[] | select(.user.login == "${login}") | select(.body | contains("${MARKER}")) | .id`], undefined, cwd);
  if (found.error || found.status !== 0) throw ghFailure("Could not read the existing comments", found);
  const id = found.stdout.split("\n").map((l) => l.trim()).find((l) => /^\d{1,15}$/.test(l));
  const payload = JSON.stringify({ body });
  const write = id
    ? run("gh", ["api", "-X", "PATCH", `repos/${pr.repo}/issues/comments/${id}`, "--input", "-"], payload, cwd)
    : run("gh", ["api", "-X", "POST", `repos/${pr.repo}/issues/${pr.number}/comments`, "--input", "-"], payload, cwd);
  if (write.error || write.status !== 0) throw ghFailure("GitHub did not accept the comment", write);
  return id ? "updated" : "created";
}

export interface PrCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  pr?: string;
  sessions?: string[];
  dryRun: boolean;
  /** Count every session since the branch started, even ones that changed only files outside the pull request. */
  includeUnrelated?: boolean;
  context: string;
  run?: RunFn;
  out: (text: string) => void;
}

interface Gathered {
  pr: PullRequest;
  /** What the status and the comment are about. */
  sessions: SessionSummary[];
  /** Sessions that were found but left out because they changed only files outside this pull request. */
  left: ClassifiedSession[];
  /** Per included session, why it is included (for the printed list). */
  why: Map<string, string>;
  summary: ReviewSummary;
  run: RunFn;
  basis: string;
}

function gather(options: PrCommandOptions): Gathered {
  const run = options.run ?? defaultRun;
  const pr = resolvePullRequest(run, options.cwd, options.pr);
  const named = options.sessions && options.sessions.length > 0;
  const since = named ? undefined : branchStartedAt(run, options.cwd, pr.baseRef);
  const found = selectSessions({ ...(named ? { sessions: options.sessions } : {}), ...(since ? { since } : {}), cwd: options.cwd, env: options.env });

  let sessions = found;
  let left: ClassifiedSession[] = [];
  const why = new Map<string, string>();
  let basis = named ? "sessions you named" : `sessions started since this branch left ${pr.baseRef} (${since})`;
  if (!named && !options.includeUnrelated) {
    const files = pullRequestFiles(run, options.cwd, pr);
    if (!files) {
      basis += "; the PR's file list could not be read, so every one of them is included";
    } else {
      const classified = classifySessions(found, files, repositoryPrefix(run, findProjectRoot(options.cwd)), options.cwd, options.env);
      sessions = classified.filter((c) => c.relevance !== "unrelated").map((c) => c.session);
      left = classified.filter((c) => c.relevance === "unrelated");
      for (const c of classified) why.set(c.session.id, c.relevance === "touches" ? `changed ${c.overlap} of this PR's files` : "no file changes recorded, so it cannot be ruled out");
      basis += ", that changed this PR's files or recorded no file changes";
    }
  }
  return { pr, sessions, left, why, summary: summarizeReview(sessions), run, basis };
}

const stamp = (s: SessionSummary): string => s.startedAt.slice(0, 16).replace("T", " ");

export function runPrStatus(options: PrCommandOptions): number {
  if (!isValidContext(options.context)) throw new PrError("The status name may only contain letters, digits, . _ / - (at most 80 characters).");
  const { pr, sessions, left, why, summary, run, basis } = gather(options);
  options.out(`Pull request #${pr.number} in ${pr.repo}, commit ${pr.headSha.slice(0, 7)}`);
  options.out(`Considering ${sessions.length} agent session${sessions.length === 1 ? "" : "s"} (${basis}):`);
  for (const s of sessions) options.out(`  ${s.agent}  ${stamp(s)}  ${(s.review ? s.review.decision : "not reviewed").padEnd(12)} ${why.get(s.id) ? `(${why.get(s.id)})` : ""}`.trimEnd());
  if (left.length > 0) {
    options.out(`Left out, because they changed only files outside this pull request (use --include-unrelated to count them):`);
    for (const c of left) options.out(`  ${c.session.agent}  ${stamp(c.session)}  ${c.session.review ? c.session.review.decision : "not reviewed"}  id ${c.session.id}`);
  }
  options.out(`Status "${options.context}": ${summary.state}: ${summary.description}`);
  if (options.dryRun) {
    options.out("Dry run: nothing was posted.");
    return 0;
  }
  postStatus(run, options.cwd, pr, { state: summary.state, description: summary.description, context: options.context });
  options.out(`Posted. Branch protection can require "${options.context}"; post it again after every push (a status belongs to one commit).`);
  return 0; // the command did its job even when the status it posted is "failure"
}

export function runPrComment(options: PrCommandOptions): number {
  const { pr, sessions, left, summary, run, basis } = gather(options);
  const body = buildComment(pr, sessions, summary, left.length);
  options.out(`Pull request #${pr.number} in ${pr.repo}: ${sessions.length} agent session${sessions.length === 1 ? "" : "s"} (${basis}).`);
  if (options.dryRun) {
    options.out("Dry run: this comment would be posted:\n");
    options.out(body);
    return 0;
  }
  const what = upsertComment(run, options.cwd, pr, body);
  options.out(`Comment ${what} on ${pr.url || `#${pr.number}`}.`);
  return 0;
}
