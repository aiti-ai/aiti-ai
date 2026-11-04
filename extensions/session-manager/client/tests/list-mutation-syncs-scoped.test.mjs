/**
 * 列表写操作（归档 / 从列表移除 / 彻底删除）必须同时对齐 scoped 通道 —— node --test。
 *
 * 事故（2026-09-22）：左栏 session dock 里点「归档」/ext 行「从列表移除」，行不消失，
 * 要刷新页面才没了。根因是「通道拆分」（2026-09-18）的半边遗漏：dock 渲染
 * store.projectSessions（scoped /sessions?project=<key>），而 store 里所有写操作的收尾
 * 只调 refreshSessions（全量通道）——全量桶行确实移走了，scoped 桶原样，于是行残留；
 * 更迷惑的是全量落地会 prune 掉该行的 pending 置灰，短暂置灰后行恢复如常，
 * 看起来完全像「点了没反应」。手动刷新（sidebar-content doRefresh）打三条通道，
 * 所以刷一次就好——正是用户报的现象。
 *
 * 范式：镜像 store.ts 到隔离目录 + stub 依赖，esbuild 打包后直接调导出的动作函数，
 * 用 fetch 桩记录请求 + 控制服务端返回（同 scoped-channel.test.mjs）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");
const serverRoot = join(here, "..", "..", "server");

const HOST_SHIM_STUB = [
  "export function useState(v) { return [undefined, () => {}]; }",
  "export function useEffect(_f, _d) { /* noop */ }",
  "export function apiUrl(p) { return '/dev' + p; }",
  "export function getExtService() { return undefined; }",
  "export function t(k) { return k; }",
  "export function getLocale() { return 'en'; }",
].join("\n");
const EXT_FLOAT_STUB = [
  "export function present() { return {}; }",
  "export function presentState() { return 'closed'; }",
  "export function openFloat() { /* test stub */ }",
  "export function closePanel() { /* test stub */ }",
].join("\n");

function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-scoped-sync-test-"));
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
  refreshSessions,
  archiveSession,
  hideExtSession,
  deleteLiveSession,
  restoreSession,
  markPendingRemoval,
  isPendingRemoval,
} = mod;

/* ── 服务端桩：live/archived 两份行集；scoped 只回本项目 live ── */
const PROJECT = "proj-a";
const SERVER = { live: [], archived: [] };
let calls = [];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", etag: '"R' + (++etagSeq) + '"' },
  });
}
let etagSeq = 0;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = String((init && init.method) || "GET");
  calls.push({ url: u, method });
  const search = new URL(u, "http://x").search;
  if (u.includes("/api/agent/running")) return json({ runningSessionIds: [] });
  if (u.includes("/sessions?") && method === "GET") {
    const project = new URLSearchParams(search).get("project");
    const live = project ? SERVER.live.filter((r) => r.projectKey === project) : SERVER.live;
    const archived = project ? SERVER.archived.filter((r) => r.projectKey === project) : SERVER.archived;
    return json({ sessions: live, archived });
  }
  if (method === "DELETE" && u.includes("/api/sessions/")) {
    const id = decodeURIComponent(u.split("/api/sessions/")[1]);
    SERVER.live = SERVER.live.filter((r) => r.id !== id);
    return json({ ok: true });
  }
  // 归档 / 从列表移除 / 恢复：把行在 live ↔ archived 两桶间搬（模拟服务端视图层归档）
  if (method === "POST" && /\/archive\/(run|ext|restore)$/.test(u)) {
    const body = JSON.parse(String((init && init.body) || "{}"));
    const ids = body.ids ?? [body.sessionId];
    const backToLive = u.includes("/archive/restore") || body.hidden === false;
    if (backToLive) {
      SERVER.archived = SERVER.archived.filter((r) => !ids.includes(r.id));
      for (const id of ids) if (!SERVER.live.some((r) => r.id === id)) SERVER.live.push(movedBack(id));
    } else {
      SERVER.archived = SERVER.archived.filter((r) => !ids.includes(r.id));
      for (const id of ids) {
        const row = SERVER.live.find((r) => r.id === id);
        if (!row) continue;
        movedStore.set(id, row);
        SERVER.live = SERVER.live.filter((r) => r.id !== id);
        SERVER.archived.push({ ...row, archived: 1 });
      }
    }
    return json({ ok: true, archived: ids.length, skippedIds: [] });
  }
  return json({ ok: true });
};

