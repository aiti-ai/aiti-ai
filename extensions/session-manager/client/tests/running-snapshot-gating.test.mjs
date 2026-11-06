/**
 * store.applyRunningSnapshot 捕获时间门控回归（2026-11-06「运行状态丢帧自愈」修复）。
 *
 * 背景：旧实现按「SSE 健康时钟」门控快照（心跳 45s 窗口内一律跳过）。总线白名单竞态
 * 之下变更帧可整窗丢失且永不重放，而心跳照发 → 健康恒真 → 快照被门死 → store.running
 * 陈旧数分钟到数小时（用户多轮实测「结束后运行状态很久不刷新」）。
 *
 * 新语义（钉死三条）：
 *   1. 帧后落地的旧快照不覆盖（保留 2026-09-07 防旧盖新语义；dedupe 微缓存 slack 内建）；
 *   2. 比帧新的快照一律可对账（内容差异才写入）——丢帧场景由此自愈；
 *   3. 内容无变化零写入（稳态 60s 慢对账零渲染）。
 *
 * 运行：node client/tests/running-snapshot-gating.test.mjs（秒级，无定时器等待）
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

// 与 pending-drafts.test.mjs 同款隔离镜像（store.ts 相对 import 层级不能少一层）
const isoDir = mkdtempSync(join(tmpdir(), "sm-runsnap-test-"));
{
  const sm = join(isoDir, "sm");
  const clientSrc = join(sm, "client", "src");
  mkdirSync(join(clientSrc, "sidebar"), { recursive: true });
  writeFileSync(join(clientSrc, "store.ts"), readFileSync(join(srcRoot, "store.ts"), "utf8"));
  writeFileSync(join(clientSrc, "host-shim.ts"), HOST_SHIM_STUB);
  writeFileSync(join(clientSrc, "sidebar", "pure.ts"), readFileSync(join(srcRoot, "sidebar", "pure.ts"), "utf8"));
  mkdirSync(join(isoDir, "_shared"), { recursive: true });
  writeFileSync(join(isoDir, "_shared", "ext-float-dock-lite.ts"), EXT_FLOAT_STUB);
  writeFileSync(join(isoDir, "_shared", "ext-float-dock.ts"), EXT_FLOAT_STUB);
  writeFileSync(join(isoDir, "_shared", "dedupe-fetch.ts"), readFileSync(join(here, "..", "..", "..", "_shared", "dedupe-fetch.ts"), "utf8"));
  mkdirSync(join(sm, "server"), { recursive: true });
  writeFileSync(join(sm, "server", "payload.ts"), readFileSync(join(serverRoot, "payload.ts"), "utf8"));
}

const bundleOut = join(isoDir, "bundle", "store.mjs");
await build({
  entryPoints: [join(isoDir, "sm", "client", "src", "store.ts")],
  bundle: true, format: "esm", platform: "node",
  outfile: bundleOut, logLevel: "silent",
});
const mod = await import(pathToFileURL(bundleOut).href + "?" + Date.now());
const { store, applyRunningFrame, applyRunningSnapshot } = mod;

test("无帧时初始快照可落地（内容差异才写）", () => {
  store.running = new Set();
  const applied = applyRunningSnapshot(["a", "b"], Date.now());
  assert.equal(applied, true);
  assert.deepEqual([...store.running].sort(), ["a", "b"]);
});

test("内容无变化的快照零写入（稳态慢对账不重渲染）", () => {
  const applied = applyRunningSnapshot(["a", "b"], Date.now() + 3000);
  assert.equal(applied, false);
  assert.deepEqual([...store.running].sort(), ["a", "b"]);
});

test("帧后落地的旧快照被弃（防旧盖新：捕获窗口内有帧）", () => {
  const changed = applyRunningFrame(["a", "b", "c"]); // 帧落地：权威
  assert.equal(changed, true);
  const stale = applyRunningSnapshot(["a"], Date.now() - 5000); // 捕获早于帧的快照
  assert.equal(stale, false, "捕获窗口内有帧 → 快照弃");
  assert.deepEqual([...store.running].sort(), ["a", "b", "c"], "帧数据不被旧快照覆盖");
});

test("比帧新的快照可对账（丢帧自愈路径：帧漏了结束事件，快照纠正）", () => {
  // 模拟失聪：帧通道漏掉 c 的结束帧，store 停留在 {a,b,c}
  const healed = applyRunningSnapshot(["a", "b"], Date.now() + 60000); // 远晚于帧的捕获
  assert.equal(healed, true, "快照比帧新 → 准落地对账");
  assert.deepEqual([...store.running].sort(), ["a", "b"]);
});

test("dedupe slack：捕获虽晚于帧但落在 2.5s 微缓存窗口内仍弃", () => {
  applyRunningFrame(["a", "b", "c"]); // 帧此刻落地
  const applied = applyRunningSnapshot(["a"], Date.now() + 1000); // 捕获仅晚 1s（< 2.5s slack）
  assert.equal(applied, false, "slack 窗口内快照数据可能早于帧 → 保守弃");
});

test("帧通道本身权威：同集合重复帧不报变化", () => {
  const first = applyRunningFrame(["a", "b"]); // 与上一用例遗留的 {a,b,c} 不同 → 变化
  const dup = applyRunningFrame(["a", "b"]); // 同集合重复帧 → 无变化
  assert.equal(first, true);
  assert.equal(dup, false);
});
