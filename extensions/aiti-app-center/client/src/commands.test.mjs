/**
 * aiti-app-center · commands 纯投影单测（buildCommandHints：匹配/排序/hidden 过滤/toggle 接线）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-app-center/client/src/commands.test.mjs
 *
 * 桩：window + localStorage（import 前就位，同 app-registry.test.mjs 范式）。
 * commands.ts 顶层 import host-shim / ext-float-dock-core——前者零副作用（函数委托），
 * 后者 window 桩已覆盖其模块级引用。
 */
import assert from "node:assert/strict";
import test from "node:test";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = {
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { buildCommandHints } = await import("./commands.ts");

// ── 固定输入（buildApps 的合法形态） ──
const EXTS = [
  {
    id: "ext-a", name: "扩展A", version: "1.0.0", description: "d-a", icon: null, category: "session",
    features: [
      { id: "feat-on", type: "boolean", label: "开关甲", enabled: true },
      { id: "feat-off", type: "boolean", label: "开关乙", enabled: false },
      { id: "feat-str", type: "string", label: "文本项", value: "x" },
    ],
  },
  // ext.name self-declared entries (2026-11-15 i18n convention): en mode overrides the CJK raw text — the third-party extension registration channel
  { id: "ext-b", name: "扩展B", version: "2.0.0", description: "d-b", icon: null, category: "code", features: null, ui: { i18n: { en: { "ext.displayName": "Extension B", "ext.description": "Desc B" } } } },
];
const SLOT_ITEMS = [
  // toolbar/sidebarFooter 卡需 meta.onClick（buildApps 死卡规则：无 onClick 的动作条目不进卡）；
  // rightFileDock 面板卡走 openPanel 无此要求；static 面板条目被 buildApps 剔除
  { slot: "toolbar", id: "ext-a:btn", extId: "ext-a", meta: { label: "动作卡", icon: "⚡", onClick: () => {} } },
  { slot: "sidebarFooter", id: "ext-b:manage", extId: "ext-b", meta: { label: "管理卡", onClick: () => {} } },
  { slot: "rightFileDock", id: "ext-b:panel", extId: "ext-b", meta: { label: "面板卡" } },
  { slot: "rightFileDock", id: "ext-b:static-panel", extId: "ext-b", static: true, meta: { label: "静态面板(应剔除)" } },
];
const BASE = {
  // q="ext" 是全部候选 extId 的子串 = 全命中基准（空 q 是 pinned-only 语义，单独用例覆盖）
  q: "ext",
  limit: 5,
  exts: EXTS,
  slotItems: SLOT_ITEMS,
  featureState: { "ext-a:feat-on": true, "ext-a:feat-off": false },
  pinned: [],
  hidden: [],
  openPanelFn: () => {},
  apiUrlFn: (p) => p,
  categoryText: (id) => `cat:${id}`,
};

const ids = (hints) => hints.map((h) => h.id);

test("buildCommandHints：四类卡全量投影（静态面板剔除 / string feature 不进 toggle）", () => {
  const hints = buildCommandHints(BASE);
  // 动作 + 管理 + 面板 + 2 boolean toggle = 5；静态面板与 string feature 被剔除
  assert.deepEqual(ids(hints).sort(), [
    "action:ext-a:btn", "manage:ext-b:manage", "panel:ext-b:panel",
    "toggle:ext-a:feat-off", "toggle:ext-a:feat-on",
  ]);
});

test("buildCommandHints：q 匹配命中 label/keywords（matchApp 分词子串）", () => {
  assert.deepEqual(ids(buildCommandHints({ ...BASE, q: "动作" })), ["action:ext-a:btn"]);
  assert.deepEqual(ids(buildCommandHints({ ...BASE, q: "面板" })), ["panel:ext-b:panel"]);
  // toggle 走 feature label + featureId keyword
  assert.deepEqual(ids(buildCommandHints({ ...BASE, q: "feat-on" })), ["toggle:ext-a:feat-on"]);
  assert.deepEqual(ids(buildCommandHints({ ...BASE, q: "不存在词" })), []);
});

test("buildCommandHints：关键词自声明优先（条目 → 扩展 → label）", () => {
  // Item-declared keywords win (and merge ahead of the extension-level ones): a command entry may
  // carry its own bilingual aliases without touching the app center's hard-coded table.
  const withItem = buildCommandHints({
    ...BASE,
    slotItems: [
      { slot: "commands", id: "ext-a:pick-model", extId: "ext-a", meta: { label: "选择模型", keywords: ["切换模型", "switch-model"], onClick: () => {} } },
    ],
    q: "switch-model",
  });
  assert.deepEqual(ids(withItem), ["action:ext-a:pick-model"], "条目级 keywords 应参与匹配");
  // Extension-level keywords (manifest pass-through) work the same way; no override-table edit needed.
  const withExt = buildCommandHints({
    ...BASE,
    exts: [{ id: "ext-c", name: "扩展C", keywords: ["compact", "压缩上下文"], category: "ai", features: null }],
    slotItems: [{ slot: "commands", id: "ext-c:compact", extId: "ext-c", meta: { label: "压缩", onClick: () => {} } }],
    q: "compact",
  });
  assert.deepEqual(ids(withExt), ["action:ext-c:compact"], "扩展级 keywords 应参与匹配");
  // A declared extension keyword must NOT need the legacy table: unknown extensions match by label alone.
  const byLabel = buildCommandHints({
    ...BASE,
    exts: [{ id: "aiti-words", name: "X", category: "ai", features: null }],
    slotItems: [{ slot: "commands", id: "aiti-words:go", extId: "aiti-words", meta: { label: "去", onClick: () => {} } }],
    q: "去",
  });
  assert.deepEqual(ids(byLabel), ["action:aiti-words:go"], "label 本身始终参与匹配");
});

test("buildCommandHints：hidden 只过滤非 toggle（应用视图语义）", () => {
  const hints = buildCommandHints({ ...BASE, hidden: ["action:ext-a:btn", "toggle:ext-a:feat-on"] });
  assert.ok(!ids(hints).includes("action:ext-a:btn"), "hidden 动作卡应被过滤");
  assert.ok(ids(hints).includes("toggle:ext-a:feat-on"), "toggle 不受 hidden 影响");
});

test("buildCommandHints：pinned 序置前，其余保持 buildApps 输出序（稳定）", () => {
  const all = buildCommandHints({ ...BASE, limit: 99 });
  const pinnedOrder = ["toggle:ext-a:feat-on", "panel:ext-b:panel"];
  const hints = buildCommandHints({ ...BASE, limit: 99, pinned: pinnedOrder });
  assert.deepEqual(ids(hints), [...pinnedOrder, ...all.map((h) => h.id).filter((id) => !pinnedOrder.includes(id))]);
});

test("buildCommandHints：limit 切片 + 空 q 返回 pinned（常用语义）", () => {
  assert.equal(buildCommandHints({ ...BASE, limit: 2 }).length, 2);
  const empty = buildCommandHints({ ...BASE, q: "  ", pinned: ["panel:ext-b:panel"] });
  assert.deepEqual(ids(empty), ["panel:ext-b:panel"], "空 q = pinned 常用");
});

test("buildCommandHints：commands 命令目录槽条目 → action 卡（无渲染点纯命令）", () => {
  const hints = buildCommandHints({
    ...BASE,
    slotItems: [
      ...SLOT_ITEMS,
      { slot: "commands", id: "ext-b:open-terminal", extId: "ext-b", meta: { label: "打开终端", icon: { svg: "<line/>" }, onClick: () => {} } },
    ],
  });
  const cmd = hints.find((h) => h.id === "action:ext-b:open-terminal");
  assert.ok(cmd, "commands 条目应进候选");
  assert.equal(cmd.kind, "action");
  assert.equal(cmd.label, "打开终端");
});

test("buildCommandHints：投影字段（成品分类文案 / toggle on 态与 run 接线）", () => {
  const hints = buildCommandHints(BASE);
  const panel = hints.find((h) => h.kind === "panel");
  assert.equal(panel.category, "cat:code", "分类走注入的成品文案函数");
  assert.equal(panel.extName, "Extension B", "ext.name 词条覆盖（en 态自声明通道）");
  const on = hints.find((h) => h.id === "toggle:ext-a:feat-on");
  const off = hints.find((h) => h.id === "toggle:ext-a:feat-off");
  assert.equal(on.on, true);
  assert.equal(off.on, false);
  // toggle run 接线：调用后走注入的 apiUrlFn 发 ops（fetch 桩记录）
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; };
  try {
    off.run();
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.enabled, true, "off → run 切为 true");
  assert.equal(calls[0].body.featureId, "feat-off");
  // 动作卡 run 转发 meta.onClick
  let ran = false;
  const a = buildCommandHints({
    ...BASE,
    slotItems: [{ slot: "toolbar", id: "ext-a:btn", extId: "ext-a", meta: { label: "动作卡", onClick: () => { ran = true; } } }],
  })[0];
  a.run();
  assert.equal(ran, true);
});
