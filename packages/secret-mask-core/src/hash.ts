/**
 * FNV-1a (32-bit) — deterministic, dependency-free digest used for
 * placeholder hashing. Not cryptographic on purpose: placeholders only need
 * to be stable and collision-unlikely within a session/namespace, and a
 * cryptographic hash would not make them more secret (values never appear in
 * the placeholder).
 */

/** FNV-1a 32-bit hash as 8 lowercase hex chars. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
