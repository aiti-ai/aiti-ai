/**
 * collapsePanelIfCovering —— 「All Sessions 里点开会话不该关掉 All Sessions」回归（2026-09-22）。
 *
 * 旧行为：任何点开会话的入口都无条件 panelOpen.onClose()，面板每次都要重开才能连点。
 * 新行为：只有浮窗铺满视口（小屏 ≤640px，aiti-float data-ext-float-full 同款断点）才会
 * 盖住刚打开的会话/查看器 → 那种场合让位；桌面浮窗、右栏停靠、面板未开都保持不动。
 *
 * 运行：node client/tests/panel-collapse-on-open.test.mjs（秒级）
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
// dock 展示态与小屏断点都由 globalThis 上的开关驱动（每个用例改写一次）
const EXT_FLOAT_STUB = [
  "export function present() { return {} as Record<string, unknown>; }",
  "export function presentState() { return (globalThis as any).__panelState; }",
  "export function openFloat() { /* test stub */ }",
  "export function closePanel() { /* test stub */ }",
].join("\n");

function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-collapse-test-"));
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
const { collapsePanelIfCovering } = mod;

let closes = 0;
mod.panelOpen.onClose = () => { closes++; };

/** @param state 浮窗/停靠/关闭态；@param small 是否命中 ≤640px；@param dom 有无 window.matchMedia */
function scene(state, small, dom = true) {
  closes = 0;
  globalThis.__panelState = state;
  if (dom) {
    globalThis.window = { matchMedia: () => ({ matches: small }) };
  } else {
    delete globalThis.window;
  }
}

test("浮窗 + 桌面宽屏：点开会话不收面板（可以连着点）", () => {
  scene("floating", false);
  collapsePanelIfCovering();
  assert.equal(closes, 0, "浮窗没铺满视口 → 不遮挡 → 保持打开");
});

test("浮窗 + 小屏全屏：收面板（否则盖住刚打开的会话/查看器）", () => {
  scene("floating", true);
  collapsePanelIfCovering();
  assert.equal(closes, 1);
});

test("右栏停靠 + 小屏：不收面板（嵌入态不遮挡）", () => {
  scene("docked:right-panel", true);
  collapsePanelIfCovering();
  assert.equal(closes, 0);
});

test("面板未开：不收（也不因读不到展示态而炸）", () => {
  scene("closed", true);
  collapsePanelIfCovering();
  assert.equal(closes, 0);
});

test("无 DOM（matchMedia 取不到）：保守不关", () => {
  scene("floating", true, false);
  collapsePanelIfCovering();
  assert.equal(closes, 0);
});

rmSync(isoDir, { recursive: true, force: true });
