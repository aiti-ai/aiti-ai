# pi-secret-mask

> **Paste-safe by default.** — 随手贴，不泄密。

Session-level secret redaction for [pi](https://github.com/earendil-works/pi-coding-agent): values you paste into prompts (API keys, tokens, credentials) are replaced with stable placeholders like `[REDACTED:github-token]` **before anything is sent to the model**, and placeholders the model echoes back inside tool arguments are restored to the real values **before the tool executes**.

A pi package. Zero runtime dependencies. One install covers the TUI and every pi-web session (each pi-web pi session is a `pi --mode rpc` subprocess that loads your global packages).

中文文档：[README.zh-CN.md](README.zh-CN.md)

```
you:  my api key is sk-ant-api03-<80 chars> — put it into .env under ANTHROPIC_KEY
model sees:   my api key is [REDACTED:ANTHROPIC_KEY#a1b2c3d4] — put it into .env ...
write tool:   ANTHROPIC_KEY=sk-ant-api03-<80 chars>   ← restored at execution time
session file: the original text (the context hook is non-destructive)
```


## About aiti

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev).

- **aiti Web workbench** (self-hosted, browser-first, this plugin ships pre-installed): npm package **`@aiti-ai/pi-web`** — <https://github.com/aiti-ai/pi-web> · site <https://aiti.pw>
- Ecosystem monorepo (docs site, extensions, integrations): <https://github.com/aiti-ai/aiti-ai>

**Works standalone**: any pi (coding agent) user can `pi install npm:@aiti-ai/pi-secret-mask` and get every capability on its own — no dependency on any other aiti component.

**Also works with aiti Web**: sessions started from the web workbench get this plugin automatically (bundled first-party plugin, auto-provisioned on startup).

## Install

```bash
pi install npm:@aiti-ai/pi-secret-mask@latest     # or a local path during development
```

or add the path to `~/.pi/agent/settings.json`:

```json
{ "packages": ["npm:@aiti-ai/pi-secret-mask@latest"] }
```

Takes effect in **newly started sessions** (each new TUI/pi-web session spawns a fresh pi process). Running sessions are unaffected.

## Commands

