/**
 * ext-float-dock fallback-layer unit tests (node --test).
 *
 * Coverage (the dock v3.1 bring-forward fix's fallback semantics, plan
 * position-picker-plan §11.3 supplementary test three):
 *   1. with aiti-float not installed, localPresent can dock / return to float / close;
 *   2. re-opening an already-docked state / dock: same zone → broadcasts
 *      piwe-float-present-activate (the host's bring-forward basis);
 *   3. floating idempotent open sends no activate;
 *   4. declareDockZones/seedDockDefault usable (the TabBar ⇱ menu's data source).
 *
 * The helper is TS + react import (inlined by each extension's vite build), unreadable
 * by node directly —
 * first bundle it with esbuild into a testable bundle (react stubbed; this file only
 * drives the non-React exports).
 * ⚠ Stubs must be installed before the bundle import: the helper's top level registers
 * window listeners at import time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEsbuild } from "./esbuild-bin.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal window/document/localStorage stub: enough for the helper's top-level
 *  listener registration and event broadcast. */
function makeDomStub() {
  const listeners = new Map(); // type -> Set<fn>
  const storage = new Map();
  const makeEl = (tag = "div") => {
    const el = {
      tag, style: {}, className: "", textContent: "", children: [], attrs: {}, handlers: {}, parentElement: null,
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); c.parentElement = this; },
      remove() {
        const p = this.parentElement;
        if (!p) return;
        const i = p.children.indexOf(this);
        if (i >= 0) p.children.splice(i, 1);
        this.parentElement = null;
      },
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter((f) => f !== fn); },
      click() { for (const fn of this.handlers.click || []) fn({ target: this, stopPropagation() {} }); },
      querySelector: () => null,
      querySelectorAll: (sel) => (sel === "button" ? this.children.filter((c) => c.tag === "button") : []),
      contains: (n) => { for (const c of this.children) { if (c === n || c.contains(n)) return true; } return false; },
    };
    return el;
  };
  const window = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev.type) ?? []) fn(ev);
      return true;
    },
    innerWidth: 1600, innerHeight: 900,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  };
  const document = {
    getElementById: () => makeEl(),
    createElement: (tag) => makeEl(tag),
    createElementNS: (_ns, tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    head: { appendChild() {} }, body: makeEl("body"),
  };
  return { window, document, listeners };
}

test("fallback layer: dock / return-to-float / close + same-state open broadcasts activate + registry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efd-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 1) esbuild bundles the helper (react → stub)
  const esbuildBin = join(here, "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild");
  const reactStub = join(dir, "react-stub.js");
  writeFileSync(reactStub,
    "export const useEffect = () => {};\nexport const useState = (v) => [v, () => {}];\nexport const useLayoutEffect = () => {};\nexport const useRef = () => null;\nexport const createElement = () => null;\n");
  const outfile = join(dir, "bundle.mjs");
  await runEsbuild(esbuildBin, [join(here, "ext-float-dock.ts"), "--bundle", "--format=esm", "--platform=node",
    "--alias:react=" + reactStub, "--outfile=" + outfile, "--log-level=error"]);

  // 2) install global stubs first, then import the bundle (the helper's top level registers window listeners)
  const dom = makeDomStub();
  globalThis.window = dom.window;
  globalThis.document = dom.document;
  globalThis.CustomEvent = class {
    constructor(type, opts) { this.type = type; if (opts && opts.detail !== undefined) this.detail = opts.detail; }
  };
  globalThis.localStorage = dom.window.localStorage;
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.CustomEvent;
    delete globalThis.localStorage;
  });

  const events = [];
  dom.window.addEventListener("piwe-float-present-activate", (e) => events.push(["activate", e.detail.key, e.detail.state, e.detail.auto === true]));
  dom.window.addEventListener("piwe-float-present-change", (e) => events.push(["change", e.detail.key, e.detail.state, e.detail.auto === true]));

  const mod = await import(pathToFileURL(outfile).href);

  // open from closed → floating (fallback semantics), change event, no activate
  mod.present("t:panel", "open");
  assert.equal(mod.presentState("t:panel"), "floating");
  assert.ok(events.some(([type, key]) => type === "change" && key === "t:panel"), "closed→floating should emit change");
  assert.ok(!events.some(([type, key]) => type === "activate" && key === "t:panel"), "floating emits no activate");

  // dock to the right panel → docked
  mod.present("t:panel", "dock:right-panel");
  assert.equal(mod.presentState("t:panel"), "docked:right-panel");

  // re-open same state → activate broadcast (the host's bring-forward basis), state unchanged
  events.length = 0;
  mod.present("t:panel", "open");
  assert.equal(mod.presentState("t:panel"), "docked:right-panel");
  assert.deepEqual(events.find(([type]) => type === "activate")?.slice(1, 3), ["t:panel", "docked:right-panel"], "same-state docked open should emit activate");

  // auto re-dock (refresh restore / project-linked sync): activate passes the auto flag
  // through; the host keeps the small-screen drawer down based on it
  events.length = 0;
  mod.present("t:panel", "open", { auto: true });
  assert.deepEqual(events.find(([type]) => type === "activate")?.slice(1), ["t:panel", "docked:right-panel", true], "auto same-state open's activate should carry auto");

  // auto + state transition (closed → docked): change also passes auto through
  events.length = 0;
  mod.present("t:panel", "close");
  events.length = 0;
  mod.present("t:panel", "dock:right-panel", { auto: true });
  assert.deepEqual(events.find(([type]) => type === "change")?.slice(1), ["t:panel", "docked:right-panel", true], "auto transition change should carry auto");

  // same-state dock: same zone → activate broadcast too
  events.length = 0;
  mod.present("t:panel", "dock:right-panel");
  assert.ok(events.some(([type]) => type === "activate"), "dock: same zone should emit activate");

  // floating idempotent open sends no activate
  mod.present("t:panel", "float");
  events.length = 0;
  mod.present("t:panel", "open");
  assert.equal(mod.presentState("t:panel"), "floating");
  assert.ok(!events.some(([type]) => type === "activate"), "floating idempotent emits no activate");

  // registry: declareDockZones/seedDockDefault usable (the ⇱ menu's data source)
  mod.declareDockZones("t:multi", ["sidebar-explorer", "right-panel"], "right-panel");
  mod.seedDockDefault("t:multi", "right-panel");
  assert.equal(mod.dockPref("t:multi"), "right-panel", "seed landed in dockPref");
});

