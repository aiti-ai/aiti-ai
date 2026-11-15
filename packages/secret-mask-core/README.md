# @aiti-ai/secret-mask-core

> **Host-agnostic secret redaction engine.** — 脱敏基础能力包，任何 TS/JS agent 均可快速适配。

Deterministic credential detection + the `[REDACTED:*]` placeholder registry + deep traversal + payload auditing + `/secret` command logic — everything except host wiring. Zero runtime dependencies.

Two production consumers:

- **[@aiti-ai/pi-secret-mask](https://www.npmjs.com/package/@aiti-ai/pi-secret-mask)** — pi (coding agent) session-level redaction
- **[@aiti-ai/dsh-secret-mask](https://www.npmjs.com/package/@aiti-ai/dsh-secret-mask)** — DSH (DeepSeek Harness) session-level redaction

Detection rules, entropy thresholds, placeholder format and restore semantics are shared verbatim across hosts (single test corpus, single fp-corpus baseline).

中文说明见下半部分。

---

## What's inside

| module | exports | role |
|---|---|---|
| `detect` | `scan`, `RULES`, `entropy`, `fnv1a`, `plausibleSecret`, `PLACEHOLDER_RE` | deterministic regex + checksum rules (AWS/GitHub/GitLab/Slack/Stripe/SendGrid/Twilio/Google/Anthropic/OpenAI/HF/npm/PyPI/Azure/JWT/PEM/DB URL/Authorization header/generic assignments + Chinese keywords + base64-wrapped tokens), Shannon-entropy floors, false-positive guards; no network, no model calls |
| `mask` | `Registry`, `redactForms`, `restoreDeep`, `redactDeep`, `auditPayload`, `MIN_REDACT_LENGTH` | value↔placeholder registry (`[REDACTED:alias]` / `[REDACTED:LABEL#hash]`, fnv1a(sessionSalt+value), idempotent, longest-form-wins), deep JSON traversal, final-payload leak proof |
| `spans` | `redactTextSpans`, `TextSpan`, `spanOf` | the send-boundary loop: map your message shapes to text spans; auto-detection runs **only** on spans you flag as user-authored |
| `commands` | `handleSecretCommand`, `SecretState`, `savePersist`/`loadPersist`/`clearPersist`, `appendAuditLog` | the `/secret add/list/remove/clear/on/off/status/save/unload/audit` logic; storage paths come from your state object |

## Adapt another TS/JS agent in four steps

```ts
import { Registry, redactTextSpans, spanOf, auditPayload } from "@aiti-ai/secret-mask-core";

// 1. One registry per session (fresh salt → same value maps to the same
//    placeholder within the session, different across sessions).
const registry = new Registry();
const salt = crypto.randomBytes(4).toString("hex");

// 2. At your send boundary, map the outgoing messages to text spans and run
//    the loop. Flag spans authored by the USER for auto-detection; model/tool
//    text only gets redaction of already-registered values.
function redactOutgoing(messages) {
  for (const m of messages) {
    const spans = m.role === "user"
      ? m.content.filter(b => b.type === "text").map(b => spanOf(() => b.text, t => { b.text = t; }))
      : /* assistant/tool text: redact-only, never mined */
        m.content.filter(b => b.type === "text").map(b => spanOf(() => b.text, t => { b.text = t; }));
    redactTextSpans(spans, registry, salt, { autoDetect: m.role === "user" });
  }
}

// 3. Before a tool executes with model-written arguments, restore placeholders
//    (deep clone if your arguments are frozen):
import { restoreDeep } from "@aiti-ai/secret-mask-core";
const args2 = restoreDeep(structuredClone(args), registry).value;

// 4. Before the request leaves the machine, audit the FINAL payload:
import { auditPayload } from "@aiti-ai/secret-mask-core";
const a = auditPayload(payload, registry);   // { strings, placeholders, leaks, leakedLabels }
if (a.leaks > 0) panic(`raw secret on the wire: ${a.leakedLabels.join(", ")}`);
```

Optional: `handleSecretCommand` gives you the whole `/secret` command surface against a `SecretState` (you provide `persistPath` / `auditPath` and a command dispatcher).

## Guarantees & limits (shared with both hosts)

- Session-scoped: fresh salt per session; registered values live in memory, opt-in persistence to your own file.
- No-keyword bare high-entropy strings are NOT auto-detected (deliberate: bare entropy detection false-positives on minified JS) — expose manual registration.
- Transform escapes (string slicing, re-encoded base64) beyond `redactForms` remain a real limit.
- Prevents accidental leaks, not malicious agents; the audit layer detects raw values at the model boundary, not post-restore exfiltration through network-executing tools.
- Images are not scanned.

## Testing

```bash
npm test          # node --test — engine, span-loop and command suites
npm run build     # esbuild → dist/index.js
npm run fp-corpus # false-positive corpus over 11 locked public repos (60k+ files)
```

License: MIT. Detection rule shapes follow the public gitleaks / GitHub secret-scanning corpus (see THIRD-PARTY-NOTICES.md for attribution).

---

## 中文说明

主机无关的脱敏基础能力包（零运行时依赖），已由 pi 与 DSH 两个生产宿主验证。四步接入任意 TS/JS agent：

1. **每会话一个 `Registry`**（随机盐——同会话同值同占位符，跨会话不可预测）；
2. **发送边界**把消息映射为文本 span（`spanOf(get, set)`），调 `redactTextSpans`：只有你标记为用户手写的 span 做自动检测登记，其余只做已登记值脱敏；
3. **工具执行前**用 `restoreDeep` 把模型回抄的占位符还原成真值（参数被冻结就先 structuredClone）；
4. **请求发出前**用 `auditPayload` 扫描最终 payload——`leaks=0` 即"只有占位符上线"的直接证据，`leaks>0` 立即报警。

`/secret` 命令逻辑（登记/列表/开关/持久化/审计）在 `handleSecretCommand` 里，给你自己的命令分发器套上即可。

## 已知取舍（与两个宿主一致）

- 无关键字上下文的裸高熵串不自动检测（防压缩 JS 误报的刻意取舍）——提供手动登记入口；
- 防意外泄露不防恶意 agent；审计层能发现真值出现在模型边界，发现不了还原后经外传工具泄露的值；
- 图片不扫描。
