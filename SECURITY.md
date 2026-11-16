# Security policy

Agent Review Desk records what AI coding agents do on your machine and can pause risky actions until you approve them. A flaw here can hide an agent's actions, approve something nobody approved, or leak what was recorded, so security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead:

1. Go to the **Security** tab of this repository.
2. Choose **Report a vulnerability**.
3. Describe what you found, how to reproduce it, and what an attacker gains.

Useful details: the `ard` version or commit, your OS and Node version, which agent (Claude Code or Codex) and its version, and the smallest steps that reproduce it. Please use fake data: do not send real recordings, API keys or tokens.

This is a small project maintained by one person. I will try to acknowledge a report within a week and to tell you what I plan to do about it, but I cannot promise a fixed timeline. There is no bug bounty.

## Supported versions

Only the latest release (and `main`) gets fixes. The project is in early development (0.x): behaviour and file formats can change between releases.

## What counts as a vulnerability

Things I want to hear about:

- **Approval bypass**: a flagged action that runs without a human decision (a timeout or an unreachable store treated as an approval, a late or forged click that flips a decision, a decision for a request that is not pending).
- **Review UI access**: reaching the local review UI or its API from another machine, another site (CSRF, DNS rebinding, framing), or without the per-launch token. Any route that skips the middleware.
- **Leaking recorded data**: a secret that survives redaction in `.ard/events.jsonl` or in the UI when the pattern is one the project claims to cover, a screenshot or recording written somewhere it should not be, or recorded data sent anywhere without the explicit action that is supposed to precede it (the optional AI summary needs a preview and a second click).
- **API key handling**: your Anthropic API key written to a file, logged, put in a URL, sent to the browser, or exposed through a process listing.
- **Command or argument injection** through recorded text, a GitHub response (`ard pr-status`, `ard pr-comment`), a hook payload, or a keychain value.
- **Recorder breaks the agent**: `ard hook` blocking (exit code 2) in a case other than a denied, timed-out or unreachable approval with approvals turned on.
- **Writing outside the project**: `ard init`, `ard run` or the hooks changing files other than the ones documented, or overwriting a settings file they could not parse.

## What is not a vulnerability

- **The policy is a safety net, not a sandbox.** It matches command text and file paths, so an encoded, wrapped or indirect command can slip past it. This is documented under *Known limitations*. A concrete bypass of a pattern the policy claims to catch is still a welcome ordinary issue, but it is not a security incident.
- Redaction is pattern-based and best effort; a secret in a format no pattern covers is a feature request (new pattern), not a vulnerability.
- Anything that needs the attacker to already control your account, your shell, or the project folder (they could just edit `.ard/` directly).
- Anyone with write access to a repository can post a commit status named `ard/review`; this is documented in *Gate a pull request without GitHub Actions*.
- Problems in the optional, unreleased and blocked team/cloud code, which does not run in a normal install. Reports about it are still read, but it is not a supported surface.
- Vulnerabilities in third-party dependencies with no way to reach them through this project (report those upstream).

## Safe harbour

If you test against your own machine and your own data, stay within the scope above, and give me a reasonable chance to fix the problem before you publish, I will not take action against you.

## Related

- How the review UI is locked down and what is recorded: see *Data and privacy* in the [README](README.md#data-and-privacy).
