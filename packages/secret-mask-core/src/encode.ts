/**
 * Encoded variants of a registered value.
 *
 * When a model pipes a mounted secret through an encoder (`| base64`,
 * `| xxd`, percent-encoding), the tool output no longer contains the raw
 * value, so plain exact-match redaction misses it and the encoded secret
 * leaks into the model context. We pre-compute the common lossless encodings
 * at registration time and redact them exactly like the raw value (same
 * placeholder), keeping the exit path symmetric with the entry path.
 *
 * Threat-model note: this closes the "casual one-liner encoder" hole. A
 * determined model can always invent a custom transformation — that is a
 * policy/audit problem, not a redaction problem.
 *
 * Pure JS on purpose: the engine stays runtime-neutral (no Node Buffer).
 */

const encoder = new TextEncoder();

/** Minimum raw byte length for encoded variants. Below this the encodings
 * get short enough to false-positive on ordinary text (hex of an 8-byte id
 * is 16 chars, often a substring of hashes/UUIDs). Raw-value matching keeps
 * its own, lower threshold. */
export const MIN_VARIANT_BYTES = 16;

/** Upper bound on the raw value size. Encodings expand ~1.3x (base64) to 2x
 * (hex) and folded copies add more, so a very large value would retain
 * megabytes of forms per entry and make every redaction pass scan them. Above
 * this, raw exact-match and the 20+ char run forms still cover the value. */
export const MAX_VARIANT_BYTES = 4096;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 63];
  }
  return out;
}

/** Fold a string into lines of `cols` characters joined by "\n" (GNU base64
 * folds at 76, `openssl base64` at 64). */
function foldLines(s: string, cols: number): string {
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += cols) lines.push(s.slice(i, i + cols));
  return lines.join("\n");
}

/**
 * Encoded forms of `value` that tools commonly produce and should be redacted
 * like the value itself: base64 (padded / unpadded), base64url, hex (lower /
 * upper), the two common line-folded base64 layouts, and percent-encoding
 * (only when it differs from the value). Deduplicated; empty below the byte
 * threshold.
 */
export function encodedVariants(value: string): string[] {
  const bytes = encoder.encode(value);
  if (bytes.length < MIN_VARIANT_BYTES || bytes.length > MAX_VARIANT_BYTES) return [];
  const b64 = bytesToBase64(bytes);
  const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_");
  const hex = bytesToHex(bytes);
  const out = new Set<string>([
    b64,
    b64.replace(/=+$/, ""),
    b64url,
    b64url.replace(/=+$/, ""),
    hex,
    hex.toUpperCase(),
    foldLines(b64, 76),
    foldLines(b64, 64),
  ]);
  const pct = encodeURIComponent(value);
  if (pct !== value) out.add(pct);
  return [...out];
}
