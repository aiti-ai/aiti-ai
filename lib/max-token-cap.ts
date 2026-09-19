/**
 * Parse a maximum output-token cap out of a provider HTTP error message.
 *
 * When a probe sends `max_tokens` above a model's real cap, providers reject
 * with HTTP 400 and usually state the bound in the error body:
 * - Ark / Volcano Engine coding: "expected a value <= 128000, but got 131072"
 * - OpenAI-style: "'max_tokens' is invalid: value must be less than or equal to N"
 * - DeepSeek-style: "... is limited to N tokens"
 * - generic: "exceeds the maximum of N tokens"
 *
 * Returns the parsed cap, or undefined when the message carries no usable
 * bound (auth errors, unknown models, timeouts, etc.). Only values within a
 * sane token range (1 .. 10M) are accepted.
 */
const CAP_PATTERNS: RegExp[] = [
  /expected a value <= (\d[\d,]*)/i,
  /(?:must|should) be (?:less than or equal to|at most|no more than|<=) (\d[\d,]*)/i,
  /limited to (\d[\d,]*)/i,
  /maximum (?:output )?(?:token|length|value)s?[^.\n]{0,40}?(\d[\d,]*)/i,
  /(?:exceeds?|exceeded) the (?:maximum|limit)[^.\n]{0,40}?(\d[\d,]*)/i,
];

export function parseMaxTokenCap(message: string): number | undefined {
  if (!message) return undefined;
  for (const pattern of CAP_PATTERNS) {
    const match = message.match(pattern);
    if (!match) continue;
    const value = Number(match[1].replace(/[,_\s]/g, ""));
    if (Number.isFinite(value) && value >= 1 && value <= 10_000_000) {
      return Math.floor(value);
    }
  }
  return undefined;
}
