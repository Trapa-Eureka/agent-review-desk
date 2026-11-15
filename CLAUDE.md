# agent-review-desk

Records AI agent (Claude Code / Codex) execution events as JSONL, and lets a human review diffs and commands in a web UI and approve or reject them.
Free tier is local (SQLite, self-hosted); team collaboration and audit logs are cloud (paid). Product background: item #1 of the GitHub_Trending_Tech_Project_TOP100 PDF in the parent folder.

## Layout (pnpm workspace)
- `packages/schema` — JSONL event schema and shared types (`@ard/schema`)
- `packages/cli` — the `ard` CLI: init / hook / run (`@ard/cli`)
- `apps/web` — Next.js review dashboard (`@ard/web`)
- `.claude/hooks` — dev-time blocking hook for this repo (not product code)

## Commands
- `pnpm install` · `pnpm build` · `pnpm typecheck`
- `pnpm test:hooks` — unit tests for the blocking hook (always run after changing its rules)
- `pnpm dev:web` — dashboard dev server

## Design principles
- Event capture: **agent hooks (PreToolUse/PostToolUse) come first**; the process wrapper (`ard run`) is a fallback for agents without hooks.
- Approval is implemented as a hook block (exit 2): risky actions wait until approved in the web UI.
- The DB is SQLite behind a single repository layer, so it can be swapped for Postgres in the cloud tier.
- Payment happens on the web only. The CLI runs `ard login` and reads the plan. The free/paid boundary is drawn by server-side features.
- Never send a user's API key to our servers. If one is needed, use the OS keychain or environment variables (BYOK).

## Rules
- Never commit user data (`.ard/`, `*.db`, `*.jsonl`) or secrets (`.env`, keys, tokens). Check `.gitignore` first.
- Never write secret values into code, tests or logs. Assemble fake values at runtime in tests.
- JSONL test fixtures live only under `**/fixtures/**`.
- If a hook blocks an action, do not work around it; tell the user.
- Strict rules belong in hooks, procedures in skills — not in this file. Keep this file under 200 lines.
- All files in this repo are written in English (code, comments, docs, UI strings).
