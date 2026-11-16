# Changelog

All notable changes are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project is in early development, so 0.x releases can change behaviour and file formats; the event log schema is versioned separately (`v: 1`).

## [Unreleased]

### Fixed

- Keeping pictures from hooks (`screenshots: true`) now works when Claude Code reads a picture file with its `Read` tool. In 0.1.0 the picture was not kept, because only two other result shapes were recognized; Claude Code actually sends `{ type: "image", file: { base64, … } }` (checked against a real Claude Code 2.1.325 payload). Nothing leaked before: image data was never written to the log. Pictures from browser tools are still unverified.

### Changed

- AI summary: the header of the text that is sent now says when recorded events are not listed (`Events: 6 recorded, 4 listed below …`), so the summary does not report that gap as missing data.

## [0.1.0] - 2026-11-16

First release. The free, local tier works end to end. Install from source (see the README); the package is not on npm yet.

### Added

- **Recording**
  - `ard init` registers Claude Code hooks in a project; `ard init --agent codex` registers Codex hooks (project `.codex/hooks.json` only; Codex asks you to trust them with `/hooks`).
  - `ard run -- <agent>` records any program and finds the files it changed through git. It adds `.ard/` to `.gitignore` first so recordings stay out of git.
  - Everything is redacted and size-capped before it is written to `.ard/events.jsonl` (the source of truth). SQLite (`.ard/data.db`) is an index of it.
  - Optional screenshots (`--screenshots`, `ard screenshot <file>`), kept locally, never synced, opt-in.
- **Review UI** (`ard review`, 127.0.0.1 only, per-launch token)
  - Sessions with a timeline of commands, outputs, file diffs and decisions; approve or reject a whole session with a note.
  - Multi-agent view: one row per agent (sessions, reviewed or not, blocked calls, commands, file changes), an agent filter, and links between an `ard run` session and the hook sessions of the same run.
  - Optional AI summary with your own Anthropic key (`ard key set` keeps it in the macOS Keychain or Linux `secret-tool`). Nothing is sent without a preview and a second click.
- **Approvals** (opt-in, `ard init --approvals`): a risky action makes the agent wait until you press Allow or Block. A timeout counts as a denial, never an approval.
- **Pull request gate without GitHub Actions**: `ard pr-status` (commit status `ard/review`) and `ard pr-comment` use your own `gh`. Sessions are picked by branch start and by overlap with the PR's changed files; sessions that recorded no file change are kept so nothing unjudged is dropped.
- A dev-time hook (`.claude/hooks`) that blocks dangerous commands while working on this repository.
- MIT license.

### Verified on real systems

- Codex 0.169.0: exit code 2 and a JSON deny both stop a shell command and an `apply_patch` call, also inside `codex exec`. A hook that outlives its timeout is **fail-open** in Codex, so the approval wait is capped at 540 s below the 600 s hook timeout.
- The pull request gate, end to end on a real pull request (status as a required check, comment updated in place, status cleared by a new push).
- Keychain storage of the API key on macOS.
- The AI summary against the real Anthropic API (`claude-opus-5-5`, one small demo session). Other models and long sessions were tried only against a stand-in server.

### Known limitations

- The policy is a safety net, not a sandbox; redaction is best effort; macOS and Linux only.
- Not yet tried at release time: picture data from Claude Code hooks (checked afterwards: it was not captured in this release, see *Unreleased*), what the Codex terminal UI shows *you* when a hook blocks a call (the model's side is known), and rename patches from a real Codex payload.
- Paid plans are still in planning; the related code in the repository is blocked and not part of this release.

[Unreleased]: https://github.com/Trapa-Eureka/agent-review-desk/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Trapa-Eureka/agent-review-desk/releases/tag/v0.1.0
