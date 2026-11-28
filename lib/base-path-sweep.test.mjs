/**
 * base-path-sweep.test.mjs —— 全量客户端路径卫生巡检（覆盖所有功能入口）。
 *
 * 背景：upstream v0.14/v0.15 的组件硬编码根绝对路径 fetch("/api/...")，子路径部署
 * （/dev、/win、/mac）下全部 404——e2e 实测回归（2026-11-05，45+ 处修复，见
 * "fix(base-path)" 提交系列）。本测试把那一轮的机械规则变成常驻闸门：
 *
 *   客户端源码里，任何以 "/api/"（或 "/sw"、"/manifest.webmanifest"）开头、
 *   未经过 apiUrl()/withBasePath() 包裹的调用形态都算违规：
 *     fetch("/api/…        fetch(`/api/…      fetchImpl("/api/…
 *     new EventSource("/api/…   new Request("/api/…   navigator.sendBeacon("/api/…
 *     return "/api/…            return `/api/…      （URL builder 函数）
 *
 * apiUrl/withBasePath 包裹后的形态（fetch(apiUrl("/api/…")）天然不被上述正则命中，
 * 因此无需逐行豁免。外部服务的 `${origin}/api/…` 形态同样不命中（非根绝对路径字面量）。
 *
 * Run: node --experimental-strip-types --test lib/base-path-sweep.test.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const SCAN_DIRS = ["app", "components", "hooks", "lib", "public"];
const VIOLATION = new RegExp(
  [
    '\\bfetch\\(\\s*["\'`]/(?:api|sw|manifest\\.webmanifest)',
    "\\bfetchImpl\\(\\s*[\"'`]/api/",
    "\\bnew EventSource\\(\\s*[\"'`]/api/",
    "\\bnew Request\\(\\s*[\"'`]/api/",
    '\\bnavigator\\.sendBeacon\\(\\s*["\'`]/api/',
    '\\breturn\\s+["\'`]/api/',
  ].join("|"),
  "g",
);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "vendor" || e.name === "__pycache__") continue;
      yield* walk(p);
    } else if (/\.(tsx?|js|mjs)$/.test(e.name) && !/\.test\.(mjs|js)$/.test(e.name) && !/\.min\.(js|mjs)$/.test(e.name)) {
      yield p;
    }
  }
}

function clientSources() {
  const out = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(root, dir);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of walk(abs)) {
      // 服务端路由不受 basePath 客户端契约约束（server fetch 自指本源）
      if (relative(root, f).replace(/\\/g, "/").startsWith("app/api/")) continue;
      out.push(f);
    }
  }
  return out;
}

test("客户端源码无未包裹的根绝对 API 路径（子路径部署回归闸门）", () => {
  const violations = [];
  for (const f of clientSources()) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(VIOLATION)) {
      const line = src.slice(0, m.index).split("\n").length;
      violations.push(`${relative(root, f).replace(/\\/g, "/")}:${line} → ${m[0].slice(0, 60)}`);
    }
  }
  assert.deepEqual(violations, [], "以下调用会绕过 basePath（改用 apiUrl()/withBasePath()）");
});

test("扫描器自检：合成违规必须命中（防正则静默失效）", () => {
  const probe = [
    'const r = fetch("/api/models");',
    "const e = new EventSource(`/api/agent/${id}/events`);",
    'function u() { return "/api/home"; }',
    'navigator.sendBeacon("/api/push/subscribe", blob);',
  ];
  let hits = 0;
  for (const line of probe) {
    VIOLATION.lastIndex = 0;
    if (VIOLATION.test(line)) hits += 1;
  }
  assert.equal(hits, probe.length, "扫描正则未能识别合成违规");
  // 负控制：包裹后的形态不得命中
  const wrapped = [
    'const r = fetch(apiUrl("/api/models"));',
    'const e = new EventSource(apiUrl(`/api/agent/${id}/events`));',
    'function u() { return apiUrl("/api/home"); }',
  ];
  for (const line of wrapped) {
    VIOLATION.lastIndex = 0;
    assert.equal(VIOLATION.test(line), false, `包裹形态被误报: ${line}`);
  }
});
