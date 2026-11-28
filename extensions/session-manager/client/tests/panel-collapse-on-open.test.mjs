/**
 * collapsePanelIfCovering — "clicking a session inside All Sessions must not trap the user" (2026-09-22,
 * extended 2026-11-21 with the geometry rule).
 *
 * History:
 *   - old behaviour: every entry that opens a session unconditionally called panelOpen.onClose(), so
 *     users had to reopen the panel for each pick.
 *   - 2026-09: only a float that fills the viewport (small screen ≤640px) yields; desktop float and
 *     right-panel dock stay open.
 *   - 2026-11-21 (field report): a **maximized / dragged-nearly-full** float also hides the target
 *     ("clicked, nothing happened, but the session opened behind it"), so the decision now also asks
 *     aiti-float whether the panel is full and measures the panel area against the viewport
 *     (thresholds in float-yield.pure.ts, unit-tested separately).
 *
 * Run: node client/tests/panel-collapse-on-open.test.mjs (seconds)
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
// Dock presentation state and the small-screen breakpoint are driven from globalThis switches
// (each case rewrites them).
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
  writeFileSync(join(clientSrc, "float-yield.pure.ts"), readFileSync(join(srcRoot, "float-yield.pure.ts"), "utf8"));
  writeFileSync(join(clientSrc, "host-shim.ts"), HOST_SHIM_STUB);
  writeFileSync(join(clientSrc, "sidebar", "pure.ts"), readFileSync(join(srcRoot, "sidebar", "pure.ts"), "utf8"));
  mkdirSync(join(dir, "node_modules", "@aiti-ai", "ext-shared"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "@aiti-ai", "ext-shared", "package.json"), JSON.stringify({ name: "@aiti-ai/ext-shared", type: "module" }));
  writeFileSync(join(dir, "node_modules", "@aiti-ai", "ext-shared", "ext-float-dock-lite.ts"), EXT_FLOAT_STUB);
  writeFileSync(join(dir, "node_modules", "@aiti-ai", "ext-shared", "ext-float-dock.ts"), EXT_FLOAT_STUB);
  writeFileSync(join(dir, "node_modules", "@aiti-ai", "ext-shared", "dedupe-fetch.ts"), readFileSync(join(here, "..", "..", "..", "_shared", "dedupe-fetch.ts"), "utf8"));
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

/**
 * Build a scene.
 * @param state   float/dock/closed presentation state
 * @param small   whether the ≤640px breakpoint matches
 * @param opts    { dom:false } → no window at all; { rect, isFull, vw, vh } → panel geometry + aiti-float
 */
function scene(state, small, opts = {}) {
  closes = 0;
  globalThis.__panelState = state;
  const { dom = true, rect = null, isFull = false, vw = 1600, vh = 900 } = opts;
  if (!dom) {
    delete globalThis.window;
    delete globalThis.document;
    return;
  }
  globalThis.window = {
    matchMedia: () => ({ matches: small }),
    innerWidth: vw,
    innerHeight: vh,
    // aiti-float global API (isFull drives the maximize / small-screen-full case)
    __piweFloat: { isFull: () => isFull, raise: () => true },
  };
  // The panel element is looked up through the host wrapper（data-ext-id + composite data-ext-item）
  const el = rect ? { getBoundingClientRect: () => rect, isConnected: true } : null;
  globalThis.document = {
    querySelector(sel) {
      if (!el) return null;
      // only the wrapper selector matches (findFloatPanel's second route)
      return /session-manager/.test(sel) ? el : null;
    },
  };
}

const rect = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height,
});

test("desktop float, default size (680×700): panel stays open (consecutive picks)", () => {
  scene("floating", false, { rect: rect(460, 100, 680, 700) });
  collapsePanelIfCovering();
  assert.equal(closes, 0, "a normal float does not cover the main area → keep it open");
});

test("desktop float, maximized (aiti-float isFull): collapses", () => {
  scene("floating", false, { rect: rect(0, 0, 1600, 857), isFull: true });
  collapsePanelIfCovering();
  assert.equal(closes, 1, "maximized All Sessions hid the session that just opened");
});

test("desktop float, dragged to ≥60% of the viewport: collapses", () => {
  scene("floating", false, { rect: rect(100, 50, 1400, 700) }); // 63%
  collapsePanelIfCovering();
  assert.equal(closes, 1);
});

test("desktop float, just under the threshold (46%): stays open", () => {
  scene("floating", false, { rect: rect(500, 300, 1100, 600) });
  collapsePanelIfCovering();
  assert.equal(closes, 0);
});

test("small screen float: collapses (old breakpoint rule still applies)", () => {
  scene("floating", true, { rect: rect(-20, -110, 680, 700), vw: 640, vh: 480 });
  collapsePanelIfCovering();
  assert.equal(closes, 1);
});

test("right-panel dock: never collapses, even on small screens", () => {
  scene("docked:right-panel", true, { rect: rect(0, 0, 1600, 900), isFull: true });
  collapsePanelIfCovering();
  assert.equal(closes, 0, "a docked panel is embedded in the layout, it covers nothing");
});

test("panel closed: no crash, no collapse", () => {
  scene("closed", true, {});
  collapsePanelIfCovering();
  assert.equal(closes, 0);
});

test("no DOM at all: conservative, no collapse", () => {
  scene("floating", true, { dom: false });
  collapsePanelIfCovering();
  assert.equal(closes, 0);
});

test("floating but panel element not found yet (first frame): falls back to the breakpoint", () => {
  scene("floating", false, { rect: null }); // panel not in the DOM yet
  collapsePanelIfCovering();
  assert.equal(closes, 0, "desktop + unknown geometry → keep open");

  scene("floating", true, { rect: null });
  collapsePanelIfCovering();
  assert.equal(closes, 1, "small screen → the breakpoint still collapses it");
});

rmSync(isoDir, { recursive: true, force: true });
