/**
 * ext-float-dock 降级层单测（node --test）。
 *
 * 覆盖点（dock v3.1 置前修复的降级语义，方案 position-picker-plan §11.3 补测三）：
 *   1. 未装 aiti-float 时 localPresent 可停靠/回浮窗/关闭；
 *   2. 同态 docked 再 open/dock:同区 → 广播 piwe-float-present-activate（宿主置前依据）；
 *   3. floating 幂等 open 不发 activate；
 *   4. declareDockZones/seedDockDefault 可用（TabBar ⇱ 菜单数据源）。
 *
 * helper 是 TS + react import（各扩展 vite 构建内联），node 直读不了——
 * 先用 esbuild 打包为可测 bundle（react 用 stub 替身，本文件只驱动非 React 出口）。
 * ⚠ 桩必须先于 bundle import 安装：helper 顶层在 import 时就注册 window 监听。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runEsbuild } from "./esbuild-bin.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** 极简 window/document/localStorage 桩：足够 helper 顶层监听注册与事件广播。 */
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

test("降级层：停靠/回浮窗/关闭 + 同态 open 广播 activate + 注册表", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efd-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 1) esbuild 打包 helper（react → stub）
  const esbuildBin = join(here, "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild");
  const reactStub = join(dir, "react-stub.js");
  writeFileSync(reactStub,
    "export const useEffect = () => {};\nexport const useState = (v) => [v, () => {}];\nexport const useLayoutEffect = () => {};\nexport const useRef = () => null;\nexport const createElement = () => null;\n");
  const outfile = join(dir, "bundle.mjs");
  await runEsbuild(esbuildBin, [join(here, "ext-float-dock.ts"), "--bundle", "--format=esm", "--platform=node",
    "--alias:react=" + reactStub, "--outfile=" + outfile, "--log-level=error"]);

  // 2) 先装全局桩，再 import bundle（helper 顶层注册 window 监听）
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

  // 关闭态 open → floating（降级语义），change 事件、无 activate
  mod.present("t:panel", "open");
  assert.equal(mod.presentState("t:panel"), "floating");
  assert.ok(events.some(([type, key]) => type === "change" && key === "t:panel"), "closed→floating 应发 change");
  assert.ok(!events.some(([type, key]) => type === "activate" && key === "t:panel"), "floating 不发 activate");

  // 停靠右栏 → docked
  mod.present("t:panel", "dock:right-panel");
  assert.equal(mod.presentState("t:panel"), "docked:right-panel");

  // 同态再 open → activate 广播（宿主置前依据），状态不变
  events.length = 0;
  mod.present("t:panel", "open");
  assert.equal(mod.presentState("t:panel"), "docked:right-panel");
  assert.deepEqual(events.find(([type]) => type === "activate")?.slice(1, 3), ["t:panel", "docked:right-panel"], "同态 docked open 应发 activate");

  // auto 入栈（刷新恢复/项目联动同步）的 activate 透传 auto 标记：宿主据此不拉起小屏抽屉
  events.length = 0;
  mod.present("t:panel", "open", { auto: true });
  assert.deepEqual(events.find(([type]) => type === "activate")?.slice(1), ["t:panel", "docked:right-panel", true], "auto 同态 open 的 activate 应带 auto");

  // auto + 状态迁移（closed → docked）的 change 也透传 auto
  events.length = 0;
  mod.present("t:panel", "close");
  events.length = 0;
  mod.present("t:panel", "dock:right-panel", { auto: true });
  assert.deepEqual(events.find(([type]) => type === "change")?.slice(1), ["t:panel", "docked:right-panel", true], "auto 迁移 change 应带 auto");

  // 同态 dock:同区 → activate 同样广播
  events.length = 0;
  mod.present("t:panel", "dock:right-panel");
  assert.ok(events.some(([type]) => type === "activate"), "dock:同区应发 activate");

  // 浮窗态幂等 open 不发 activate
  mod.present("t:panel", "float");
  events.length = 0;
  mod.present("t:panel", "open");
  assert.equal(mod.presentState("t:panel"), "floating");
  assert.ok(!events.some(([type]) => type === "activate"), "floating 幂等不发 activate");

  // 注册表：declareDockZones/seedDockDefault 可用（⇱ 菜单数据源）
  mod.declareDockZones("t:multi", ["sidebar-explorer", "right-panel"], "right-panel");
  mod.seedDockDefault("t:multi", "right-panel");
  assert.equal(mod.dockPref("t:multi"), "right-panel", "seed 已落 dockPref");
});

