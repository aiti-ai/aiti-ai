/**
 * session-manager scoped 会话通道「跨 workspace 卡死」回归测试（2026-09-18 修复）。
 *
 * 背景（docs/pi-web-session-manager-scoped-workspace-channel-fix-plan.md）：
 * scoped 通道（/sessions?fmt=2&project=<key>）的 in-flight / ETag / 已加载标记 / 刷新
 * 目标全是单槽全局量——A 在飞时切 B，B 的刷新被合流吞掉（不发请求）；A 落地后
 * B 恒 loading；手动刷新又刷 store.projectSessionsKey（旧的已落地 key）→ 只有整页
 * 刷新才能恢复。本套用例钉死按 key 治理后的语义：
 *   T1 首拉：行/驻留 key/loaded gate 一致；
 *   T2 A 在飞切 B：B 必须发出请求；A 迟到响应被目标守卫丢弃；
 *   T3 同 key 并发合流仍只发一次请求；
 *   T4 ETag 只在「驻留行就是本 key」时发出（跨 key 不发，杜绝 304 死锁）；
 *   T5 304 保持行、不打脏、loaded 仍 true；
 *   T6 target 跟随最近刷新；isProjectSessionsLoaded 只认真驻留 key；
 *   T7 坏响应（fmt=2 缺 cwds）不覆盖驻留行。
 *
 * 运行：node client/tests/scoped-channel.test.mjs（秒级）
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

/** 隔离目录镜像 store.ts 的相对 import 结构（sm/client/src + _shared + sm/server）。 */
function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-scoped-test-"));
  const sm = join(dir, "sm");
  const clientSrc = join(sm, "client", "src");
  mkdirSync(join(clientSrc, "sidebar"), { recursive: true });
  writeFileSync(join(clientSrc, "store.ts"), readFileSync(join(srcRoot, "store.ts"), "utf8"));
  writeFileSync(join(clientSrc, "host-shim.ts"), HOST_SHIM_STUB);
  writeFileSync(join(clientSrc, "sidebar", "pure.ts"), readFileSync(join(srcRoot, "sidebar", "pure.ts"), "utf8"));
  mkdirSync(join(dir, "_shared"), { recursive: true });
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
const {
  store,
  refreshProjectSessions,
  getProjectSessionsTarget,
  isProjectSessionsLoaded,
} = mod;

// ── fetch mock：scoped 请求按 project 挂起（deferred），测试显式 respond 控制落地时序 ──
const pendingFetch = new Map(); // project -> resolve
let requests = [];             // { project, headers }
globalThis.fetch = (url, init = {}) => {
  const u = String(url);
  if (u.includes("/api/agent/running")) {
    return Promise.resolve(new Response(JSON.stringify({ runningSessionIds: [] }), { status: 200 }));
  }
  const project = new URL(u, "http://x").searchParams.get("project") ?? "";
  requests.push({ project, headers: { ...(init.headers ?? {}) } });
  return new Promise((resolve) => {
    pendingFetch.set(project, resolve);
  });
};

function respond(project, body, status = 200, headers = {}) {
  const resolve = pendingFetch.get(project);
  assert.ok(resolve, `没有挂起的请求：${project}`);
  pendingFetch.delete(project);
  resolve(new Response(status === 304 ? null : JSON.stringify(body ?? {}), { status, headers }));
}

/** 最小行（旧传输形态 { sessions: [...] }，decodeSessionsPayload 原样透传）。 */
const row = (id, cwd = "/wa") => ({ id, cwd, modified: "2026-09-18T00:00:00Z", messageCount: 1 });

test("T1 首拉 A：行/驻留 key/loaded gate 三者一致", async () => {
  const p = refreshProjectSessions("proj-a");
  respond("proj-a", { sessions: [row("a1")] }, 200, { etag: '"EA"' });
  await p;
  assert.deepEqual(store.projectSessions.map((r) => r.id), ["a1"]);
  assert.equal(store.projectSessionsKey, "proj-a");
  assert.equal(isProjectSessionsLoaded("proj-a"), true);
  assert.equal(isProjectSessionsLoaded("proj-b"), false);
  assert.equal(isProjectSessionsLoaded(""), false, "空 key 永不 loaded");
});

