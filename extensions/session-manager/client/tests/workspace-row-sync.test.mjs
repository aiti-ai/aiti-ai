/**
 * Regression tests for row-level sync into the workspaces aggregate (2026-11-09
 * "workspace dropdown no longer sorts" fix).
 *
 * Background: the [通道拆分] commit (44e5d93c) switched the project list to the
 * store.workspaces array fed by the server-side /workspaces snapshot aggregate, while
 * activity frames / incremental patches only write the row buckets — a running project's
 * growing lastModified no longer reached the project order (pre-split, getRecentProjects
 * derived order from full rows on every render, so it followed frames naturally). User
 * report: justdb had an active session but stayed at position 58 in the dropdown.
 *
 * Three sync paths under test:
 *   1. activity data frame → syncWorkspacesFromRow: upsert lastModified (max) + re-sort;
 *   2. list landing → syncWorkspacesFromRows: mirror row buckets (new projects appear);
 *   3. running-frame change → entries.tsx refreshWorkspaces (server-authoritative counts;
 *      parameterless calls reuse the last unread set so red dots don't get wiped).
 *
 * Covers: activity row bumps an existing project to the top, appends unknown projects,
 * archived rows are ignored, refreshSessions mirrors new projects, refreshWorkspaces
 * unread-set reuse / explicit clearing.
 *
 * Run: node client/tests/workspace-row-sync.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

// 与 session-activity-frame 测试同款隔离目录镜像（store.ts 相对 import 三层层级）
function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-ws-sync-test-"));
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

// Server stubs: /workspaces returns two fixed projects sorted by lastModified desc (the
// real server returns them pre-sorted); /sessions returns one /b row (the activity-frame
// known-check needs the row in a bucket). Every URL is recorded for unread-param asserts.
const WORKSPACES = [
  { key: "/c", root: "/c", name: "c", lastModified: "2026-11-09T02:00:00.000Z", sessionCount: 1, runningCount: 0, unreadCount: 0 },
  { key: "/b", root: "/b", name: "b", lastModified: "2026-11-09T01:00:00.000Z", sessionCount: 2, runningCount: 0, unreadCount: 0 },
];
const liveRows = [{ id: "b-1", cwd: "/b", path: "", created: "", modified: "2026-11-09T01:00:00.000Z", messageCount: 3, firstMessage: "b" }];
const fetchUrls = [];
globalThis.fetch = (async (url) => {
  const u = String(url);
  fetchUrls.push(u);
  if (u.includes("/workspaces")) {
    return new Response(JSON.stringify({ rev: "w1", workspaces: JSON.parse(JSON.stringify(WORKSPACES)) }),
      { status: 200, headers: { "content-type": "application/json", etag: "\"w1\"" } });
  }
  if (u.includes("/sessions")) {
    return new Response(JSON.stringify({ sessions: JSON.parse(JSON.stringify(liveRows)), archived: [], rev: "r1" }),
      { status: 200, headers: { "content-type": "application/json", etag: "\"r1\"" } });
  }
  if (u.includes("/agent/running")) {
    return new Response(JSON.stringify({ runningSessionIds: [] }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
});

const mod = await import(pathToFileURL(bundleOut).href + "?" + Date.now());
const { store, refreshSessions, refreshWorkspaces, onSessionActivityFrame } = mod;

const activityFrame = (row) => ({
  type: "sm:session-activity", sessionId: String(row.id), row: JSON.parse(JSON.stringify(row)),
});

test("活动帧数据行：已有项目 lastModified 抬升并浮顶", async () => {
  await refreshSessions({ force: true }); // b-1 入桶（known 判据）
  await refreshWorkspaces(undefined, true); // 聚合落地：[c, b]
  assert.deepEqual(store.workspaces.map((w) => w.key), ["/c", "/b"]);
  // b 项目会话新落盘一条消息（modified 比 c 新）→ 活动帧 → b 浮到顶部
  onSessionActivityFrame(activityFrame({ id: "b-1", cwd: "/b", modified: "2026-11-09T03:00:00.000Z", messageCount: 4 }));
  assert.deepEqual(store.workspaces.map((w) => w.key), ["/b", "/c"], "活跃项目应浮顶");
  assert.equal(store.workspaces[0].lastModified, "2026-11-09T03:00:00.000Z");
  assert.equal(store.workspaces[0].sessionCount, 2, "计数不被行级同步覆盖（服务端权威）");
});

test("活动帧行指向快照外的新项目 → 追加条目并参与排序", () => {
  onSessionActivityFrame(activityFrame({ id: "b-1", cwd: "/newproj", projectRoot: "/newproj", modified: "2026-11-09T04:00:00.000Z" }));
  const keys = store.workspaces.map((w) => w.key);
  assert.ok(keys.includes("/newproj"), "新项目应被追加");
  assert.equal(keys[0], "/newproj", "最新 modified 应排首位");
  assert.equal(store.workspaces.find((w) => w.key === "/newproj").name, "newproj");
});

test("旧 modified 不回退（max 单调）", () => {
  const before = store.workspaces.find((w) => w.key === "/newproj").lastModified;
  onSessionActivityFrame(activityFrame({ id: "b-1", cwd: "/newproj", modified: "2026-11-01T00:00:00.000Z" }));
  assert.equal(store.workspaces.find((w) => w.key === "/newproj").lastModified, before, "陈旧帧不得回退项目序");
});

test("归档行活动不参与项目序", () => {
  const snapshot = JSON.parse(JSON.stringify(store.workspaces));
  onSessionActivityFrame(activityFrame({ id: "b-1", cwd: "/b", modified: "2026-11-09T99:00:00.000Z", archived: true }));
  assert.deepEqual(store.workspaces, snapshot, "归档行不应影响 workspaces");
});

test("refreshSessions 落地 → 行桶镜像（快照外新项目即时出现）", async () => {
  liveRows.push({ id: "d-1", cwd: "/d", path: "", created: "", modified: "2026-11-09T05:00:00.000Z", messageCount: 1, firstMessage: "d" });
  liveRows[0].modified = "2026-11-09T06:00:00.000Z";
  await refreshSessions({ force: true });
  const keys = store.workspaces.map((w) => w.key);
  assert.ok(keys.includes("/d"), "列表落地的新项目应镜像进聚合");
  assert.equal(keys[0], "/b", "b（06:00 最新）应排首位");
  assert.equal(store.workspaces.find((w) => w.key === "/b").lastModified, "2026-11-09T06:00:00.000Z");
});

test("refreshWorkspaces 无参调用复用最近未读集合（防红点冲零）", async () => {
  fetchUrls.length = 0;
  await refreshWorkspaces(new Set(["s1", "s2"]), true);
  assert.ok(fetchUrls.at(-1)?.includes("unread=s1%2Cs2"), "显式集合应随请求下发");
  fetchUrls.length = 0;
  await refreshWorkspaces(undefined, true); // 无参（entries.tsx running 帧路径）
  assert.ok(fetchUrls.at(-1)?.includes("unread=s1%2Cs2"), "无参调用应复用最近集合");
  fetchUrls.length = 0;
  await refreshWorkspaces(new Set(), true); // 显式空集 = 清除
  assert.ok(!fetchUrls.at(-1)?.includes("unread="), "显式空集应清空未读参数");
});
