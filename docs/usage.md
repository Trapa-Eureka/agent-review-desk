# Usage

Every command, explained. New here? Start with the [Quick start](../README.md#quick-start); [Installation](../README.md#installation) comes first.

한국어: [usage.ko.md](usage.ko.md)

**On this page:** [Hooks for Claude Code](#record-a-claude-code-session-hooks) · [Hooks for Codex](#record-a-codex-session-hooks) · [Any agent (wrapper)](#record-any-agent-wrapper) · [Review UI](#review-sessions-web-ui) · [AI summary](#ai-summary-bring-your-own-key) · [Pull request gate](#gate-a-pull-request-without-github-actions) · [Approvals](#approvals-pause-risky-actions-until-you-say-so)

## Record a Claude Code session (hooks)

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

## Record a Codex session (hooks)

```bash
cd your-project
ard init --agent codex   # writes this project's .codex/hooks.json and creates .ard/
# open Codex in the project and run /hooks: review and trust the new hooks
codex
```

Codex does not run a hook until you have reviewed it with `/hooks`, and asks again whenever the file changes, so `ard init` cannot switch it on by itself. `ard init --agent codex --remove` takes ard's hooks out again; your own hooks in that file are never touched.

What Codex's hooks give ard (checked against payloads captured from a real Codex 0.169.0 session):

- **Sessions, every shell command and its output**, and the other tool calls. ✔
- **No exit code.** Codex sends a command's output as one string and nothing else: a failing command looks like a quiet success. The review UI therefore shows no exit badge for Codex commands.
- **No file edits.** The Codex model wrote files with shell commands (`printf … > file`), which are just commands. When Codex edits through `apply_patch`, the hook turns the patch into a diff (checked against a real `apply_patch` call on Codex 0.169.0). For file changes, run `ard run -- codex` as well: hooks and wrapper link up automatically, and the wrapper finds the changed files through git.
- **Risky-command blocking** (`ard init --agent codex --approvals`): **verified on Codex 0.169.0 for shell commands.** A hook that exits with code 2, or answers with a JSON "deny", stopped the command from running, and an allowed command ran normally.
- **A timeout means "run it".** Also verified: if a hook is still waiting when its timeout passes, Codex stops waiting and **runs the command anyway**. So on Codex ard waits for your decision for at most **9 minutes** (whatever `timeoutSeconds` says; Claude Code keeps the configured value), and registers the hook with Codex's documented default timeout of 10 minutes, so ard always gives up and blocks first.
- Checked on Codex 0.169.0: a blocking hook (exit code 2) also stops `apply_patch` and works inside `codex exec`, including when Codex reports `permission_mode` as `bypassPermissions`.
- Checked on Codex 0.169.0: when a hook blocks a call, the model is told `Command blocked by PreToolUse hook: <the hook's message>. Command: <the command, or the whole patch>`. So ard's message reaches the model word for word, which is why it says not to retry. The same call blocked a shell command and an `apply_patch`, and the file was not created.
- Also checked: one `apply_patch` call that updates one file and deletes another is recorded as two file changes (paths made relative to the project; a deleted file has no content to show).
- Not verified: what the Codex terminal UI shows *you* when a call is blocked (only the model's side was observed, through `codex exec`), and patches that rename a file.

## Record any agent (wrapper)

```bash
ard run -- claude        # or: ard run -- codex
```

The wrapper runs the program with your terminal attached and records the session plus the files it changed, found by comparing the git working tree before and after. In a git repository it also adds `.ard/` to your `.gitignore` the first time (and says so), so a recording, which can hold code and secrets, never ends up in `git add .`. Exit codes and Ctrl-C behave as if you ran the program directly.

| | Hooks (`ard init`) | Wrapper (`ard run`) |
|---|---|---|
| Works with | Claude Code, Codex | any program |
| Sees commands and their output | Yes | No |
| Sees individual tool calls | Yes | No |
| Sees file edits | Yes (edited text) | Yes (git diff) |
| Sees changes to git-ignored files such as `.env` | Yes | **No** |
| Needs git | No | For file changes |

Both can be active at once; hook events are linked to the wrapper session through `wrapperSessionId`.

## Review sessions (web UI)

```bash
ard review               # from your project; needs `pnpm build` once in the agent-review-desk folder
```

It prints a private link like `http://127.0.0.1:4777/?token=…`. Open it in your browser. You get:

- **Agents**: one row per agent (Claude Code, Codex, anything run through `ard run`) with its sessions, how many are not reviewed / approved / rejected, blocked calls, commands and file changes. Click an agent to show only its sessions (`/?agent=codex`); *All agents* clears the filter.
- **Sessions**: newest first, with agent, folder, number of commands and file changes, and badges (`waiting`, `blocked`, `approved`/`rejected`, `active`). A run recorded twice, from outside by `ard run` and from inside by the agent's hooks, is marked on both sessions and linked from each one's page (*Same run, other recorder*); review each, they stay separate.
- **A session's timeline**: what the agent did in order. Commands with output and exit code, file changes as a colored diff, failed tool calls, and every approval decision.
- **Your review**: *Approve session* / *Reject session* with an optional note. You can change your mind; the newest decision is shown and all of them stay in the log.
- **Waiting for your decision**: pending approval requests at the top (see below). The page refreshes by itself.
- **AI summary** _(optional, your own key)_: a one-paragraph summary of a long session. See [AI summary](#ai-summary-bring-your-own-key).

`--port <number>` picks another port (default 4777).

## AI summary (bring your own key)

A long session is hard to read. **Summarize with AI…** on a session page asks Claude for a short summary: what the agent did, which files changed, which commands failed, and what is worth checking first.

```bash
ard key set                         # once: paste your own key (it is not shown); saved in your system keychain
ard review                          # then just open a session and press "Summarize with AI…"
```

Prefer not to save it? Set `ANTHROPIC_API_KEY=...` for that terminal instead; if both exist, the environment variable wins. `ard key status` shows where a key would come from (never the key itself) and `ard key remove` deletes the saved one. You can also pipe it in: `pbpaste | ard key set`.

- **Nothing is sent until you press Send.** The first click only shows a preview: exactly which text would be sent, where (`api.anthropic.com`), with which model, and how big it is. A second, explicit click sends *that* text; if the session changed in between, you are asked to preview again.
- **It goes from your computer to Anthropic with your key, and is billed to your account.** The key lives in your operating system's keychain (macOS Keychain; on Linux the desktop keyring through `secret-tool`) or in `ANTHROPIC_API_KEY`. It is never written to a file, never in a project folder, never logged or put in a URL, never sent to the browser, and never sent to us (we have no server in this path). It is read from the keychain only at the moment a summary is sent. On Windows there is no keychain support yet: use `ANTHROPIC_API_KEY`.
- **What is in the text:** commands with exit codes and a short piece of their output, changed files with the changed lines (long diffs are cut), approval decisions, and failures. Secrets are redacted again first, but redaction is best effort: read the preview if the session touched anything sensitive. **Pictures are never sent.** Very long sessions are shortened (the start and the end are kept) and the preview says so.
- **The default model is `claude-opus-5-5`.** `ARD_SUMMARY_MODEL=claude-haiku-5-5` is much cheaper (about 1/40 of the price per token); `claude-sonnet-5-5` is in between. Other values are ignored.
- **Treat it as a hint, not a verdict.** A summary can be wrong or miss things. The recorded text is handled as untrusted data (an agent's output can contain text that looks like instructions to the summarizer), the summary is shown as plain text, and it never recommends approving: the timeline stays the record.
- Tried once against the real Anthropic API (`claude-opus-5-5`, one small demo session, summary returned as expected, about 540 tokens in and 430 out). Other models and long sessions were tested only against a local stand-in server.

## Gate a pull request without GitHub Actions

Make "the agent sessions behind this branch were reviewed and approved" visible on the pull request, and optionally required before merging, using only your own machine and the [GitHub CLI](https://cli.github.com) (`gh auth login` once). Nothing runs on GitHub's servers, so there is nothing to bill.

```bash
ard review                       # approve (or reject) the sessions behind the branch, as usual
ard pr-status --dry-run          # shows which sessions it found and what it would post; posts nothing
ard pr-status                    # posts the commit status "ard/review" on the PR's latest commit
ard pr-comment                   # posts (or updates) a PR comment listing the sessions and decisions
```

- **The status** is `success` when every session was approved, `failure` if one was rejected, `pending` while some are not reviewed yet (and `success` when no agent session was recorded for the branch).
- **To block merging until you have reviewed:** in the repository settings, under the branch protection rule (or ruleset) for your main branch, turn on *Require status checks to pass* and add `ard/review`. With a ruleset, leave the source on *any source*. GitHub accepts commit statuses as required checks, not only Actions checks.
- **Post it again after every push.** A status belongs to one commit, so a new commit has none, and the merge button stays blocked until you run `ard pr-status` again. That is the safe direction.
- **Which sessions belong to the PR?** Without `--session`: those that started since the branch left its base branch **and** changed at least one of the PR's files, plus any session that recorded no file change at all (a read-only session, or an agent whose hooks cannot see edits, like Codex), because a session that cannot be judged must not be dropped silently. Sessions that changed only other files are printed as *left out*, and `--include-unrelated` counts them anyway. If GitHub's file list cannot be read, every session since the branch started is used. It is still a guess (the list is printed: check it); name sessions with `--session <id>` (repeatable) to skip the guessing. Sessions are listed by `ard review`.
- **The comment contains counts and review decisions only**: never code, command output, file names or paths (it only says how many sessions were left out), because a pull request can be public. It updates its own earlier comment instead of adding a new one, and it only ever edits your own comments.
- `--pr <number>` targets another pull request. `--context <name>` renames the status (letters, digits, `. _ / -`).

Limits, honestly: anyone with write access can post a status named `ard/review` too, so this stops an *accidental* merge without review, not a determined one (the same people can merge anyway). The review happens on the author's machine; GitHub only records who posted the status. It has been tried end to end on a real pull request (status posted with the normal `gh` login, required as a check, comment updated in place, status gone after a new push). Start with `--dry-run` on yours.

## Approvals: pause risky actions until you say so

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
