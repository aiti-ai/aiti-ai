# dsh-secret-mask

> **Paste-safe by default.** — 随手贴，不泄密。

Session-level secret redaction for **DSH (DeepSeek Harness)**: values you paste into prompts (tokens, API keys, credentials) are replaced with opaque tokens like `rsec_a1b2c3d4` **before a step enters the model**, and placeholders the model echoes back inside whitelisted tool arguments are **restored to the real values before the tool executes**. Zero runtime dependencies.

Detection core is ported verbatim from [@aiti-ai/pi-secret-mask](https://www.npmjs.com/package/@aiti-ai/pi-secret-mask) — same rules, entropy thresholds, placeholder format and restore semantics. Also see the official `@deepseek-ai/dsh-client-ui-secret-mask`, which masks the *display* of sent text only (model input keeps the raw characters); this plugin complements it at the model boundary.

中文文档：[README.zh-CN.md](README.zh-CN.md)

```
你：  我的 api key 是 sk-ant-api03-<80位> —— 帮我写进 .env 的 ANTHROPIC_KEY
模型看到：我的 api key 是 rsec_a1b2c3d4 —— 帮我写进 .env ...
bash 工具：ANTHROPIC_KEY=sk-ant-api03-<80位>   ← shadow wrapper 执行时已还原为真值
session 日志：占位符持久落盘（pre-step 替换是 durable 的）
```

## 0.3.0: weak values

- Structured extraction from tool output and write arguments (`DB_PASSWORD=…`, JSON/YAML/header/URL) with **no entropy gate**; keys stay readable, values are registered and redacted at `tools/post-execute`.
- Sensitive files (`.env*`, `id_*`, `.pgpass`, `secret.txt`, …): dedicated unstructured files are registered as a whole and the result is **blocked** (fail-closed) instead of returning raw content.
- Weak-password candidates after `密码是` / `password is`; dictionary hits register, other weak-shaped values notify (`/secret weak auto|off`).

## 0.2.0 highlights (shared engine v2)

- Placeholder format is now `rsec_<hash8>` (credential-shaped; models stop refusing to use it). Legacy `[REDACTED:*]` tokens remain restorable.
- Unresolved-placeholder guard: a shadow tool that receives a token not mounted in this session fails with an actionable error instead of executing a literal fake value (the session log is durable, so after a restart old tokens would otherwise be meaningless).
- Custom rules: `~/.dsh/secret-mask-rules.json` (global + per-workspace, hot reloaded) with placeholder / one-way (`fixed`) modes, via `/secret rule …`.
- Landing policy is `ephemeral` by design (pre-step replacement is durable; values live in this process only) — `/secret status` shows it; `/secret save|load <file>` stays an explicit plaintext snapshot.

## Install

```bash
dsh plugin --profile web add @aiti-ai/dsh-secret-mask
dsh --profile web --dump-config   # verify the bundle row
```

Manual equivalent: `pnpm add @aiti-ai/dsh-secret-mask` inside the profile directory, then insert into `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-secret-mask
      name: '@aiti-ai/dsh-secret-mask'
```

New sessions pick it up on their next agent creation.

## Config (settings per profile)

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch for all redaction/restore behaviour |
| `autoDetect` | `true` | auto-detect secret-shaped values in user-authored text |
| `restoreToolArgs` | `true` | restore placeholders inside whitelisted tool arguments (shadow tools) |
| `audit` | `false` | start sessions with the per-send wire-payload audit ON |
| `workspaceDir` | process cwd | persistence bucket key |
| `auditPath` | `~/.dsh/secret-mask-audit.log` | audit evidence file override |

## Command

| command | effect |
|---|---|
| `/secret add <值> [as <别名>]` | register a value. **`recordInput: false` — the value never reaches the model and is never written to the session log** (commands do not become model-facing messages). |
| `/secret list` | registered values (masked preview `…****abcd`, source, rule id) |
| `/secret remove <别名\|标签>` / `clear` | unregister one / all |
| `/secret on` / `off` | toggle redaction for this session |
| `/secret status` | state overview (incl. audit state and last audit result) |
| `/secret save` / `unload` | persist values for this workspace to `~/.dsh/secret-mask.json` (0600, explicit opt-in) / drop them |
| `/secret audit on\|off\|show` | per-send wire-payload proof log |

## How it works

| stage | hook | behaviour |
|---|---|---|
| send boundary | `agent/pre-step` | auto-detect (high-confidence rules) + redact registered values across every text block of the claimed `UserMessage[]` batch (followup / steering / injected context all arrive here). The replacement is **durable**: the session log stores placeholders. |
| convention | `systemPrompt.section` | a `secret_masking` section (rendered only when the session holds registered values): placeholders are opaque stand-ins, copy them verbatim into tool arguments, never guess. |
| execution | `agent/session-start` shadow tools | `bash`, `write`, `edit`, `str_replace_editor` are re-registered in the agent scope with a wrapped `execute` that restores placeholders into a deep clone of the arguments before delegating. The frozen pipeline arguments and the model-visible call record keep placeholders. |
| tool output | `tools/post-execute` | redact registered values from the canonical `value` first (schema-revalidated; fail-closed), falling back to presentation `content` text blocks. |
| proof | `llm/stream` | opt-in: scan the final outgoing payload (conversation **plus compaction/title auxiliary calls**) for registered raw values and placeholder counts; evidence appended to `~/.dsh/secret-mask-audit.log` (0600, never contains raw values); any raw value raises an immediate `secret-mask LEAK` error log. |

## What it does not do (known limits, in line with the pi edition)

- **Pre-step replacement is durable in DSH** — the local session log stores placeholders, not the original text (pi keeps originals in its transcript). This is the documented DSH semantics for pre-step replacements.
- **No-keyword bare values are not auto-detected** — a bare high-entropy string without `key =` / `Authorization:` shapes is invisible to rules; use `/secret add`.
- Transform escapes (`${T:0:10}` slicing, re-encoded base64) — `redactForms` covers common reshapes, the rest is a real limit.
- Images are not scanned.
- `ctx.tools.restrict` interplay: the shadow whitelist is deliberately narrow (bash + file-write family); a restricted-away global tool is never shadowed (visibility checked at wrap time).
- A prompt-injected agent can still exfiltrate restored values via network commands — this tool prevents **accidental** leaks, not malicious agents. The audit layer detects raw values at the model boundary.

## Detection rules

Deterministic regex + checksum rules, no network, no model calls: AWS, GitHub, GitLab, Slack (token + webhook), Stripe live, SendGrid, Twilio, Google API/OAuth, Anthropic, OpenAI, Hugging Face, npm, PyPI, Azure storage, JWT (alg header decoded), PEM private keys (full + truncated), DB URLs with real passwords, `Authorization` headers, generic `key = "value"` assignments (Shannon entropy threshold + code-identifier/template/URL exclusions), base64-wrapped prefix tokens, Chinese keyword forms (`密码：xxx`, `授权码：xxx`, full-width colon, CJK word boundaries). False-positive guards: `plausibleSecret` exclusion set, entropy floors, near-miss test corpus. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for attribution.

## Development

```bash
npm test            # node --test — 50 cases (ported pi suite + DSH adapter suite)
npm run build       # esbuild → lib/index.js (host bundle)
npm run fp-corpus   # false-positive corpus over 11 locked public repos
```

License: MIT. Part of the [aiti](https://github.com/aiti-ai/aiti-ai) ecosystem; works standalone in any DSH profile (web / headless / acp).
