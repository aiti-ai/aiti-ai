/**
 * store.pendingDrafts 全链路测试（2026-09「新会话丢失」修复回归）。
 *
 * 覆盖：note 幂等/emit、落盘转正、窗口内退避补拉（refresh=1 绕过 core 5s 缓存）、
 * 窗口截止链完全停止（有界，非轮询）、TTL 清理、主动移除。
 *
 * 运行：node client/tests/pending-drafts.test.mjs
 * 约 4.5 分钟（含 155s 窗口 + 末次退避在途的完整停止验证）。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 *  必须镜像 session-manager 层级：store.ts 的 "../../../_shared/ext-float-dock"
 *  从 client/src 出发三层 —— 少一层则解析不到 stub（实测构建报 Could not resolve）。 */
function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-store-test-"));
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
  // dedupe-fetch 无外部依赖，直接镜像真实实现（store.ts 2026-09 起引用，重复请求分析 §3.1）
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

// Windows 下动态 import 必须走 file:// URL（裸 C:\... 路径 ERR_UNSUPPORTED_ESM_URL_SCHEME）；？cache-bust 照旧
const mod = await import(pathToFileURL(bundleOut).href + "?" + Date.now());
const { store, subscribe, refreshSessions, noteDraftSession, removePendingDraft } = mod;

// ── fetch mock（真实 304 语义：etag 不变且非 refresh → 304）──
let liveRows = [];
let archRows = [];
let forcedScanCount = 0;
let lastEtag = null;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/api/agent/running")) return new Response(JSON.stringify({ runningSessionIds: [] }), { status: 200 });
  if (u.includes("/sessions")) {
    if (u.includes("refresh=1")) forcedScanCount++;
    const etag = '"' + liveRows.map((r) => r.id + ":" + (r.modified ?? "")).join("|") + '"';
    if (lastEtag !== null && etag === lastEtag && !u.includes("refresh=1")) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    lastEtag = etag;
    return new Response(JSON.stringify({ sessions: liveRows, archived: archRows, rev: "rv-" + forcedScanCount }), {
      status: 200, headers: { etag },
    });
  }
  return new Response("{}", { status: 404 });
};

// 守卫语义实测：首拉前 note 被忽略（列表未加载过时「不在列表」无法证明「未落盘」）。
noteDraftSession({ id: "pre-load", cwd: "/c", name: "早于首拉" });
assert.equal(store.pendingDrafts.length, 0, "首拉未完成 note 忽略");
// 建立已加载态：后续用例的 note 才会入列。
await refreshSessions({ force: true });

test("noteDraftSession：入列/幂等/emit", () => {
  let emitted = 0;
  const unsub = subscribe(() => emitted++);
  noteDraftSession({ id: "new-1", cwd: "/c", name: "新建会话", firstMessage: "hi" });
  assert.equal(store.pendingDrafts.length, 1);
  assert.equal(store.pendingDrafts[0].session.transient, true, "快照标记 transient");
  assert.equal(emitted, 1, "入列 emit 一次");
  noteDraftSession({ id: "new-1", cwd: "/c", name: "改名" });
  assert.equal(store.pendingDrafts.length, 1, "重复 note 不重复入列");
  assert.equal(store.pendingDrafts[0].session.name, "改名", "重复 note 更新快照");
  assert.equal(emitted, 1, "重复 note 不重复 emit");
  unsub();
});

test("落盘转正：列表出现该 id → pending 移出", async () => {
  liveRows = [{ id: "new-1", cwd: "/c", name: "新建会话", modified: "2026-09-07T00:00:00Z", messageCount: 1 }];
  await refreshSessions({ force: true });
  assert.equal(store.pendingDrafts.length, 0, "落盘后 pending 清空");
  assert.ok(store.sessions.some((x) => x.id === "new-1"));
});