test("fallback layer: ⇱ menu DOM construction and interaction (float absent)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efd-menu-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const esbuildBin = join(here, "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild");
  const reactStub = join(dir, "react-stub.js");
  writeFileSync(reactStub,
    "export const useEffect = () => {};\nexport const useState = (v) => [v, () => {}];\nexport const useLayoutEffect = () => {};\nexport const useRef = () => null;\nexport const createElement = () => null;\n");
  const outfile = join(dir, "bundle.mjs");
  await runEsbuild(esbuildBin, [join(here, "ext-float-dock.ts"), "--bundle", "--format=esm", "--platform=node",
    "--alias:react=" + reactStub, "--outfile=" + outfile, "--log-level=error"]);

  const dom = makeDomStub();
  globalThis.window = dom.window;
  globalThis.document = dom.document;
  globalThis.CustomEvent = class {
    constructor(type, opts) { this.type = type; if (opts && opts.detail !== undefined) this.detail = opts.detail; }
  };
  globalThis.localStorage = dom.window.localStorage;
  globalThis.localStorage.setItem("pi-locale", "zh-CN"); // header/menu word table picks by locale; this block asserts the resolved word-table labels
  // Note: do not delete the global stubs — opening the menu registers a dismiss
  // setTimeout(0); if the stubs were deleted after the test's synchronous body,
  // the timer callback would ReferenceError and mark the whole test file failed
  // (node --test file-level failure).
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const mod = await import(pathToFileURL(outfile).href);

  // register (multi-zone + default) and dock to the right panel (also regression-covers
  // the docked: canonical-state fix)
  mod.declareDockZones("m:panel", ["right-panel"], "right-panel");
  mod.present("m:panel", "dock:right-panel");
  assert.equal(mod.presentState("m:panel"), "docked:right-panel", "docked state should be canonical docked:<zone>");

  // dispatch the host tab ⇱ event → the fallback listener should build the unified position menu
  dom.window.dispatchEvent({ type: "piwe-float-dock-menu", detail: { key: "m:panel", rect: { left: 100, bottom: 100 } } });
  const menu = dom.document.body.children.find((c) => c.attrs["data-ext-dock-menu"]);
  assert.ok(menu, "menu should attach to body");
  // v5 icon row (plan pi-web-dock-icon-row-plan): one "name + right-aligned icon group"
  // row inside the menu
  const row = menu.children.find((c) => c.attrs["data-ext-dock-icon-row"] === "1");
  assert.ok(row, "menu should contain an icon row");
  const label = row.children.find((c) => c.attrs["data-ext-dock-icon-row-label"] === "1");
  assert.equal(label.textContent, "停靠方位", "row name (mirrors the menu style: name left + icons right-aligned)");
  const group = row.children.find((c) => c.attrs["data-ext-dock-icon-group"] === "1");
  assert.ok(group, "icon group container");
  const btns = group.children.filter((c) => c.tag === "button");
  assert.equal(btns.length, 2, "float + right panel, two icon buttons");
  const floatBtn = btns.find((b) => b.attrs["data-ext-dock-icon"] === "float");
  const rightBtn = btns.find((b) => b.attrs["data-ext-dock-icon"] === "right-panel");
  assert.ok(floatBtn && rightBtn, "icon buttons fully tagged with data-ext-dock-icon");
  assert.equal(floatBtn.title, "浮窗", "float tooltip (zh-CN word table)");
  assert.equal(rightBtn.title, "右栏 · 面板（默认）", "default-position tooltip carries (default) (zh-CN word table)");
  assert.equal(rightBtn.attrs["aria-checked"], "true", "active-state aria-checked");
  assert.ok(rightBtn.children.some((g) => g.attrs["data-ext-dock-icon-default"] === "1"), "default-position dot badge");
  assert.ok(floatBtn.children.some((g) => g.tag === "svg"), "icon button contains an svg (stub createElementNS)");

  // click "float" → back to float
  floatBtn.click();
  assert.equal(mod.presentState("m:panel"), "floating", "choosing float should return to float");
});

