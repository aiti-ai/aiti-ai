/**
 * 增量 patch「残缺集」误判回归测试（2026-09-12 修复）。
 *
 * 背景：store.refreshSessionsInner 的「行数骤降 >50% 视为残缺集」sanity 检查此前
 * 把 patch 响应也算进来 —— patch.up 通常只有 1 行，1771 行列表恒命中「骤降」，
 * 于是每次会话变化（SSE/事件触发的增量同步）都被判残缺：丢弃 + 清 rev +
 * 递归全量重拉 738KB（2026-09-12 chrome-devtools 实测调用栈
 * refreshSessionsInner→refreshSessionsInner 实锤）。
 *
 * 修复语义：
 *   - sanity 仅对【全量响应】生效（Array.isArray(d.sessions)）；
 *   - patch 响应（完整 diff，服务端已有 rm>30% 降级 + 冷启动禁 patch 保护）直接应用；
 *   - 全量骤降仍 keep-last 丢弃（rev 不推进，下轮 since 自动补）。
 *
 * 运行：node client/tests/incremental-patch.test.mjs（秒级）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "../../node_modules/esbuild/lib/main.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");
const serverRoot = join(here, "..", "..", "server");

const HOST_SHIM_STUB = [
  "export function useState<T>(_v: T) { return [undefined, () => {}] as [T, (v: T) => void]; }",
  "export function useEffect(_f: () => unknown, _d?: unknown[]) { /* noop */ }",
  "export function apiUrl(p: string) { return \"/dev\" + p; }",
  "export function getExtService<T>(_k: string): T | undefined { return undefined; }",
  "export function t(k: string) { return k; }",
  "export function getLocale() { return \"en\"; }",
].join("\n");
const EXT_FLOAT_STUB = [
  "export function present() { return {} as Record<string, unknown>; }",
  "export function presentState() { return \"closed\" as const; }",
  "export function openFloat() { /* test stub */ }",
  "export function closePanel() { /* test stub */ }",
].join("\n");

/** 隔离目录镜像 store.ts 的相对 import 结构（sm/client/src/ + _shared/ + sm/server/）。 */
function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-patch-test-"));
  const sm = join(dir, "sm");
  const clientSrc = join(sm, "client", "src");
  mkdirSync(join(clientSrc, "sidebar"), { recursive: true });
  writeFileSync(join(clientSrc, "store.ts"), readFileSync(join(srcRoot, "store.ts"), "utf8"));
  writeFileSync(join(clientSrc, "host-shim.ts"), HOST_SHIM_STUB);
  writeFileSync(join(clientSrc, "sidebar", "pure.ts"), readFileSync(join(srcRoot, "sidebar", "pure.ts"), "utf8"));
  mkdirSync(join(dir, "_shared"), { recursive: true });
  // store.ts 2026-09 起 import ext-float-dock-lite（present/openFloat/closePanel 门面）；
  // 旧名一并镜像（防其它 transitively 引用）。
  writeFileSync(join(dir, "_shared", "ext-float-dock-lite.ts"), EXT_FLOAT_STUB);
  writeFileSync(join(dir, "_shared", "ext-float-dock.ts"), EXT_FLOAT_STUB);
  writeFileSync(join(dir, "_shared", "dedupe-fetch.ts"), readFileSync(join(here, "..", "..", "..", "_shared", "dedupe-fetch.ts"), "utf8"));
  mkdirSync(join(sm, "server"), { recursive: true });
  writeFileSync(join(sm, "server", "payload.ts"), readFileSync(join(serverRoot, "payload.ts"), "utf8"));
  return dir;
}

const isoDir = setupIsolation();
const bundleOut = join(isoDir, "bundle", "store.mjs");
await build({
  entryPoints: [join(isoDir, "sm", "client", "src", "store.ts")],
  bundle: true, format: "esm", platform: "node",
  outfile: bundleOut, logLevel: "silent",
});

const mod = await import(pathToFileURL(bundleOut).href + "?" + Date.now());
const { store, refreshSessions } = mod;

// ── fetch mock：无 since → 全量；有 since → patch（up=1 行）──
let liveRows = [];
let fullCount = 0;
let patchCount = 0;
let overshrink = false; // 全量响应故意只剩 10 行（模拟服务端残缺集）
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/api/agent/running")) {
    return new Response(JSON.stringify({ runningSessionIds: [] }), { status: 200 });
  }
  if (u.includes("/sessions")) {
    const since = new URL(u, "http://x").searchParams.get("since");
    if (since) {
      patchCount++;
      // 服务端恒前进：patch { up: 变化行, rm: [] }（无 fmt=2 字段 → 旧形态路径，
      // sanity 判定与编码形态无关，此处专测判定逻辑本身）
      const changed = { ...liveRows[0], name: "changed-" + patchCount };
      return new Response(JSON.stringify({ rev: "rv-p" + patchCount, patch: { up: [changed], rm: [] } }), {
        status: 200, headers: { etag: '"rvp' + patchCount + '"' },
      });
    }
    fullCount++;
    const rows = overshrink ? liveRows.slice(0, 10) : liveRows;
    return new Response(JSON.stringify({ sessions: rows, archived: [], rev: "rv-" + fullCount }), {
      status: 200, headers: { etag: '"rv' + fullCount + '"' },
    });
  }
  return new Response("{}", { status: 404 });
};

// 初始态：120 行（>50，触发 sanity 的 prevCount 门槛）
liveRows = Array.from({ length: 120 }, (_, i) => ({
  id: "s" + i, cwd: "/c", name: "n" + i, modified: "2026-09-01T00:00:00Z", messageCount: 1,
}));

test("首拉全量：store 落地 120 行", async () => {
  await refreshSessions({ force: true });
  assert.equal(fullCount, 1, "首拉 1 次全量");
  assert.equal(store.sessions.length, 120);
});

test("【回归】增量 patch 正常应用，不再触发全量重拉", async () => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(a.map(String).join(" ")); };
  try {
    liveRows[0] = { ...liveRows[0], modified: "2026-09-02T00:00:00Z" }; // 触发变化
    const beforeFull = fullCount;
    await refreshSessions({ force: true }); // 事件触发的增量同步
    assert.equal(patchCount, 1, "第二次请求走 patch 通道（带 since）");
    assert.equal(fullCount, beforeFull, "patch 后不再有全量重拉（修复前此处 +1）");
    assert.equal(warns.length, 0, "不再出现「残缺集」误判 warn（修复前必现）");
    assert.equal(store.sessions.length, 120, "patch 应用后行数不变");
    assert.equal(store.sessions.find((s) => s.id === "s0")?.name, "changed-1", "patch 行已更新");
  } finally {
    console.warn = origWarn;
  }
});

test("全量骤降仍被保护：keep-last 丢弃、无自愈重拉", async () => {
  overshrink = true;
  const beforeFull = fullCount;
  const beforePatch = patchCount;
  await refreshSessions({ refresh: true }); // 强制全量（不带 since）
  assert.equal(fullCount, beforeFull + 1, "全量请求确实发出");
  assert.equal(store.sessions.length, 120, "残缺全量被丢弃（keep last）");
  assert.equal(fullCount, beforeFull + 1, "无额外全量重拉");
  assert.equal(patchCount, beforePatch, "无额外 patch 请求");
  overshrink = false;
});