| Command | Effect |
|---|---|
| `/secret add <value> [as <alias>]` | Register a value (interactive input when omitted). Alias makes the placeholder readable. |
| `/secret list` | Registered values with masked previews (`…****abcd`), source and rule id. |
| `/secret remove <alias\|label>` | Unregister one value. |
| `/secret clear` | Unregister all. |
| `/secret on` / `off` | Toggle redaction for this session. |
| `/secret status` | State summary (incl. audit state and last audit result). |
| `/secret save` / `unload` | Persist values for the current project to `~/.pi/agent/secret-mask.json` (0600, opt-in) / drop them. |
| `/secret audit on\|off` | Per-send wire-payload proof log (see [Verification](#testing--verification)). |
| `/secret audit show` | Show the latest audit evidence lines. |

## How it works

| Stage | Hook | Behaviour |
|---|---|---|
| Send boundary | `context` | Redacts all roles (user, assistant text, tool results, `!` bash command/output, compaction summaries). Auto-detection (high-confidence rules) registers new secrets from **user-authored text only**. The hook gets a deep copy: the session transcript keeps the original. |
| Agreement | `before_agent_start` | Injects a `secret_masking` prompt section: placeholders are opaque, copy them verbatim into tool arguments, never guess the value. |
| Return boundary | `tool_call` | Restores placeholders inside tool arguments **in place** (pi reads the fields off the event object). Bash is included by design — the primary use case is "use this key in a command". Turn redaction `off` if that is too permissive for your threat model. |
| Tool output | `tool_result` | Redacts registered values from tool output before it re-enters the context and the session record (so `cat .env` does not re-leak into the transcript). |
| Proof layer | `before_provider_request` | With `/secret audit on`: scans the **final wire payload** (provider-serialized, right before HTTP) for registered raw values and placeholder occurrences. `leaks=0` + `placeholders>0` per send is direct evidence that only placeholders went out; any raw value raises an immediate alarm. Independent of the redaction pass — it sees whatever earlier hooks produced. |

## Detection rules

Deterministic regex + checksum rules, no network, no model calls: AWS, GitHub, GitLab, Slack (tokens + webhooks), Stripe live, SendGrid, Twilio, Google API/OAuth, Anthropic, OpenAI, Hugging Face, npm, PyPI, Azure storage, JWT (alg-header validated), PEM private keys (complete + truncated), DB URLs with real passwords, `Authorization` header values, generic `key = "value"` / `key = value` assignments guarded by Shannon-entropy thresholds and code-identifier/template/URL exclusion. Base64-wrapped prefix tokens are decoded and caught whole. Values shorter than 6 characters are ignored (noise guard).

**CJK keywords** (v0.1.x): the generic-assignment keyword table includes `密码 / 密钥 / 秘钥 / 口令 / 令牌 / 授权码 / 授权密钥 / 访问令牌 / 访问密钥 / 凭证 / 凭据 / 私钥`; assignment separators accept the fullwidth colon (`密码：xxx`, `授权码：xxx`, `Authorization：Bearer xxx`); latin–CJK adjacency (`API密钥`, `db密码`) and pure-CJK prefixes (`数据库密码`) both count as word boundaries. The bare-value entropy floor is **2.5 bits/char** (lowered from cc-redact's 3.0, which was tuned for file scanning: in the chat scene it only ever rejected human-chosen passwords, which commonly sit at 2.5–3.0, while CJK prose straddles the old gate anyway; measured on 212k local repo files the lower gate only adds keyword+colon prose / minified-code shapes, no real credentials). Fullwidth CJK punctuation terminates a bare value (`密码：xxx，请记好` does not swallow the trailing prose). Quoted forms and `/secret add` remain the reliable path for ultra-low-entropy values.

False positives are guarded three ways: `plausibleSecret` exclusion set (template slots, `${VAR}`, paths, URLs, `process.env.*`, filler like `example`/`changeme`), entropy floors (≥2.0 quoted / ≥2.5 bare bits-per-char), and code-identifier/member-chain exclusion (`Uint8Array`, `jose.base64url.decode` are not values). Rule shapes follow the public gitleaks/GitHub secret-scanning corpus as implemented by the MIT-licensed `claude-code-redact` project; the fp-corpus harness in `tools/fp-corpus.mjs` reuses its 11 pinned public repositories (42k+ files) for false-positive measurement. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full attribution, license texts and trademark notes.

## Placeholders

- Manual entry with alias: `[REDACTED:github-token]` — the alias is the semantics.
- Auto-detected: `[REDACTED:GITHUB_TOKEN#a1b2c3d4]` — hash = fnv1a(sessionSalt + value); stable within a session (same value → same placeholder, cache-friendly), meaningless across sessions.

## Testing & verification

Four layers, from unit to wire-level proof:

### 1. Unit tests (`npm test`)

`node --test`, 38 tests. Coverage: every rule family (positive match + near-miss fixtures — shape-adjacent non-secrets that must NOT match), entropy/checksum helpers, CJK keyword forms (fullwidth colon, latin–CJK adjacency, prose near-misses like `密码规则如下：`), placeholder idempotency, longest-form-wins on substring overlap, multi-form matching (PEM bodies reshaped by line numbers), restore round-trips, deep traversal of tool inputs, per-role message redaction, command handling, persistence round-trip, and the wire-payload audit scan.

### 2. False-positive corpus (`npm run fp-corpus`)

Scans the same 11 pinned public repositories used by claude-code-redact's fp-corpus (lockfiles, go.sum, Kubernetes/Terraform manifests, sample-credential compose files, docs-heavy Markdown, minified JS, JWT/PEM test vectors, JOSE vectors, `.env` fixtures; ~60k text files scanned, <2MB each). Result at pinning time: **66 hits, all real-shaped (test PEM keys, signed JWT vectors, sample DB credentials) — 0 false positives**, matching the upstream baseline (42,836 files / 68 hits / 0 FP). Judgement standard: complete private keys / signed JWTs / sample DB credentials published as test vectors ARE secrets and should be redacted. Results land in `tools/fp-corpus-results.md`; repos are cached under `/tmp/pi-secret-mask-fp-corpus/`, rerun takes ~20s.

Limitation: the corpus is English. CJK false-positive behaviour is covered by unit near-misses only (`密码规则如下：` / `密码策略：` must not match).

### 3. End-to-end smoke (behavioural proof)

In a fresh session — the model **cannot state what it never received**:

```
you:  save this key to /tmp/k.txt: sk-ant-api03-<fake 80 chars>
      (model sees only [REDACTED:ANTHROPIC_KEY#hash]; its write-tool call carries the placeholder)
you:  what does /tmp/k.txt contain? print it verbatim
      → stating the real value would mean redaction FAILED; placeholder-only means it works
cat /tmp/k.txt   → contains the real value (tool_call restore worked)
```

### 4. Wire-payload audit (per-send evidence, self-issued)

`/secret audit on` — every provider request is then scanned at the last possible moment (`before_provider_request`, after all other hooks) and one evidence line is appended to `~/.pi/agent/secret-mask-audit.log` (0600):

```json
{"time":"...","sessionId":"...","strings":299,"placeholders":2,"leaks":0,"leakedLabels":[]}
```

- `leaks=0` with `placeholders>0` = direct evidence that only placeholders went out on that send
- `placeholders` grows across turns as the conversation carries placeholders — consistent with masking
- any registered raw value found in the payload raises an immediate `secret-mask LEAK: ...` alarm notification
- the evidence file never contains raw values (labels only); `/secret audit show` prints the tail in-session

## What it does not do (known limits, same as comparable tools)

- **The session file keeps the original text.** pi has no transcript-rewrite hook; redaction applies at the model/provider boundary only. Your local transcript already contained the value because you typed it.
- **Unannotated bare values without any keyword context are not auto-detected.** A raw token pasted with no `key =` / `Authorization:` shape nearby is invisible to the rules — use `/secret add` for those. This is deliberate: bare high-entropy detection would fire on minified JS.
- **Pure-CJK bare phrases** under the 2.5 bits/char entropy floor (roughly fewer than ~6 distinct characters) are not auto-detected; quote them or `/secret add`.
- **Transformed values escape** (`${T:0:10}` slices, re-encoded base64) — except the multi-part forms handled by `redactForms` (PEM bodies split by line numbers, JSON key files).
- **Images are not scanned.**
- A prompt-injected agent that restores a value into a network command can still exfiltrate it — this tool prevents *accidental* disclosure, not a hostile agent. The audit layer detects raw values leaving on the model boundary but not values exfiltrated through a restored Bash command. See keyshroud's security model for the same caveat.

## Coexistence

Safe alongside `keyshroud` (vault-based redaction) and any other `tool_result`/`context`-rewriting extension: hook chains compose in load order and the exact-match replacement sets are disjoint (vault values vs session-registered values).

## Credits & third-party notices

Rule shapes and methodology reference two MIT projects — [claude-code-redact](https://github.com/karanb192/claude-code-redact) (Karan Bansal) and [keyshroud](https://github.com/dinhkarate/keyshroud) (Daniel / EONSR) — plus the public [gitleaks](https://github.com/gitleaks/gitleaks) token corpus. Independent implementation; full attributions and license texts in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Product/vendor names in rule labels are nominative references to credential formats only; no affiliation or endorsement.

## Development

```bash
npm test            # node --test, 38 tests
npm run fp-corpus   # false-positive corpus over pinned public repos (~20s warm)
```

License: MIT.