test("fallback layer: twin inline copies share localStorage state — open/close consistent across copies (folder float-window ghost-state regression)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efd-twin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // two independent bundles = two module instances, simulating session-manager /
  // aiti-folder each inlining their own _shared copy in one page (the real-world shape
  // of this module being inlined by multiple extensions at build time).
  const esbuildBin = join(here, "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild");
  const reactStub = join(dir, "react-stub.js");
  writeFileSync(reactStub,
    "export const useEffect = () => {};\nexport const useState = (v) => [v, () => {}];\nexport const useLayoutEffect = () => {};\nexport const useRef = () => null;\nexport const createElement = () => null;\n");
  const bundle = async (name) => {
    const outfile = join(dir, name);
    // the derived form (Linux native ELF / Windows .exe, or node running a JS entry) is
    // resolved by esbuild-bin
    await runEsbuild(esbuildBin, [join(here, "ext-float-dock.ts"), "--bundle", "--format=esm", "--platform=node",
      "--alias:react=" + reactStub, "--outfile=" + outfile, "--log-level=error"]);
    return outfile;
  };
  const outfileA = await bundle("bundle-a.mjs");
  const outfileB = await bundle("bundle-b.mjs");

  const dom = makeDomStub();
  globalThis.window = dom.window;
  globalThis.document = dom.document;
  globalThis.CustomEvent = class {
    constructor(type, opts) { this.type = type; if (opts && opts.detail !== undefined) this.detail = opts.detail; }
  };
  globalThis.localStorage = dom.window.localStorage;
  // Note: same as the ⇱ menu test above, do not delete the global stubs — the other
  // copy's menu/event callbacks may fire asynchronously after the test ends
  // (setTimeout(0) dismiss registration); deleting stubs would ReferenceError and sink
  // the file.
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const events = [];
  dom.window.addEventListener("piwe-float-present-change", (e) => events.push(["change", e.detail.key, e.detail.state]));

  const modA = await import(pathToFileURL(outfileA).href); // session-manager's inline copy (the open initiator)
  const modB = await import(pathToFileURL(outfileB).href); // aiti-folder's inline copy (the face holding closePanel)

  // ── Scenario 1 (direct hit on the original bug): copy A present(open) (the old
  // floating-semantics path) → copy B must see the same state; copy B's close must take
  // effect and emit an event (pre-fix, B's memory table was empty → no-op, never closable).
  modA.present("x:panel", "float");
  assert.equal(modB.presentState("x:panel"), "floating", "copy B should read the floating copy A wrote (shared localStorage)");
  events.length = 0;
  modB.present("x:panel", "close");
  assert.equal(modA.presentState("x:panel"), "closed", "after copy B closes, copy A should also read closed");
  assert.equal(modB.presentState("x:panel"), "closed", "copy B's own state closed");
  assert.ok(events.some(([type, key, st]) => type === "change" && key === "x:panel" && st === "closed"), "close should broadcast change(closed) (the gate unmount basis)");

  // ── Scenario 2: open-goes-straight-to-dock new semantics (no self-overlay modal float
  // window pops when aiti-float is absent).
  // Declared zones + default position → open lands docked:<default>; user pref
  // (non-float) wins over the default.
  modA.declareDockZones("x:folder", ["sidebar-explorer", "right-panel"], "right-panel");
  modA.present("x:folder", "open");
  assert.equal(modA.presentState("x:folder"), "docked:right-panel", "a declaring panel's open should land directly on the default dock position");
  assert.equal(modB.presentState("x:folder"), "docked:right-panel", "copy B consistent");
  // user pref = sidebar-explorer (cross-copy localStorage sharing; B writes, A reads the same key)
  modB.present("x:folder", "dock:sidebar-explorer");
  modA.present("x:folder", "close");
  modA.present("x:folder", "open");
  assert.equal(modA.presentState("x:folder"), "docked:sidebar-explorer", "open lands by user pref");
  // pref = "float" unrecognized (the fallback layer has no float form) → falls back to
  // the default position
  modA.present("x:folder", "float");
  modA.present("x:folder", "close");
  try { dom.window.localStorage.setItem("pi-web:ext-float:dockpref:v1:x:folder", "float"); } catch { /* ignore */ }
  modA.present("x:folder", "open");
  assert.equal(modA.presentState("x:folder"), "docked:right-panel", "pref=float falls back to the default dock position in the fallback layer");

  // ── Scenario 3: a panel with no zones declared at all, open → floating backstop
  // (legacy semantics kept).
  modA.present("x:legacy", "open");
  assert.equal(modA.presentState("x:legacy"), "floating", "a non-declaring panel's open backstops to floating");
  assert.equal(modB.presentState("x:legacy"), "floating", "copy B consistent");
});
