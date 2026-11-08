#!/usr/bin/env node
// release-audit.mjs —— 扩展/插件公开发布审核器（15 项清单，docs/aiti-ai-npm-release-plan.md §4.2）。
//
// 用法：
//   node tools/release-audit.mjs                          # 审核全部（只报告）
//   node tools/release-audit.mjs --fix                    # 机械项自动修复（脱敏/元数据/LICENSE/lock）
//   node tools/release-audit.mjs --target official        # 按 official 口径审核（lock 私源 URL 视为违规）
//   node tools/release-audit.mjs --target staging         # 按 staging 口径（私源 resolved 允许——源即私域）
//   node tools/release-audit.mjs --only aiti-float,...    # 只审指定扩展
//   node tools/release-audit.mjs --json report.json       # 结构化报告落盘
//   node tools/release-audit.mjs --smoke                  # 附带安装冒烟（每扩展 tgz 干净安装+入口探测）
//
// 退出码：全部通过 0；有任何 FAIL 1。--fix 修复后重审直至通过或仅剩人工项。
// 覆盖：pi-web-ext/* 全部扩展 + 仓根插件（pi-models-combo、pi-subagents、pi-git-trace、pi-ext/*）。
// private 包（pi-subagents/qoder-private）审 A 项（脱敏）跳过发布项。

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname, resolve, relative, basename } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extProtocolInfo } from "../extensions/_shared/ext-protocol.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions");
const REPO = resolve(ROOT, "..");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const FIX = has("--fix");
const SMOKE = has("--smoke");
const ONLYIdx = args.indexOf("--only");
const ONLY = ONLYIdx >= 0 ? args[ONLYIdx + 1].split(",").map(s => s.trim()) : null;
const JSONOut = args.indexOf("--json") >= 0 ? args[args.indexOf("--json") + 1] : null;
const tIdx = args.indexOf("--target");
const TARGET = tIdx >= 0 ? args[tIdx + 1] : (process.env.AITI_NPM_TARGET || "staging");
if (!["staging", "official"].includes(TARGET)) {
  console.error(`--target/--AITI_NPM_TARGET 必须为 staging|official，得到: ${TARGET}`);
  process.exit(2);
}
const REGISTRY = TARGET === "official" ? "https://registry.npmjs.org/" : "https://registry.npmjs.org/";

// ---- 发布范围（与 publish-all.mjs 同口径）----
const EXCLUDE = new Set(["demo", "demo-lazy", "sm-demo-source", "templates", "shared"]);
const PLUGIN_ROOTS = ["pi-plugins", "packages"];

// ---- 脱敏规则（与 sync-extensions-to-aiti-ai.mjs 同口径 + 官方源补充）----
const REDACT = [
  [/\/home\/wind/g, "/home/pi"],
  [/192\.168\.5\./g, "192.168.122."],
  [/https:\/\/npm\.alot\.pw/g, "https://registry.npmjs.org"],
  [/([a-z0-9-]+\.)*alot\.pw/g, (m) => m.replace(/\.alot\.pw$/, ".example.com").replace(/^alot\.pw$/, "example.com")],
  [/user/g, "user"],
];

// A1 扫描的额外敏感形态（官方源口径：私源引用本身也是违规）
const SCAN_PATTERNS = [
  [/alot\.pw/i, "内部域名 example.com"],
  [/\/home\/wind/g, "真实用户路径 /home/pi"],
  [/192\.168\.5\./g, "内网拓扑段 192.168.122.*"],
  [/\buser\b/i, "内部用户名 user"],
];

