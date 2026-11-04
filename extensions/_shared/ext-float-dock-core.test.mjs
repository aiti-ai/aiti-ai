/**
 * ext-float-dock-core tests — 左栏 dock 区块栈纯状态层（排序/折叠/旧 key 迁移）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/ext-float-dock-core.test.mjs
 *
 * 覆盖（sidebar 统一 dock 方案 §3.1/§3.6/§3.8 实施期出过 tie-break bug 的逻辑）：
 * effectiveBlockOrder（用户序∩在场键 + priority 稳定补尾）/ moveBlockKey（邻居交换与
 * 边界 no-op）/ moveBlockTo（拖拽落位前/后插入）/ 折叠与排序持久化事件 / 四旧折叠
 * key 迁移（含 file-explorer 语义取反、旧 key 保留、新键不覆盖）。
 *
 * 桩：window（dispatchEvent/addEventListener 记录）+ localStorage（内存 Map）——
 * core 顶层零副作用，仅在函数体内触碰全局，桩在 import 前就位即可。
 */
import assert from "node:assert/strict";
import test from "node:test";

const store = new Map();
const dispatched = [];
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = {
  dispatchEvent: (e) => { dispatched.push(e); return true; },
  addEventListener: () => {},
  removeEventListener: () => {},
};

const {
  SIDEBAR_COLLAPSE_EVENT,
  SIDEBAR_ORDER_EVENT,
  effectiveBlockOrder,
  isSidebarDockState,
  migrateLegacyCollapseKeys,
  moveBlockKey,
  moveBlockTo,
  readBlockCollapsed,
  readDockOrder,
  seedBlockCollapsedDefault,
  sidebarZoneOf,
  writeBlockCollapsed,
  writeDockOrder,
} = await import("./ext-float-dock-core.ts");

test("effectiveBlockOrder: 空用户序时按 priority 稳定排序（项目0→任务1→文件2→停靠3+）", () => {
  const entries = [
    { key: "asr", priority: 3 },
    { key: "fleet", priority: 1 },
    { key: "folder:b", priority: 2 },
    { key: "projects", priority: 0 },
    { key: "prompts", priority: 3 },
    { key: "folder:a", priority: 2 },
  ];
  assert.deepEqual(
    effectiveBlockOrder(entries, []).map((e) => e.key),
    ["projects", "fleet", "folder:b", "folder:a", "asr", "prompts"],
  );
});

test("effectiveBlockOrder: 用户序在前（∩ 在场键），其余按 priority 补尾", () => {
  const entries = [
    { key: "projects", priority: 0 },
    { key: "fleet", priority: 1 },
    { key: "folder:a", priority: 2 },
    { key: "prompts", priority: 3 },
  ];
  assert.deepEqual(
    effectiveBlockOrder(entries, ["prompts", "projects", "不存在键"]).map((e) => e.key),
    ["prompts", "projects", "fleet", "folder:a"],
  );
});

test("isSidebarDockState: 规范 sidebar:* 与旧 sidebar-explorer 都命中，右栏/浮窗不命中", () => {
  assert.equal(isSidebarDockState("docked:sidebar:aiti-prompts:panel"), true);
  assert.equal(isSidebarDockState("docked:sidebar-explorer"), true);
  assert.equal(isSidebarDockState("docked:right-panel"), false);
  assert.equal(isSidebarDockState("floating"), false);
  assert.equal(isSidebarDockState("closed"), false);
});

test("sidebarZoneOf: blockKey 即 itemKey", () => {
  assert.equal(sidebarZoneOf("aiti-prompts:panel"), "sidebar:aiti-prompts:panel");
});

test("writeBlockCollapsed/readBlockCollapsed 往返 + 事件广播", () => {
  dispatched.length = 0;
  assert.equal(readBlockCollapsed("x"), false);
  writeBlockCollapsed("x", true);
  assert.equal(readBlockCollapsed("x"), true);
  assert.equal(dispatched.filter((e) => e.type === SIDEBAR_COLLAPSE_EVENT).length, 1);
});

test("seedBlockCollapsedDefault: 仅当无记录时播种，用户操作后永不覆盖", () => {
  // 无记录 → 写默认折叠态
  seedBlockCollapsedDefault("seed-proj", false);
  assert.equal(readBlockCollapsed("seed-proj"), false);
  seedBlockCollapsedDefault("seed-folder", true);
  assert.equal(readBlockCollapsed("seed-folder"), true);
  // 已有记录（用户手动）→ 不覆盖
  writeBlockCollapsed("seed-folder", false);
  seedBlockCollapsedDefault("seed-folder", true);
  assert.equal(readBlockCollapsed("seed-folder"), false);
});

