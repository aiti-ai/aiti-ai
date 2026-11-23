# pi-secret-mask

> **Paste-safe by default.** — 随手贴，不泄密。

Session-level secret redaction for [pi](https://github.com/earendil-works/pi-coding-agent): values you paste into prompts (API keys, tokens, credentials) are replaced with opaque, credential-shaped tokens like `rsec_a1b2c3d4` **before anything is sent to the model**, and tokens the model echoes back inside tool arguments are restored to the real values **before the tool executes**.

A pi package. Zero runtime dependencies (detection/redaction engine shared with the encrypted-persistence edition via `@aiti-ai/secret-mask-core`). One install covers the TUI and every pi-web session (each pi-web pi session is a `pi --mode rpc` subprocess that loads your global packages).

中文文档：[README.zh-CN.md](README.zh-CN.md)

```
you:  my api key is sk-ant-api03-<80 chars> — put it into .env under ANTHROPIC_KEY
model sees:      my api key is rsec_a1b2c3d4 — put it into .env ...
write tool:      ANTHROPIC_KEY=sk-ant-api03-<80 chars>   ← restored at execution time
session file:    plain landing: original text · ephemeral landing: rsec_a1b2c3d4
```

Why `rsec_<hash8>` instead of `[REDACTED:name]`: safety-trained models read `[REDACTED:*]` as "blocked, you cannot access this" and refuse to put it into tool arguments. A token that looks like a working credential is used naturally — and the runtime still never sends the real value to the model.

> Need values to survive restarts, shared across sessions, encrypted at rest, and queryable by the model without leaking? Use the persistent edition: **`@aiti-ai/pi-secret-vault`** (`/vault add`, `vault_list` / `vault_get`). The two packages share the same engine and are mutually exclusive in one session (the vault wins; mask self-disables).

## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev).

- **aiti Web workbench** (self-hosted, browser-first, this plugin ships pre-installed): npm package **`@aiti-ai/pi-web`** — <https://github.com/aiti-ai/aiti-ai> · site <https://aiti.pw>
- Ecosystem monorepo (docs site, extensions, integrations): <https://github.com/aiti-ai/aiti-ai>

**Works standalone**: any pi (coding agent) user can `pi install npm:@aiti-ai/pi-secret-mask` and get every capability on its own — no dependency on any other aiti component.

## Install

```bash
pi install npm:@aiti-ai/pi-secret-mask@latest     # or a local path during development
```

or add the path to `~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:@aiti-ai/pi-secret-mask@latest"] }
```

Takes effect in **newly started sessions**. Running sessions are unaffected.

## Commands

| Command | Effect |
|---|---|
| `/secret add [<value>] [as <alias> \| --alias <alias>]` | Register a value (masked interactive input when the value is omitted). Alias makes the placeholder readable in `/secret list`. |
| `/secret list` | Placeholder → alias/rule mapping with masked previews (`…****abcd`). |
| `/secret remove <alias\|label\|placeholder>` | Unregister one value (old placeholder references keep working for the rest of the session). |
| `/secret clear` | Unregister all. |
| `/secret on` / `off` | Toggle redaction for this session. |
| `/secret landing [plain\|ephemeral]` | Where real values may live on disk (see below). |
| `/secret guard [on\|off]` | Block tool calls that reference placeholders not mounted in this session (default ON). |
| `/secret strict [on\|off]` | Fail closed on side channels (`!` commands, summarizer paths) instead of warn-and-pass. |
| `/secret rule list \| add <label> <exact\|regex> <pattern> [--fixed <text>] [--global] \| remove <label> \| reload` | Custom detection rules (`~/.pi/agent/secret-mask-rules.json`, hot reloaded). |
| `/secret extract on\|off` | Structured extraction from tool output / write inputs (default ON). |
| `/secret files learn\|block\|off` | Sensitive-file policy (default `learn`): register & redact values, withhold dedicated secret files, or block reads. |
| `/secret weak notify\|auto\|off` | Weak-password candidates after `password is` / `密码是` (dictionary hits register; others notify or auto-register). |
| `/secret learn [last\|<file>]` | Register values from the latest tool output or a local file (after-the-fact recovery). |
| `/secret save <file>` / `load <file>` | Explicit plaintext snapshot to/from a file you choose (0600). No implicit persistence, no remembered paths — placement and safety are yours. |
| `/secret audit on\|off` / `show` | Per-send wire-payload proof log (see below). |
| `/secret status` | State summary: landing, guard, strict, rule count, registry size, audit state. |

## Landing policy (where real values live)

| Mode | Session file | Recovery after restart | Notes |
|---|---|---|---|
| `plain` (default) | original text | grep the session, or `/secret load <file>`, or re-paste | current behaviour; the local transcript already contained the value because you typed it |
| `ephemeral` | redacted (`rsec_*` tokens) | **impossible by design** — values exist only in this process | `message_end` rewrites the persisted copy |
| `vault` | redacted | `/vault unlock` + `vault_get <alias>` remounts a **stable** token | only in `@aiti-ai/pi-secret-vault` |

Session mode only affects a session; new sessions start at the default.

## How it works

| Stage | Hook | Behaviour |
|---|---|---|
| Input boundary | `input` | In vault/ephemeral landing: detect the value in **your own prompt** and rewrite it to a token *before* the message is persisted (message_end alone would run after the raw prompt is already stored). Plain landing passes through untouched. |
| Send boundary | `context` | Redacts all roles (user, assistant text/thinking, tool results, `!` bash command/output, compaction summaries). Auto-detection (high-confidence rules) registers new secrets from **user-authored text only**. The hook gets a deep copy: the session transcript keeps the original unless landing is vault/ephemeral. |
| System prompt | `context_with_system` | Redacts values that ride the **system segment** (AGENTS.md, project instructions) — a blind spot of the `context` hook, which only sees the conversation. |
| Agreement | `before_agent_start` | Injects a `secret_masking` section: the token IS a working credential, copy it verbatim, never refuse, never ask for the raw value. It also pre-empts the self-doubt loop — tokens legitimately show up in the model's own history and in file contents (display, not damage), so it must not apologize, re-read or "clean" them; a guard block only means the value is not mounted here. |
| Guard | `tool_call` | Placeholders that are not mounted (old session, `/vault forget`, rotation) are **blocked** with an actionable message instead of running a command with a literal token. Mounted ones are then restored in place (any tool, any argument). |
| Tool output | `tool_result` | Redacts registered values from tool output before it re-enters the context and the session record (`cat .env` does not re-leak). |
| On-disk copy | `message_end` | In vault/ephemeral landing: returns a redacted replacement message (role preserved) so the session JSONL stores only tokens. |
| Summaries | `session_before_compact` / `session_before_tree` | Deep-redacts the summarizer's input (`messagesToSummarize`, `turnPrefixMessages`, `previousSummary`, tree entries). |
| `!` commands | `user_bash` | Warns when the command contains a registered value (it would be persisted verbatim); `strict` blocks the command instead. |
| Proof layer | `before_provider_request` | Rewrites any raw value that survived every other hook (safety net, on by default, zero cost when nothing is registered) and, with `/secret audit on`, scans the **final wire payload** for raw values + placeholder counts. `leaks=0` + `placeholders>0` is direct evidence that only tokens went out. |

Opaque provider fields (thinking signatures, thought signatures, text signatures) are never modified.

## Weak values: values that do not look like credentials

A human password such as `123abc`, `qwerty` or `password=abcdefgh` is not shaped like a machine
credential, so entropy/length rules miss it. Three context signals close that gap:

1. **Structured extraction (default ON)** — every tool result and every `write`/`edit` input is
   scanned for key/value pairs whose *key* is credential-like (`DB_PASSWORD=…`,
   `"password": "…"`, `api_key: …`, `Authorization: …`, URL userinfo, netrc). Values are
   registered **without an entropy gate** (≥6 chars) and redacted immediately; keys stay readable
   so the model can still use the structure.
2. **Sensitive-file policy (default `learn`)** — `.env*`, `id_rsa`, `.pgpass`, `.netrc`,
   `.npmrc`, `.git-credentials`, `credentials.json`, `secret.txt`, `*.key/p12/pfx`, kube/aws
   credential paths: structured values are redacted; a dedicated unstructured secret file is
   registered as a whole and **withheld** from the model (placeholder notice). `block` refuses
   the read before execution; `off` disables the path policy.
3. **Weak-password candidates** — after a strong context (`password is`, `PWD=`, `密码是`, `密码改成`), a
   small embedded dictionary (`qwerty`, `123abc`, `1qaz2wsx`, …) registers automatically; other
   weak-shaped values only raise a one-time notice (`/secret weak auto` to register them).

`/secret learn [last|<file>]` is the after-the-fact net: register values from the latest tool
output or a local file; the next `context` call then replaces them in the model history too.

Honest limit: a context-free low-entropy value with no key name, no file name and no dictionary
hit cannot be detected reliably; the complete fix is to keep such files away from the model
(`/secret files block` or the vault). Values shorter than 6 characters are not registered.

## Detection rules

Deterministic regex + checksum rules, no network, no model calls: AWS, GitHub, GitLab, Slack (tokens + webhooks), Stripe live, SendGrid, Twilio, Google API/OAuth, Anthropic, OpenAI, Hugging Face, npm, PyPI, Azure storage, JWT (alg-header validated), PEM private keys (complete + truncated), DB URLs with real passwords, `Authorization` header values, generic `key = "value"` / `key = value` assignments guarded by Shannon-entropy thresholds and code-identifier/template/URL exclusion. Base64-wrapped prefix tokens are decoded and caught whole. Values shorter than 6 characters are ignored (noise guard).

**Assignment verbs** (chat hand-over, no operator): `密码改成 X` / `密码设为 X` / `密码重置为 X` / `新密码 X` / `set the password to X` / `new password X`, plus a bare `设为 X` / `改成 X` / `set it to X` whose credential keyword sits in the same passage (160 chars back, so a keyword from the previous sentence still counts). The bare form needs ASCII letters **and** digits, ≥8 chars, entropy ≥2.8 and a non-file-name tail; config prose (`端口改成 8080`, `分支改成 feature/login2`, `文件名改成 report2024.md`, `主题设置为 dark2night`) stays untouched.

**CJK keywords**: the generic-assignment keyword table includes `密码 / 密钥 / 秘钥 / 口令 / 令牌 / 授权码 / 授权密钥 / 访问令牌 / 访问密钥 / 凭证 / 凭据 / 私钥`; assignment separators accept the fullwidth colon (`密码：xxx`, `授权码：xxx`, `Authorization：Bearer xxx`); latin–CJK adjacency (`API密钥`, `db密码`) and pure-CJK prefixes (`数据库密码`) both count as word boundaries. The bare-value entropy floor is **2.5 bits/char**. Fullwidth CJK punctuation terminates a bare value (`密码：xxx，请记好` does not swallow the trailing prose).

**Custom rules** (`~/.pi/agent/secret-mask-rules.json`):

```jsonc
{
  "version": 1,
  "rules": [
    { "label": "corp-token", "type": "regex", "match": "acme_[A-Za-z0-9]{32}" },
    { "label": "ticket", "type": "exact", "match": "TICKET-1234", "mode": "fixed", "fixed": "<ticket>" }
  ],
  "projects": {
    "/home/me/repo": [{ "label": "local-key", "type": "exact", "match": "..." }]
  }
}
```

`mode: "placeholder"` (default) registers the match like a normal secret (redacted outbound + restored in tool arguments); `mode: "fixed"` is a one-way replacement. Invalid rules are skipped and reported in `/secret rule list`. The file is re-read when its mtime/size changes (no timers, no polling).

## Testing & verification

- **Unit tests** — `npm test` (22 cases) plus the shared engine suite (`@aiti-ai/secret-mask-core`, 62 cases): engine + adapters + wiring; a mock pi host drives every hook (input, send-boundary redaction, guard/restore, message_end, compaction/tree, `!` gate, provider rewrite, audit log, handshake).
- **False-positive corpus** — `npm run fp-corpus`: the same 11 pinned public repositories used by claude-code-redact (~42k text files). Baseline after the v2 placeholder pass: **65 hits, all real-shaped — 0 false positives** (the prose `token is configured.` and `${VAR:default}` template-default shapes were removed as false positives).
- **End-to-end smoke** — in a fresh session, ask the model what a written file contains: a real value in its answer means redaction failed.
- **Wire-payload audit** — `/secret audit on` appends one line per send to `~/.pi/agent/secret-mask-audit.log` (0600, labels only, never values).

## What it does not do (known limits)

- **Unannotated bare values without keyword context are not auto-detected.** Use `/secret add` for those. Deliberate: bare high-entropy detection would fire on minified JS.
- **Pure-CJK bare phrases** under the 2.5 bits/char floor are not auto-detected; quote them or `/secret add`.
- **Transformed values escape** (`${T:0:10}` slices, re-encoded base64) — except the multi-part forms handled by `redactForms` (PEM bodies split by line numbers, JSON key files).
- **Images are not scanned.**
- **Streaming tool output**: pi only feeds the finalized tool result back to the model; `tool_execution_update` partials are UI-only, so no stream scrub is needed (verified against pi 1.5).
- **Plain landing keeps the session file readable by local processes.** Use `ephemeral`/`vault` landing when that matters; and remember a prompt-injected agent that restores a value into a network command can still exfiltrate it — this tool prevents *accidental* disclosure, not a hostile agent.

## Coexistence

Safe alongside `keyshroud` and other `tool_result`/`context`-rewriting extensions (hook chains compose, replacement sets are disjoint). Alongside **`@aiti-ai/pi-secret-vault`** the same-session handshake makes mask yield automatically (the vault is the superset); install both only if you want per-project choice.

## Credits & third-party notices

Rule shapes and methodology reference two MIT projects — [claude-code-redact](https://github.com/karanb192/claude-code-redact) (Karan Bansal) and [keyshroud](https://github.com/dinhkarate/keyshroud) (Daniel / EONSR) — plus the public [gitleaks](https://github.com/gitleaks/gitleaks) token corpus. Independent implementation; full attributions and license texts in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Product/vendor names in rule labels are nominative references to credential formats only; no affiliation or endorsement.

## Development

```bash
npm test            # node --test (engine + pi adapters + hook wiring)
npm run fp-corpus   # false-positive corpus over pinned public repos (~20s warm)
```

License: MIT.
