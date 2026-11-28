/**
 * Ignore-semantics shared module (practical subset of .gitignore / .aitiignore / .dockerignore)
 *
 * ⭐ Authoritative source: this file. Copies sync to consumer extensions (after changing here, sync
 * all three places):
 *   - aiti-doc-center/lib/ignore-semantics.ts (walkFiles collector)
 *   - aiti-plan-first/lib/ignore-semantics.ts (selector fs-walk fallback + session-md .aitiignore filter)
 *   - aiti-git-trace does not use this module (.gitignore/.aitiignore go through git's exclusion
 *     machinery: ls-files --exclude-standard / --exclude-per-directory, see its §16.3 listMd v2)
 *
 * Semantics (practical gitignore subset, Linux case-sensitive):
 *   - `#` comments and empty lines are skipped; `!` negative rules (a later match overrides earlier ones)
 *   - a trailing `/` means directory-only (the directory and its contents match together via (?:/.*)?)
 *   - containing `/` (including a leading `/`) = anchored to the ignore file's directory; no slash = basename at any depth
 *   - a "double asterisk + slash" prefix = any depth; the same mid-pattern = zero or more directories; a trailing
 *     segment = anything under the directory; `*`/`?` = single-level wildcards
 *   - segmented construction guarantees segment boundaries (the skills glob does not swallow skillsfoo;
 *     a + double-star + b does not swallow a + xb)
 *
 * API:
 *   compileIgnoreGlob(glob)            one glob -> RegExp
 *   compileIgnoreLines(text)           multi-line ignore text -> IgnoreRule[]
 *   matchRules(rules, rel)             later match overrides earlier; null = no rule matched (the caller decides the default)
 */

export interface IgnoreRule { neg: boolean; dirOnly: boolean; re: RegExp }

function escSeg(seg: string): string {
  let r = "";
  for (const ch of seg) {
    if (ch === "*") r += "[^/]*";
    else if (ch === "?") r += "[^/]";
    else r += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return r;
}

/** One gitignore-style glob -> regex (segmented construction guarantees segment boundaries) */
export function compileIgnoreGlob(glob: string): RegExp {
  let body = glob;
  let pre = "";
  let tail = "(?:/.*)?";
  if (body === "**") return /^.*$/;
  const anchored = body.includes("/");
  if (body.endsWith("/**")) { body = body.slice(0, -3); tail = "/.*"; }
  else if (body.endsWith("/")) { body = body.slice(0, -1); tail = "/.*"; }
  if (!anchored) pre += "(?:.*/)?"; // no slash -> any depth
  if (body.startsWith("**/")) { pre += "(?:.*/)?"; body = body.slice(3); }
  else if (body.startsWith("**")) { pre += ".*"; body = body.slice(2); }
  if (!body) return new RegExp("^" + pre + (tail === "/.*" ? "/.*" : "") + "$");
  if (body.startsWith("/")) body = body.slice(1); // anchored: drop the root slash (/sub/x.md -> sub/x.md)
  const segs = body.split("/**/");
  return new RegExp("^" + pre + segs.map(escSeg).join("(?:.*/)?") + tail + "$");
}


export function compileIgnoreLines(text: string): IgnoreRule[] {
  const out: IgnoreRule[] = [];
  for (let raw of String(text || "").split(/\r?\n/)) {
    raw = raw.replace(/\s+$/, "");
    if (!raw || raw.startsWith("#")) continue;
    let neg = false;
    if (raw.startsWith("!")) { neg = true; raw = raw.slice(1); }
    let dirOnly = raw.endsWith("/");
    if (dirOnly) raw = raw.slice(0, -1);
    if (!raw) continue;
    out.push({ neg, dirOnly, re: compileIgnoreGlob(raw) });
  }
  return out;
}

/** Rule matching: later match overrides earlier (including ! negation); returns null on no match (the caller decides the default) */
export function matchRules(rules: IgnoreRule[], rel: string): boolean | null {
  let decision: boolean | null = null;
  for (const r of rules) {
    if (r.re.test(rel)) decision = !r.neg;
  }
  return decision;
}
