/**
 * check-client —— 扩展 client .mjs/.js 的 TS 残留 tripwire（零依赖，纯 node）。
 *
 * 背景：aiti-plan-review 事故（docs/aiti-ext-client-hardening-plan.md §1）——
 * `useState<any>(null)` 解析为合法 JS 比较表达式 `useState < any > (null)`，
 * node --check / TS 解析器 / babel 全不报错，只有运行时才炸。纯语法检查
 * 原理性无效，只能启发式规则 + 渲染期错误边界兜底。
 *
 * 用法：
 *   CLI    node check-client.mjs <file|dir>...        FAIL → exit 1
 *   自测   node check-client.mjs --selftest           fixtures 全过 → exit 0
 *   API    lintClientSource(src) → violations[]       { line, level, rule, text }
 *          lintPath(path)        → { files, violations }（文件或目录，递归）
 *          checkClientDir(dir,{log})                 FAIL → throw（deploy 脚本用）
 *
 * 词法：规则匹配前先剥离注释/字符串/模板字面量（${} 插值内代码保留检查）——
 * aiti-editor 的 Monaco TS stub 模板串、JSDoc @return 都是合法内容，不剥全误报。
 * 已知极限：regex 字面量含引号等 lexer 歧义允许漏报（tripwire 定位非编译器）。
 *
 * 豁免：目标行或其上一行含 `check-client:allow` 即跳过该行。
 * 权威源：本文件；aiti-extman 部署副本由其 tools/deploy.mjs 拷贝（改动两处同步）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ── 规则（分级）──────────────────────────────────────────────────────────────

const RULES = [
  // FAIL：合法 JS 但运行时必炸 / 纯 TS 语法
  { level: "FAIL", re: /\b(useState|useRef|useMemo|useCallback|useReducer|useImperativeHandle)\s*</, why: "React hook 泛型（运行时必炸）" },
  // 注：含「any/unknown/string」字样的规则用字符串构 RegExp——本文件自身也
  // 会被扫，正则字面量里的 (?:any 会被自己命中（词法器不处理 regex 字面量），
  // 字符串字面量则会被词法遮蔽。
  { level: "FAIL", re: new RegExp("\\bas\\s+(?:" + "any|unknown|const)\\b"), why: "as 断言" },
  { level: "FAIL", re: new RegExp(":\\s*(?:" + "any|unknown)\\b"), why: ": any/: unknown 注解" },
  { level: "FAIL", re: /\b(?:import|export)\s+type\s/, why: "import/export type" },
  { level: "FAIL", re: /\b(?:interface|enum)\s+[A-Za-z_$]/, why: "interface/enum 声明" },
  // warn：疑似残留，人工确认，不阻断
  { level: "warn", re: new RegExp(":\\s*(?:" + "string|number|boolean|void)\\b(?!\\s*[._\\w])"), why: "疑似类型注解" },
  { level: "warn", re: /\bsatisfies\s/, why: "satisfies" },
  { level: "warn", re: /\b(?:Record|Partial|Readonly|Omit|Pick)\s*</, why: "TS 工具类型" },
];

// ── 词法剥离：注释/字符串/模板字面量 → 空格（保留换行，行号不漂移）─────────
export function stripLiterals(src) {
  const out = src.split("");
  const n = src.length;
  const mask = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let mode = "code";
  let depth = 0;
  const stack = []; // 模板 ${ 插值进入时的 brace 深度（支持嵌套模板）
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
          // 未闭合到行尾 → 可能是 regex 字面量歧义，只遮开引号，按代码继续
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
          mode = "tpl"; // 插值结束回模板
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
      // 不可达：line/block/字符串均在 code 分支内联处理
      i++;
    }
  }
  return out.join("");
}

// ── 单源检查 ────────────────────────────────────────────────────────────────
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

// ── 文件/目录检查 ───────────────────────────────────────────────────────────
const SKIP_DIR = new Set(["node_modules", ".git"]);
/** 超过此体积视为 vendored bundle（如 Monaco ts.worker，合法含 interface 字样），不查。 */
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
  if (st.size > MAX_BYTES) return out; // vendored bundle 豁免
  out.files++;
  for (const v of lintClientSource(readFileSync(p, "utf8"))) out.violations.push({ file: p, ...v });
  return out;
}

export function formatViolations(violations) {
  return violations
    .map((v) => `  ${v.level} ${v.file}:${v.line} [${v.rule}] ${v.text}`)
    .join("\n");
}

/** deploy 脚本用：检查目录，FAIL 抛错（消息含违规清单），warn 只打日志不阻断。 */
export function checkClientDir(dir, { log = console.log } = {}) {
  const { files, violations } = lintPath(resolve(dir));
  const fails = violations.filter((v) => v.level === "FAIL");
  const warns = violations.filter((v) => v.level === "warn");
  if (warns.length) log(`[check-client] ${warns.length} 处疑似 TS 残留（不阻断，建议人工确认）：\n${formatViolations(warns)}`);
  if (fails.length) {
    throw new Error(
      `client 检查未通过：${files} 个文件中 ${fails.length} 处 TS 残留（.mjs 里是合法 JS，语法检查不报，运行时必炸）。\n` +
        formatViolations(fails) +
        `\n修复或在该行加注释 // check-client:allow 豁免。详见 docs/aiti-ext-client-hardening-plan.md`,
    );
  }
  if (files) log(`[check-client] ${files} 个 client 文件检查通过`);
  return { files, fails: fails.length, warns: warns.length };
}

/**
 * extman 安装用：扫整个扩展目录（含第三方，不遵循 client/ 约定）。
 * 在 SKIP_DIR 之上额外跳过构建产物/vendored 目录（Monaco ts.worker、语言包等
 * 合法包含 TS 字样，词法器对 minified 代码不提供保证）；体积上限同上。
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
    "if (a // 注释里 as any 不算\n  ) run();",
  ];
  let bad = 0;
  const check = (src, expect, desc) => {
    const v = lintClientSource(src);
    const fails = v.filter((x) => x.level === "FAIL");
    const ok = expect === "FAIL" ? fails.length > 0 : expect === "PASS" ? v.length === 0 : v.length > 0 && fails.length === 0;
    if (!ok) {
      bad++;
      console.log(`SELFTEST FAIL [${desc}] 期望 ${expect}，实际 ${JSON.stringify(v)}`);
    }
  };
  MUST_FAIL.forEach((s) => check(s, "FAIL", s.slice(0, 40)));
  MUST_WARN.forEach((s) => check(s, "WARN", s.slice(0, 40)));
  MUST_PASS.forEach((s) => check(s, "PASS", s.replace(/\n/g, "⏎").slice(0, 40)));
  if (bad) {
    console.log(`selftest: ${bad} 处未过`);
    process.exit(1);
  }
  console.log("selftest: 全部通过（8 FAIL / 3 WARN / 7 PASS）");
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
    console.log(`\n${all.files} 个文件：FAIL=${fails.length} warn=${warns.length}`);
    process.exit(fails.length ? 1 : 0);
  } else {
    console.log("用法：node check-client.mjs <file|dir>... ｜ --selftest");
    process.exit(2);
  }
}
