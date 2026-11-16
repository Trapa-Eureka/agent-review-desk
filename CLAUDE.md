# agent-review-desk

Records AI agent (Claude Code / Codex) execution events as JSONL, and lets a human review diffs and commands in a web UI, approve or reject them, and pause risky actions until approved.
Free tier is local (JSONL + SQLite, self-hosted); team collaboration and audit logs are cloud (paid). Product background: item #1 of the GitHub_Trending_Tech_Project_TOP100 PDF in the parent folder.

## Layout (pnpm workspace)
- `packages/schema` — JSONL event schema and validation (`@ard/schema`)
- `packages/core` — SQLite repository, policy engine, approvals, config, redaction, JSONL append (`@ard/core`). Shared by the CLI and the web app.
- `packages/cli` — the `ard` CLI: init / hook / run / review / login / logout / whoami / sync (`@ard/cli`)
- `packages/billing` — Paddle and Dodo providers, webhook verification, entitlement (`@ard/billing`). UNRELEASED
- `packages/cloud` — accounts, orgs, roles, SSO, per-org workspaces, billing service (`@ard/cloud`). UNRELEASED
- `packages/summary` — optional BYOK AI session summary (`@ard/summary`; the only package that talks to Anthropic)
- `packages/ui` — review components shared by both UIs (`@ard/ui`, source-shipped via `transpilePackages`)
- `apps/web` — Next.js review UI (`@ard/web`), started by `ard review`, never run bare
- `apps/cloud` — Next.js team workspace (`@ard/cloud-web`). UNRELEASED and BLOCKED; guide in `docs/unreleased/cloud-selfhosting.md`
- `.claude/hooks` — dev-time blocking hook for this repo (not product code)

