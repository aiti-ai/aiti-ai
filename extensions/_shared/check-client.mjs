/**
 * check-client — TS-leftover tripwire for extension client .mjs/.js (zero deps, pure node).
 *
 * Background: the aiti-plan-review incident (docs/aiti-ext-client-hardening-plan.md §1) —
 * `useState<any>(null)` parses as the legal JS comparison expression `useState < any > (null)`;
 * node --check, the TS parser and babel all stay silent, only runtime blows up. Pure syntax
 * checking cannot work in principle; only heuristic rules + render-time error boundaries cover it.
 *
 * Usage:
 *   CLI      node check-client.mjs <file|dir>...      FAIL → exit 1
 *   selftest node check-client.mjs --selftest         all fixtures pass → exit 0
 *   API      lintClientSource(src) → violations[]     { line, level, rule, text }
 *            lintPath(path)        → { files, violations } (file or dir, recursive)
 *            checkClientDir(dir,{log})                FAIL → throw (used by deploy scripts)
 *
 * Lexing: comments/strings/template literals are stripped before rule matching (code inside ${}
 * interpolation stays checked) — aiti-editor's Monaco TS stub template strings and JSDoc @return
 * are legal content; without stripping, everything false-positives.
 * Known limit: lexer ambiguities such as regex literals containing quotes may under-report
 * (the tripwire locates, it is not a compiler).
 *
 * Exemption: a line is skipped when it or the line above contains `check-client:allow`.
 * Authoritative source: this file; the aiti-extman deployed copy is copied by its tools/deploy.mjs
 * (keep both in sync when changing).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ── Rules (leveled) ──────────────────────────────────────────────────────────────

const RULES = [
  // FAIL: legal JS but guaranteed to blow up at runtime / pure TS syntax
  { level: "FAIL", re: /\b(useState|useRef|useMemo|useCallback|useReducer|useImperativeHandle)\s*</, why: "React hook generics (blows up at runtime)" },
  // Note: rules mentioning any/unknown/string build their RegExp from strings — this file itself
  // gets scanned; a regex literal like (?:any would match itself (the lexer does not handle regex
  // literals), while string literals are lexically masked.
  { level: "FAIL", re: new RegExp("\\bas\\s+(?:" + "any|unknown|const)\\b"), why: "as assertion" },
  { level: "FAIL", re: new RegExp(":\\s*(?:" + "any|unknown)\\b"), why: ": any/: unknown annotation" },
  { level: "FAIL", re: /\b(?:import|export)\s+type\s/, why: "import/export type" },
  { level: "FAIL", re: /\b(?:interface|enum)\s+[A-Za-z_$]/, why: "interface/enum declaration" },
  // warn: suspected leftover, confirm manually, non-blocking
  { level: "warn", re: new RegExp(":\\s*(?:" + "string|number|boolean|void)\\b(?!\\s*[._\\w])"), why: "suspected type annotation" },
  { level: "warn", re: /\bsatisfies\s/, why: "satisfies" },
  { level: "warn", re: /\b(?:Record|Partial|Readonly|Omit|Pick)\s*</, why: "TS utility type" },
];

// ── Lexical strip: comments/strings/template literals → spaces (newlines kept, line numbers stable) ─────────
export function stripLiterals(src) {
  const out = src.split("");
  const n = src.length;
  const mask = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let mode = "code";
  let depth = 0;
  const stack = []; // brace depth when entering a template ${ interpolation (nested templates supported)
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : "";
    if (mode === "code") {
      if (c === "/" && d === "/") {
        const j = src.indexOf("\n", i);
        const end = j === -1 ? n : j;
        mask(i, end);
        i = end;
      } else if (c === "/" && d === "*") {
        const j = src.indexOf("*/", i + 2);
        const end = j === -1 ? n : j + 2;
        mask(i, end);
        i = end;
      } else if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
        if (j < n && src[j] === c) {
          mask(i, j + 1);
          i = j + 1;
        } else {
          // unclosed at end of line → possible regex-literal ambiguity; mask only the quote, keep going as code
          out[i] = " ";
          i++;
        }
      } else if (c === "`") {
        mode = "tpl";
        out[i] = " ";
        i++;
      } else if (c === "{") {
        depth++;
        i++;
      } else if (c === "}") {
        if (stack.length && depth === stack[stack.length - 1]) {
          stack.pop();
          mode = "tpl"; // interpolation ends, back to template
          out[i] = " ";
        } else {
          depth = Math.max(0, depth - 1);
        }
        i++;
      } else i++;
    } else if (mode === "tpl") {
      if (c === "\\") {
        mask(i, Math.min(i + 2, n));
        i += 2;
      } else if (c === "`") {
        mode = "code";
        out[i] = " ";
        i++;
      } else if (c === "$" && d === "{") {
        stack.push(depth);
        mode = "code";
        mask(i, i + 2);
        i += 2;
      } else {
        if (c !== "\n") out[i] = " ";
        i++;
      }
    } else {
      // unreachable: line/block/strings are all handled inline in the code branch
      i++;
    }
  }
  return out.join("");
}