test("归档转正：选中归档会话不误判未落盘（refresh 风暴回归）", async () => {
  store.pendingDrafts = [];
  liveRows = [];
  archRows = [{ id: "arch-1", cwd: "/c", name: "已归档", modified: "2026-09-07T02:00:00Z", messageCount: 3 }];
  noteDraftSession({ id: "arch-1", cwd: "/c", name: "已归档" });
  assert.equal(store.pendingDrafts.length, 1, "note 入列（不在 live 列表）");
  const before = forcedScanCount;
  await refreshSessions({ force: true }); // 落地后 reconcile：归档桶同查
  assert.equal(store.pendingDrafts.length, 0, "归档桶命中 → 移出 pending");
  await sleep(5100); // 若误判未落盘，5s 后会出现 refresh=1 补拉
  assert.equal(forcedScanCount, before, "不再补拉（旧实现 155s 窗口内反复全量 refresh=1）");
  archRows = [];
});

test("等落盘：窗口内退避补拉（refresh=1）+ 自动转正", async () => {
  store.pendingDrafts = [];
  liveRows = [];
  const before = forcedScanCount;
  noteDraftSession({ id: "new-2", cwd: "/c", name: "新会话2", firstMessage: "x" });
  assert.equal(store.pendingDrafts.length, 1, "note 后 pending 保留");
  await sleep(6000); // 第一次补拉（退避 5s）
  assert.ok(forcedScanCount > before, "自动补拉带 refresh=1");
  liveRows = [{ id: "new-2", cwd: "/c", name: "新会话2", modified: "2026-09-07T01:00:00Z", messageCount: 1 }];
  await sleep(10500); // 第二次补拉（退避 10s）落地
  assert.equal(store.pendingDrafts.length, 0, "落盘后自动转正（无需人工刷新）");
  assert.ok(store.sessions.some((x) => x.id === "new-2"));
});

test("补拉有界：退避间隔递增 + 窗口截止后链完全停止", async () => {
  store.pendingDrafts = [];
  liveRows = [];
  noteDraftSession({ id: "new-3", cwd: "/c", name: "永不落盘", firstMessage: "y" });
  const marks = [Date.now()];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("/sessions") && String(url).includes("refresh=1")) marks.push(Date.now());
    return origFetch(url, opts);
  };
  await sleep(40000); // 覆盖 5s+10s+20s=35s
  globalThis.fetch = origFetch;
  const gaps = marks.slice(1).map((t, i) => Math.round((t - marks[i]) / 1000));
  assert.ok(gaps.length >= 3, `窗口内至少 3 次补拉（实际 ${gaps.length}）`);
  assert.ok(gaps[0] >= 4 && gaps[0] <= 7 && gaps[1] >= 9 && gaps[1] <= 13 && gaps[2] >= 19 && gaps[2] <= 23,
    `退避间隔递增 5s/10s/20s（实际 ${gaps.join("/")}s）`);
  assert.ok(store.pendingDrafts.some((p) => p.session.id === "new-3"), "TTL 内行仍保留显示");
  const cBound = forcedScanCount;
  await sleep(135000); // > 155s 窗口（75s/155s 在途已发生）
  const cAfter = forcedScanCount;
  assert.ok(cAfter - cBound <= 2, `窗口截止附近补拉有界（记录后 ${cAfter - cBound} 次）`);
  await sleep(95000); // > 235s（末次 80s 在途也已落地）
  assert.equal(forcedScanCount, cAfter, "链完全停止（窗口截止后不再补拉）");
});

test("TTL 清理：超时未落盘行被清", async () => {
  const p = store.pendingDrafts.find((x) => x.session.id === "new-3");
  p.notedAt = Date.now() - 11 * 60 * 1000;
  await refreshSessions({ force: true, refresh: true });
  assert.ok(!store.pendingDrafts.some((x) => x.session.id === "new-3"), "超 TTL 清理");
});

test("removePendingDraft：主动移除", () => {
  noteDraftSession({ id: "new-4", cwd: "/c", name: "x", firstMessage: "z" });
  removePendingDraft("new-4");
  assert.equal(store.pendingDrafts.length, 0);
});

rmSync(isoDir, { recursive: true, force: true });
