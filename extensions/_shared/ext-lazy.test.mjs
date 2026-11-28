/**
 * ext-lazy unit tests (node --test) — the minimal self-test shipped with plan
 * pi-web-eager-ext-split-plan.md §4.1.
 *
 * Coverage:
 *   1. createLazyModule: idempotent singleton load (same instance), failure reset + retry,
 *      subscribe/useModule readiness notification;
 *   2. lazyExtView: active=false renders null and never imports (gate first); active=true triggers
 *      loading → renders the pick component when ready; fallback while loading; failure → null +
 *      onError, retries when the gate reopens;
 *   3. the same load reference shares one singleton across views (concurrent imports happen once).
 *
 * The helper is TS with react imports (inlined by each extension's vite build); node cannot read it
 * directly — so first bundle it into a testable bundle with esbuild (react is a mini stub that can
 * drive hooks: state persists per component instance (key) + call order, effects queue and flush
 * manually, modeling minimal React semantics).
 * ⚠ The stub must be installed before the bundle import.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEsbuild } from "./esbuild-bin.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Mini react stub: useState/useEffect actually driven (state persists per key (component
 *  instance) + slot order; effects compare deps — unchanged deps don't re-run, modeling
 *  minimal React semantics). */
function makeReactStub() {
  const slotsByKey = new Map(); // key -> Map(slotIndex -> value)
  const effectDeps = new Map(); // key:slotIndex -> last deps (shallow compare)
  const pendingEffects = [];
  let currentKey = null;
  let slotIdx = 0;
  const stub = {
    useState(init) {
      let slots = slotsByKey.get(currentKey);
      if (!slots) { slots = new Map(); slotsByKey.set(currentKey, slots); }
      const id = slotIdx++;
      if (!slots.has(id)) slots.set(id, typeof init === "function" ? init() : init);
      const set = (v) => {
        slots.set(id, typeof v === "function" ? v(slots.get(id)) : v);
      };
      return [slots.get(id), set];
    },
    useEffect(fn, deps) {
      const id = `${currentKey}:${slotIdx++}`;
      const last = effectDeps.get(id);
      const same = last && deps && last.length === deps.length && deps.every((d, i) => d === last[i]);
      if (same) return; // deps unchanged: don't re-run (React semantics)
      effectDeps.set(id, deps ? [...deps] : null);
      pendingEffects.push(fn);
    },
    useRef(v) { return { current: v }; },
    createElement(type, props, ...children) { return { type, props, children }; },
    /** Render one round under a "component instance key": slot order resets, state persists across rounds. */
    render(key, fn) {
      const prevKey = currentKey;
      currentKey = key;
      slotIdx = 0;
      try { return fn(); } finally { currentKey = prevKey; }
    },
    __flushEffects() {
      const list = pendingEffects.splice(0, pendingEffects.length);
      for (const fn of list) fn();
    },
  };
  return stub;
}