test("writeDockOrder/readDockOrder 往返 + 事件广播", () => {
  dispatched.length = 0;
  writeDockOrder(["b", "a"]);
  assert.deepEqual(readDockOrder(), ["b", "a"]);
  assert.equal(dispatched.filter((e) => e.type === SIDEBAR_ORDER_EVENT).length, 1);
});

test("moveBlockKey: 邻居交换 + 边界 no-op + 未知键 no-op", () => {
  const keys = ["a", "b", "c"];
  store.delete("pi:sidebar-dock:order");
  moveBlockKey("b", -1, keys);
  assert.deepEqual(readDockOrder(), ["b", "a", "c"]);
  moveBlockKey("b", -1, keys); // 已在首位 → no-op
  assert.deepEqual(readDockOrder(), ["b", "a", "c"]);
  moveBlockKey("c", 1, keys); // 已在末位 → no-op
  assert.deepEqual(readDockOrder(), ["b", "a", "c"]);
  moveBlockKey("不存在", 1, keys);
  assert.deepEqual(readDockOrder(), ["b", "a", "c"]);
});

test("moveBlockTo: 尊重既有用户序（真实有效序输入）", () => {
  store.set("pi:sidebar-dock:order", JSON.stringify(["b", "a", "c"]));
  moveBlockTo("a", "b", ["b", "a", "c"], true); // a 移到 b 之前
  assert.deepEqual(readDockOrder(), ["a", "b", "c"]);
});

test("moveBlockTo: key===target no-op", () => {
  store.set("pi:sidebar-dock:order", JSON.stringify(["a", "b"]));
  moveBlockTo("a", "a", ["a", "b"], true);
  assert.deepEqual(readDockOrder(), ["a", "b"]);
});

test("migrateLegacyCollapseKeys: 四旧 key 迁入（含 file-explorer 取反）且旧 key 保留", () => {
  store.set("pi-web:sidebar-projects-collapsed", "1");            // sm 编码：折叠
  store.set("pi-sidebar-tasks-collapsed", "false");               // 宿主编码：展开
  store.set("pi-web:sidebar-explorer-dock-collapsed", "true");    // 折叠
  store.set("pi-web:file-explorer:open", "false");                // 展开 → 折叠取反
  migrateLegacyCollapseKeys();
  assert.equal(readBlockCollapsed("projects"), true);
  assert.equal(readBlockCollapsed("tasks"), false);
  assert.equal(readBlockCollapsed("docks"), true);
  assert.equal(readBlockCollapsed("files"), true);
  // 旧 key 保留（回滚旧宿主仍可读）
  assert.equal(store.get("pi-web:sidebar-projects-collapsed"), "1");
  assert.equal(store.get("pi-web:file-explorer:open"), "false");
});

test("migrateLegacyCollapseKeys: 新 key 已存在时不覆盖", () => {
  writeBlockCollapsed("projects", false);
  migrateLegacyCollapseKeys(); // once 守卫在——直接断言不被覆盖即可
  assert.equal(readBlockCollapsed("projects"), false);
});

/* ── v4 对齐分组：splitBlockAlign（上对齐/下对齐）── */

const { splitBlockAlign } = await import("./ext-float-dock-core.ts");

test("splitBlockAlign: 未声明 align 全部进默认组（top）", () => {
  const entries = [{ key: "a" }, { key: "b" }];
  const { top, bottom } = splitBlockAlign(entries);
  assert.deepEqual(top.map((e) => e.key), ["a", "b"]);
  assert.deepEqual(bottom, []);
});

test("splitBlockAlign: 混合分组保持有效序的组内相对序（项目/定时任务钉顶，文件夹/停靠钉底）", () => {
  // 模拟 DockStack 构造产物：blocks 缺省 top、dockable item 缺省 bottom
  const entries = [
    { key: "projects", align: "top" },
    { key: "aiti-ai-schedule:panel", align: "top" },
    { key: "folder:/a", align: "bottom" },
    { key: "aiti-prompts:panel", align: "bottom" },
    { key: "aiti-ai-input:asr", align: "bottom" },
  ];
  const { top, bottom } = splitBlockAlign(entries, "top");
  assert.deepEqual(top.map((e) => e.key), ["projects", "aiti-ai-schedule:panel"]);
  assert.deepEqual(bottom.map((e) => e.key), ["folder:/a", "aiti-prompts:panel", "aiti-ai-input:asr"]);
});

