/**
 * @aiti-ai/secret-mask-core — host-agnostic secret redaction engine.
 *
 * Shared by @aiti-ai/pi-secret-mask (pi) and @aiti-ai/dsh-secret-mask
 * (DeepSeek Harness). Anything TS/JS-based can adapt it:
 *
 *  1. Detection + registry: `scan` / `Registry` — paste-safe value mapping to
 *     stable `[REDACTED:*]` placeholders (same rules as the public
 *     gitleaks/GitHub secret-shape corpus; deterministic, no network, no model).
 *  2. Deep traversal: `restoreDeep` / `redactDeep` for tool arguments and
 *     structured results; `auditPayload` for the final outgoing payload proof.
 *  3. Span loop: map your message shapes to `TextSpan`s and call
 *     `redactTextSpans` at your send boundary (auto-detection runs only on
 *     user-authored spans — you decide which those are).
 *  4. `/secret` command logic: `handleSecretCommand` over a `SecretState`
 *     (you provide storage paths and a command surface).
 *
 * Host wiring that deliberately stays OUT of this package: hook/event
 * plumbing, message shapes, immutability semantics, storage locations.
 */

export * from "./detect.ts";
export * from "./mask.ts";
export * from "./spans.ts";
export * from "./commands.ts";
