/**
 * folder-dock（aiti-folder 文件夹区块）单测 —— node --test。
 *
 * 覆盖 2026-09-18 修复的两处：
 *   1. faces 重注册 render/meta 引用稳定化：宿主 ExtSlot 以 `<it.render/>` 为元素类型，
 *      重注册换新闭包 = React 卸载重挂整棵子树（FolderBrowser root/展开集全丢）——
 *      「点钉住 → folder 打回旧值」。本测试钉死：同路径重注册引用不变、差量新增/移除
 *      不影响既有引用。
 *   2. 钉住清单语义：toggle 翻转 + 广播、清单缺席（旧式 tab）→ 追加钉住条目（不得静默 no-op）。
 *
 * helper 是 TSX + react import，node 直读不了——先 esbuild 打包为可测 bundle（react 用
 * stub 替身；FolderBrowser 是动态 import 的懒模块，测试不渲染故不会执行其初始化）。
 */
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { runEsbuild } from "../../../_shared/esbuild-bin.ts";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = "pi:sidebar-dock:folders";
const EVENT = "pi:sidebar-dock:folders-changed";

/** 极简 window/document/localStorage 桩（同 _shared/ext-float-dock.test.mjs 范式）。 */
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

function esbuildBin() {
  const local = resolve(here, "..", "..", "node_modules", "esbuild", "bin", "esbuild");
  if (existsSync(local)) return local;
  return resolve(here, "..", "..", "..", "_shared", "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild");
}

