/**
 * Typo-tolerant search.
 *
 * Scenario: typing typos like servcie / sevice in an extension search box must still hit service-tunnels.
 * Design:
 *   - OSA distance (restricted Damerau-Levenshtein): adjacent transpositions count as 1 step —
 *     servcie->service=1, sevice->service=1 (pure Levenshtein counts the transposition as 2, which short-word
 *     thresholds would miss).
 *   - Threshold adapts to query length (typo-tolerance convention): <=3 chars disables fuzzing (too noisy),
 *     4-7 allow 1 error, 8+ allow 2.
 *   - Enabled only for space-free short queries; candidate text is tokenized (alphanumeric / CJK segments)
 *     and compared per token, with length-gap pruning + overlong tokens (whole CJK sentences) skipped.
 * Pure functions, no deps: the client bundle (vite) and node --test run the same implementation directly.
 */

/** OSA (optimal string alignment) edit distance. */
export function osaDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev2 = null;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

/** Typos a query may contain (adaptive by length; <=3 returns 0 = fuzzing disabled). */
export function typoThreshold(q) {
  const len = [...String(q)].length;
  if (len <= 3) return 0;
  if (len <= 7) return 1;
  return 2;
}

const TOKEN_SPLIT = /[^a-z0-9\u4e00-\u9fa5]+/;
const MAX_TOKEN_LEN = 24; // overlong tokens (unseparated CJK sentences etc.) skip fuzzing: the DP cost and false-hit noise are not worth it

function* candidateTokens(text) {
  for (const tok of String(text || "").toLowerCase().split(TOKEN_SPLIT)) {
    if (tok && tok.length <= MAX_TOKEN_LEN) yield tok;
  }
}

/**
 * Typo-tolerant hit decision: when the query is a short space-free word, compare the OSA distance
 * against each token of the candidate text.
 * Besides regular tokens, also checks the "separator-stripped form" (service-tunnels -> servicetunnels)
 * so queries with missing/wrong hyphens still hit. When the enable conditions aren't met (multi-word /
 * too short) it always returns false; the caller falls back to exact includes behavior (this function
 * carries no includes semantics).
 */
export function typoMatch(q, text) {
  const query = String(q || "").trim().toLowerCase();
  if (!query || /\s/.test(query)) return false;
  const threshold = typoThreshold(query);
  if (threshold <= 0) return false;
  const raw = String(text || "");
  for (const src of [raw, raw.replace(/[-_/]/g, "")]) {
    for (const tok of candidateTokens(src)) {
      if (Math.abs(tok.length - query.length) > 2) continue; // length-gap pruning (cap 2: kept loose for the two-error missing-char case)
      const d = osaDistance(query, tok);
      if (d <= threshold) return true;
      // Missing-character relaxation to 2 edits (sevic→service, tunel→tunnels). The candidate token
      // must be LONGER than the query (the dropped-character direction) and share the first char
      // (typos are rarely at the head; zzvic must not hit service). Without the direction check the
      // rule degrades into "query carries two unrelated extra chars", which made a 4-char CJK query
      // hit an unrelated 3-char word inside another extension's display name.
      if (d <= 2 && tok.length > query.length && query[0] === tok[0]) return true;
    }
  }
  return false;
}