test("ext-lazy: singleton / retry / gated lazy view", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ext-lazy-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const esbuildBin = join(here, "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild");
  const reactStub = join(dir, "react-stub.js");
  writeFileSync(reactStub,
    "export const useState = (i) => globalThis.__reactStub.useState(i);\n" +
    "export const useEffect = (f, d) => globalThis.__reactStub.useEffect(f, d);\n" +
    "export const useRef = (v) => globalThis.__reactStub.useRef(v);\n" +
    "export const createElement = (...a) => globalThis.__reactStub.createElement(...a);\n");
  const outfile = join(dir, "bundle.mjs");
  // Derived form (Linux native ELF / Windows official .exe, or node running a JS entry directly) is settled by esbuild-bin
  await runEsbuild(esbuildBin, [join(here, "ext-lazy.tsx"), "--bundle", "--format=esm", "--platform=node",
    "--alias:react=" + reactStub, "--outfile=" + outfile, "--log-level=error"]);

  const react = makeReactStub();
  globalThis.__reactStub = react;
  t.after(() => { delete globalThis.__reactStub; });

  const flush = async () => {
    react.__flushEffects();
    // Macrotask drain: the microtask count of the import chain (including nested then adoption)
    // is unpredictable, so wait out a full macrotask as the backstop
    await new Promise((r) => setImmediate(r));
  };

  const mod = await import(pathToFileURL(outfile).href);

  // ── 1) createLazyModule: idempotent singleton + failure reset retry + subscription ──
  let importCount = 0;
  let fail = true;
  const ref = mod.createLazyModule(() => {
    importCount += 1;
    if (fail) return Promise.reject(new Error("boom"));
    return Promise.resolve({ api: () => "ok" });
  });
  const events = [];
  ref.subscribe(() => events.push(importCount));

  await assert.rejects(ref.load(), /boom/);
  await assert.rejects(ref.load(), /boom/);
  assert.equal(importCount, 2, "failure reset: each load re-imports (otherwise the failed promise is cached forever)");
  fail = false;
  const m1 = await ref.load();
  const m2 = await ref.load();
  assert.equal(importCount, 3, "idempotent after success: no more imports");
  assert.equal(m1, m2, "same module instance");
  assert.deepEqual(events, [3], "readiness should notify subscribers");

  // useModule: already ready at mount → module returned immediately
  let seen = "unset";
  react.render("probe", () => { seen = ref.useModule(); return null; });
  react.__flushEffects();
  assert.equal(seen, m1, "useModule should return the module immediately when already ready at mount");

  // ── 2) lazyExtView: gate / fallback / pick rendering / failure retry ──
  let viewImports = 0;
  const viewLoader = () => {
    viewImports += 1;
    return Promise.resolve({ Comp: (props) => ({ comp: "Comp", props }) });
  };
  const renderView = (active, extra = {}) =>
    react.render("view", () => mod.lazyExtView({ active, load: viewLoader, pick: "Comp", ...extra }));

  // active=false: renders null and never imports
  assert.equal(renderView(false), null, "gate closed renders null");
  react.__flushEffects();
  assert.equal(viewImports, 0, "gate closed never imports (always-mounted dialogs/pages slot safety)");

  // active=true: fallback while loading; once ready returns an h(Comp, props) element (props pass through)
  assert.equal(renderView(true, { fallback: () => "loading" }), "loading", "renders fallback while loading");
  await flush();
  assert.equal(viewImports, 1);
  const el1 = renderView(true, { props: { a: 1 } });
  assert.equal(el1 && el1.props && el1.props.a, 1, "returns the element when ready with props passed through");
  assert.deepEqual(el1.type && el1.type(el1.props), { comp: "Comp", props: { a: 1 } }, "the element's type is the picked export component");

  // Failure: onError + renders null; gate false→true reopen auto-retries successfully
  const errors = [];
  let failLoaderFail = true;
  let failLoaderCount = 0;
  const failLoader = () => {
    failLoaderCount += 1;
    if (failLoaderFail) return Promise.reject(new Error("fail"));
    return Promise.resolve({ Comp: () => "ok" });
  };
  const renderFail = (active) =>
    react.render("failView", () => mod.lazyExtView({ active, load: failLoader, pick: "Comp", onError: (e) => errors.push(e) }));
  assert.equal(renderFail(true), null);
  await flush();
  assert.equal(failLoaderCount, 1);
  assert.equal(errors.length, 1, "failure should call onError");
  assert.equal(renderFail(true), null, "failed state renders null (no auto-retry while active is unchanged)");
  failLoaderFail = false;
  assert.equal(renderFail(false), null); // gate closed
  await flush();
  assert.equal(renderFail(true), null);  // gate reopened → retrying
  await flush();
  assert.equal(failLoaderCount, 2, "gate reopen should retry");
  assert.equal(renderFail(true) && renderFail(true).type(), "ok", "renders the component after a successful retry");

  // missing pick export → onError + null
  const missingLoader = () => Promise.resolve({ other: 1 });
  const renderMissing = () =>
    react.render("missingView", () => mod.lazyExtView({ active: true, load: missingLoader, pick: "Comp", onError: (e) => errors.push(e) }));
  assert.equal(renderMissing(), null);
  await flush();
  assert.equal(renderMissing(), null, "missing export renders null");
  assert.equal(errors.length, 2, "missing export should go through onError (detected at render time)");

  // Concurrent singleton: the same load reference, multiple views (different instances) share one import
  let sharedCount = 0;
  const sharedLoader = () => { sharedCount += 1; return Promise.resolve({ Comp: () => "s" }); };
  const renderShared = (key) => react.render(key, () => mod.lazyExtView({ active: true, load: sharedLoader, pick: "Comp" }));
  renderShared("s1"); renderShared("s2"); renderShared("s3");
  await flush();
  assert.equal(sharedCount, 1, "concurrent views on the same load reference import only once");
});
