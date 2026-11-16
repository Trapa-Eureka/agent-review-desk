# 사용법

모든 명령을 하나씩 설명합니다. 처음이라면 [빠른 시작](../README.md#quick-start)부터 보세요. [설치](../README.md#installation)가 먼저입니다.

> 이 문서는 [영어 원문](usage.md)의 한국어 번역입니다. 내용이 다르면 영어 원문이 기준입니다. 화면의 버튼과 문구(예: *Approve session*, *Summarize with AI…*)와 규칙 id는 영어로 표시되므로 번역하지 않고 그대로 적었습니다.

**이 페이지의 내용:** [Claude Code 훅](#claude-code-세션-기록하기-훅) · [Codex 훅](#codex-세션-기록하기-훅) · [아무 에이전트나 (래퍼)](#아무-에이전트나-기록하기-래퍼) · [검토 UI](#세션-검토하기-웹-ui) · [AI 요약](#ai-요약-내-키-사용) · [풀 리퀘스트 게이트](#github-actions-없이-풀-리퀘스트-게이트-걸기) · [승인](#승인-위험한-동작은-허락할-때까지-멈추기)

## Claude Code 세션 기록하기 (훅)

```bash
cd your-project
ard init                 # registers the hooks and creates .ard/
# restart Claude Code (or open /hooks) so it picks up the new hooks
```

이때부터 Claude Code가 그 프로젝트에서 하는 모든 세션, 도구 호출, 셸 명령, 파일 수정이 `.ard/events.jsonl`에 이어서 기록됩니다.

- `ard init`은 `.claude/settings.local.json`에 씁니다(개인용이고 git에서 제외되며, 이 node와 CLI의 절대 경로를 고정합니다). 커밋하는 `.claude/settings.json`에 쓰려면 `ard init --shared`를 쓰세요. 이 방식은 그냥 `ard`를 호출하므로 `PATH`에 `ard`가 있어야 합니다.
- 두 파일에 모두 등록하지 마세요. Claude Code는 모든 설정 파일의 훅을 실행하므로 이벤트가 두 번 기록됩니다. 그런 경우 `ard init`이 경고합니다.
- `ard init`은 `.ard/`를 `.gitignore`에 추가합니다. 읽을 수 없는 설정 파일은 절대 덮어쓰지 않고, 사용자가 직접 넣은 훅도 건드리지 않습니다.
- `ard init --remove`는 ard의 훅을 다시 제거합니다. `.ard/`의 기록은 남습니다.

## Codex 세션 기록하기 (훅)

```bash
cd your-project
ard init --agent codex   # writes this project's .codex/hooks.json and creates .ard/
# open Codex in the project and run /hooks: review and trust the new hooks
codex
```

Codex는 `/hooks`로 검토하기 전에는 훅을 실행하지 않고, 파일이 바뀔 때마다 다시 묻습니다. 그래서 `ard init`이 스스로 훅을 켤 수는 없습니다. `ard init --agent codex --remove`는 ard의 훅을 다시 제거하며, 그 파일에 있는 사용자의 훅은 건드리지 않습니다.

Codex의 훅이 ard에 주는 것(실제 Codex 0.169.0 세션에서 캡처한 데이터로 확인):

- **세션, 모든 셸 명령과 그 출력**, 그리고 그 밖의 도구 호출. ✔
- **종료 코드는 없습니다.** Codex는 명령의 출력을 하나의 문자열로만 보내고 다른 정보는 없습니다. 실패한 명령도 조용히 성공한 것처럼 보입니다. 그래서 검토 UI는 Codex 명령에 종료 코드 배지를 보여 주지 않습니다.
- **파일 수정은 보이지 않습니다.** Codex 모델은 셸 명령(`printf … > file`)으로 파일을 썼고, 이는 그저 명령입니다. Codex가 `apply_patch`로 수정하면 훅이 그 패치를 diff로 바꿉니다(Codex 0.169.0의 실제 `apply_patch` 호출로 확인). 파일 변경이 필요하면 `ard run -- codex`도 함께 쓰세요. 훅과 래퍼는 자동으로 연결되고, 래퍼는 git으로 바뀐 파일을 찾습니다.
- **위험한 명령 차단** (`ard init --agent codex --approvals`): **셸 명령에 대해 Codex 0.169.0에서 확인했습니다.** 종료 코드 2로 끝나거나 JSON "deny"로 답하는 훅은 명령 실행을 막았고, 허용된 명령은 정상 실행됐습니다.
- **시간 초과는 "실행"을 뜻합니다.** 이것도 확인했습니다. 훅이 제한 시간이 지나도록 기다리고 있으면 Codex는 기다림을 멈추고 **그 명령을 그대로 실행합니다.** 그래서 Codex에서는 ard가 당신의 결정을 최대 **9분**만 기다립니다(`timeoutSeconds`가 얼마든 상관없이. Claude Code는 설정한 값을 그대로 씁니다). 그리고 훅은 Codex의 문서상 기본 제한 시간인 10분으로 등록하므로, 항상 ard가 먼저 포기하고 차단합니다.
- Codex 0.169.0에서 확인: 차단하는 훅(종료 코드 2)은 `apply_patch`도 막고 `codex exec` 안에서도 동작합니다. Codex가 `permission_mode`를 `bypassPermissions`로 보고할 때도 마찬가지입니다.
- 확인하지 못한 것: Codex가 차단 사유를 당신과 모델에게 어떤 문구로 보여 주는지.

## 아무 에이전트나 기록하기 (래퍼)

```bash
ard run -- claude        # or: ard run -- codex
```

래퍼는 당신의 터미널을 연결한 채 프로그램을 실행하고, 세션과 그 프로그램이 바꾼 파일을 기록합니다. 바뀐 파일은 실행 전후의 git 작업 트리를 비교해 찾습니다. git 저장소에서는 처음 한 번 `.ard/`를 `.gitignore`에 추가하고(그렇게 했다고 알려 줍니다), 코드와 비밀이 들어 있을 수 있는 기록이 `git add .`에 딸려 들어가지 않게 합니다. 종료 코드와 Ctrl-C는 프로그램을 직접 실행한 것과 똑같이 동작합니다.

| | 훅 (`ard init`) | 래퍼 (`ard run`) |
|---|---|---|
| 지원 대상 | Claude Code, Codex | 모든 프로그램 |
| 명령과 그 출력을 봄 | 예 | 아니요 |
| 개별 도구 호출을 봄 | 예 | 아니요 |
| 파일 수정을 봄 | 예 (수정한 텍스트) | 예 (git diff) |
| `.env` 같은 git 제외 파일의 변경을 봄 | 예 | **아니요** |
| git이 필요함 | 아니요 | 파일 변경에는 필요 |

둘을 동시에 켤 수 있습니다. 훅 이벤트는 `wrapperSessionId`로 래퍼 세션과 연결됩니다.

## 세션 검토하기 (웹 UI)

```bash
ard review               # from your project; needs `pnpm build` once in the agent-review-desk folder
```

`http://127.0.0.1:4777/?token=…` 같은 비공개 링크를 출력합니다. 브라우저로 여세요. 다음을 볼 수 있습니다.

- **Agents**: 에이전트(Claude Code, Codex, `ard run`으로 실행한 모든 것)마다 한 줄씩. 세션 수, 검토 전 / 승인 / 거절된 수, 차단된 호출, 명령, 파일 변경이 나옵니다. 에이전트를 누르면 그 에이전트의 세션만 보이고(`/?agent=codex`), *All agents*를 누르면 필터가 풀립니다.
- **Sessions**: 최신순이며 에이전트, 폴더, 명령 수와 파일 변경 수, 배지(`waiting`, `blocked`, `approved`/`rejected`, `active`)가 붙습니다. 같은 실행이 두 번 기록된 경우, 즉 바깥에서 `ard run`이, 안에서 에이전트의 훅이 기록한 경우에는 두 세션 모두에 표시되고 각 세션 페이지에서 서로 연결됩니다(*Same run, other recorder*). 둘은 별개이므로 각각 검토하세요.
- **세션의 타임라인**: 에이전트가 한 일을 순서대로. 출력과 종료 코드가 있는 명령, 색이 입혀진 diff로 보이는 파일 변경, 실패한 도구 호출, 모든 승인 결정.
- **Your review**: 선택 메모와 함께 *Approve session* / *Reject session*. 마음을 바꿀 수 있고, 가장 최근 결정이 표시되며 모든 결정은 로그에 남습니다.
- **Waiting for your decision**: 승인 대기 요청이 맨 위에 나옵니다(아래 참고). 페이지는 저절로 새로 고쳐집니다.
- **AI 요약** _(선택, 내 키 사용)_: 긴 세션을 한 문단으로 요약합니다. [AI 요약](#ai-요약-내-키-사용)을 보세요.

`--port <number>`로 다른 포트를 고를 수 있습니다(기본값 4777).

## AI 요약 (내 키 사용)

긴 세션은 읽기 어렵습니다. 세션 페이지의 **Summarize with AI…**는 Claude에게 짧은 요약을 요청합니다. 에이전트가 무엇을 했는지, 어떤 파일이 바뀌었는지, 어떤 명령이 실패했는지, 먼저 확인할 만한 것이 무엇인지를 알려 줍니다.

```bash
ard key set                         # once: paste your own key (it is not shown); saved in your system keychain
ard review                          # then just open a session and press "Summarize with AI…"
```

키를 저장하고 싶지 않다면 그 터미널에서만 `ANTHROPIC_API_KEY=...`를 설정하세요. 둘 다 있으면 환경 변수가 우선합니다. `ard key status`는 키가 어디에서 올지 알려 주고(키 자체는 절대 보여 주지 않습니다), `ard key remove`는 저장된 키를 지웁니다. 파이프로 넣을 수도 있습니다: `pbpaste | ard key set`.

- **보내기를 누르기 전에는 아무것도 전송되지 않습니다.** 첫 클릭은 미리보기만 보여 줍니다. 정확히 어떤 텍스트가, 어디로(`api.anthropic.com`), 어떤 모델로, 얼마나 큰지 보여 줍니다. 두 번째, 명시적인 클릭이 *그 텍스트*를 보냅니다. 그 사이에 세션이 바뀌었다면 다시 미리보기를 하라고 안내합니다.
- **내 컴퓨터에서 내 키로 Anthropic에 직접 가며, 요금은 내 계정에 청구됩니다.** 키는 운영체제의 키체인(macOS는 Keychain, Linux는 `secret-tool`을 통한 데스크톱 키링) 또는 `ANTHROPIC_API_KEY`에 있습니다. 파일에 쓰이지 않고, 프로젝트 폴더에 들어가지 않고, 기록이나 URL에 남지 않고, 브라우저로 보내지지 않고, 우리에게도 전송되지 않습니다(이 경로에는 우리 서버가 없습니다). 키체인에서는 요약을 보내는 순간에만 읽습니다. Windows는 아직 키체인을 지원하지 않으니 `ANTHROPIC_API_KEY`를 쓰세요.
- **텍스트에 들어가는 것:** 종료 코드와 출력 일부가 있는 명령, 바뀐 줄이 있는 변경 파일(긴 diff는 잘림), 승인 결정, 실패. 비밀은 먼저 한 번 더 가려지지만 이 가림은 최선 노력일 뿐이니, 세션이 민감한 것을 건드렸다면 미리보기를 읽어 보세요. **그림은 절대 보내지 않습니다.** 아주 긴 세션은 줄이며(처음과 끝은 남김) 미리보기가 그렇게 알려 줍니다.
- **기본 모델은 `claude-opus-5-5`입니다.** `ARD_SUMMARY_MODEL=claude-haiku-5-5`는 훨씬 저렴하고(토큰당 가격이 약 1/40), `claude-sonnet-5-5`는 그 중간입니다. 다른 값은 무시됩니다.
- **힌트로 보세요, 판결이 아닙니다.** 요약은 틀리거나 놓치는 것이 있을 수 있습니다. 기록된 텍스트는 신뢰할 수 없는 데이터로 다루고(에이전트의 출력에는 요약기에게 하는 지시처럼 보이는 글이 들어 있을 수 있습니다), 요약은 일반 텍스트로 보여 주며, 승인하라고 권하는 일은 절대 없습니다. 기록은 타임라인입니다.
- 실제 Anthropic API로 한 번 시험했습니다(`claude-opus-5-5`, 작은 데모 세션 하나, 요약이 기대대로 돌아옴, 입력 약 540토큰·출력 약 430토큰). 다른 모델과 긴 세션은 로컬의 대역(stand-in) 서버로만 시험했습니다.

## GitHub Actions 없이 풀 리퀘스트 게이트 걸기

"이 브랜치 뒤의 에이전트 세션을 검토하고 승인했다"는 사실을 풀 리퀘스트에 보이게 하고, 원하면 병합 전에 필수로 만듭니다. 당신의 컴퓨터와 [GitHub CLI](https://cli.github.com)(`gh auth login`을 한 번)만 씁니다. GitHub 서버에서는 아무것도 실행되지 않으므로 청구될 것이 없습니다.

```bash
ard review                       # approve (or reject) the sessions behind the branch, as usual
ard pr-status --dry-run          # shows which sessions it found and what it would post; posts nothing
ard pr-status                    # posts the commit status "ard/review" on the PR's latest commit
ard pr-comment                   # posts (or updates) a PR comment listing the sessions and decisions
```

- **상태(status)** 는 모든 세션이 승인되면 `success`, 하나라도 거절되면 `failure`, 아직 검토 전인 것이 있으면 `pending`입니다(그 브랜치에 기록된 에이전트 세션이 없으면 `success`).
- **검토하기 전에는 병합을 막으려면:** 저장소 설정에서 메인 브랜치의 브랜치 보호 규칙(또는 룰셋)의 *Require status checks to pass*를 켜고 `ard/review`를 추가하세요. 룰셋에서는 출처를 *any source*로 두세요. GitHub는 Actions 체크뿐 아니라 커밋 상태도 필수 체크로 받아들입니다.
- **푸시할 때마다 다시 올리세요.** 상태는 커밋 하나에 속하므로 새 커밋에는 상태가 없고, `ard pr-status`를 다시 실행하기 전까지 병합 버튼은 막혀 있습니다. 이쪽이 안전한 방향입니다.
- **어떤 세션이 PR에 속하나요?** `--session`이 없으면: 브랜치가 기준 브랜치에서 갈라진 뒤에 시작했고 **그리고** PR의 파일을 하나 이상 바꾼 세션, 그리고 파일 변경을 전혀 기록하지 않은 세션(읽기만 한 세션, 또는 Codex처럼 훅이 수정을 볼 수 없는 에이전트)입니다. 판단할 수 없는 세션을 조용히 빼면 안 되기 때문입니다. 다른 파일만 바꾼 세션은 *left out*으로 출력되며, `--include-unrelated`를 쓰면 그래도 포함합니다. GitHub의 파일 목록을 읽을 수 없으면 브랜치가 시작된 뒤의 모든 세션을 씁니다. 이는 여전히 추측이므로(목록이 출력되니 확인하세요) 추측을 건너뛰려면 `--session <id>`(여러 번 가능)로 세션을 직접 지정하세요. 세션은 `ard review`에 나열됩니다.
- **댓글에는 개수와 검토 결정만 들어갑니다.** 코드, 명령 출력, 파일 이름, 경로는 절대 넣지 않습니다(제외된 세션이 몇 개인지만 말합니다). 풀 리퀘스트는 공개일 수 있기 때문입니다. 새 댓글을 달지 않고 자기가 단 이전 댓글을 갱신하며, 당신 자신의 댓글만 수정합니다.
- `--pr <number>`는 다른 풀 리퀘스트를 대상으로 합니다. `--context <name>`은 상태 이름을 바꿉니다(글자, 숫자, `. _ / -`).

한계를 솔직히 말하면: 쓰기 권한이 있는 사람은 누구나 `ard/review`라는 이름의 상태를 올릴 수 있으므로, 이 방법이 막는 것은 검토 없는 *실수로 인한* 병합이지 작정하고 하는 병합이 아닙니다(그 사람들은 어차피 병합할 수 있습니다). 검토는 작성자의 컴퓨터에서 이뤄지고, GitHub는 누가 상태를 올렸는지만 기록합니다. 실제 풀 리퀘스트에서 처음부터 끝까지 시험했습니다(평소 `gh` 로그인으로 상태를 올림, 필수 체크로 지정, 댓글이 제자리에서 갱신됨, 새 푸시 뒤 상태가 사라짐). 먼저 당신의 PR에 `--dry-run`으로 시작하세요.

## 승인: 위험한 동작은 허락할 때까지 멈추기

기본값은 꺼짐입니다. 프로젝트마다 켭니다.

```bash
ard init --approvals     # writes { "approvals": true } to ard.config.json (commit it to share with your team)
ard review               # keep this running to see and answer requests
```

이때부터 에이전트가 정책이 위험하다고 표시한 일을 하려 하면 에이전트가 **멈추고**, 정확한 명령이나 파일과 어떤 규칙이 표시했는지가 담긴 요청이 검토 UI에 나타납니다. **Allow**는 실행을 허용합니다(그 뒤에도 Claude Code 자체의 권한 확인은 그대로 적용됩니다). **Block**은 실행을 막고 에이전트에게 당신의 메모를 전달해서 아무 생각 없이 다시 시도하지 않게 합니다.

아무것도 하지 않으면: `timeoutSeconds`(기본 300초)가 지난 뒤 그 동작은 **차단**되고 시간 초과로 기록됩니다. 승인은 절대 가정하지 않습니다.

| 규칙 id | 표시하는 것 | 기본값 |
|---|---|---|
| `rm-recursive-broad` | `/`, `~`, `$HOME`, `..`, `*` 또는 시스템 폴더에 대한 `rm -rf` | approve |
| `git-force-push` | `git push --force`, `-f`, `--force-with-lease`, `+refspec` | approve |
| `git-discard-work` | `git reset --hard`, `git clean -f`, `git checkout .`, `git restore .` | approve |
| `git-stage-secrets` | `git add -f`, 또는 `.env`, `.ard`, 데이터베이스, 키 파일 추가 | approve |
| `destructive-sql` | `DROP`, `TRUNCATE`, `WHERE` 없는 `DELETE` | approve |
| `pipe-to-shell` | `curl … \| sh` | approve |
| `system-wide-change` | `/`에 대한 `chmod -R` / `chown -R`, `dd of=/dev/…`, `mkfs` | approve |
| `package-publish` | `npm`/`pnpm`/`yarn publish` | approve |
| `secret-in-command` | 명령 안에 들어 있는 API 키, 토큰, 개인 키 | approve |
| `write-secret-file` | `.env`, `.pem`, `.key`, SSH 키 파일 쓰기 | approve |
| `write-secret-content` | 쓰고 있는 파일 안의 비밀처럼 보이는 텍스트 | approve |
| `write-outside-project` | 프로젝트 폴더 밖에 쓰기(임시 폴더는 예외) | approve |
| `delete-ard-data` | `.ard/`, 데이터베이스, `events.jsonl` 삭제 또는 덮어쓰기 | **deny** |
| `write-protected-path` | 파일 도구로 `.git/` 또는 `.ard/` 수정 | **deny** |

`approve` = 당신의 결정이 필요함, `deny` = 요청 없이 항상 차단. `ard.config.json`에서 조정합니다.

```json
{
  "approvals": true,
  "timeoutSeconds": 120,
  "rules": { "git-force-push": "deny", "package-publish": "allow" }
}
```

각 규칙은 `allow`(끔), `approve`, `deny`로 설정할 수 있습니다. 망가진 설정 파일이 에이전트를 멈추게 하는 일은 없습니다. ard는 승인을 **끈** 기본값으로 돌아가고 그 이유를 출력합니다.

ard 자체에서 문제가 생기면 경우마다 안전한 쪽으로 실패합니다. *기록*에 문제가 있어도 에이전트를 막지 않지만, 정책이 위험하다고 표시한 호출은 ard가 승인 저장소에 닿지 못하면 **차단**됩니다.
