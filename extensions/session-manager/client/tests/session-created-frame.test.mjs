/**
 * onSessionCreatedFrame 单测（2026-09「跨 tab 新会话即时上列表」修复回归）。
 *
 * 背景：服务端 rpc-manager 全新会话启动成功后 publish `sm:session-created`
 * （SSE 直达所有 tab）；此前跨 tab/服务端直建（ai-helper invoke/急救 AI/定时任务/
 * ACP 桥）的新会话只能靠 running 帧间接带动刷新，jsonl 未落盘 + 5s 扫描缓存窗口
 * 内两帧都拉空 → 本 tab 列表长期不出现。
 *
 * 覆盖：无关帧忽略、首拉判据（sessionsLoadedOnce 前跳过）、有效帧记草稿（cwd 元
 * 数据 + transient）、幂等（重复帧/live 桶/archived 桶跳过）。
 *
 * 运行：node client/tests/session-created-frame.test.mjs（秒级；结束前清草稿停补拉链）
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

// 与 pending-drafts.test.mjs 同款隔离目录镜像（store.ts 相对 import 三层层级）
function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-created-test-"));
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

// fetch stub：/sessions 返回含 live-1 的全量（首拉判据落地用）；archived 由专门
// 用例经直接写 store.archived 模拟（不必再拉一次）。
const liveRow = { id: "live-1", cwd: "/w", path: "", created: "", modified: "", messageCount: 0, firstMessage: "live" };
globalThis.fetch = (async (url) => {
  const u = String(url);
  if (u.includes("/sessions")) {
    return new Response(JSON.stringify({ sessions: [liveRow], archived: [], rev: "r1" }),
      { status: 200, headers: { "content-type": "application/json", etag: "\"r1\"" } });
  }
  if (u.includes("/agent/running")) {
    return new Response(JSON.stringify({ runningSessionIds: [] }),
      { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
});

const mod = await import(pathToFileURL(bundleOut).href + "?" + Date.now());
const { store, refreshSessions, removePendingDraft, onSessionCreatedFrame } = mod;

const frame = (id, cwd = "/proj") => ({ type: "sm:session-created", sessionId: id, cwd });

test("无关帧（type 不符 / 缺 sessionId）静默忽略", () => {
  onSessionCreatedFrame({ type: "running", runningSessionIds: [] });
  onSessionCreatedFrame({ type: "sm:session-created" });
  onSessionCreatedFrame({ type: "sm:session-created", sessionId: "" });
  onSessionCreatedFrame(null);
  assert.equal((store.pendingDrafts ?? []).length, 0);
});

test("首拉未落地：有效帧被首拉判据跳过（不误记、不触发补拉）", () => {
  onSessionCreatedFrame(frame("early-1"));
  assert.equal((store.pendingDrafts ?? []).length, 0);
});

test("首拉后：有效帧记入草稿（transient + cwd 元数据 + 触发补拉链）", async () => {
  await refreshSessions({ force: true }); // 首拉落地 → sessionsLoadedOnce = true
  assert.equal(store.sessions.length, 1);
  onSessionCreatedFrame(frame("new-1", "/proj"));
  const drafts = store.pendingDrafts.map((p) => p.session);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].id, "new-1");
  assert.equal(drafts[0].cwd, "/proj");
  assert.equal(drafts[0].transient, true);
  // 转正验证：同 id 进 live 列表后 reconcile 移出（直接写桶模拟下一轮拉取）
  store.sessions = [...store.sessions, { ...liveRow, id: "new-1", cwd: "/proj" }];
  removePendingDraft("new-1"); // 先移除（同时停补拉链），再验证 reconcile 幂等不复活
  assert.equal(store.pendingDrafts.length, 0);
  store.sessions = store.sessions.filter((s) => s.id !== "new-1");
});

test("幂等：重复帧不重复记", () => {
  onSessionCreatedFrame(frame("dup-1"));
  onSessionCreatedFrame(frame("dup-1"));
  onSessionCreatedFrame(frame("dup-1"));
  const hits = store.pendingDrafts.filter((p) => p.session.id === "dup-1");
  assert.equal(hits.length, 1);
  removePendingDraft("dup-1");
});

test("已在 live / archived 桶的 id 跳过", async () => {
  // live 桶：live-1 在首拉已入桶
  onSessionCreatedFrame(frame("live-1"));
  assert.equal(store.pendingDrafts.filter((p) => p.session.id === "live-1").length, 0);
  // archived 桶：直接写桶（归档行独立，live 视图不含）
  store.archived = [{ ...liveRow, id: "arch-1" }];
  onSessionCreatedFrame(frame("arch-1"));
  assert.equal(store.pendingDrafts.filter((p) => p.session.id === "arch-1").length, 0);
  store.archived = [];
});
