/**
 * store.applySessionNameLocal / 本地改名 override 测试（2026-09-12「重命名不刷新」修复回归）。
 *
 * 覆盖：live/archived/projectSessions 三桶就地改名 + emit；未命中不 emit；在途旧响应落地时
 * override 套回（防闪回）；服务端数据对齐后确认清除（此后服务端值为准）；
 * [2026-09-22 补] scoped 桶（左栏 dock 渲染源）同样就地生效，且 scoped 落地只套回不清
 * override——scoped 响应不含其它项目的行，据此判「行已消失」会把别处的乐观值丢掉。
 *
 * 运行：node client/tests/apply-session-name.test.mjs（秒级；不涉 pending 补拉链）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

/** 隔离目录镜像 store.ts 的相对 import 结构（sm/client/src/ + _shared/ + sm/server/）。
 *  与 pending-drafts.test.mjs 同款（相对层级少一层则构建解析失败）。 */
function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-name-test-"));
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
const { store, subscribe, refreshSessions, refreshProjectSessions, applySessionNameLocal } = mod;

// ── fetch mock：/sessions 恒 200 全量（每次 rev 前进），/api/agent/running 空集 ──
let liveRows = [];
let archRows = [];
/** 非空时 scoped 请求（URL 带 project=）用它应答——模拟「本项目只含全表一部分行」。 */
let scopedRows = null;
let revSeq = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/api/agent/running")) return new Response(JSON.stringify({ runningSessionIds: [] }), { status: 200 });
  if (u.includes("/sessions")) {
    revSeq += 1;
    const scoped = u.includes("project=") && scopedRows !== null ? scopedRows : null;
    // 全量响应无 etag 条件——每次 refresh 都真实应用（覆盖路径即本测试目标）
    return new Response(JSON.stringify({
      sessions: scoped ?? liveRows,
      archived: scoped ? [] : archRows,
      rev: "rv-" + revSeq,
    }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
};

const row = (id, name) => ({ id, cwd: "/w", name, modified: "2026-09-07T00:00:00Z", messageCount: 1 });

test("applySessionNameLocal：live 桶命中就地改名 + emit 一次，他行不动", async () => {
  liveRows = [row("s1", "旧名"), row("s2", "别的")];
  archRows = [];
  await refreshSessions({ force: true });
  let emitted = 0;
  const unsub = subscribe(() => emitted++);
  applySessionNameLocal("s1", "新名");
  assert.equal(emitted, 1, "命中 → emit 一次");
  assert.equal(store.sessions.find((r) => r.id === "s1").name, "新名");
  assert.equal(store.sessions.find((r) => r.id === "s2").name, "别的", "他行保持原样");
  unsub();
});

test("applySessionNameLocal：archived 桶命中同样就地改名（两桶都扫）", async () => {
  liveRows = [];
  archRows = [row("a1", "归档旧名")];
  await refreshSessions({ force: true });
  let emitted = 0;
  const unsub = subscribe(() => emitted++);
  applySessionNameLocal("a1", "归档新名");
  assert.equal(emitted, 1);
  assert.equal(store.archived.find((r) => r.id === "a1").name, "归档新名");
  unsub();
});

test("applySessionNameLocal：id 不在册不 emit（等下次刷新自然带出）", async () => {
  liveRows = [row("s1", "旧名")];
  archRows = [];
  await refreshSessions({ force: true });
  let emitted = 0;
  const unsub = subscribe(() => emitted++);
  applySessionNameLocal("nope", "X");
  assert.equal(emitted, 0, "未命中 → 不 emit");
  unsub();
});

test("本地改名 override：在途旧响应落地不盖回；服务端对齐后确认清除", async () => {
  liveRows = [row("s1", "旧名")];
  archRows = [];
  await refreshSessions({ force: true });
  applySessionNameLocal("s1", "新名");
  assert.equal(store.sessions.find((r) => r.id === "s1").name, "新名");

  // 模拟重命名前已发出的在途全量响应（服务端仍是旧名）在乐观更新后落地 → 套回乐观值
  liveRows = [row("s1", "旧名")];
  await refreshSessions({ force: true });
  assert.equal(store.sessions.find((r) => r.id === "s1").name, "新名", "在途旧响应不得盖回新名（override 生效）");

  // 服务端数据对齐（新名）→ override 确认清除
  liveRows = [row("s1", "新名")];
  await refreshSessions({ force: true });
  assert.equal(store.sessions.find((r) => r.id === "s1").name, "新名");

  // 清除验证：服务端此后报第三名（如 TUI 侧改名）→ 直接采纳，override 不再干预
  liveRows = [row("s1", "第三方改名")];
  await refreshSessions({ force: true });
  assert.equal(store.sessions.find((r) => r.id === "s1").name, "第三方改名", "确认后 override 已清除");
});

test("scoped 桶（左栏 dock 渲染源）：就地改名同样生效并 emit", async () => {
  liveRows = [row("k1", "旧名")];
  archRows = [];
  scopedRows = [row("k1", "旧名")];
  await refreshSessions({ force: true });
  await refreshProjectSessions("proj-k");
  assert.deepEqual(store.projectSessions.map((r) => String(r.id)), ["k1"], "前置：dock 行在 scoped 桶");
  let emitted = 0;
  const unsub = subscribe(() => emitted++);
  applySessionNameLocal("k1", "新名");
  assert.ok(emitted >= 1, "命中 scoped 行也要 emit（否则 dock 不重绘）");
  assert.equal(store.projectSessions.find((r) => r.id === "k1").name, "新名");
  unsub();
  scopedRows = null;
});

test("全量通道尚未加载：只改 scoped 行也即时生效（原 found=false 直接 return）", async () => {
  liveRows = [];
  archRows = [];
  scopedRows = [row("d1", "旧名")];
  await refreshSessions({ force: true }); // 全量空桶（Phase 1 延后拉全量的形态）
  await refreshProjectSessions("proj-d");
  assert.equal(store.sessions.length, 0, "前置：全量桶为空");
  applySessionNameLocal("d1", "新名");
  assert.equal(store.projectSessions.find((r) => r.id === "d1").name, "新名", "dock 行不得等全量加载才改名");
  scopedRows = null;
});

test("scoped 落地：旧名不盖回；本项目桶不含的行不得据此判「已消失」而清 override", async () => {
  liveRows = [row("p1", "旧名"), row("other", "别项目的行")];
  archRows = [];
  scopedRows = [row("p1", "旧名")]; // 当前项目只有 p1
  await refreshSessions({ force: true });
  await refreshProjectSessions("proj-p");
  applySessionNameLocal("p1", "新名");
  applySessionNameLocal("other", "改名了");

  await refreshProjectSessions("proj-p", { refresh: true }); // 服务端 5s 扫描缓存内，仍旧名
  assert.equal(store.projectSessions.find((r) => r.id === "p1").name, "新名", "scoped 落地不得盖回乐观名");

  liveRows = [row("p1", "旧名"), row("other", "别项目的行")];
  await refreshSessions({ force: true });
  assert.equal(store.sessions.find((r) => r.id === "other").name, "改名了",
    "other 只在别的项目（本次 scoped 桶没有它）——override 不能被误清，否则这里闪回旧名");
  scopedRows = null;
});

test("服务端确认只认刚落地的桶：自己写进 scoped 的乐观值不得提前清 override", async () => {
  liveRows = [row("q1", "旧名")];
  archRows = [];
  scopedRows = [row("q1", "旧名")];
  await refreshSessions({ force: true });
  await refreshProjectSessions("proj-q");
  applySessionNameLocal("q1", "新名"); // 两桶都写成新名（scoped 那份是乐观值，非服务端凭据）

  for (let i = 0; i < 2; i++) { // 两轮在途旧全量响应落地：都不许闪回旧名
    liveRows = [row("q1", "旧名")];
    await refreshSessions({ force: true });
    assert.equal(store.sessions.find((r) => r.id === "q1").name, "新名", `第 ${i + 1} 轮旧响应后仍保持乐观名`);
    assert.equal(store.projectSessions.find((r) => r.id === "q1").name, "新名");
  }

  liveRows = [row("q1", "新名")]; // 服务端真对齐 → 确认清除
  await refreshSessions({ force: true });
  liveRows = [row("q1", "第三方改名")];
  await refreshSessions({ force: true });
  assert.equal(store.sessions.find((r) => r.id === "q1").name, "第三方改名", "确认后服务端值为准");
  scopedRows = null;
});

rmSync(isoDir, { recursive: true, force: true });