test("T2 【回归】A 在飞切 B：B 请求必须发出；A 迟到响应不覆盖 B", async () => {
  const pA = refreshProjectSessions("race-a");
  const pB = refreshProjectSessions("race-b");
  assert.ok(pendingFetch.has("race-a") && pendingFetch.has("race-b"),
    "异 key 并行发出（修复前：B 被单槽 in-flight 吞掉，pending 里没有 race-b）");
  // B 先落地
  respond("race-b", { sessions: [row("b1", "/wb")] }, 200, { etag: '"EB"' });
  await pB;
  assert.deepEqual(store.projectSessions.map((r) => r.id), ["b1"]);
  assert.equal(store.projectSessionsKey, "race-b");
  // A（更早发起）迟到：目标已是 B → 守卫丢弃
  respond("race-a", { sessions: [row("a1")] }, 200, { etag: '"EA2"' });
  await pA;
  assert.deepEqual(store.projectSessions.map((r) => r.id), ["b1"], "A 迟到响应被目标守卫丢弃");
  assert.equal(store.projectSessionsKey, "race-b");
  assert.equal(isProjectSessionsLoaded("race-b"), true);
});

test("T3 同 key 并发合流：仍只发一次请求", async () => {
  requests = [];
  const p1 = refreshProjectSessions("same-c");
  const p2 = refreshProjectSessions("same-c");
  // 同步发起期即可断言（fetch 在 await 前同步调用）；若发生重复请求直接失败，
  // 不进入后面的等待（防孤立 promise 把用例挂住）
  assert.equal(requests.filter((r) => r.project === "same-c").length, 1, "同 key 只发一次请求");
  respond("same-c", { sessions: [row("c1")] }, 200, { etag: '"EC"' });
  await Promise.all([p1, p2]);
  assert.equal(store.projectSessionsKey, "same-c");
});

test("T4 ETag 只在驻留行同 key 时发出", async () => {
  // 先建立独立驻留 + etag
  const seed = refreshProjectSessions("etag-a");
  respond("etag-a", { sessions: [row("ea")] }, 200, { etag: '"EA1"' });
  await seed;
  requests = [];
  // 同 key 再拉：驻留 = etag-a → 带 etag
  const same = refreshProjectSessions("etag-a");
  assert.equal(requests.at(-1).headers["if-none-match"], '"EA1"');
  respond("etag-a", { sessions: [row("ea")] }, 200, { etag: '"EA2"' });
  await same;
  // 换 key：驻留 ≠ etag-b → 不带（修复前会拿 EA2 问 B，304 时死锁）
  const other = refreshProjectSessions("etag-b");
  assert.equal(requests.at(-1).headers["if-none-match"], undefined, "跨 key 不得复用 ETag");
  respond("etag-b", { sessions: [row("eb", "/wb")] }, 200, { etag: '"EB1"' });
  await other;
  assert.equal(store.projectSessionsKey, "etag-b");
});

test("T5 304：保持行、不打脏、loaded 仍 true", async () => {
  const before = store.projectSessions;
  const p = refreshProjectSessions("etag-b");
  assert.equal(requests.at(-1).headers["if-none-match"], '"EB1"');
  respond("etag-b", undefined, 304, { etag: '"EB1"' });
  await p;
  assert.equal(store.projectSessions, before, "304 不替换行引用");
  assert.equal(store.projectSessionsKey, "etag-b");
  assert.equal(isProjectSessionsLoaded("etag-b"), true);
});

test("T6 target 跟随最近刷新；loaded 只认真驻留 key", async () => {
  assert.equal(getProjectSessionsTarget(), "etag-b");
  const p = refreshProjectSessions("tgt-x");
  assert.equal(getProjectSessionsTarget(), "tgt-x", "发起即记录目标（刷新按钮据此打对 key）");
  respond("tgt-x", { sessions: [row("tx")] }, 200, { etag: '"TX"' });
  await p;
  assert.equal(isProjectSessionsLoaded("tgt-x"), true);
  assert.equal(isProjectSessionsLoaded("etag-b"), false, "旧 key 不再驻留");
  // 失败在飞也前移目标（keep-last 行，刷新按钮仍打最近一次意图）
  const fail = refreshProjectSessions("tgt-fail");
  respond("tgt-fail", null, 500);
  await fail;
  assert.equal(getProjectSessionsTarget(), "tgt-fail");
  assert.equal(store.projectSessionsKey, "tgt-x", "失败 keep-last 不动驻留行");
  assert.equal(isProjectSessionsLoaded("tgt-fail"), false);
});

test("T7 坏响应（fmt=2 缺 cwds）不覆盖驻留行", async () => {
  const before = store.projectSessions;
  const p = refreshProjectSessions("bad-z");
  respond("bad-z", { fmt: 2, sessions: [{ id: "z1", c: 0 }] }, 200, { etag: '"BZ"' });
  await p;
  assert.equal(store.projectSessions, before);
  assert.equal(store.projectSessionsKey, "tgt-x");
  assert.equal(isProjectSessionsLoaded("bad-z"), false);
});
