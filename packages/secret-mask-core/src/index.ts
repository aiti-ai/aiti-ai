/**
 * @aiti-ai/secret-mask-core — host-agnostic secret redaction engine.
 *
 * Shared by @aiti-ai/pi-secret-mask (pi) and @aiti-ai/dsh-secret-mask
 * (DeepSeek Harness); also the masking layer of @aiti-ai/pi-secret-vault.
 * Anything TS/JS-based can adapt it:
 *
 *  1. Detection + registry: `scan` / `Registry` — paste-safe value mapping to
 *     stable, credential-shaped placeholders (`rsec_<hash8>`; legacy
 *     `[REDACTED:*]` tokens stay restorable). Same rules as the public
 *     gitleaks/GitHub secret-shape corpus; deterministic, no network, no model.
 *  2. Deep traversal: `restoreDeep` / `redactDeep` / `redactDeepInPlace` for
 *     tool arguments and structured results; `auditPayload` for the final
 *     outgoing payload proof.
 *  3. Span loop: map your message shapes to `TextSpan`s and call
 *     `redactTextSpans` at your send boundary (auto-detection runs only on
 *     user-authored spans — you decide which those are). `messages.ts` ships
 *     the pi `AgentMessage` adapters.
 *  4. Unresolved-placeholder guard: `unmountedInValue` / `guardReason`.
 *  5. Landing policy: `LandingMode` (plain / vault / ephemeral).
 *  6. Custom rules: `RulesSource` / `registerRuleMatches` / `applyFixedRules`.
 *  7. `/secret` command logic: `handleSecretCommand` over a `SecretState`
 *     (you provide storage paths and a command surface).
 *
 * Host wiring that deliberately stays OUT of this package: hook/event
 * plumbing, message shapes, immutability semantics, storage locations.
 */

export * from "./hash.ts";
export * from "./detect.ts";
export * from "./placeholder.ts";
export * from "./mask.ts";
export * from "./spans.ts";
export * from "./messages.ts";
export * from "./guard.ts";
export * from "./landing.ts";
export * from "./rules.ts";
export * from "./extract.ts";
export * from "./commands.ts";
