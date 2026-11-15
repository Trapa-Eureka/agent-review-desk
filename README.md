# Agent Review Desk

A workspace that records what AI coding agents (Claude Code, Codex) do on your machine, so a human can review the diffs and commands and **approve or reject** them.

> **Status: early development (Phase 1 complete).**
> The recorder works: you can capture Claude Code sessions with hooks (`ard init`) or record any agent with the process wrapper (`ard run`). The review UI, approve/reject and the paid cloud tier are **planned, not yet implemented**. Everything marked _(planned)_ below describes the intended behavior.

## Overview

AI agents change files, run shell commands and drive browsers. The record of who approved what usually ends up scattered across terminal scrollback and chat logs.

Agent Review Desk keeps one reviewable trail:

1. A CLI records agent execution events as JSONL.
2. A web dashboard shows diffs, commands and screenshots.
3. You approve or reject each run, and the decision is stored with the record.

It is built for development teams and agencies that use AI agents and need an audit trail.

## Features

| Feature | Status |
|---|---|
| pnpm monorepo (`packages/schema`, `packages/cli`, `apps/web`) | Done |
| Dev-time hook that blocks dangerous actions (see [Safety hook](#safety-hook)) | Done |
| JSONL event schema with validation (`@ard/schema`) | Done |
| `ard init` — registers Claude Code hooks in your project | Done |
| `ard hook` — records session, tool-use, command and file-change events from Claude Code hooks | Done |
| `ard run -- <agent>` — process wrapper for any agent (e.g. Codex): records the session and the files it changed, via git | Done |
| Redaction of API keys/tokens and size caps on everything written to the log | Done |
| Review UI: session list, timeline, diff viewer, command log | Planned (Phase 2) |
| Approve / reject, including pre-approval of risky actions | Planned (Phase 2) |
| Default policy pack (block secret writes, destructive deletes) | Planned (Phase 2) |
| `ard login`, cloud sync, team workspace | Planned (Phase 3) |
| Role-based approval, policy engine, retention, SSO | Planned (Phase 3) |

### How it works

- **Capture** _(done)_: Claude Code hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionEnd`) are the primary source of events. The `ard run` wrapper is a fallback for agents that have no hooks.
- **Store** _(done for JSONL)_: events are appended to `.ard/events.jsonl` in your project, on **your own machine**. Nothing leaves your computer on the free tier. A local SQLite database for the review UI comes in Phase 2 _(planned)_.
- **Approve** _(planned)_: for risky actions the hook will block (exit code 2) until you approve in the web UI.
- **Your API keys stay yours**: the recorder wraps the agent CLI you already use and logged in to. It does not need your Anthropic/OpenAI API key. If a future feature needs one (for example AI summaries), it will be bring-your-own-key, stored in the OS keychain and never sent to our servers.

## Requirements

- Node.js **22.5 or newer** (developed on Node 24)
- [pnpm](https://pnpm.io) 10
- Git

## Installation

The package is not published to npm yet. Install from source:

```bash
git clone https://github.com/Trapa-Eureka/agent-review-desk.git
cd agent-review-desk
pnpm install
pnpm build
```

Until the CLI is published, run it from the build output. For convenience, add an alias (adjust the path):

```bash
alias ard='node /path/to/agent-review-desk/packages/cli/dist/index.js'
```

After the first release _(planned)_ you will be able to install the CLI with:

```bash
npm install -g agent-review-desk
```

## Running

### Record a Claude Code session (hooks)

```bash
cd your-project
ard init                 # registers the hooks and creates .ard/
# restart Claude Code (or open /hooks) so it picks up the new hooks
```

From now on every session, tool call, shell command and file edit Claude Code makes in that project is appended to `.ard/events.jsonl`.

- `ard init` writes to `.claude/settings.local.json` (personal, git-ignored, pins absolute paths to this node and CLI). Use `ard init --shared` to write the committed `.claude/settings.json` instead; that variant calls plain `ard` and needs it on your `PATH`.
- Do not register in both files: Claude Code runs hooks from every settings file, so events would be recorded twice. `ard init` warns you if that happens.
- `ard init` adds `.ard/` to `.gitignore`. It never overwrites a settings file it cannot parse, and it leaves your own hooks untouched.
- `ard init --remove` takes ard's hooks out again. Your recordings in `.ard/` are kept.

### Record any agent (wrapper)

```bash
ard run -- claude        # or: ard run -- codex
```

The wrapper runs the program with your terminal attached and records the session plus the files it changed, found by comparing the git working tree before and after. Exit codes and Ctrl-C behave as if you ran the program directly.

| | Hooks (`ard init`) | Wrapper (`ard run`) |
|---|---|---|
| Works with | Claude Code | any program |
| Sees commands and their output | Yes | No |
| Sees individual tool calls | Yes | No |
| Sees file edits | Yes (edited text) | Yes (git diff) |
| Sees changes to git-ignored files such as `.env` | Yes | **No** |
| Needs git | No | For file changes |

Both can be active at once; hook events are linked to the wrapper session through `wrapperSessionId`.

### Develop this repository

```bash
pnpm build               # build all packages
pnpm typecheck
pnpm test                # schema + CLI tests
pnpm test:hooks          # tests for the dev-time safety hook
pnpm dev:web             # dashboard placeholder at http://localhost:3000
ard --help
```

### Not yet available _(planned)_

```bash
ard login                # sign in to the cloud workspace (paid tier)
```

## Event log

`.ard/events.jsonl` holds one JSON object per line (schema version 1, defined in `packages/schema`). Event types: `session_start`, `session_end`, `tool_use` (before/after each tool call), `command`, `file_change`, `approval` (written by the review UI in Phase 2).

Before anything is written, it is **redacted and size-capped**: API keys, tokens, private keys, `KEY=value` style secrets and values under secret-looking names are replaced with `[REDACTED]`; long output and file text are cut with a marker. The folder is created owner-only (`0700`, file `0600`).

Redaction is pattern-based and best effort. Treat `.ard/` as sensitive anyway and never commit it.

## Known limitations

- Hook capture was written against the Claude Code hooks documentation (checked November 2026). Claude Code owns that format, so re-verify after major Claude Code updates.
- Claude Code reports no exit code for successful commands, so a recorded `exitCode: 0` means "the call succeeded". Failed commands carry the real exit code.
- The wrapper cannot see inside the agent, cannot see git-ignored files, and cannot attribute edits to a file that was already untracked before the run.
- `ard hook` never blocks anything yet (it always exits 0). Pre-approval comes with the review UI.
- macOS and Linux only; Windows is untested.

## Free vs. paid _(planned)_

The pricing below is an initial hypothesis and **may change before launch**.

| | Free (self-hosted) | Team (cloud) |
|---|---|---|
| Price | $0 | roughly **$19–99 per month per team** |
| CLI recorder and wrapper | Yes | Yes |
| Local JSONL + SQLite storage | Yes | Yes |
| Self-hosted review UI (single user) | Yes | Yes |
| Diff, command and screenshot review | Yes | Yes |
| Approve / reject | Yes | Yes |
| Default safety policies | Yes | Yes |
| Cloud sync and shared team workspace | No | Yes |
| Role-based approval | No | Yes |
| Audit log and retention periods | No | Yes |
| Policy engine, multi-agent view | No | Yes |
| SSO | No | Yes |

The free/paid boundary follows **server-side features**: everything that runs on your machine is free; everything that needs our servers (sync, sharing, retention, SSO) is paid.

## Payment _(planned)_

- **Billing model: monthly subscription** per team. An annual plan with a discount may be added later. It is **not** a one-time purchase, because the paid features need servers and storage that cost money every month.
- **Payment happens on the web, never inside the CLI.** `ard login` opens your browser, you sign in and pay there, and the CLI only stores a token and reads your plan (free or team).
- **Payment provider**: a merchant-of-record service such as Paddle (handles international sales tax) or Stripe. Not decided yet.
- **We never see or store your card details.** The provider handles them.
- Cancelling the subscription does not delete your local data. You keep using the free tier.

## Safety hook

This repository ships a Claude Code `PreToolUse` hook (`.claude/hooks/block-dangerous.mjs`, configured in `.claude/settings.json`). While you develop in this repo with Claude Code, it blocks:

- broad recursive deletes (`rm -rf ~`, `rm -rf /`, ...)
- git force pushes, `reset --hard`, `clean -fd`
- staging secret or data files (`.env`, `.ard/`, `*.db`, keys, `git add -f`)
- destructive SQL (`DROP`, `TRUNCATE`, `DELETE` without `WHERE`)
- `curl | sh`, `npm publish`, and similar actions
- writing API-key-shaped strings or private keys into files

It is a safety net, not a complete defense: it matches command text, so a wrapped or obfuscated command can slip through, and an innocent command that merely contains a dangerous-looking string can be blocked.

## Data and privacy

- Your recorded data (`.ard/`, `*.db`, `*.jsonl`) stays on your machine and is excluded by `.gitignore`.
- Do not commit recorded data: it can contain code, file paths and sometimes secrets.
- Secrets (`.env`, keys, tokens) are never committed. Use `.env.example` for placeholders.

## Project layout

```
agent-review-desk/
├── packages/
│   ├── schema/   # JSONL event schema and shared types (@ard/schema)
│   └── cli/      # the `ard` CLI (@ard/cli)
├── apps/
│   └── web/      # Next.js review dashboard (@ard/web)
├── .claude/
│   ├── settings.json
│   └── hooks/    # dev-time blocking hook and its tests
├── CLAUDE.md     # short guidance for AI agents working in this repo
└── pnpm-workspace.yaml
```

## Roadmap

- [x] **Phase 0** — monorepo, `CLAUDE.md`, safety hook
- [x] **Phase 1** — event schema, `ard init`, `ard hook`, `ard run`
- [ ] **Phase 2** — self-hosted review UI, approve/reject, default policies
- [ ] **Phase 3** — `ard login`, cloud sync, billing, roles, SSO
- [ ] **Phase 4** — optional: bring-your-own-key AI summaries, multi-agent view, GitHub Action

## Contributing

The project is at an early stage. Please open an issue to discuss a change before sending a pull request. All files in this repository are written in English.

## License

Not decided yet. Until a license file is added, all rights are reserved.