test("splitBlockAlign: defaultAlign=bottom（dockable 缺省下对齐语义）", () => {
  const entries = [{ key: "x" }, { key: "y", align: "top" }];
  const { top, bottom } = splitBlockAlign(entries, "bottom");
  assert.deepEqual(top.map((e) => e.key), ["y"]);
  assert.deepEqual(bottom.map((e) => e.key), ["x"]);
});

test("splitBlockAlign: 用户改序后组内序跟随（跨组移动被容器钳制，此处只验分组纯函数）", () => {
  // 用户把定时任务移到项目之前（同组内合法）：有效序 [sched, projects] → top 组同序
  const entries = [
    { key: "aiti-ai-schedule:panel", align: "top" },
    { key: "projects", align: "top" },
    { key: "folder:/a", align: "bottom" },
  ];
  const { top, bottom } = splitBlockAlign(entries, "top");
  assert.deepEqual(top.map((e) => e.key), ["aiti-ai-schedule:panel", "projects"]);
  assert.deepEqual(bottom.map((e) => e.key), ["folder:/a"]);
});

/* ── v3 dock 头工具条 store：actions/commands/state/menuItems/pending ── */

const { createDockHeaderStore, DOCK_HEADER_PENDING_TTL } = await import("./ext-float-dock-core.ts");

function freshStore() {
  const s = createDockHeaderStore();
  const notes = new Map(); // key -> count
  let sub = null;
  return {
    s,
    notes,
    watch(key) { notes.set(key, 0); sub = s.subscribe(key, () => notes.set(key, (notes.get(key) || 0) + 1)); },
    unwatch() { sub && sub(); sub = null; },
  };
}

test("headerStore: register 部分字段合并 + 读取", () => {
  const { s } = freshStore();
  const un = s.register("k", { actions: [{ id: "a", title: "A", onClick: () => {} }], state: { open: true } });
  assert.equal(s.actionsOf("k")?.length, 1);
  assert.deepEqual(s.stateOf("k"), { open: true });
  assert.equal(s.commandsOf("k"), null);
  assert.equal(s.menuItemsOf("k"), null);
  // 再注册 commands/menuItems（合并）
  s.register("k", { commands: { go: () => {} }, menuItems: [{ kind: "item", label: "X", run: () => {} }] });
  assert.equal(typeof s.commandsOf("k")?.go, "function");
  assert.equal(s.menuItemsOf("k")?.length, 1);
  assert.equal(s.actionsOf("k")?.length, 1); // 未被覆盖
  un(); // disposer 清本次 actions/state
  assert.equal(s.actionsOf("k"), null);
  assert.deepEqual(s.stateOf("k"), {});
  assert.equal(s.menuItemsOf("k")?.length, 1); // 非本次注册字段保留
});

test("headerStore: state 签名去重（同值不通知，变化通知）", () => {
  const { s, notes, watch } = freshStore();
  watch("k");
  s.register("k", { state: { a: 1 } });
  assert.equal(notes.get("k"), 1);
  s.register("k", { state: { a: 1 } }); // 同值（新引用）→ 不通知
  assert.equal(notes.get("k"), 1);
  s.register("k", { state: { a: 2 } });
  assert.equal(notes.get("k"), 2);
});

test("headerStore: actions 签名变化通知（onClick 变化不通知，视觉字段变化通知）", () => {
  const { s, notes, watch } = freshStore();
  watch("k");
  const mk = (active) => [{ id: "a", title: "A", active, onClick: () => {} }];
  s.register("k", { actions: mk(false) });
  assert.equal(notes.get("k"), 1);
  s.register("k", { actions: mk(false) }); // 仅 onClick 新引用 → 不通知
  assert.equal(notes.get("k"), 1);
  s.register("k", { actions: mk(true) });
  assert.equal(notes.get("k"), 2);
});

test("headerStore: request 命中命令（payload 透传）", () => {
  const { s } = freshStore();
  const seen = [];
  s.register("k", { commands: { go: (p) => seen.push(p) } });
  assert.equal(s.request("k", "go", { x: 1 }), true);
  assert.deepEqual(seen, [{ x: 1 }]);
});

test("headerStore: request 未命中 → 展开 + pending，命令注册时补跑一次（payload 保留）", () => {
  const { s } = freshStore();
  const key = "aiti-demo:panel";
  writeBlockCollapsed(key, true);
  const seen = [];
  assert.equal(s.request(key, "search", { anchor: { top: 10 } }), false);
  assert.equal(readBlockCollapsed(key), false); // 自动展开
  s.register(key, { commands: { search: (p) => seen.push(p) } });
  assert.deepEqual(seen, [{ anchor: { top: 10 } }]); // 补跑
  s.register(key, { commands: { search: (p) => seen.push(p) } }); // pending 已清，不重复
  assert.equal(seen.length, 1);
});