const MIT_LICENSE = `MIT License

Copyright (c) 2026 aiti-ai contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// ---- 收集包 ----
const pkgs = [];
function addPkg(pkgDir, tag) {
  const pjPath = join(pkgDir, "package.json");
  let p;
  try { p = JSON.parse(readFileSync(pjPath, "utf8")); } catch { return; }
  pkgs.push({ dir: basename(pkgDir) + (tag ? ` (${tag})` : ""), pkgDir, pjPath, p, isExt: tag === undefined });
}
for (const d of readdirSync(ROOT)) {
  if (EXCLUDE.has(d)) continue;
  const pj = join(ROOT, d, "package.json");
  if (existsSync(pj)) addPkg(join(ROOT, d));
}
for (const rel of PLUGIN_ROOTS) {
  const abs = join(REPO, rel);
  if (existsSync(join(abs, "package.json"))) { addPkg(abs, "plugin"); continue; }
  if (!existsSync(abs)) continue;
  for (const d of readdirSync(abs, { withFileTypes: true })) {
    if (d.isDirectory() && existsSync(join(abs, d.name, "package.json"))) addPkg(join(abs, d.name), "plugin");
  }
}

function* srcFiles(pkgDir) {
  // 审核范围：源码文本（排除 node_modules/dist/构建产物——dist 由构建生成，扫源码）
  for (const e of walk(pkgDir)) {
    if (/\.(tsx?|mjs|js|cjs|json|md|html|css|sh|yml|yaml|py|svg)$/.test(e) && !/\.min\.(js|mjs)$/.test(e)) yield e;
  }
}
function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", "dist", ".git", "__pycache__", "vendor"].includes(e.name)) continue;
      yield* walk(p);
    } else yield p;
  }
}

// ---- 各项检查（返回 { state: "pass"|"fail"|"warn", detail }）----
const checks = {
  // A1 脱敏扫描（源码文本，dist/node_modules 排除）
  A1_scan(src, pkgDir) {
    const hits = [];
    for (const f of srcFiles(pkgDir)) {
      const text = readFileSync(f, "utf8");
      for (const [pat, label] of SCAN_PATTERNS) {
        let m;
        const re = new RegExp(pat.source, "gm");
        while ((m = re.exec(text))) {
          const line = text.slice(0, m.index).split("\n").length;
          hits.push(`${relative(pkgDir, f).replace(/\\/g, "/")}:${line} ${label}`);
          if (hits.length > 20) return { state: "fail", hits };
        }
      }
    }
    return hits.length ? { state: "fail", hits } : { state: "pass" };
  },
  fix_A1_scan(pkgDir) {
    let n = 0;
    for (const f of srcFiles(pkgDir)) {
      const text = readFileSync(f, "utf8");
      let t = text;
      for (const [re, to] of REDACT) t = t.replace(re, to);
      if (t !== text) { writeFileSync(f, t); n++; }
    }
    return n;
  },
  // A2 lock 私源 URL（official 口径违规；staging 源即私域，允许）
  A2_lock(pkgDir, isExt) {
    const lock = join(pkgDir, "package-lock.json");
    if (!existsSync(lock)) return { state: "pass", detail: "无 lock" };
    const text = readFileSync(lock, "utf8");
    const n = (text.match(/npm\.alot\.pw/g) || []).length;
    if (TARGET === "official" && n > 0) return { state: "fail", detail: `${n} 处私源 resolved URL` };
    return { state: "pass", detail: n ? `${n} 处（staging 口径允许）` : "" };
  },
  fix_A2_lock(pkgDir) {
    const lock = join(pkgDir, "package-lock.json");
    if (!existsSync(lock)) return 0;
    const text = readFileSync(lock, "utf8");
    const t = text.replace(/https:\/\/npm\.alot\.pw/g, "https://registry.npmjs.org");
    if (t !== text) { writeFileSync(lock, t); return 1; }
    return 0;
  },
  // B5 name
  B5_name(p, dir) {
    if (p.name && p.name.startsWith("@aiti-ai/")) return { state: "pass" };
    return { state: "fail", detail: `name="${p.name || "无"}" → @aiti-ai/<id>` };
  },
  // B6 version
  B6_version(p) {
    if (p.version && /^\d+\.\d+\.\d+/.test(p.version)) return { state: "pass" };
    return { state: "fail", detail: `version="${p.version || "无"}"` };
  },
  // B7 license + LICENSE 文件
  B7_license(p, pkgDir) {
    const hasLicenseFile = existsSync(join(pkgDir, "LICENSE"));
    if (p.license && hasLicenseFile) return { state: "pass" };
    return { state: "fail", detail: `license=${p.license || "无"} LICENSE 文件=${hasLicenseFile ? "有" : "无"}` };
  },
  // B8 protocol（仅 pi-web-ext 扩展）
  B8_protocol(p) {
    const proto = extProtocolInfo(p.aitiExtProtocol);
    if (proto.state === "missing" || proto.state === "invalid") return { state: "fail", detail: `aitiExtProtocol=${p.aitiExtProtocol || "缺失"}` };
    return { state: "pass" };
  },
  // C9 dist 构建（有 build:client 的扩展）
  C9_dist(p, pkgDir) {
    if (!p.scripts?.["build:client"]) return { state: "pass", detail: "无 client 构建（纯服务端扩展）" };
    // "build:client": "true" 是纯服务端扩展的占位约定（无客户端产物，非缺构建）
    if (p.scripts["build:client"].trim() === "true") return { state: "pass", detail: "无 client 构建（占位约定）" };
    const dist = join(pkgDir, "dist");
    if (!existsSync(dist)) return { state: "fail", detail: "dist/ 不存在（未构建）" };
    const files = readdirSync(dist);
    if (!files.length) return { state: "fail", detail: "dist/ 为空" };
    return { state: "pass", detail: `${files.length} 文件` };
  },
  // C11 client:/main 路径与包内文件对齐
  C11_paths(p, pkgDir) {
    const out = [];
    for (const key of ["client", "main"]) {
      const v = p[key];
      if (!v) continue;
      const rel = String(v).replace(/^\.\//, "");
      if (!existsSync(join(pkgDir, rel))) out.push(`${key}: ${rel} 不存在`);
    }
    return out.length ? { state: "fail", detail: out.join("; ") } : { state: "pass" };
  },
  // D12 @aiti-ai/* 依赖在目标 registry 可解析
  D12_deps(p) {
    const bad = [];
    const deps = { ...(p.dependencies || {}) };
    for (const [name, spec] of Object.entries(deps)) {
      if (!name.startsWith("@aiti-ai/")) continue;
      const version = spec.replace(/^[~^]/, "");
      try {
        execSync(`npm view ${JSON.stringify(name)} versions --json --registry ${REGISTRY}`, { encoding: "utf8", timeout: 30_000 });
      } catch { bad.push(`${name}@${spec} 在 ${REGISTRY} 不可解析`); continue; }
      void version;
    }
    return bad.length ? { state: "fail", detail: bad.join("; ") } : { state: "pass" };
  },
  // D14 postinstall 副作用（信息项；patch-package 白名单）
  D14_postinstall(p) {
    const scripts = p.scripts || {};
    const side = ["postinstall", "prepublish", "prepare"].filter((k) => scripts[k]);
    if (!side.length) return { state: "pass" };
    const ok = side.every((k) => /patch-package|prepare-terminal/.test(scripts[k]));
    return ok ? { state: "pass", detail: scripts[side[0]].slice(0, 40) } : { state: "warn", detail: scripts[side[0]].slice(0, 60) };
  },
};

// ---- 修复器 ----
const fixes = {
  fix_B5_name(p, pjPath, dir) {
    if (p.name && p.name.startsWith("@aiti-ai/")) return false;
    p.name = p.name.includes("/") ? p.name : `${"@aiti-ai"}/${p.name}`;
    writeFileSync(pjPath, JSON.stringify(p, null, 2) + "\n");
    return true;
  },
  fix_B7_license(p, pjPath, pkgDir) {
    let changed = false;
    if (!p.license) { p.license = "MIT"; changed = true; }
    writeFileSync(pjPath, JSON.stringify(p, null, 2) + "\n");
    if (!existsSync(join(pkgDir, "LICENSE"))) { writeFileSync(join(pkgDir, "LICENSE"), MIT_LICENSE); changed = true; }
    return changed;
  },
  fix_B8_protocol(p, pjPath) {
    if (p.aitiExtProtocol) return false;
    p.aitiExtProtocol = "1.0";
    writeFileSync(pjPath, JSON.stringify(p, null, 2) + "\n");
    return true;
  },
  fix_C9_dist(pkgDir) {
    if (!existsSync(join(pkgDir, "package.json"))) return false;
    const p = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    if (!p.scripts?.["build:client"]) return false;
    try {
      execSync("npm run build:client", { cwd: pkgDir, stdio: "pipe" });
      return true;
    } catch { return false; }
  },
};

// E15 安装冒烟：tgz → 干净目录安装 → 入口探测
function installSmoke(pkgDir, p, dir) {
  const tmp = mkdtempSync(join(tmpdir(), `smoke-${dir}-`));
  try {
    const tgz = execSync("npm pack --dry-run 2>/dev/null && npm pack", { cwd: pkgDir, encoding: "utf8" });
    void tgz;
    const tgzFile = readdirSync(pkgDir).find((f) => f.endsWith(".tgz"));
    if (!tgzFile) return { state: "fail", detail: "npm pack 无产物" };
    const r = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error", join(pkgDir, tgzFile)], {
      cwd: tmp, encoding: "utf8", timeout: 180_000, shell: process.platform === "win32",
    });
    if (r.status !== 0) return { state: "fail", detail: `安装失败: ${(r.stderr || "").slice(-120)}` };
    // 入口探测：client bundle / index.ts / main 在安装结果里存在
    const installed = join(tmp, "node_modules", p.name);
    if (!existsSync(installed)) return { state: "fail", detail: "安装后包目录缺失" };
    const distOk = existsSync(join(installed, "dist")) || existsSync(join(installed, "index.ts")) || p.main && existsSync(join(installed, p.main));
    rmSync(join(pkgDir, tgzFile), { force: true });
    return distOk ? { state: "pass" } : { state: "fail", detail: "入口文件缺失" };
  } catch (e) {
    return { state: "fail", detail: e.message.slice(0, 100) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- 主流程 ----
import { tmpdir } from "node:os";
const onlyArgs = ONLY;
const results = [];
let passN = 0, failN = 0;

for (const { dir, pkgDir, pjPath, p, isExt } of pkgs) {
  if (EXCLUDE.has(dir)) continue;
  if (onlyArgs && !onlyArgs.some((o) => dir.includes(o))) continue;
  const private_ = p.private === true;
  const row = { dir, version: p.version || null, private: private_, items: {}, failures: [] };

  // A1 脱敏（含 --fix）
  let a1 = checks.A1_scan(null, pkgDir);
  if (a1.state === "fail" && FIX) {
    const n = checks.fix_A1_scan(pkgDir);
    a1 = checks.A1_scan(null, pkgDir);
    a1.detail = `--fix 改写 ${n} 文件后重扫`;
  }
  row.items.A1 = a1;

  // A2 lock（official 口径；含 --fix）
  if (!private_) {
    let a2 = checks.A2_lock(pkgDir, isExt);
    if (a2.state === "fail" && FIX) {
      checks.fix_A2_lock(pkgDir);
      a2 = checks.A2_lock(pkgDir, isExt);
      a2.detail = "已重写为官方源";
    }
    row.items.A2 = a2;
  }

  // B5/B6/B7/B8（含 --fix）
  if (!private_) {
    let b5 = checks.B5_name(p, dir);
    if (b5.state === "fail" && FIX && checks.fix_B5_name(p, pjPath, dir)) b5 = { state: "pass", detail: "已改名" };
    row.items.B5 = b5;
    row.items.B6 = checks.B6_version(p);
    let b7 = checks.B7_license(p, pkgDir);
    if (b7.state === "fail" && FIX && fixes.fix_B7_license(p, pjPath, pkgDir)) b7 = { state: "pass", detail: "已注入 MIT/LICENSE" };
    row.items.B7 = b7;
    if (isExt) {
      let b8 = checks.B8_protocol(p);
      if (b8.state === "fail" && FIX && fixes.fix_B8_protocol(p, pjPath)) b8 = { state: "pass", detail: "已补 1.0" };
      row.items.B8 = b8;
    }
  }

  // C9 dist（含 --fix 构建）
  if (!private_) {
    let c9 = checks.C9_dist(p, pkgDir);
    if (c9.state === "fail" && FIX && fixes.fix_C9_dist(pkgDir)) c9 = checks.C9_dist(p, pkgDir);
    row.items.C9 = c9;
    row.items.C11 = checks.C11_paths(p, pkgDir);
    row.items.D12 = checks.D12_deps(p);
  }
  row.items.D14 = checks.D14_postinstall(p);

  // E15 冒烟（可选；--fix 后重跑才有意义）
  if (SMOKE && !private_) {
    row.items.E15 = installSmoke(pkgDir, p, dir);
  }

  // 汇总
  const fails = Object.entries(row.items).filter(([, v]) => v.state === "fail");
  row.result = fails.length === 0 ? "PASS" : (FIX && fails.every(([, v]) => v.detail && v.detail.includes("--fix")) ? "PASS(fixed)" : "FAIL");
  if (fails.length) row.failures = fails.map(([k, v]) => `${k}: ${v.detail || ""}`);
  if (row.result === "PASS") passN++; else failN++;
  results.push(row);
  const mark = row.result.startsWith("PASS") ? "✅" : "❌";
  console.log(`${mark} ${dir}@${p.version || "?"} → ${row.result}${row.failures ? " | " + row.failures.join(" | ") : ""}`);
}

console.log(`\n===== 审核报告（target=${TARGET} fix=${FIX ? "on" : "off"} smoke=${SMOKE ? "on" : "off"}）=====`);
console.log(`通过 ${passN} / 失败 ${failN} / 共 ${results.length}`);
if (failN) {
  console.log("\n失败明细：");
  for (const r of results.filter((r) => r.result === "FAIL")) {
    console.log(`  ${r.dir}: ${r.failures.join(" | ")}`);
  }
}
if (JSONOut) writeFileSync(JSONOut, JSON.stringify({ target: TARGET, generatedAt: new Date().toISOString(), results }, null, 2));
if (failN) process.exitCode = 1;