// ── Single-source check  ────────────────────────────────────────────────────────────────
export function lintClientSource(src) {
  const masked = stripLiterals(src);
  const origLines = src.split("\n");
  const maskedLines = masked.split("\n");
  const violations = [];
  for (let i = 0; i < maskedLines.length; i++) {
    const prev = i > 0 ? origLines[i - 1] : "";
    if (origLines[i].includes("check-client:allow") || prev.includes("check-client:allow")) continue;
    for (const { level, re, why } of RULES) {
      if (re.test(maskedLines[i])) {
        violations.push({ line: i + 1, level, rule: why, text: origLines[i].trim().slice(0, 90) });
      }
    }
  }
  return violations;
}

// ── File/dir check  ───────────────────────────────────────────────────────────
const SKIP_DIR = new Set(["node_modules", ".git"]);
/** Above this size a file is treated as a vendored bundle (e.g. Monaco ts.worker, legally contains the word interface) and skipped. */
const MAX_BYTES = 512 * 1024;
const isClientFile = (name) => /\.(mjs|js|cjs)$/.test(name) && !/\.min\./.test(name) && !/\.test\./.test(name);

export function lintPath(p, out = { files: 0, violations: [] }) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) {
      if (SKIP_DIR.has(name)) continue;
      lintPath(join(p, name), out);
    }
    return out;
  }
  const base = p.split("/").pop();
  if (!isClientFile(base)) return out;
  if (st.size > MAX_BYTES) return out; // vendored bundle exemption
  out.files++;
  for (const v of lintClientSource(readFileSync(p, "utf8"))) out.violations.push({ file: p, ...v });
  return out;
}

export function formatViolations(violations) {
  return violations
    .map((v) => `  ${v.level} ${v.file}:${v.line} [${v.rule}] ${v.text}`)
    .join("\n");
}

/** Used by deploy scripts: check a dir, throw on FAIL (message lists the violations); warn only logs, non-blocking. */
export function checkClientDir(dir, { log = console.log } = {}) {
  const { files, violations } = lintPath(resolve(dir));
  const fails = violations.filter((v) => v.level === "FAIL");
  const warns = violations.filter((v) => v.level === "warn");
  if (warns.length) log(`[check-client] ${warns.length} suspected TS leftovers (non-blocking, confirm manually):\n${formatViolations(warns)}`);
  if (fails.length) {
    throw new Error(
      `client check failed: ${fails.length} TS leftovers across ${files} files (legal JS in .mjs, syntax checks stay silent, blows up at runtime).\n` +
        formatViolations(fails) +
        `\nFix them, or add a // check-client:allow comment on the line to exempt. See docs/aiti-ext-client-hardening-plan.md`,
    );
  }
  if (files) log(`[check-client] ${files} client files passed`);
  return { files, fails: fails.length, warns: warns.length };
}

