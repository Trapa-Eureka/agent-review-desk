# agent-review-desk

Records AI agent (Claude Code / Codex) execution events as JSONL, and lets a human review diffs and commands in a web UI, approve or reject them, and pause risky actions until approved.
Free tier is local (JSONL + SQLite, self-hosted); team collaboration and audit logs are cloud (paid). Product background: item #1 of the GitHub_Trending_Tech_Project_TOP100 PDF in the parent folder.

## Layout (pnpm workspace)
- `packages/schema` — JSONL event schema and validation (`@ard/schema`)
- `packages/core` — SQLite repository, policy engine, approvals, config, redaction, JSONL append (`@ard/core`). Shared by the CLI and the web app.
- `packages/cli` — the `ard` CLI: init / hook / run / review (`@ard/cli`)
- `apps/web` — Next.js review UI (`@ard/web`), started by `ard review`, never run bare
- `.claude/hooks` — dev-time blocking hook for this repo (not product code)

## Commands
- `pnpm install` · `pnpm build` · `pnpm typecheck`
- `pnpm test` — schema, core and CLI tests (compiled to `dist/`, run with `node --test`)
- `pnpm test:hooks` — unit tests for the dev-time blocking hook (always run after changing its rules)
- `ard review` — the UI needs `pnpm build` first; it takes its project folder and access token from the CLI

## Design principles
- `.ard/events.jsonl` is the **source of truth**. SQLite (`.ard/data.db`) is an index of it plus the pending approval requests. Hooks on the fast path write only JSONL and never open SQLite.
- Event capture: **agent hooks come first**; the process wrapper (`ard run`) is a fallback for agents without hooks.
- Pre-approval: with `"approvals": true` in `ard.config.json`, a PreToolUse call that the policy flags makes the hook wait on an `approval_requests` row until a human decides in the UI. Opt-in; off by default.
- Only `packages/core/src/repository.ts` knows SQL, so the cloud tier can swap in Postgres behind the same methods.
- Payment happens on the web only. The CLI runs `ard login` and reads the plan. The free/paid boundary is drawn by server-side features.
- Never send a user's API key to our servers. If one is needed, use the OS keychain or environment variables (BYOK).

## Invariants (tested; do not break)
- `ard hook` exits 2 (which makes Claude Code BLOCK the call) **only** when approvals are on and a flagged action was denied, rejected, timed out, or could not be put to a human. Every other problem exits 0: a recorder must never break the agent.
- Fail-open for recording, config and policy bugs; fail-closed for a flagged action whose approval store is unreachable. A timeout is a denial, never an approval.
- The PreToolUse hook timeout in settings (`PRE_TOOL_TIMEOUT_SECONDS`) must exceed the longest allowed wait (`MAX_TIMEOUT_SECONDS`): if Claude Code killed the hook first it would treat that as a non-blocking error and the risky call would run unapproved.
- A decision counts only while the request is pending and unexpired (`decideApprovalRequest`); a late click must never flip or fake an outcome. An interrupted hook retires its own request.
- Everything is redacted and size-capped (`packages/core/src/redact.ts`) before it is written to `.ard/events.jsonl` or shown in the UI. The token patterns mirror `.claude/hooks/block-dangerous.mjs`; keep them in sync. Policy shell patterns (`policy.ts`) mirror that script too.
- The review UI can approve actions, so it stays locked down (`apps/web/middleware.ts`): 127.0.0.1 only, per-launch token cookie, Host and Origin checks, no framing. Do not add a route that skips the middleware, and do not redirect from it (Next rewrites 127.0.0.1 to localhost, which loses the cookie).
- `ard init` never overwrites a settings or config file it cannot parse, never touches the user's own hooks, is idempotent, and does not write any hook if the config update fails.
- `ard run` never records ard's own data folder as an agent change, and only attributes changes made during the run.
- Adding an optional event field keeps schema `v: 1`; renaming or removing one bumps `SCHEMA_VERSION`. SQL migrations are append-only (`MIGRATIONS` in `db.ts`).

## Rules
- Never commit user data (`.ard/`, `*.db`, `*.jsonl`) or secrets (`.env`, keys, tokens). Check `.gitignore` first. `ard.config.json` is policy only and is meant to be committed in a normal project, but in THIS repo it is git-ignored on purpose (a committed `"approvals": true` would pause every contributor's Claude Code). Never run `ard init` here; use a throwaway project.
- After adding a package or folder, run `git status` and confirm it is listed. A broad `.gitignore` pattern once hid all of `packages/core` (a bare `core` rule meant for core dumps); anchor such patterns with a leading `/`.
- Never write secret values into code, tests or logs. Assemble fake values at runtime in tests.
- JSONL test fixtures live only under `**/fixtures/**`.
- If a hook blocks an action, do not work around it; tell the user.
- Black-box checks must assert on what matters (e.g. the redirect *host*, not just the status code); verify a check can fail before trusting it.
- Strict rules belong in hooks, procedures in skills — not in this file. Keep this file under 200 lines.
- All files in this repo are written in English (code, comments, docs, UI strings).
