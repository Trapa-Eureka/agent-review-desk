# Agent Review Desk

A workspace that records what AI coding agents (Claude Code, Codex) do on your machine, so a human can review the diffs and commands and **approve or reject** them.

> **Status: early development (Phase 0 complete).**
> The repository skeleton, the safety hook and the build pipeline are done. The recorder, the review UI and the paid cloud tier are **planned, not yet implemented**. Everything marked _(planned)_ below describes the intended behavior.

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
| JSONL event schema | Planned (Phase 1) |
| `ard init` — registers agent hooks in your project | Planned (Phase 1) |
| `ard hook` — records tool-use events from Claude Code hooks | Planned (Phase 1) |
| `ard run -- <agent>` — wrapper for agents without hooks (e.g. Codex) | Planned (Phase 1) |
| Review UI: session list, timeline, diff viewer, command log | Planned (Phase 2) |
| Approve / reject, including pre-approval of risky actions | Planned (Phase 2) |
| Default policy pack (block secret writes, destructive deletes) | Planned (Phase 2) |
| `ard login`, cloud sync, team workspace | Planned (Phase 3) |
| Role-based approval, policy engine, retention, SSO | Planned (Phase 3) |

### How it will work _(planned)_

- **Capture**: agent hooks (`PreToolUse` / `PostToolUse`) are the primary source of events. The `ard run` wrapper is a fallback for agents that have no hooks.
- **Approve**: for risky actions the hook blocks (exit code 2) until you approve in the web UI.
- **Store**: events go to a local SQLite database on **your own machine**. Nothing leaves your computer on the free tier.
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

After the first release _(planned)_ you will be able to install the CLI with:

```bash
npm install -g agent-review-desk
```

## Running

### What works today

```bash
# Build everything and type-check
pnpm build
pnpm typecheck

# Run the unit tests for the safety hook
pnpm test:hooks

# Start the dashboard (currently a placeholder page) at http://localhost:3000
pnpm dev:web

# Run the CLI (currently only prints help)
node packages/cli/dist/index.js --help
```

### Intended usage _(planned)_

```bash
ard init                 # register hooks in the current project
ard run -- claude        # or: ard run -- codex   (wrapper mode)
ard login                # sign in to the cloud workspace (paid tier)
```

Events are written to `.ard/events.jsonl` and the local database to `.ard/data.db` inside your project. These are git-ignored by default.

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
- [ ] **Phase 1** — event schema, `ard init`, `ard hook`, `ard run`
- [ ] **Phase 2** — self-hosted review UI, approve/reject, default policies
- [ ] **Phase 3** — `ard login`, cloud sync, billing, roles, SSO
- [ ] **Phase 4** — optional: bring-your-own-key AI summaries, multi-agent view, GitHub Action

## Contributing

The project is at an early stage. Please open an issue to discuss a change before sending a pull request. All files in this repository are written in English.

## License

Not decided yet. Until a license file is added, all rights are reserved.
