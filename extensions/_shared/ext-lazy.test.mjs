/**
 * ext-lazy 单测（node --test）——方案 pi-web-eager-ext-split-plan.md §4.1 附带最小自测。
 *
 * 覆盖点：
 *   1. createLazyModule：load 幂等单例（同实例）、失败复位重试、subscribe/useModule 就绪通知；
 *   2. lazyExtView：active=false 渲染 null 且不 import（门控前置）；active=true 触发加载
 *      → 就绪渲染 pick 组件；fallback 加载占位；失败 → null + onError，门控重开后重试；
 *   3. 同一 load 引用跨视图共享单例（并发只 import 一次）。
 *
 * helper 是 TS + react import（各扩展 vite 构建内联），node 直读不了——
 * 先用 esbuild 打包为可测 bundle（react 用可驱动 hooks 的迷你桩：state 按组件实例
 * （key）+调用序持久化，effect 排队手动 flush，建模 React 最小语义）。
 * ⚠ 桩必须先于 bundle import 安装。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEsbuild } from "./esbuild-bin.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** 迷你 react 桩：useState/useEffect 真实驱动（state 按 key（组件实例）+slot 序持久化；
 *  effect 带 deps 比较——deps 未变不重跑，建模 React 最小语义）。 */
function makeReactStub() {
  const slotsByKey = new Map(); // key -> Map(slotIndex -> value)
  const effectDeps = new Map(); // key:slotIndex -> last deps（浅比较）
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
      if (same) return; // deps 未变：不重跑（React 语义）
      effectDeps.set(id, deps ? [...deps] : null);
      pendingEffects.push(fn);
    },
    useRef(v) { return { current: v }; },
    createElement(type, props, ...children) { return { type, props, children }; },
    /** 渲染一轮「组件实例 key」：slot 序复位，state 跨轮持久化。 */
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

test("ext-lazy：单例/重试/门控懒视图", async (t) => {
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
  // 派生形态（Linux 原生 ELF / Windows 官方 .exe，或 node 直跑 JS 入口）由 esbuild-bin 收口
  await runEsbuild(esbuildBin, [join(here, "ext-lazy.tsx"), "--bundle", "--format=esm", "--platform=node",
    "--alias:react=" + reactStub, "--outfile=" + outfile, "--log-level=error"]);

  const react = makeReactStub();
  globalThis.__reactStub = react;
  t.after(() => { delete globalThis.__reactStub; });

  const flush = async () => {
    react.__flushEffects();
    // 宏任务排空：import 链（含 then 嵌套采纳）的微任务数不定，宏任务兜底等全
    await new Promise((r) => setImmediate(r));
  };

  const mod = await import(pathToFileURL(outfile).href);

  // ── 1) createLazyModule：幂等单例 + 失败复位重试 + 订阅 ──
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
  assert.equal(importCount, 2, "失败复位：每次 load 重新 import（否则失败 promise 永久缓存）");
  fail = false;
  const m1 = await ref.load();
  const m2 = await ref.load();
  assert.equal(importCount, 3, "成功后幂等：不再 import");
  assert.equal(m1, m2, "同一模块实例");
  assert.deepEqual(events, [3], "就绪应通知订阅者");

  // useModule：挂载时已就绪 → 立即拿到模块
  let seen = "unset";
  react.render("probe", () => { seen = ref.useModule(); return null; });
  react.__flushEffects();
  assert.equal(seen, m1, "useModule 挂载时已就绪应立即返回模块");

  // ── 2) lazyExtView：门控 / fallback / pick 渲染 / 失败重试 ──
  let viewImports = 0;
  const viewLoader = () => {
    viewImports += 1;
    return Promise.resolve({ Comp: (props) => ({ comp: "Comp", props }) });
  };
  const renderView = (active, extra = {}) =>
    react.render("view", () => mod.lazyExtView({ active, load: viewLoader, pick: "Comp", ...extra }));

  // active=false：渲染 null 且不 import
  assert.equal(renderView(false), null, "门控关闭渲染 null");
  react.__flushEffects();
  assert.equal(viewImports, 0, "门控关闭绝不 import（dialogs/pages 常挂插槽安全性）");

  // active=true：加载中 fallback；就绪后返回 h(Comp, props) 元素（props 透传）
  assert.equal(renderView(true, { fallback: () => "loading" }), "loading", "加载中渲染 fallback");
  await flush();
  assert.equal(viewImports, 1);
  const el1 = renderView(true, { props: { a: 1 } });
  assert.equal(el1 && el1.props && el1.props.a, 1, "就绪后返回元素且透传 props");
  assert.deepEqual(el1.type && el1.type(el1.props), { comp: "Comp", props: { a: 1 } }, "元素 type 即 pick 导出组件");

  // 失败：onError + 渲染 null；门控 false→true 重开自动重试成功
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
  assert.equal(errors.length, 1, "失败应回调 onError");
  assert.equal(renderFail(true), null, "失败态渲染 null（active 未变不自动重试）");
  failLoaderFail = false;
  assert.equal(renderFail(false), null); // 门控关
  await flush();
  assert.equal(renderFail(true), null);  // 门控重开 → 重试中
  await flush();
  assert.equal(failLoaderCount, 2, "门控重开应重试");
  assert.equal(renderFail(true) && renderFail(true).type(), "ok", "重试成功后渲染组件");

  // pick 导出缺失 → onError + null
  const missingLoader = () => Promise.resolve({ other: 1 });
  const renderMissing = () =>
    react.render("missingView", () => mod.lazyExtView({ active: true, load: missingLoader, pick: "Comp", onError: (e) => errors.push(e) }));
  assert.equal(renderMissing(), null);
  await flush();
  assert.equal(renderMissing(), null, "导出缺失渲染 null");
  assert.equal(errors.length, 2, "导出缺失应走 onError（渲染期发现）");

  // 并发单例：同一 load 引用，多视图（不同实例）共享一次 import
  let sharedCount = 0;
  const sharedLoader = () => { sharedCount += 1; return Promise.resolve({ Comp: () => "s" }); };
  const renderShared = (key) => react.render(key, () => mod.lazyExtView({ active: true, load: sharedLoader, pick: "Comp" }));
  renderShared("s1"); renderShared("s2"); renderShared("s3");
  await flush();
  assert.equal(sharedCount, 1, "同 load 引用并发只 import 一次");
});
