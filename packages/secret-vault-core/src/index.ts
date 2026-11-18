/**
 * @aiti-ai/secret-vault-core — local encrypted secret vault engine.
 *
 * Depends on @aiti-ai/secret-mask-core for rules/placeholder/redaction; this
 * package adds persistence:
 *
 *  - `VaultStore`      AES-256-GCM store, keyfile unlock, global + project
 *                      scope buckets, rotation with attribution fields
 *  - entries           capture from command stdout, .env / env import,
 *                      value→alias lookup, auto-alias suggestion
 *  - tools             read-only AI surface: vault_list / vault_get
 *  - commands          `/vault` human command logic
 *  - landing           vault landing mode adapter (prompt values → library)
 *  - session-state     zero-value session records for management UIs
 *
 * The pi package (@aiti-ai/pi-secret-vault) adds hooks, tools registration,
 * `/secret` + `/vault` wiring and the mutual-exclusion handshake.
 */

export * from "./crypto.ts";
export * from "./store.ts";
export * from "./entries.ts";
export * from "./tools.ts";
export * from "./landing.ts";
export * from "./commands.ts";
export * from "./session-state.ts";
