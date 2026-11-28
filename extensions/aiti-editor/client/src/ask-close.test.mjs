/**
 * askCloseHandler 属主注册表测试 — keep-alive 逐出误清回归钉（方案
 * docs/aiti-editor-right-dock-keepalive-plan.md §9.3）。
 *
 * 背景：旧实现 askCloseHandler 是无属主单例——keep-alive 池下激活与逐出分处两个 React
 * commit，「后挂载者注册 → 被逐出者卸载置 null」打穿注册，confirmClose 走 resolve(true)
 * 分支，脏文件关闭被静默放行。修复后为属主 Map（卸载只删自己）+ 可见性优先派发。
 *
 * Run: node scripts/test-web-ext.mjs --only aiti-editor
 * （registry.ts 无扩展名 import，node strip-types 解析不了 → esbuild 打包 + 全局桩范式）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runEsbuild } from "../../../_shared/esbuild-bin.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const esbuildBin = join(here, "..", "..", "node_modules", "esbuild", "bin", "esbuild"); // JS 入口：node 直跑（.bin shim 在 Windows ENOENT）

/** BroadcastChannel stub：同名实例互通（验证跨 tab 缓存通知走监听器集合）。
 *  模块级单例 hub——registry 的 _bc 创建于首个测试的 setup，后续测试必须与它同一 hub。 */
const sharedChannels = new Map(); // name -> Set<channel>
class BroadcastChannelStub {
  constructor(name) {
    this.name = name;
    if (!sharedChannels.has(name)) sharedChannels.set(name, new Set());
    sharedChannels.get(name).add(this);
    this.onmessage = null;
  }
  postMessage(data) {
    for (const ch of sharedChannels.get(this.name) ?? []) {
      if (ch !== this) ch.onmessage?.({ data });
    }
  }
}

async function setup() {
  // 1) esbuild 打包 registry.ts（无扩展名 import → 必须打包；依赖全在仓内，无外部 bare import）
  const dir = mkdtempSync(join(tmpdir(), "aiti-editor-askclose-"));
  const outfile = join(dir, "registry.bundle.mjs");
  await runEsbuild(esbuildBin, [join(here, "registry.ts"), "--bundle", "--format=esm", "--platform=node",
    `--outfile=${outfile}`]);

  // 2) 全局桩先于 bundle import（registry 顶层/初始化读 window/localStorage/location/fetch）
  const store = new Map();
  const storage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const orig = { localStorage: globalThis.localStorage, window: globalThis.window, location: globalThis.location, document: globalThis.document, fetch: globalThis.fetch, BroadcastChannel: globalThis.BroadcastChannel };
  globalThis.localStorage = storage;
  globalThis.window = globalThis;
  globalThis.location = { href: "http://127.0.0.1:3001/dev/", origin: "http://127.0.0.1:3001", pathname: "/dev/" };
  globalThis.document = {
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {} } }),
    head: { appendChild() {} }, body: { appendChild() {} }, addEventListener() {},
  };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  globalThis.BroadcastChannel = BroadcastChannelStub;

  const { setupRegistry } = await import(pathToFileURL(outfile).href);
  setupRegistry({});
  const A = globalThis.window.__aitiEditor;
  assert.ok(A, "setupRegistry 应注册 window.__aitiEditor");
  const cleanup = () => {
    delete globalThis.window.__aitiEditor; // 单例复位：每个测试各自 setupRegistry 干净实例
    globalThis.localStorage = orig.localStorage;
    globalThis.window = orig.window;
    globalThis.location = orig.location;
    globalThis.document = orig.document;
    globalThis.fetch = orig.fetch;
    globalThis.BroadcastChannel = orig.BroadcastChannel;
    rmSync(dir, { recursive: true, force: true });
  };
  return { A, cleanup };
}

/** 造一个可观察的 handler：记录派发，返回 { fn, calls, settle }。 */
function makeHandler(name, { path, visible = true } = {}) {
  const state = { calls: [], resolvers: [] };
  const fn = (p, blockers, resolve) => {
    state.calls.push({ p, blockers });
    state.resolvers.push(resolve);
  };
  fn.displayName = name;
  return { fn, state };
}