## Commands
- `pnpm install` · `pnpm build` · `pnpm typecheck`
- `pnpm test` — schema, core and CLI tests (compiled to `dist/`, run with `node --test`)
- `pnpm test:hooks` — unit tests for the dev-time blocking hook (always run after changing its rules)
- `pnpm test:e2e` — real cloud server + real CLI + signed webhooks + local OIDC IdP (needs `pnpm build` first; uses throwaway data and fake credentials, and blanks `ARD_*` so a developer's real `apps/cloud/.env` is never used)
- `ard review` — the UI needs `pnpm build` first; it takes its project folder and access token from the CLI

## Design principles
- `.ard/events.jsonl` is the **source of truth**. SQLite (`.ard/data.db`) is an index of it plus the pending approval requests. Hooks on the fast path write only JSONL and never open SQLite.
- Event capture: **agent hooks come first**; the process wrapper (`ard run`) is a fallback for agents without hooks.
- Pre-approval: with `"approvals": true` in `ard.config.json`, a PreToolUse call that the policy flags makes the hook wait on an `approval_requests` row until a human decides in the UI. Opt-in; off by default.
- Only `packages/core/src/repository.ts` knows SQL, so the cloud tier can swap in Postgres behind the same methods.
- Payment happens on the web only. The CLI runs `ard login` and reads the plan. The free/paid boundary is drawn by server-side features.
- Never send a user's API key to our servers. If one is needed, use the OS keychain or environment variables (BYOK).

## Invariants (tested; do not break)
- **Paid/team features are unreleased and BLOCKED.** `ard login|logout|whoami|sync` and the `apps/cloud` server (middleware 503 for every route, a guard on `pnpm start/dev`, and `getCloud()`) refuse to run unless `ARD_UNRELEASED_CLOUD=1`, which exists for development and `pnpm test:e2e` only. Do not mention them in the README or `ard --help`, and do not set the switch anywhere by default. The e2e proves the block (503 on every path, commands refuse, help is clean).
- `ard hook` exits 2 (which makes Claude Code BLOCK the call) **only** when approvals are on and a flagged action was denied, rejected, timed out, or could not be put to a human. Every other problem exits 0: a recorder must never break the agent.
- Fail-open for recording, config and policy bugs; fail-closed for a flagged action whose approval store is unreachable. A timeout is a denial, never an approval.
- The PreToolUse hook timeout in settings (`PRE_TOOL_TIMEOUT_SECONDS`) must exceed the longest allowed wait (`MAX_TIMEOUT_SECONDS`): if Claude Code killed the hook first it would treat that as a non-blocking error and the risky call would run unapproved.
- A decision counts only while the request is pending and unexpired (`decideApprovalRequest`); a late click must never flip or fake an outcome. An interrupted hook retires its own request.
- Everything is redacted and size-capped (`packages/core/src/redact.ts`) before it is written to `.ard/events.jsonl` or shown in the UI. The token patterns mirror `.claude/hooks/block-dangerous.mjs`; keep them in sync. Policy shell patterns (`policy.ts`) mirror that script too.
- The review UI can approve actions, so it stays locked down (`apps/web/middleware.ts`): 127.0.0.1 only, per-launch token cookie, Host and Origin checks, no framing. Do not add a route that skips the middleware, and do not redirect from it (Next rewrites 127.0.0.1 to localhost, which loses the cookie).
- Cloud billing: a webhook is tied to an organization **only** through the random nonce we put in the checkout (or ids stored from it), never an id read from the webhook body. Signatures are checked on the raw bytes; events are idempotent and order-safe.
- Cloud web: cookie-authenticated state changes go through `assertSameOrigin` (`Sec-Fetch-Site` leads; `Origin` alone breaks under `no-referrer`). Do not redirect from middleware. SSO users stay scoped to their org (`homeOrgId`), never merged with platform users. A session belongs to its first uploader; client-uploaded session reviews are dropped; the server redacts again.
- AI summary (`@ard/summary`, BYOK): the key comes only from `ANTHROPIC_API_KEY` in the environment of `ard review`, else the OS keychain (`ard key set`: macOS `security`, Linux `secret-tool`; the secret goes on stdin, never in argv, and only `[A-Za-z0-9_-]` is accepted so it cannot inject a command). Never in a file or project folder, logged, in a URL, or sent to the browser (errors are scrubbed); existence checks never read the secret. Nothing is sent without a preview + an explicit second click, and the POST must carry the SHA-256 of the previewed text. Recorded text is untrusted data (wrapped in `<session>`, closing tags escaped), the summary renders as plain text, pictures are never included. Newest-model request rules: no temperature/top_p/top_k, no `thinking: disabled`, `effort: low`. Verified only against a stand-in server, not the real API.
- Codex adapter (`packages/cli/src/codex.ts`): built from payloads captured on a real Codex 0.169.0 (fixtures under `src/fixtures/codex`). Facts: Bash `tool_response` is ONE string (no exit code, no stderr; a failing command looks empty), Codex has no failure event, file writes arrive as shell commands, no CLAUDE_PROJECT_DIR (project = payload cwd). Verified on 0.169.0: exit-2 and JSON-deny both stop a shell command, AND a hook that outlives its timeout is FAIL-OPEN (Codex runs the command). So on Codex the approval wait is capped at `CODEX_MAX_WAIT_SECONDS` (540) below the registered hook timeout `CODEX_PRE_TOOL_TIMEOUT_SECONDS` (600, Codex's documented default). Verified on 0.169.0 too: `apply_patch` arrives as tool_name `apply_patch` with the patch text in `tool_input.command` and a one-string response (fixtures `*-apply-patch.json`), and exit-2 blocks `apply_patch` and works inside `codex exec` (even when `permission_mode` is `bypassPermissions`). Unverified: the reason text shown to the model/user, and `Update`/`Delete` patches in a real payload (only an `Add File` was captured). `ard init --agent codex` edits only the project's `.codex/hooks.json` (never `~/.codex`), keeps the user's hooks, and Codex needs a `/hooks` trust review.
- PR gate (`packages/cli/src/pr.ts`): no GitHub Actions. `ard pr-status` / `ard pr-comment` use the user's own `gh`; sessions are picked by branch start AND overlap with the PR's files (sessions with no recorded file change are kept, unreadable file list keeps all: never drop a session that cannot be judged); everything that comes back from GitHub (sha, repo, base ref, PR number, comment id) is validated before it reaches a command or URL; JSON goes on stdin (`gh api --input -`); only the user's own comments are edited; the comment carries counts and decisions only, never code/output/paths. Tried end to end on a real PR (status as a required check, comment updated in place, status gone after a push).
- Screenshots: a picture cannot be redacted, so keeping pictures from hooks is opt-in (`screenshots: true`), they stay in `.ard/screenshots/<sha256>`, `ard sync` skips them and the cloud refuses them. Type comes from the first bytes (PNG/JPEG/GIF/WebP only, never SVG), the id is only ever 64 hex chars, base64 image data never goes into the text log. Hook capture is unverified: Claude Code does not document image data in PostToolUse.
- Cloud sign-in is bound to the starting browser (login cookie == `state`); no `form-action` in the CSP (Chrome enforces it on the redirect after a form post); fetches of customer-typed URLs connect to the address that was checked (`pinnedFetch`). A late event for a replaced subscription must not overwrite the current one; a webhook `conflict` is answered 409.
- `ard sync` uploads nothing without `--yes` on first use per org; tokens go only over https (localhost excepted).
- `ard run` adds `.ard/` to `.gitignore` (only in a git repo, only when the data folder is the default `.ard`, best effort, BEFORE the snapshot so it is never attributed to the agent).
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
- All files in this repo are written in English (code, comments, docs, UI strings). The one exception is an explicitly requested translation named `*.ko.md` under `docs/`; the English file stays the source of truth and must link to it.
