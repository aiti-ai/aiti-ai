/**
 * onSessionActivityFrame 单测（2026-09-14「最新状态没及时更新，始终显示停止之前的状态」修复回归）。
 *
 * 背景：列表刷新此前只由 running 集变化带动（会话开始/结束），会话持续运行期间
 * 消息数/modified 一路增长却不触发任何刷新——行数据冻结在「开始运行那一刻」
 * （实证：行显示 34 条/19 小时前，实际已 300+ 条）。服务端 agent message_end 后
 * 广播 sm:session-activity；2026-09-15 数据帧化：帧携带 row（服务端行缓存 + 事件
 * 增量更新）→ client 直接 patch store 零请求；帧无 row 才回退既有增量通道刷新。
 *
 * 覆盖：无关帧忽略、未知会话（列表外/空 id）不拉、live/archived 桶命中刷新
 *（信号帧路径）；数据帧直接 patch 零请求、row.id 与 sessionId 不匹配时回退刷新。
 *
 * 运行：node client/tests/session-activity-frame.test.mjs（含 4 处 ~3.1s 节流等待）
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

// 与 pending-drafts/session-created-frame 测试同款隔离目录镜像（store.ts 相对 import 三层层级）
function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-activity-test-"));
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

// fetch stub：/sessions 全量返回 live-1（messageCount 可动态改，模拟运行中增长）。
const liveRow = { id: "live-1", cwd: "/w", path: "", created: "", modified: "", messageCount: 34, firstMessage: "live" };
let sessionsFetches = 0;
let runningFetches = 0;
globalThis.fetch = (async (url) => {
  const u = String(url);
  if (u.includes("/sessions")) {
    sessionsFetches += 1;
    return new Response(JSON.stringify({ sessions: [JSON.parse(JSON.stringify(liveRow))], archived: [], rev: "r1" }),
      { status: 200, headers: { "content-type": "application/json", etag: "\"r1\"" } });
  }
  if (u.includes("/agent/running")) {
    runningFetches += 1;
    return new Response(JSON.stringify({ runningSessionIds: [] }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
});

const mod = await import(pathToFileURL(bundleOut).href + "?" + Date.now());
const { store, refreshSessions, onSessionActivityFrame } = mod;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (id) => ({ type: "sm:session-activity", sessionId: id });

test("无关帧（type 不符 / 缺 sessionId / 空帧）静默忽略", () => {
  const before = sessionsFetches;
  onSessionActivityFrame({ type: "running", runningSessionIds: [] });
  onSessionActivityFrame({ type: "sm:session-activity" });
  onSessionActivityFrame({ type: "sm:session-activity", sessionId: "" });
  onSessionActivityFrame(null);
  assert.equal(sessionsFetches, before, "不该发起任何请求");
});

test("未知会话（列表外）→ 不触发刷新", async () => {
  await refreshSessions({ force: true }); // 首拉落地：live-1 入桶
  await sleep(3100); // 越过 refreshSessions 的 3s 节流窗口，使后续请求可观察
  const before = sessionsFetches;
  onSessionActivityFrame(frame("ghost-1"));
  await sleep(120);
  assert.equal(sessionsFetches, before, "列表外 id 无行可刷，不发请求");
  assert.equal(store.sessions[0].messageCount, 34);
});

test("live 会话 → 触发增量刷新（行数据随服务端变化落地）", async () => {
  await sleep(3100);
  liveRow.messageCount = 300; // 模拟运行中消息数增长（下一轮扫描可见）
  const before = sessionsFetches;
  onSessionActivityFrame(frame("live-1"));
  await sleep(200);
  assert.equal(sessionsFetches, before + 1, "命中列表 → 触发一次列表拉取");
  assert.equal(store.sessions[0].messageCount, 300, "行数据刷新到最新");
});

test("archived 桶命中也触发（归档行可被外部继续追加）", async () => {
  await sleep(3100);
  store.archived = [{ ...liveRow, id: "arch-1" }];
  const before = sessionsFetches;
  onSessionActivityFrame(frame("arch-1"));
  await sleep(200);
  assert.equal(sessionsFetches, before + 1);
  store.archived = [];
});

test("数据帧（带 row）→ 直接 patch 行、零请求", async () => {
  await sleep(3100);
  if (!store.sessions.some((r) => String(r.id) === "live-1")) await refreshSessions({ force: true });
  const before = sessionsFetches;
  const current = store.sessions.find((r) => String(r.id) === "live-1");
  const row = {
    ...JSON.parse(JSON.stringify(current)),
    messageCount: 500,
    lastMessage: "最新消息预览",
    lastRole: "assistant",
    modified: "2026-09-15T12:00:00.000Z",
  };
  onSessionActivityFrame({ type: "sm:session-activity", sessionId: "live-1", row });
  await sleep(150);
  assert.equal(sessionsFetches, before, "数据帧直接落地，不发请求");
  const after = store.sessions.find((r) => String(r.id) === "live-1");
  assert.equal(after.messageCount, 500, "行数据被帧内容替换");
  assert.equal(after.lastMessage, "最新消息预览");
  assert.equal(after.modified, "2026-09-15T12:00:00.000Z");
});

test("数据帧：row.id 与 sessionId 不匹配（服务端异常）→ 不信任，回退增量刷新", async () => {
  await sleep(3100);
  const before = sessionsFetches;
  onSessionActivityFrame({
    type: "sm:session-activity",
    sessionId: "live-1",
    row: { id: "other", messageCount: 999 },
  });
  await sleep(200);
  assert.equal(sessionsFetches, before + 1, "id 不匹配 → 走刷新");
});

// ── 运行通道基线（2026-09-15：服务端 running 帧生产与 events route 连接解绑后新增）──
// 放最后：align 会置 delivered，不影响前面用例。
test("运行通道基线：align 订阅即对齐（一次，不重拉）→ 健康（兜底轮询归零）", async () => {
  const { alignRunningSnapshotOnce, isRunningSseHealthy } = mod;
  assert.equal(isRunningSseHealthy(), false, "初始未对齐（兜底轮询兜底）");
  await sleep(2600); // 越过 dedupeFetch 2.5s 微缓存窗口，确保对齐发起真实请求
  const before = runningFetches;
  alignRunningSnapshotOnce();
  await sleep(200);
  assert.equal(runningFetches, before + 1, "对齐拉一次快照");
  assert.equal(isRunningSseHealthy(), true, "对齐后健康 → 30s 兜底轮询不再发请求");
  alignRunningSnapshotOnce();
  await sleep(200);
  assert.equal(runningFetches, before + 1, "重复调用不重拉（幂等一次）");
});