/**
 * Used by extman install: scan the whole extension dir (third parties included, no client/ convention).
 * On top of SKIP_DIR, also skip build-output/vendored dirs (Monaco ts.worker, language packs etc.
 * legally contain TS wording; the lexer makes no promises for minified code); same size cap as above.
 */
export function lintExtensionDir(dir) {
  const out = { files: 0, violations: [] };
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p)) {
        if (SKIP_DIR.has(name) || VENDORED_DIRS.has(name)) continue;
        walk(join(p, name));
      }
      return;
    }
    const base = p.split("/").pop();
    if (!isClientFile(base) || st.size > MAX_BYTES) return;
    out.files++;
    for (const v of lintClientSource(readFileSync(p, "utf8"))) out.violations.push({ file: p, ...v });
  };
  walk(resolve(dir));
  return out;
}
const VENDORED_DIRS = new Set(["vendor", "monaco", "dist", "build", "assets", "static", "bundles", "chunks"]);

// ── CLI ─────────────────────────────────────────────────────────────────────
function selftest() {
  const MUST_FAIL = [
    "const [st, setSt] = useState<any>(null);",
    "const r = useRef<number>(null);",
    "const x = v as any;",
    "function f(a: unknown) {}",
    'import type { Foo } from "./x";',
    "interface Foo { a: string }",
    "enum Color { Red }",
    "const y = v as const;",
  ];
  const MUST_WARN = [
    "const opts = { mode: string };",
    "x satisfies Y;",
    "const m: Record<string, any> = {};",
  ];
  const MUST_PASS = [
    'const REACT_TYPE_STUB = `\ndeclare module "react" {\n  export function useState<T>(init: T): [T];\n  export const Fragment: any;\n}\n`;',
    "/** @return {{chars1: string, chars2: string}} */",
    "const [s] = useState(null);",
    "useState<any>(null); // check-client:allow",
    "// check-client:allow\nuseState<never>(0);",
    "const cmp = a < b && c > (d);",
    "if (a // as any inside a comment does not count\n  ) run();",
  ];
  let bad = 0;
  const check = (src, expect, desc) => {
    const v = lintClientSource(src);
    const fails = v.filter((x) => x.level === "FAIL");
    const ok = expect === "FAIL" ? fails.length > 0 : expect === "PASS" ? v.length === 0 : v.length > 0 && fails.length === 0;
    if (!ok) {
      bad++;
      console.log(`SELFTEST FAIL [${desc}] expected ${expect}, got ${JSON.stringify(v)}`);
    }
  };
  MUST_FAIL.forEach((s) => check(s, "FAIL", s.slice(0, 40)));
  MUST_WARN.forEach((s) => check(s, "WARN", s.slice(0, 40)));
  MUST_PASS.forEach((s) => check(s, "PASS", s.replace(/\n/g, "⏎").slice(0, 40)));
  if (bad) {
    console.log(`selftest: ${bad} failed`);
    process.exit(1);
  }
  console.log("selftest: all passed (8 FAIL / 3 WARN / 7 PASS)");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv.includes("--selftest")) {
    selftest();
  } else if (process.argv.length > 2) {
    const all = { files: 0, violations: [] };
    for (const p of process.argv.slice(2)) lintPath(resolve(p), all);
    const fails = all.violations.filter((v) => v.level === "FAIL");
    const warns = all.violations.filter((v) => v.level === "warn");
    if (all.violations.length) console.log(formatViolations(all.violations));
    console.log(`\n${all.files} files: FAIL=${fails.length} warn=${warns.length}`);
    process.exit(fails.length ? 1 : 0);
  } else {
    console.log("usage: node check-client.mjs <file|dir>... | --selftest");
    process.exit(2);
  }
}