test("降级层：⇱ 菜单 DOM 构建与交互（float 缺席）", async (t) => {
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
  // 注意：不删全局桩——菜单打开会注册 dismiss setTimeout(0)，若测试同步结束后桩被删，
  // 定时器回调将 ReferenceError 并把整个测试文件标记失败（node --test 文件级失败）。
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const mod = await import(pathToFileURL(outfile).href);

  // 注册（多 zone + 默认）并停靠右栏（同时回归 docked: 规范态修复）
  mod.declareDockZones("m:panel", ["right-panel"], "right-panel");
  mod.present("m:panel", "dock:right-panel");
  assert.equal(mod.presentState("m:panel"), "docked:right-panel", "停靠态应规范为 docked:<zone>");

  // 派发宿主页签 ⇱ 事件 → 降级监听应构建统一位置菜单
  dom.window.dispatchEvent({ type: "piwe-float-dock-menu", detail: { key: "m:panel", rect: { left: 100, bottom: 100 } } });
  const menu = dom.document.body.children.find((c) => c.attrs["data-ext-dock-menu"]);
  assert.ok(menu, "菜单应挂到 body");
  // v5 图标排（方案 pi-web-dock-icon-row-plan）：菜单内一行「名称 + 右对齐图标组」
  const row = menu.children.find((c) => c.attrs["data-ext-dock-icon-row"] === "1");
  assert.ok(row, "菜单内应有图标排行");
  const label = row.children.find((c) => c.attrs["data-ext-dock-icon-row-label"] === "1");
  assert.equal(label.textContent, "停靠方位", "行名称（参照菜单样式：名称左 + 图标右对齐）");
  const group = row.children.find((c) => c.attrs["data-ext-dock-icon-group"] === "1");
  assert.ok(group, "图标组容器");
  const btns = group.children.filter((c) => c.tag === "button");
  assert.equal(btns.length, 2, "浮窗 + 右栏 两个图标按钮");
  const floatBtn = btns.find((b) => b.attrs["data-ext-dock-icon"] === "float");
  const rightBtn = btns.find((b) => b.attrs["data-ext-dock-icon"] === "right-panel");
  assert.ok(floatBtn && rightBtn, "图标按钮 data-ext-dock-icon 标注完整");
  assert.equal(floatBtn.title, "浮窗", "浮窗 tooltip");
  assert.equal(rightBtn.title, "右栏 · 面板（默认）", "默认位 tooltip 带（默认）");
  assert.equal(rightBtn.attrs["aria-checked"], "true", "当前态 aria-checked");
  assert.ok(rightBtn.children.some((g) => g.attrs["data-ext-dock-icon-default"] === "1"), "默认位圆点角标");
  assert.ok(floatBtn.children.some((g) => g.tag === "svg"), "图标按钮内含 svg（桩 createElementNS）");

  // 点「浮窗」→ 回浮窗
  floatBtn.click();
  assert.equal(mod.presentState("m:panel"), "floating", "选浮窗应回浮窗");
});

