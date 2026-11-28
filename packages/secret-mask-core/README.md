# @aiti-ai/secret-mask-core

> **Host-agnostic secret redaction engine.** — 脱敏基础能力包，任何 TS/JS agent 均可快速适配。

Deterministic credential detection + the `rsec_<hash8>` placeholder registry (legacy `[REDACTED:*]` still restorable) + deep traversal + pi message adapters + unresolved-placeholder guard + landing policy + custom rules + payload auditing + `/secret` command logic — everything except host wiring. Zero runtime dependencies.

Production consumers:

- **[@aiti-ai/pi-secret-mask](https://www.npmjs.com/package/@aiti-ai/pi-secret-mask)** — pi session-level redaction (plain/ephemeral landing)
- **[@aiti-ai/pi-secret-vault](https://www.npmjs.com/package/@aiti-ai/pi-secret-vault)** / **[@aiti-ai/secret-vault-core](https://www.npmjs.com/package/@aiti-ai/secret-vault-core)** — encrypted persistent edition (stable vault tokens, vault landing, AI tools)
- **[@aiti-ai/dsh-secret-mask](https://www.npmjs.com/package/@aiti-ai/dsh-secret-mask)** — DSH (DeepSeek Harness) session-level redaction

Detection rules, entropy thresholds, placeholder semantics and restore behaviour are shared verbatim across hosts (single test corpus, single fp-corpus baseline).

中文说明见下半部分。

---

## What's inside

| module | exports | role |
|---|---|---|
| `detect` | `scan`, `RULES`, `entropy`, `plausibleSecret` | deterministic regex + checksum rules (AWS/GitHub/GitLab/Slack/Stripe/SendGrid/Twilio/Google/Anthropic/OpenAI/HF/npm/PyPI/Azure/JWT/PEM/DB URL/Authorization header/generic assignments + assignment verbs + Chinese keywords + base64-wrapped tokens), entropy floors, false-positive guards; no network, no model calls |
| `hash` | `fnv1a` | 32-bit FNV-1a digest used for placeholder hashing |
| `placeholder` | `PLACEHOLDER_RE`, `sessionPlaceholder`, `stablePlaceholder`, `findPlaceholders`, `isPlaceholderToken` | v2 format `rsec_<8 hex>` (credential-shaped so models use it naturally) + legacy `[REDACTED:alias]` / `[REDACTED:LABEL#hash]` compatibility |
| `mask` | `Registry`, `registerManual`/`registerAuto`/`registerStable`, `redactForms`, `restoreDeep`, `redactDeep`, `redactDeepInPlace`, `auditPayload`, `MIN_REDACT_LENGTH` | value↔placeholder registry (session-salted for session values, `vault:`-namespaced/stable for vault aliases; idempotent; longest-form-wins; redirects keep old references alive), deep JSON traversal, final-payload leak proof |
| `spans` | `redactTextSpans`, `TextSpan`, `spanOf`, `onDetected` | the send-boundary loop: map your message shapes to text spans; auto-detection runs **only** on spans you flag as user-authored; `onDetected` lets a host re-mount newly found values (vault landing) |
| `messages` | `collectSpans`, `collectSystemSpans`, `redactMessages`, `redactSystemMessages`, `redactMessageDeep` | pi `AgentMessage` adapters: `context` (deep copy), `context_with_system` (system prompt/AGENTS.md blind spot), `message_end` (role-preserving replacement for on-disk redaction) |
| `guard` | `unmountedPlaceholders`, `unmountedInValue`, `guardReason` | G7: block tool calls that reference placeholders no longer mounted, with the exact recovery command |
| `landing` | `LandingMode`, `redactOnDisk`, `landingText` | G1 policy: `plain` / `vault` / `ephemeral` |
| `rules` | `RulesSource`, `CustomRule`, `registerRuleMatches`, `applyFixedRules`, `addRuleToFile` | G6 custom rules file (`secret-mask-rules.json`, global + per-project, hot reload by mtime, placeholder vs fixed modes) |
| `extract` | `extractStructuredSecrets`, `registerExtractedSecrets`, `inspectSensitivePath`, `inspectToolTargets`, `weakPasswordCandidates`, `registerWeakCandidates`, `learnFromText`, `WEAK_PASSWORDS` | weak-value discovery: key-name-based extraction (`.env`/JSON/YAML/header/URL/netrc), sensitive-file classification, weak-password dictionary + strong-context candidates, explicit learn |
| `commands` | `handleSecretCommand`, `SecretState`, `saveSnapshot`/`loadSnapshot`, `appendAuditLog` | `/secret add/list/remove/clear/on/off/status/landing/guard/strict/rule/save/load/audit`; explicit snapshots only (no implicit persistence) |

## Adapt another TS/JS agent in four steps

```ts
import { Registry, redactTextSpans, spanOf, restoreDeep, auditPayload } from "@aiti-ai/secret-mask-core";

// 1. One registry per session; set the salt so placeholders stay stable
//    within the session (same value → same token, cache-friendly).
const registry = new Registry();
registry.salt = crypto.randomBytes(4).toString("hex");

// 2. At your send boundary, map outgoing messages to text spans. Flag spans
//    authored by the USER for auto-detection; everything else is redact-only.
function redactOutgoing(messages) {
  for (const m of messages) {
    const spans = m.content.filter(b => b.type === "text").map(b => spanOf(() => b.text, t => { b.text = t; }));
    redactTextSpans(spans, registry, registry.salt, { autoDetect: m.role === "user" });
  }
}

// 3. Before a tool executes with model-written arguments, restore tokens
//    (deep clone if your arguments are frozen):
const { value: args2 } = restoreDeep(structuredClone(args), registry);

// 4. Before the request leaves the machine, audit the FINAL payload:
const a = auditPayload(payload, registry); // { strings, placeholders, leaks, leakedLabels }
if (a.leaks > 0) panic(`raw secret on the wire: ${a.leakedLabels.join(", ")}`);
```

Activating the guard and custom rules:

```ts
import { unmountedInValue, guardReason, RulesSource, loadSnapshot } from "@aiti-ai/secret-mask-core";

const missing = unmountedInValue(toolInput, registry);
if (missing.length) return { block: true, reason: guardReason(missing) };

const rules = new RulesSource("/home/me/.pi/agent/secret-mask-rules.json", cwd);
redactTextSpans(spans, registry, salt, { autoDetect: true, rules: rules.rules() });
```

## Weak values (L1/L2/L3)

`extract.ts` closes the "human password that does not look like a credential" gap without
lowering the global entropy gates:

- **Structured extraction**: `DB_PASSWORD=123abc`, `"password": "qwerty"`, `api_key: …`,
  `Authorization: Bearer …`, URL userinfo, netrc — key-name driven, **no entropy floor**
  (values ≥6 chars). Mine tool results, write/edit contents and assistant tool calls.
- **Sensitive paths**: `inspectSensitivePath` classifies `.env*`, `id_*`, `.pgpass`, `.netrc`,
  `.npmrc`, `.git-credentials`, `credentials.json`, `secret.txt`, `*.key/p12/pfx`,
  kube/aws paths; `dedicated` marks files whose whole content is one secret (for withholding).
- **Weak candidates**: `weakPasswordCandidates` + `WEAK_PASSWORDS` (strong keyword/copula/assignment-verb
  context only, e.g. `密码是…`, `密码改成…`, `password to …`); dictionary hits register, other weak-shaped
  values are reported for a host prompt or auto-registered.
- **Strength assessment**: `assessPasswordStrength` (dictionary, <8 chars, single character
  class, low entropy, sequences) for long-term stores; `describePasswordWeakness` for warnings.
- **Learn**: `learnFromText` (structured first, whole-content fallback for dedicated files).

`inspectToolTargets(toolName, input)` turns read/write/edit/bash/powershell calls into read
paths, write paths and mineable content; `registerValueSecrets` mines nested `details` /
`structuredContent` leaves.

## Guarantees & limits (shared with all hosts)

- Session-scoped by default: fresh salt per session; session values live in memory. Vault entries use a stable namespace instead so resume/rotation keeps the same token.
- Placeholder strings look like credentials on purpose (`rsec_<hash8>`): models stop refusing to use them; the digest reveals nothing about the value.
- No-keyword bare high-entropy strings are NOT auto-detected (deliberate: bare entropy detection false-positives on minified JS) — expose manual registration or custom rules. A bare value after an assignment verb (`设为 X`, `set it to X`) is the one exception, and it still needs a credential keyword in the same passage.
- Encoded forms of registered values — base64 padded/unpadded, base64url, hex lower/upper, the two common line folds (64/76 chars), percent-encoding — are pre-computed in `redactForms` and redact to the same placeholder. Transform escapes beyond that (string slicing/truncation, offset-annotated hex dumps like `xxd`/`hexdump` default output, arbitrary custom transforms) remain a real limit.
- Prevents accidental leaks, not malicious agents; the audit layer detects raw values at the model boundary, not post-restore exfiltration through network-executing tools.
- Images are not scanned.

## Testing

```bash
npm test          # node --test — engine, adapters, guard, landing, rules, commands
npm run build     # esbuild → dist/index.js
npm run fp-corpus # false-positive corpus over 11 locked public repos (43k+ files scanned, 65 hits / 0 prose-template FP)
```

License: MIT. Detection rule shapes follow the public gitleaks / GitHub secret-scanning corpus (see THIRD-PARTY-NOTICES.md for attribution).

---

## 中文说明

主机无关的脱敏基础能力包（零运行时依赖），已由 pi（轻量版 + 加密持久版）与 DSH 三个生产宿主验证。四步接入任意 TS/JS agent：

1. **每会话一个 `Registry`**（设置 `salt`——同会话同值同令牌，跨会话不可预测；vault 别名用稳定命名空间）；
2. **发送边界**把消息映射为文本 span（`spanOf(get, set)`），调 `redactTextSpans`：只有你标记为用户手写的 span 做自动检测登记；`onDetected` 可把新值改挂到 vault 库（稳定令牌）；
3. **工具执行前**用 `restoreDeep` / `restoreDeepInPlace` 还原令牌；`unmountedInValue` + `guardReason` 拦截未挂载占位符；
4. **请求发出前**用 `auditPayload` 扫描最终 payload——`leaks=0` 即「只有令牌上线」的直接证据。

新增能力（0.2.0）：占位符 v2 `rsec_<hash8>`（模型不再拒用）、`message_end` 深替换适配（落盘脱敏）、system 段覆盖、落盘三态（plain/vault/ephemeral）、自定义规则（`RulesSource`，mtime 懒加载）、显式快照（`saveSnapshot`/`loadSnapshot`，无隐式持久化）。

## 已知取舍（与所有宿主一致）

- 无关键字上下文的裸高熵串不自动检测（防压缩 JS 误报的刻意取舍）——提供手动登记/自定义规则入口；
- 防意外泄露不防恶意 agent；审计层能发现真值出现在模型边界，发现不了还原后经外传工具泄露的值；
- 图片不扫描。