/** 恢复/放回时补齐的 live 行（同 projectKey，服务端按索引行还原）。 */
function movedBack(id) {
  const src = movedStore.get(id) ?? { id, projectKey: PROJECT, cwd: "/wa" };
  return { ...src, archived: 0 };
}
const movedStore = new Map();

const rowOf = (id) => ({ id, cwd: "/wa", projectKey: PROJECT, modified: "2026-09-22T00:00:00Z", messageCount: 1 });

/** 让 refreshListChannels 里 void 掉的两次刷新都落地（宏任务队列排空若干轮）。 */
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

test("前置：scoped 未拉过（dock 未挂载）→ 写操作不多打 scoped 请求", async () => {
  SERVER.live = [rowOf("x1")];
  SERVER.archived = [];
  calls = [];
  await refreshSessions({ force: true });
  await settle();
  await hideExtSession("x1", true);
  await settle();
  assert.ok(calls.some((c) => c.url.includes("/sessions?fmt=2") && !c.url.includes("project=")),
    "全量通道照旧刷新");
  assert.equal(calls.filter((c) => c.url.includes("project=")).length, 0,
    "无 scoped 目标时不该凭空发 scoped 请求");
});

test("dock 已挂载：从列表移除后 scoped 列表落地即无该行", async () => {
  SERVER.live = [rowOf("e1")];
  SERVER.archived = [];
  await refreshSessions({ force: true });
  await refreshProjectSessions(PROJECT);
  await settle();
  assert.deepEqual(store.projectSessions.map((r) => r.id), ["e1"], "前置：行在 dock 列表源里");
  markPendingRemoval("e1", "live");

  calls = [];
  assert.equal(await hideExtSession("e1", true), true);
  await settle();

  assert.ok(calls.some((c) => c.url.includes("project=")),
    "必须刷 scoped 通道（dock 渲染源）——修复前只刷全量，行残留到手动刷新");
  assert.deepEqual(store.projectSessions.map((r) => r.id), [], "scoped 落地后 dock 行消失");
  assert.ok(!store.sessions.some((r) => r.id === "e1"), "全量 live 桶同步无该行");
  assert.equal(isPendingRemoval("e1"), false, "pending 置灰随全量落地清干净");
});

test("dock 已挂载：pi 会话归档同样移出 dock 行", async () => {
  SERVER.live = [rowOf("p1")];
  SERVER.archived = [];
  await refreshSessions({ force: true });
  await refreshProjectSessions(PROJECT);
  await settle();
  calls = [];
  const r = await archiveSession("p1");
  await settle();
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.url.includes("project=")), "归档也要刷 scoped");
  assert.deepEqual(store.projectSessions.map((x) => x.id), []);
});

test("dock 已挂载：彻底删除（core DELETE）同样移出 dock 行", async () => {
  SERVER.live = [rowOf("d1")];
  SERVER.archived = [];
  await refreshSessions({ force: true });
  await refreshProjectSessions(PROJECT);
  await settle();
  calls = [];
  assert.equal(await deleteLiveSession("d1"), null);
  await settle();
  assert.ok(calls.some((c) => c.url.includes("project=")), "删除也要刷 scoped");
  assert.deepEqual(store.projectSessions.map((x) => x.id), []);
});

test("dock 已挂载：恢复把行放回 scoped 列表（反向残留）", async () => {
  movedStore.set("r1", rowOf("r1"));
  SERVER.live = [];
  SERVER.archived = [{ ...rowOf("r1"), archived: 1 }];
  await refreshSessions({ force: true });
  await refreshProjectSessions(PROJECT);
  await settle();
  assert.deepEqual(store.projectSessions.map((x) => x.id), [], "前置：归档行不在 dock");
  markPendingRemoval("r1", "archived");

  calls = [];
  assert.equal(await restoreSession("r1"), true);
  await settle();
  assert.ok(calls.some((c) => c.url.includes("project=")), "恢复也要刷 scoped");
  assert.ok(store.sessions.some((x) => x.id === "r1"), "全量 live 桶回到该行了");
});