test("属主注销：卸载 A 不误清后注册的 B（单例误清回归钉）", async () => {
  const { A, cleanup } = await setup();
  try {
    A._setDirty("/f/a.ts", true);
    A._setDirty("/f/b.ts", true);
    const ha = makeHandler("A", { path: "/f/a.ts" });
    const hb = makeHandler("B", { path: "/f/b.ts" });
    A._setAskCloseHandler(ha.fn, { path: "/f/a.ts" });
    A._setAskCloseHandler(hb.fn, { path: "/f/b.ts" });

    // 模拟 keep-alive 逐出时序：后注册者仍在，先注册者（被逐出实例）卸载
    A._clearAskCloseHandler(ha.fn);

    // 关 B（仍挂载编辑器）：必须派发到 B，而不是走 resolve(true) 静默放行
    const pending = A.confirmClose("/f/b.ts", { isSwitch: false });
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(hb.state.calls.length, 1, "应派发到仍在挂载的 B 的 handler");
    assert.equal(ha.state.calls.length, 0, "不应派发给已注销的 A");
    assert.equal(settled, false, "有 handler 时 confirmClose 必须挂起等用户决定，不得静默放行");
    hb.state.resolvers[0](true);
    assert.equal(await pending, true);
  } finally { cleanup(); }
});

test("可见性优先：关闭隐藏脏文件时弹层派发给可见编辑器", async () => {
  const { A, cleanup } = await setup();
  try {
    A._setDirty("/f/hidden.ts", true);
    const hHidden = makeHandler("hidden", { path: "/f/hidden.ts", visible: false });
    const hVisible = makeHandler("visible", { path: "/f/other.ts", visible: true });
    A._setAskCloseHandler(hHidden.fn, { path: "/f/hidden.ts", isVisible: () => false });
    A._setAskCloseHandler(hVisible.fn, { path: "/f/other.ts", isVisible: () => true });

    const pending = A.confirmClose("/f/hidden.ts", { isSwitch: false });
    assert.equal(hVisible.state.calls.length, 1, "弹层应落在可见编辑器");
    assert.equal(hVisible.state.calls[0].p, "/f/hidden.ts", "派发的 path 仍是被关文件");
    hVisible.state.resolvers[0](false);
    assert.equal(await pending, false, "用户取消 → 拦截关闭");
  } finally { cleanup(); }
});

test("精确 path：可见编辑器并存时优先派发给被关文件自己的 handler", async () => {
  const { A, cleanup } = await setup();
  try {
    A._setDirty("/f/a.ts", true);
    const ha = makeHandler("A", { path: "/f/a.ts", visible: true });
    const hb = makeHandler("B", { path: "/f/b.ts", visible: true });
    A._setAskCloseHandler(ha.fn, { path: "/f/a.ts", isVisible: () => true });
    A._setAskCloseHandler(hb.fn, { path: "/f/b.ts", isVisible: () => true });

    const pending = A.confirmClose("/f/a.ts", { isSwitch: false });
    assert.equal(ha.state.calls.length, 1, "该 path 且可见 → 派发给自己");
    assert.equal(hb.state.calls.length, 0);
    ha.state.resolvers[0](true);
    await pending;
  } finally { cleanup(); }
});

test("无 handler 时放行（保留宿主兜底语义）；切换语义不阻塞", async () => {
  const { A, cleanup } = await setup();
  try {
    assert.equal(await A.confirmClose("/f/x.ts", { isSwitch: false }), true, "无 handler → 放行");
    // isSwitch=true：dirty 不构成 blocker → 直接 true（关闭守卫只在真关时拦截）
    A._setDirty("/f/y.ts", true);
    assert.equal(await A.confirmClose("/f/y.ts", { isSwitch: true }), true);
  } finally { cleanup(); }
});

test("跨 tab 缓存通知派发给全部已注册监听器，注销只删自己", async () => {
  const { A, cleanup } = await setup();
  try {
    assert.equal(A._onCacheUpdate, undefined, "旧单例槽应已移除");
    const got1 = [];
    const got2 = [];
    const l1 = (msg) => got1.push(msg);
    const l2 = (msg) => got2.push(msg);
    A._registerCacheListener(l1);
    A._registerCacheListener(l2);
    A._unregisterCacheListener(l1);
    // 经真实 BroadcastChannel 通路触发（stub 同名实例互通）
    const bc = new globalThis.BroadcastChannel("aiti-editor-cache");
    bc.postMessage({ type: "update", filePath: "/f/a.ts", contentHash: "h1" });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(got1, [], "已注销监听器不得再收到广播");
    assert.equal(got2.length, 1, "仍在册监听器收到广播");
    assert.equal(got2[0].contentHash, "h1");
  } finally { cleanup(); }
});
