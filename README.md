# Agent Review Desk

A workspace that records what AI coding agents (Claude Code, Codex) do on your machine, so a human can review the diffs and commands and **approve or reject** them.

> **Status: early development (Phase 3 complete, not yet run live).**
> The free, local tier works end to end: record Claude Code sessions (`ard init`) or any agent (`ard run`), review them in a local web UI (`ard review`), approve or reject whole sessions, and have risky actions wait for your approval before they run.
> The paid **Team** tier is built and tested too: `ard login`, `ard sync` to a team workspace, roles, single sign-on, and monthly billing through **Paddle** and **Dodo Payments**. What has not been done is a *live* payment or a *live* sign-in with real provider accounts: see [Running Agent Review Desk Cloud](docs/cloud-selfhosting.md#7-first-live-test-what-to-check-yourself). Everything marked _(planned)_ below describes the intended behavior.

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
| pnpm monorepo (`packages/schema`, `packages/core`, `packages/cli`, `apps/web`) | Done |
| Dev-time hook that blocks dangerous actions (see [Safety hook](#safety-hook)) | Done |
| JSONL event schema with validation (`@ard/schema`) | Done |
| `ard init` — registers Claude Code hooks in your project | Done |
| `ard hook` — records session, tool-use, command and file-change events from Claude Code hooks | Done |
| `ard run -- <agent>` — process wrapper for any agent (e.g. Codex): records the session and the files it changed, via git | Done |
| Redaction of API keys/tokens and size caps on everything written to the log | Done |
| Local SQLite index of the recordings (built-in `node:sqlite`, nothing to compile) | Done |
| `ard review` — local web UI: session list, timeline, diff viewer, command log | Done |
| Approve / reject a whole session after the fact | Done |
| **Pre-approval**: risky actions pause the agent until you approve them in the UI | Done (opt-in) |
| Default policy pack (14 rules) with per-rule overrides in `ard.config.json` | Done |
| Screenshots of browser actions in the review UI | Planned |
| `ard login` / `logout` / `whoami`: sign in to a cloud workspace with a short code confirmed in the browser | Done |
| `ard sync`: upload recorded sessions to a team workspace (explicit consent first, resumable, server redacts again) | Done |
| Team workspace (`apps/cloud`): organizations, shared sessions, timeline and diff, team review | Done |
| Roles: owner / admin / reviewer / member, invitations, audit log | Done |
| Single sign-on per organization (OpenID Connect; SAML not supported) | Done |
| Monthly subscriptions through **Paddle** and **Dodo Payments** (signed webhooks, access follows the subscription) | Done, not yet run live |
| Retention periods, per-seat pricing, centrally managed team policies, Postgres for multi-server hosting | Planned |

### How it works

- **Capture** _(done)_: Claude Code hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionEnd`) are the primary source of events. The `ard run` wrapper is a fallback for agents that have no hooks.
- **Store**: events are appended to `.ard/events.jsonl` in your project, on **your own machine**. That file is the source of truth. The review UI imports it into a local SQLite database (`.ard/data.db`), which is just an index plus the pending approval requests. Nothing leaves your computer on the free tier.
- **Approve**: with approvals on, a risky action makes the hook wait (the agent is paused) until you press Allow or Block in the review UI. See [Approvals](#approvals-pause-risky-actions-until-you-say-so).
- **Your API keys stay yours**: the recorder wraps the agent CLI you already use and logged in to. It does not need your Anthropic/OpenAI API key. If a future feature needs one (for example AI summaries), it will be bring-your-own-key, stored in the OS keychain and never sent to our servers.

## Requirements

- Node.js **22.13 or newer** (developed on Node 24). The built-in SQLite module needs it.
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

### Review sessions (web UI)

```bash
ard review               # from your project; needs `pnpm build` once in the agent-review-desk folder
```

It prints a private link like `http://127.0.0.1:4777/?token=…`. Open it in your browser. You get:

- **Sessions**: newest first, with agent, folder, number of commands and file changes, and badges (`waiting`, `blocked`, `approved`/`rejected`, `active`).
- **A session's timeline**: what the agent did in order. Commands with output and exit code, file changes as a colored diff, failed tool calls, and every approval decision.
- **Your review**: *Approve session* / *Reject session* with an optional note. You can change your mind; the newest decision is shown and all of them stay in the log.
- **Waiting for your decision**: pending approval requests at the top (see below). The page refreshes by itself.

`--port <number>` picks another port (default 4777).

### Approvals: pause risky actions until you say so

Off by default. Turn it on per project:

```bash
ard init --approvals     # writes { "approvals": true } to ard.config.json (commit it to share with your team)
ard review               # keep this running to see and answer requests
```

From then on, when the agent tries something the policy flags, the agent **pauses** and a request appears in the review UI showing the exact command or file, and which rule flagged it. **Allow** lets it run (Claude Code's own permission prompts still apply afterwards). **Block** stops it and tells the agent your note, so it does not retry blindly.

What happens when you do nothing: after `timeoutSeconds` (default 300) the action is **blocked** and recorded as a timeout. Approval is never assumed.

| Rule id | Flags | Default |
|---|---|---|
| `rm-recursive-broad` | `rm -rf` of `/`, `~`, `$HOME`, `..`, `*` or a system folder | approve |
| `git-force-push` | `git push --force`, `-f`, `--force-with-lease`, `+refspec` | approve |
| `git-discard-work` | `git reset --hard`, `git clean -f`, `git checkout .`, `git restore .` | approve |
| `git-stage-secrets` | `git add -f`, or adding `.env`, `.ard`, database, key files | approve |
| `destructive-sql` | `DROP`, `TRUNCATE`, `DELETE` without `WHERE` | approve |
| `pipe-to-shell` | `curl … \| sh` | approve |
| `system-wide-change` | `chmod -R` / `chown -R` on `/`, `dd of=/dev/…`, `mkfs` | approve |
| `package-publish` | `npm`/`pnpm`/`yarn publish` | approve |
| `secret-in-command` | an API key, token or private key inside a command | approve |
| `write-secret-file` | writing `.env`, `.pem`, `.key`, SSH key files | approve |
| `write-secret-content` | secret-looking text inside a file being written | approve |
| `write-outside-project` | writing outside the project folder (temp folders exempt) | approve |
| `delete-ard-data` | deleting or overwriting `.ard/`, the database, `events.jsonl` | **deny** |
| `write-protected-path` | editing `.git/` or `.ard/` with a file tool | **deny** |

`approve` = needs your decision; `deny` = always blocked, no request. Tune it in `ard.config.json`:

```json
{
  "approvals": true,
  "timeoutSeconds": 120,
  "rules": { "git-force-push": "deny", "package-publish": "allow" }
}
```

Each rule can be set to `allow` (off), `approve` or `deny`. A broken config file never stops the agent: ard falls back to defaults with approvals **off** and prints why.

If something goes wrong in ard itself, it fails in the safe direction for each case: problems with *recording* never block the agent, but a call the policy flagged as risky is **blocked** if ard cannot reach its approval store.

### Develop this repository

```bash
pnpm build               # build all packages (the review UI needs this once)
pnpm typecheck
pnpm test                # schema, core and CLI tests
pnpm test:hooks          # tests for the dev-time safety hook
ard --help
```

The review UI is an ordinary Next.js app in `apps/web`; run it through `ard review` so it gets its project folder and access token.

### Team workspace (the paid Team tier)

Run your own cloud server (see [docs/cloud-selfhosting.md](docs/cloud-selfhosting.md)), then from any project:

```bash
export ARD_CLOUD_URL=https://cloud.example.com   # or pass --server on each command
ard login                # prints a link and a short code; you confirm it in the browser
ard whoami               # who you are, your organizations and their plan
ard sync --dry-run       # see exactly what would be uploaded (nothing is sent)
ard sync --org acme --yes   # upload recorded sessions; --yes is only needed the first time per organization
ard logout               # revokes this machine's token on the server and forgets it
```

- **Nothing is uploaded without your say-so.** The recorded log holds command output and file diffs, so the first `ard sync` to an organization refuses to run until you pass `--yes`; `--dry-run` shows the summary first. Everything was already redacted when recorded, and the server redacts again.
- **Resumable.** Progress is saved after each batch; an interrupted sync repeats nothing and loses nothing. Uploading the same event twice is harmless.
- **The token** is stored in `~/.config/ard/credentials.json` (owner-only; move it with `ARD_CONFIG_DIR`). It is only ever sent over https (plain http only for `localhost`). `ard logout` revokes it on the server.
- **Free vs Team:** `ard login` works on any plan, but `ard sync` is refused (with a message that says why) for an organization without an active subscription. Everything you recorded stays on your machine either way.
- **In the browser**, owners create the organization, invite people, pay, and configure single sign-on; reviewers approve or reject synced sessions with their e-mail on the record.

| Role | Read sessions | Sync | Review | Members & audit log | Billing & SSO |
|---|---|---|---|---|---|
| member | yes | yes | no | no | no |
| reviewer | yes | yes | **yes** | no | no |
| admin | yes | yes | yes | **yes** | no |
| owner | yes | yes | yes | yes | **yes** |

## Event log

`.ard/events.jsonl` holds one JSON object per line (schema version 1, defined in `packages/schema`). Event types: `session_start`, `session_end`, `tool_use` (before/after each tool call), `command`, `file_change`, and `approval` (a decision: written by the review UI for your clicks, and by the hook for policy denials and timeouts).

Before anything is written, it is **redacted and size-capped**: API keys, tokens, private keys, `KEY=value` style secrets and values under secret-looking names are replaced with `[REDACTED]`; long output and file text are cut with a marker. The folder is created owner-only (`0700`, file `0600`).

Redaction is pattern-based and best effort. Treat `.ard/` as sensitive anyway and never commit it.

## Known limitations

- Hook capture was written against the Claude Code hooks documentation (checked November 2026). Claude Code owns that format, so re-verify after major Claude Code updates.
- Claude Code reports no exit code for successful commands, so a recorded `exitCode: 0` means "the call succeeded". Failed commands carry the real exit code.
- The wrapper cannot see inside the agent, cannot see git-ignored files, and cannot attribute edits to a file that was already untracked before the run.
- The policy is a safety net, not a sandbox. It matches command text and file paths, so a wrapped, encoded or indirect command (`bash -c "$(…)"`, a script that does the deleting) can slip past it, and a harmless command that merely contains a dangerous-looking string can be flagged. It only gates what Claude Code's hooks see; the `ard run` wrapper cannot block anything.
- While a request waits, the agent is stuck. If you enable approvals, keep `ard review` open (or lower `timeoutSeconds`).
- The review UI shows what was recorded, which is redacted on a best-effort basis. It runs on your machine only (see [Data and privacy](#data-and-privacy)).
- Screenshots of browser actions are not captured yet.
- macOS and Linux only; Windows is untested. Node's built-in SQLite is still marked experimental by Node; ard hides its startup warning.
- **Cloud:** SQLite and a single server instance (no Postgres yet), no SAML, no outgoing e-mail (invitation links are copied by hand), one flat plan per organization (no per-seat pricing), no automatic data retention or deletion yet. Pre-approval of risky actions stays local: the cloud workspace reviews *finished* sessions, it does not gate a running agent. See [docs/cloud-selfhosting.md](docs/cloud-selfhosting.md#9-known-limits).
- **Cloud, not yet verified live:** a real purchase with Paddle or Dodo Payments, and a sign-in with a real identity provider. The code paths are tested, including end to end with signed webhooks and real OIDC redirects against a local provider.

## Free vs. paid

The price is whatever you set in your payment provider's dashboard. The planning hypothesis is roughly **$19–99 per month per team** and **may change before launch**; the code only needs the price id.

| | Free (local) | Team (cloud) |
|---|---|---|
| Price | $0 | monthly subscription per organization |
| CLI recorder and wrapper | Yes | Yes |
| Local JSONL + SQLite storage | Yes | Yes |
| Local review UI (single user) | Yes | Yes |
| Diff and command review | Yes | Yes |
| Approve / reject (local) | Yes | Yes |
| Pre-approval of risky actions, default policy pack, per-rule overrides | Yes | Yes |
| Cloud sync and shared team workspace | No | Yes |
| Roles (owner / admin / reviewer / member) and team review | No | Yes |
| Invitations and audit log | No | Yes |
| Single sign-on (OpenID Connect) | No | Yes |
| Retention periods, centrally managed team policies, multi-agent view | No | Planned |

The free/paid boundary follows **server-side features**: everything that runs on your machine is free; everything that needs a server (sync, sharing, roles, SSO) is paid. When a subscription lapses, uploads and reviews stop but **everything already synced stays readable**.

## Payment

- **Billing model: monthly subscription** per organization. It is **not** a one-time purchase, because the paid features need servers and storage that cost money every month.
- **Two providers are built in: Paddle and Dodo Payments.** Both are merchants of record (they handle international sales tax and invoicing). Configure one or both; owners choose on the Billing page. Both default to their sandbox / test mode; going live is a deliberate switch.
- **Payment happens on the web, never inside the CLI.** The CLI only stores a token and reads the plan.
- **We never see or store card details.** The provider's hosted checkout does.
- **How a payment becomes access:** the server starts the checkout with a one-time value; the provider's signed webhook brings it back; only that value ties the payment to an organization. Webhooks are verified against the exact bytes received, are idempotent, and tolerate out-of-order delivery. A failed payment keeps access for 7 days; a cancelled subscription keeps it until the paid period ends.
- Cancelling the subscription never deletes your local data, and nothing already synced is withdrawn.
- **Tested** against each provider's documented webhook format (including cross-checks with Paddle's and Standard Webhooks' own libraries) and in an end-to-end run with signed webhooks. **Not yet done:** a live purchase with your accounts. The checklist is in [docs/cloud-selfhosting.md](docs/cloud-selfhosting.md#7-first-live-test-what-to-check-yourself).

Whether you need to register as a business, charge VAT or report income depends on where you live and how much you sell; the payment providers do not decide that for you. Ask a tax adviser.

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
- `ard.config.json` holds only policy settings. It is meant to be committed.

### The review UI is locked down

It can approve actions an agent is waiting on and it shows your code, so a web page you merely visit must not be able to use it:

- It listens on `127.0.0.1` only, never on the network.
- Every `ard review` run creates a **new random token**. The printed link carries it once; the UI turns it into an `HttpOnly`, `SameSite=Strict` cookie and removes it from the address bar. Without it every page and API call is refused.
- Requests whose `Host` is not `127.0.0.1` / `localhost` are refused (blocks DNS-rebinding), and state-changing requests must come from the UI's own origin (blocks cross-site requests).
- It cannot be embedded in another page (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`), so nobody can trick a click on **Allow**.
- A decision only counts while a request is still pending. A late click on an expired request is refused, so it can never look like an approval the agent did not get.

Anyone who can run commands as your user can read `.ard/` directly anyway; this protects against *websites and other network peers*, not against local malware.

## Project layout

```
agent-review-desk/
├── packages/
│   ├── schema/   # JSONL event schema and validation (@ard/schema)
│   ├── core/     # SQLite repository, policy engine, approvals, config, redaction (@ard/core)
│   ├── cli/      # the `ard` CLI: init, hook, run, review, login, logout, whoami, sync (@ard/cli)
│   ├── billing/  # Paddle and Dodo Payments: checkout, portal, signed webhooks, entitlement (@ard/billing)
│   ├── cloud/    # accounts, organizations, roles, SSO, synced workspaces, billing service (@ard/cloud)
│   └── ui/       # review components shared by the local and cloud UIs (@ard/ui)
├── apps/
│   ├── web/      # local Next.js review UI (@ard/web), started by `ard review`
│   └── cloud/    # team workspace server (@ard/cloud-web), see docs/cloud-selfhosting.md
├── docs/         # self-hosting guide for the cloud server
├── .claude/
│   ├── settings.json
│   └── hooks/    # dev-time blocking hook and its tests
├── CLAUDE.md     # short guidance for AI agents working in this repo
└── pnpm-workspace.yaml
```

## Roadmap

- [x] **Phase 0** — monorepo, `CLAUDE.md`, safety hook
- [x] **Phase 1** — event schema, `ard init`, `ard hook`, `ard run`
- [x] **Phase 2** — SQLite storage layer, review UI, approve/reject, pre-approval of risky actions
- [x] **Phase 3** — `ard login`, cloud sync, billing (Paddle + Dodo Payments), roles, SSO. Built and tested; first live purchase / sign-in still to do
- [ ] **Phase 4** — optional: bring-your-own-key AI summaries, multi-agent view, GitHub Action

## Contributing

The project is at an early stage. Please open an issue to discuss a change before sending a pull request. All files in this repository are written in English.

## License

Not decided yet. Until a license file is added, all rights are reserved.