/** 打包 folder-dock.tsx（react → stub）并安装 DOM 桩后 import；每测试独立模块实例。 */
async function loadFolderDock(t) {
  const dir = mkdtempSync(join(tmpdir(), "afd-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reactStub = join(dir, "react-stub.js");
  writeFileSync(reactStub,
    "export const useEffect = () => {};\n" +
    "export const useState = (v) => [v, () => {}];\n" +
    "export const useLayoutEffect = () => {};\n" +
    "export const useRef = () => null;\n" +
    "export const useCallback = (f) => f;\n" +
    "export const useMemo = (f) => f();\n" +
    "export const memo = (f) => f;\n" +
    "export const createElement = () => null;\n" +
    "export const Fragment = null;\n");
  const outfile = join(dir, "bundle.mjs");
  // 派生形态（Linux 原生 ELF / Windows 官方 .exe，或 node 直跑 JS 入口）由 esbuild-bin 收口
  await runEsbuild(esbuildBin(), [join(here, "folder-dock.tsx"), "--bundle", "--format=esm", "--platform=node",
    "--alias:react=" + reactStub, "--outfile=" + outfile, "--log-level=error"]);

  const dom = makeDomStub();
  globalThis.window = dom.window;
  globalThis.document = dom.document;
  globalThis.localStorage = dom.window.localStorage;
  t.after(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.localStorage;
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { mod, dom };
}

const readEntries = () => JSON.parse(globalThis.localStorage.getItem(KEY) ?? "[]");
const writeEntries = (entries) => globalThis.localStorage.setItem(KEY, JSON.stringify(entries));

/** 从注册调用批次里取某 slot 最后一次的 item 映射（id → item）。 */
function itemsOf(batches, slot) {
  const last = batches.filter(([s]) => s === slot).pop();
  return new Map((last?.[1] ?? []).map((it) => [it.id, it]));
}

test("钉住清单：toggle 翻转 + 事件广播 + 清单缺席追加钉住条目（不得静默 no-op）", async (t) => {
  const { mod, dom } = await loadFolderDock(t);
  writeEntries([{ p: "/a" }, { p: "/b", pin: 1 }]);
  let fired = 0;
  dom.window.addEventListener(EVENT, () => fired++);

  mod.toggleFolderPin("/a");
  assert.deepEqual(readEntries(), [{ p: "/a", pin: 1 }, { p: "/b", pin: 1 }], "未钉 → 钉住");
  assert.equal(mod.isFolderPinned("/a"), true);
  assert.equal(fired, 1, "钉住翻转应广播 INSTANCES_EVENT");

  mod.toggleFolderPin("/b");
  assert.deepEqual(readEntries(), [{ p: "/a", pin: 1 }, { p: "/b" }], "已钉 → 取消");

  // 清单缺席（旧式 folder tab / 非 dock 实例）：追加钉住条目而不是无声无息
  mod.toggleFolderPin("/c");
  assert.deepEqual(readEntries(), [{ p: "/a", pin: 1 }, { p: "/b" }, { p: "/c", pin: 1 }], "缺席路径应追加钉住条目");
  assert.equal(mod.isFolderPinned("/c"), true);
  assert.equal(fired, 3, "每次 toggle 都应广播");

  // 空路径忽略；尾斜杠差异按原样比较（清单内精确匹配）
  const before = globalThis.localStorage.getItem(KEY);
  mod.toggleFolderPin("");
  assert.equal(globalThis.localStorage.getItem(KEY), before, "空路径 no-op");
});

test("未钉 FIFO 配额：>3 未钉挤最旧，钉住豁免", async (t) => {
  const { mod } = await loadFolderDock(t);
  writeEntries([]);
  mod.addFolderInstance("/f1");
  mod.addFolderInstance("/f2");
  mod.addFolderInstance("/f3");
  mod.addFolderInstance("/f4"); // 第 4 个未钉 → /f1 被挤出
  assert.deepEqual(readEntries().map((e) => e.p), ["/f2", "/f3", "/f4"], "溢出挤掉最旧未钉");

  mod.toggleFolderPin("/f2");
  mod.addFolderInstance("/f5");
  mod.addFolderInstance("/f6"); // 未钉 = /f3,/f4,/f5 → 第 4 个挤出 /f3
  assert.deepEqual(readEntries().map((e) => e.p), ["/f2", "/f4", "/f5", "/f6"], "钉住豁免配额");
  assert.equal(mod.isFolderPinned("/f2"), true);
});

test("faces 重注册：同路径 render/meta 引用恒定（pin 翻转零重挂），差量增删不改既有引用", async (t) => {
  const { mod } = await loadFolderDock(t);
  writeEntries([{ p: "/a" }, { p: "/b" }]);
  const batches = [];
  const ctx = {
    registerItems: (slot, items) => batches.push([slot, items]),
    disposeItems: () => {},
  };

  mod.syncFolderDockFaces(ctx);
  const first = itemsOf(batches, "sidebarExplorerDock");
  assert.deepEqual([...first.keys()].sort(), ["folder:/a", "folder:/b"], "两条 face 注册");
  const a1 = first.get("folder:/a");
  const b1 = first.get("folder:/b");

  // ① 仅 pin 翻转（清单路径未变）→ 重注册但 render/meta 引用不变（宿主 unchanged → 不 bump、不重挂）
  batches.length = 0;
  mod.toggleFolderPin("/a");
  mod.syncFolderDockFaces(ctx);
  const afterPin = itemsOf(batches, "sidebarExplorerDock");
  assert.equal(afterPin.get("folder:/a").render, a1.render, "既有路径 render 引用必须不变（防 Remount → root 回退）");
  assert.equal(afterPin.get("folder:/a").meta, a1.meta, "既有路径 meta 引用必须不变");
  assert.equal(afterPin.get("folder:/b").render, b1.render, "未变动路径 render 引用必须不变");

  // ② 新增路径 → 新 face 注册，既有引用保持
  batches.length = 0;
  mod.addFolderInstance("/c");
  mod.syncFolderDockFaces(ctx);
  const afterAdd = itemsOf(batches, "sidebarExplorerDock");
  assert.equal(afterAdd.get("folder:/a").render, a1.render, "新增路径不得换既有 render 引用");
  assert.equal(afterAdd.get("folder:/b").render, b1.render, "新增路径不得换既有 render 引用");
  assert.ok(afterAdd.has("folder:/c"), "新路径 face 已注册");

  // ③ 移除路径 → 该 face 被 dispose，剩余引用保持（缓存同步回收）
  const disposed = [];
  const ctx2 = {
    registerItems: (slot, items) => batches.push([slot, items]),
    disposeItems: (slot, ids) => disposed.push([slot, ids]),
  };
  batches.length = 0;
  mod.removeFolderInstance("/b");
  mod.syncFolderDockFaces(ctx2);
  const afterRemove = itemsOf(batches, "sidebarExplorerDock");
  assert.deepEqual([...afterRemove.keys()].sort(), ["folder:/a", "folder:/c"], "移除路径不再注册");
  assert.equal(afterRemove.get("folder:/a").render, a1.render, "移除路径不得换幸存者 render 引用");
  assert.ok(disposed.some(([slot, ids]) => slot === "sidebarExplorerDock" && ids.includes("folder:/b")), "移除路径应 dispose face");

  // ④ 重新加入被移除路径 → 重建闭包（旧缓存已回收），不必与旧引用相同，但功能仍在
  batches.length = 0;
  mod.addFolderInstance("/b");
  mod.syncFolderDockFaces(ctx2);
  const afterReadd = itemsOf(batches, "sidebarExplorerDock");
  assert.ok(afterReadd.has("folder:/b"), "重新加入路径重建 face");
});

test("openFolderDocked 透传 auto：恢复性落位（宿主 select:false 后台打开）标记随状态机事件出栈", async (t) => {
  const { mod, dom } = await loadFolderDock(t);
  writeEntries([]);
  const seen = [];
  dom.window.addEventListener("piwe-float-present-change", (e) => seen.push(e.detail));

  mod.openFolderDocked("/user-picked", "right-panel");
  mod.openFolderDocked("/restored", "right-panel", { auto: true });

  assert.deepEqual(seen, [
    { key: "aiti-folder:folder:/user-picked", state: "docked:right-panel" },
    { key: "aiti-folder:folder:/restored", state: "docked:right-panel", auto: true },
  ], "用户主动落位不带 auto；auto 必须原样透传（宿主据此不拉小屏右栏、不抢 tab 焦点）");
});