test("降级层：双内联副本共享 localStorage 状态——open/close 跨副本一致（folder 浮窗幽灵态回归）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "efd-twin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // 两份独立 bundle = 两个模块实例，模拟同一页面里 session-manager / aiti-folder
  // 各自内联的 _shared 副本（本模块被多扩展构建期内联的现实形态）。
  const esbuildBin = join(here, "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild");
  const reactStub = join(dir, "react-stub.js");
  writeFileSync(reactStub,
    "export const useEffect = () => {};\nexport const useState = (v) => [v, () => {}];\nexport const useLayoutEffect = () => {};\nexport const useRef = () => null;\nexport const createElement = () => null;\n");
  const bundle = async (name) => {
    const outfile = join(dir, name);
    // 派生形态（Linux 原生 ELF / Windows .exe 或 node 直跑 JS 入口）由 esbuild-bin 收口
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
  // 注意：与上方 ⇱ 菜单测试同理，不删全局桩——另一副本的菜单/事件回调可能在
  // 测试结束后异步触发（setTimeout(0) dismiss 注册），删桩会 ReferenceError 拖垮文件。
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const events = [];
  dom.window.addEventListener("piwe-float-present-change", (e) => events.push(["change", e.detail.key, e.detail.state]));

  const modA = await import(pathToFileURL(outfileA).href); // session-manager 内联份（open 发起方）
  const modB = await import(pathToFileURL(outfileB).href); // aiti-folder 内联份（closePanel 所在 face）

  // ── 场景 1（原 bug 直击）：副本 A present(open)（floating 语义旧路径）→ 副本 B 必须
  // 看到同一状态；副本 B close 必须生效并发事件（修复前 B 内存表为空 → no-op 永关不掉）。
  modA.present("x:panel", "float");
  assert.equal(modB.presentState("x:panel"), "floating", "副本 B 应读到副本 A 写入的 floating（共享 localStorage）");
  events.length = 0;
  modB.present("x:panel", "close");
  assert.equal(modA.presentState("x:panel"), "closed", "副本 B close 后副本 A 也应读到 closed");
  assert.equal(modB.presentState("x:panel"), "closed", "副本 B 自身状态 closed");
  assert.ok(events.some(([type, key, st]) => type === "change" && key === "x:panel" && st === "closed"), "close 应广播 change(closed)（gate 卸载依据）");

  // ── 场景 2：open 直达停靠新语义（aiti-float 缺席时不弹自带遮罩的模态浮窗）。
  // 声明 zones + 默认位 → open 落 docked:<default>；用户 pref（非 float）优先于默认。
  modA.declareDockZones("x:folder", ["sidebar-explorer", "right-panel"], "right-panel");
  modA.present("x:folder", "open");
  assert.equal(modA.presentState("x:folder"), "docked:right-panel", "声明过的面板 open 应直达默认停靠位");
  assert.equal(modB.presentState("x:folder"), "docked:right-panel", "副本 B 一致");
  // 用户 pref = sidebar-explorer（跨副本 localStorage 共享，B 写 A 读同键）
  modB.present("x:folder", "dock:sidebar-explorer");
  modA.present("x:folder", "close");
  modA.present("x:folder", "open");
  assert.equal(modA.presentState("x:folder"), "docked:sidebar-explorer", "open 尊重用户 pref 落位");
  // pref = "float" 不认（降级层无浮窗形态）→ 回落默认位
  modA.present("x:folder", "float");
  modA.present("x:folder", "close");
  try { dom.window.localStorage.setItem("pi-web:ext-float:dockpref:v1:x:folder", "float"); } catch { /* ignore */ }
  modA.present("x:folder", "open");
  assert.equal(modA.presentState("x:folder"), "docked:right-panel", "pref=float 在降级层回落默认停靠位");

  // ── 场景 3：完全未声明 zones 的面板 open → floating 兜底（老语义保留）。
  modA.present("x:legacy", "open");
  assert.equal(modA.presentState("x:legacy"), "floating", "无声明面板 open 兜底 floating");
  assert.equal(modB.presentState("x:legacy"), "floating", "副本 B 一致");
});