test("headerStore: pending TTL 过期不执行", () => {
  const { s } = freshStore();
  const key = "aiti-demo:ttl";
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    s.request(key, "x");
    now += DOCK_HEADER_PENDING_TTL + 1;
    const seen = [];
    s.register(key, { commands: { x: () => seen.push(1) } });
    assert.equal(seen.length, 0);
  } finally {
    Date.now = realNow;
  }
});

test("headerStore: 多 key 隔离", () => {
  const { s } = freshStore();
  s.register("k1", { state: { v: 1 } });
  s.register("k2", { state: { v: 2 } });
  assert.deepEqual(s.stateOf("k1"), { v: 1 });
  assert.deepEqual(s.stateOf("k2"), { v: 2 });
  s.request("k2", "only2");
  const seen = [];
  s.register("k1", { commands: { only2: () => seen.push("k1") } });
  assert.equal(seen.length, 0); // k1 不消费 k2 的 pending
  s.register("k2", { commands: { only2: () => seen.push("k2") } });
  assert.deepEqual(seen, ["k2"]);
});

test("positionMenuItems/positionMenuModel（v5 图标排）：icon/isDefault/active 与浮窗项", async () => {
  const { positionMenuItems, positionMenuModel } = await import("./ext-float-dock-core.ts");
  // 两 zone（sidebar 族 + 右栏），默认 sidebar；当前态 = 右栏停靠
  const items = positionMenuItems("x:p", ["sidebar:x:p", "right-panel"], "sidebar:x:p", "docked:right-panel");
  assert.deepEqual(items.map((i) => i.key), ["sidebar-explorer", "right-panel"], "sidebar 族折叠成一项");
  assert.deepEqual(items.map((i) => i.icon), ["panel-left", "panel-right"], "方位图标名");
  assert.deepEqual(items.map((i) => i.isDefault), [true, false], "默认位判定");
  assert.deepEqual(items.map((i) => i.active), [false, true], "当前态判定（族兼容）");
  // 模型含浮窗项且在最前；浮窗态时 active
  const model = positionMenuModel("x:p", ["sidebar:x:p", "right-panel"], "right-panel", "floating");
  assert.deepEqual(model.map((i) => i.key), ["float", "sidebar-explorer", "right-panel"], "浮窗 → 各停靠位");
  assert.equal(model[0].icon, "float");
  assert.equal(model[0].active, true, "浮窗态高亮");
  assert.equal(model[2].isDefault, true, "右栏默认位");
  // 「新窗口打开」项（2026-09-15 拍板）：提供 onNewWindow 时排最前（B 图标），
  // 不提供且无注册 = 不显示（「有些暂时不支持」能力注册决定）
  const withWin = positionMenuModel("x:p", ["sidebar:x:p", "right-panel"], "right-panel", "floating", { onNewWindow: () => {} });
  assert.deepEqual(withWin.map((i) => i.key), ["new-window", "float", "sidebar-explorer", "right-panel"], "新窗口 → 浮窗 → 各停靠位");
  assert.equal(withWin[0].icon, "new-window");
  assert.equal(withWin[0].active, undefined, "新窗口项非位置态（role=menuitem）");
});

test("resolveDropZone/SIDEBAR_DROP_ZONE（drag-drop-unify §3.1）：通配 sidebar 落点解析", async () => {
  const { resolveDropZone, SIDEBAR_DROP_ZONE } = await import("./ext-float-dock-core.ts");
  assert.equal(SIDEBAR_DROP_ZONE, "sidebar");
  // 精确命中：marker 在面板声明 zones 里原样返回（现有右栏行为不变）
  assert.equal(resolveDropZone("right-panel", ["sidebar:x:p", "right-panel"]), "right-panel");
  // 通配：公共落点 "sidebar" → 面板声明的第一个 sidebar:* zone
  assert.equal(resolveDropZone("sidebar", ["right-panel", "sidebar:x:p"]), "sidebar:x:p");
  // 旧值 sidebar-explorer 一并认
  assert.equal(resolveDropZone("sidebar", ["sidebar-explorer"]), "sidebar-explorer");
  // 面板未声明 sidebar 族 → 不入位
  assert.equal(resolveDropZone("sidebar", ["right-panel"]), null);
  // marker 不在声明集且非通配 → 不入位
  assert.equal(resolveDropZone("right-panel", ["sidebar:x:p"]), null);
  assert.equal(resolveDropZone("", ["right-panel"]), null);
});
