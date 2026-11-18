/**
 * Placeholder format (v2) and parsing helpers.
 *
 * v2 disguises placeholders as credential-shaped opaque tokens:
 *
 *   session entry (manual / auto-detected):  rsec_<fnv1a(salt + value)>    (8 hex)
 *   stable entry (vault, cross-session):     rsec_<fnv1a(namespace:alias)> (8 hex)
 *
 * Why the format changed: `[REDACTED:...]` reads as metadata ("this was
 * blocked"), which makes safety-trained models refuse to pass it into tool
 * arguments — the restore path then never fires. A token that looks like a
 * working credential is used naturally (zero resistance) while remaining
 * meaningless outside this session.
 *
 * v1 placeholders (`[REDACTED:alias]`, `[REDACTED:LABEL#hash]`) are still
 * recognized and restorable for migration; they are never generated anymore.
 */

import { fnv1a } from "./hash.ts";

export const PLACEHOLDER_PREFIX = "rsec_";

/** Length of the hex digest inside a v2 placeholder. */
export const PLACEHOLDER_HASH_LEN = 8;

/** Stable (cross-session) placeholder namespace used by the vault package. */
export const STABLE_NAMESPACE = "vault";

/** Build a v2 placeholder from a digest (first 8 hex chars). */
export function placeholderFromHash(hash: string): string {
  return PLACEHOLDER_PREFIX + hash.slice(0, PLACEHOLDER_HASH_LEN);
}

/** Session-scoped placeholder: same value + same salt → same token, always. */
export function sessionPlaceholder(salt: string, value: string): string {
  return placeholderFromHash(fnv1a(salt + value));
}

/**
 * Stable placeholder: independent of the session salt so it survives resume
 * (the vault re-mounts the same alias to the same token). `namespace` keeps
 * different mount sources disjoint.
 */
export function stablePlaceholder(namespace: string, alias: string): string {
  return placeholderFromHash(fnv1a(`${namespace}:${alias}`));
}

/** Matches v2 and legacy v1 placeholders. */
export const PLACEHOLDER_RE = /rsec_[0-9a-f]{8}\b|\[REDACTED:[A-Za-z0-9_-]{1,64}(?:#[0-9a-fA-F]{1,16})?\]/g;

/** v2-only matcher (used by the guard; legacy tokens are handled permissively). */
export const V2_PLACEHOLDER_RE = /rsec_[0-9a-f]{8}\b/g;

/** True when the whole string is exactly one placeholder. */
export function isPlaceholderToken(text: string): boolean {
  const re = new RegExp(`^(?:${PLACEHOLDER_RE.source})$`);
  return re.test(text);
}

/** Extract placeholder-looking tokens from a text. */
export function findPlaceholders(text: string): string[] {
  if (!text) return [];
  PLACEHOLDER_RE.lastIndex = 0;
  return text.match(new RegExp(PLACEHOLDER_RE.source, "g")) ?? [];
}

/** Extract v2 placeholder tokens from a text (guard input). */
export function findV2Placeholders(text: string): string[] {
  if (!text) return [];
  return text.match(/(?:^|[^A-Za-z0-9_])rsec_[0-9a-f]{8}\b/g)?.map((m) => m.replace(/^[^r]+/, "")) ?? [];
}

/** Human-readable placeholder origin, for /secret list and vault notes. */
export function describePlaceholder(entry: { placeholder: string; alias?: string; label: string; source: string }): string {
  const name = entry.alias ?? entry.label;
  return `${entry.placeholder} → ${name} [${entry.source}]`;
}
