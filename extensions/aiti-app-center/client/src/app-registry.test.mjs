/**
 * aiti-app-center · app-registry 纯逻辑单测（分类解析链 / 形态自适应 / 搜索 / 钉住隐藏存储 / 卡片组装）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-app-center/client/src/app-registry.test.mjs
 *
 * 桩：window（事件记录）+ localStorage（内存 Map）——import 前就位（ext-float-dock-core.test.mjs 同范式）。
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
  DEFAULT_CATEGORY,
  FLAT_MODE_THRESHOLD,
  resolveCategory,
  isInternalCategory,
  categoryLabel,
  categorySortKey,
  viewMode,
  moreExpandedDefault,
  matchApp,
  readPinned,
  writePinned,
  togglePinned,
  movePinned,
  readHidden,
  writeHidden,
  toggleHidden,
  hideApp,
  isToggleId,
  pruneToggleIds,
  splitByKind,
  extensionToggleGroups,
  hardDependents,
  disableExtension,
  buildApps,
} = await import("./app-registry.ts");

test("resolveCategory：条目级 → 扩展级 → 覆盖表 → 默认 other", () => {
  assert.equal(resolveCategory("code", "ai", "some-ext"), "code");
  assert.equal(resolveCategory(undefined, "ai", "some-ext"), "ai");
  assert.equal(resolveCategory(undefined, undefined, "session-manager"), "session"); // 覆盖表
  assert.equal(resolveCategory(undefined, undefined, "unknown-ext"), DEFAULT_CATEGORY);
  // 空白/空串标注视为未标注
  assert.equal(resolveCategory("  ", "", "unknown-ext"), DEFAULT_CATEGORY);
});

test("resolveCategory：非内部 id = 自定义分类原样透传", () => {
  assert.equal(resolveCategory("我的工具", undefined, "x"), "我的工具");
  assert.ok(!isInternalCategory("我的工具"));
  assert.ok(isInternalCategory("code"));
});

test("categoryLabel / categorySortKey：内部 i18n、自定义原文、内部序在前", () => {
  const t = (k) => ({ "cat.code": "代码与 Git", "cat.other": "其他" })[k] ?? k;
  assert.equal(categoryLabel("code", t), "代码与 Git");
  assert.equal(categoryLabel("其他分类", t), "其他分类");
  assert.ok(categorySortKey("session") < categorySortKey("other"));
  assert.ok(categorySortKey("other") < categorySortKey("我的工具"));
});

test("viewMode / moreExpandedDefault：形态自适应（v3）", () => {
  assert.equal(viewMode(FLAT_MODE_THRESHOLD), "flat");
  assert.equal(viewMode(FLAT_MODE_THRESHOLD + 1), "two-segment");
  assert.equal(moreExpandedDefault(0), true); // 首次态：更多展开
  assert.equal(moreExpandedDefault(3), false); // 已钉住：收起
});

test("matchApp：多词 AND、大小写不敏感、覆盖 keywords", () => {
  const app = { label: "扩展管理", extId: "aiti-extman", extName: "Extensions", keywords: ["插件"] };
  assert.equal(matchApp(app, ""), true);
  assert.equal(matchApp(app, "扩展"), true);
  assert.equal(matchApp(app, "extman"), true);
  assert.equal(matchApp(app, "EXT"), true);
  assert.equal(matchApp(app, "插件 管理"), true); // 多词 AND
  assert.equal(matchApp(app, "插件 不存在词"), false);
  assert.equal(matchApp(app, "zzz"), false);
});

test("钉住/隐藏存储：读写、幂等 toggle、上/下移、清空删 key", () => {
  assert.deepEqual(readPinned(), []);
  togglePinned("a:1");
  togglePinned("a:2");
  togglePinned("a:1"); // 幂等去钉
  assert.deepEqual(readPinned(), ["a:2"]);
  togglePinned("a:1");
  assert.deepEqual(readPinned(), ["a:2", "a:1"]);
  movePinned("a:1", -1); // 上移到首位
  assert.deepEqual(readPinned(), ["a:1", "a:2"]);
  movePinned("a:1", -1); // 越界 no-op
  assert.deepEqual(readPinned(), ["a:1", "a:2"]);
  writePinned([]);
  assert.deepEqual(readPinned(), []);
  assert.equal([...store.keys()].includes("pi:app-center:pinned:v1"), false); // 清空即删 key
  toggleHidden("a:9");
  assert.deepEqual(readHidden(), ["a:9"]);
  toggleHidden("a:9");
  assert.deepEqual(readHidden(), []);
});

test("buildApps：action 需 onClick / panel 不需 / dialogs 不收 / toggle 收 boolean features", () => {
  const exts = [
    { id: "ext-a", name: "A", category: "code", features: [{ id: "behavior.on", label: "开关甲", enabled: true }, { id: "cfg.s", type: "string", label: "配置", enabled: true, value: "x" }] },
    { id: "ext-b", name: "B", features: [{ id: "behavior.off", label: "开关乙", enabled: false }] },
  ];
  const slotItems = [
    { slot: "toolbar", id: "ext-a:btn", extId: "ext-a", meta: { label: "按钮甲", onClick: () => {} } },
    { slot: "toolbar", id: "ext-a:nop", extId: "ext-a", meta: { label: "自绘无 onClick" } }, // 滤除
    { slot: "rightFileDock", id: "ext-a:panel", extId: "ext-a", meta: { title: "面板甲" } }, // 无 onClick 也进
    { slot: "dialogs", id: "ext-a:dlg", extId: "ext-a", meta: { label: "弹窗", onClick: () => {} } }, // v1 不收
    { slot: "sidebarFooter", id: "ext-b:mgmt", extId: "ext-b", meta: { label: "管理甲", onClick: () => {} } },
  ];
  const apps = buildApps({ exts, slotItems, featureState: { "ext-b:behavior.off": false }, openPanel: () => {} });
  const byId = new Map(apps.map((a) => [a.id, a]));
  // action / panel / manage
  assert.ok(byId.has("action:ext-a:btn"));
  assert.equal(byId.get("action:ext-a:btn").category, "code"); // 条目级缺省 → 扩展级
  assert.ok(byId.has("panel:ext-a:panel"));
  assert.ok(byId.has("manage:ext-b:mgmt"));
  assert.ok(!byId.has("action:ext-a:nop"));
  assert.ok(![...byId.keys()].some((k) => k.includes("ext-a:dlg")));
  // toggles：boolean 两个都进；string 配置项不进
  assert.ok(byId.has("toggle:ext-a:behavior.on"));
  assert.ok(byId.has("toggle:ext-b:behavior.off"));
  assert.ok(![...byId.keys()].some((k) => k.startsWith("toggle:ext-a:cfg")));
  assert.equal(byId.get("toggle:ext-a:behavior.on").on, true);
  assert.equal(byId.get("toggle:ext-b:behavior.off").on, false);
  // feature 级 category 优先于扩展级
  const exts2 = [{ id: "ext-c", category: "system", features: [{ id: "f", label: "F", category: "debug", enabled: true }] }];
  const apps2 = buildApps({ exts: exts2, slotItems: [], featureState: {}, openPanel: () => {} });
  assert.equal(apps2[0].category, "debug");
  // panel run = openPanel 注入原语
  let opened = "";
  const apps3 = buildApps({ exts, slotItems: [slotItems[2]], featureState: {}, openPanel: (k) => { opened = k; } });
  apps3[0].run();
  assert.equal(opened, "ext-a:panel");
});

test("buildApps：扩展级 version/description/icon + feature description 透传到卡片（信息页数据源）", () => {
  const exts = [{
    id: "ext-d", name: "D", version: "1.2.3", description: "一行说明", icon: "icons/box.svg",
    features: [{ id: "f.on", label: "开关", description: "开关的说明", enabled: true }],
  }];
  const slotItems = [{ slot: "toolbar", id: "ext-d:btn", extId: "ext-d", meta: { label: "按钮", onClick: () => {}, icon: { svg: "<svg/>" } } }];
  const apps = buildApps({ exts, slotItems, featureState: {}, openPanel: () => {} });
  const action = apps.find((a) => a.kind === "action");
  const toggle = apps.find((a) => a.kind === "toggle");
  for (const a of [action, toggle]) {
    assert.equal(a.extVersion, "1.2.3");
    assert.equal(a.extDescription, "一行说明");
    assert.equal(a.extIcon, "icons/box.svg");
  }
  assert.equal(toggle.featureDescription, "开关的说明");
  assert.equal(action.featureDescription, undefined);
  assert.deepEqual(action.icon, { svg: "<svg/>" }); // 条目级 icon 优先于扩展级（卡片图标不变）
  // 未声明 description/version 的扩展：字段留空（信息页自行兜底）
  const bare = buildApps({ exts: [{ id: "ext-e", features: null }], slotItems: [], featureState: {}, openPanel: () => {} });
  assert.equal(bare.length, 0);
  const bare2 = buildApps({
    exts: [{ id: "ext-f", features: [{ id: "f", label: "F", enabled: false }] }],
    slotItems: [], featureState: {}, openPanel: () => {},
  });
  assert.equal(bare2[0].extDescription, undefined);
  assert.equal(bare2[0].extVersion, undefined);
});

test("splitByKind：应用视图（action/panel/manage）与开关视图（toggle）分置", () => {
  const apps = [
    { id: "action:a", kind: "action" }, { id: "toggle:b", kind: "toggle" },
    { id: "panel:c", kind: "panel" }, { id: "manage:d", kind: "manage" }, { id: "toggle:e", kind: "toggle" },
  ];
  const { entries, toggles } = splitByKind(apps);
  assert.deepEqual(entries.map((a) => a.id), ["action:a", "panel:c", "manage:d"]);
  assert.deepEqual(toggles.map((a) => a.id), ["toggle:b", "toggle:e"]);
  assert.ok(toggles.every((a) => isToggleId(a.id)));
  assert.ok(entries.every((a) => !isToggleId(a.id)));
  assert.deepEqual(splitByKind([]), { entries: [], toggles: [] });
});

test("extensionToggleGroups：按来源扩展分组（组序按扩展名、组内保持声明序）", () => {
  const apps = [
    { id: "toggle:zeta:f1", kind: "toggle", extId: "zeta", extName: "Zeta", extIcon: "icons/z.svg", label: "Z1" },
    { id: "toggle:alpha:f1", kind: "toggle", extId: "alpha", extName: "Alpha", label: "A1" },
    { id: "action:x", kind: "action", extId: "alpha", extName: "Alpha", label: "不分组" },
    { id: "toggle:alpha:f2", kind: "toggle", extId: "alpha", extName: "Alpha", label: "A2" },
    { id: "toggle:nov", kind: "toggle", extId: "nov", label: "N" },
  ];
  const groups = extensionToggleGroups(apps);
  assert.deepEqual(groups.map((g) => g.extId), ["alpha", "nov", "zeta"]);
  assert.deepEqual(groups[0].apps.map((a) => a.label), ["A1", "A2"]); // 声明序，非按 label 排序
  assert.equal(groups[0].extIcon, undefined);
  assert.equal(groups[2].extIcon, "icons/z.svg");
  assert.equal(groups[1].extName, undefined); // 缺 extName 时按 extId 定序
  assert.deepEqual(extensionToggleGroups([]), []);
});

test("hardDependents：id 精确 / 能力前缀（. 与 :）/ provides 能力名 三种命中口径", () => {
  const exts = [
    { id: "aiti-float", name: "Float", provides: ["dockstack", "aiti-float.dockstack"], dependsOn: ["aiti-float"] }, // 自身依赖不算
    { id: "session-manager", name: "Sessions", dependsOn: ["aiti-float.dockstack"] },   // 能力前缀
    { id: "aiti-app-center", name: "App Center", dependsOn: ["aiti-float:dockstack"] }, // 冒号形态
    { id: "aiti-folder", name: "Folder", dependsOn: ["aiti-float"] },                   // 扩展本名
    { id: "aiti-x", name: "X", dependsOn: ["dockstack"] },                              // provides 能力名
    { id: "aiti-y", name: "X", dependsOn: ["aiti-float.dockstack"] },                   // 展示名去重
    { id: "demo", name: "Demo", dependsOn: ["service-tunnels.tunnels", "unrelated"] },  // 不命中
  ];
  assert.deepEqual(hardDependents(exts, "aiti-float"), ["App Center", "Folder", "Sessions", "X"]);
  assert.deepEqual(hardDependents(exts, "demo"), []);
  assert.deepEqual(hardDependents(exts, "unregistered"), []);
  assert.deepEqual(hardDependents([], "aiti-float"), []);
});

test("pruneToggleIds：一次性清洗 v1 残留 toggle 记录，干净时零写入（幂等）", () => {
  writePinned(["action:a", "toggle:b:f", "panel:c"]);
  writeHidden(["toggle:d:f"]);
  assert.equal(isToggleId("toggle:b:f"), true);
  assert.equal(pruneToggleIds(), 2);
  assert.deepEqual(readPinned(), ["action:a", "panel:c"]);
  assert.deepEqual(readHidden(), []);
  assert.equal(store.has("pi:app-center:hidden:v1"), false); // 清空即删 key

  const writes = [];
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => real.getItem(k),
    setItem: (k, v) => { writes.push(k); real.setItem(k, v); },
    removeItem: (k) => { writes.push(k); real.removeItem(k); },
  };
  try {
    assert.equal(pruneToggleIds(), 0);
    assert.deepEqual(writes, []); // 无残留 → 不写、不广播
  } finally {
    globalThis.localStorage = real;
  }
  writePinned([]);
});

test("hideApp：追加写语义（幂等，不翻转）——与恢复区 toggleHidden 区分", () => {
  dispatched.length = 0;
  hideApp("panel:x");
  assert.deepEqual(readHidden(), ["panel:x"]);
  hideApp("panel:x");
  assert.deepEqual(readHidden(), ["panel:x"]);
  assert.equal(dispatched.length, 1); // 第二次命中已存在 → 零写入零广播
  dispatched.length = 0;
  toggleHidden("panel:x"); // 恢复区翻转语义仍可拔除
  assert.deepEqual(readHidden(), []);
});

test("disableExtension：ops 请求形态 + HTTP 200 里的 body.error 也算失败", async () => {
  const calls = [];
  let next = { ok: true, status: 200, body: {} };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init && JSON.parse(init.body) });
    return { ok: next.ok, status: next.status, json: async () => next.body };
  };
  try {
    next = { ok: true, status: 200, body: { ok: true, extensions: {} } };
    assert.deepEqual(await disableExtension((p) => "/base" + p, "aiti-demo"), { ok: true });
    assert.deepEqual(calls[0], {
      url: "/base/api/extensions/aiti-extman/ops",
      init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "disable", id: "aiti-demo" }) },
      body: { action: "disable", id: "aiti-demo" },
    });
    next = { ok: true, status: 200, body: { error: "有硬依赖者：Sessions" } };
    assert.deepEqual(await disableExtension((p) => p, "aiti-demo"), { ok: false, error: "有硬依赖者：Sessions" });
    next = { ok: false, status: 500, body: {} };
    assert.deepEqual(await disableExtension((p) => p, "aiti-demo"), { ok: false, error: "HTTP 500" });
    globalThis.fetch = async () => { throw new Error("network down"); };
    assert.deepEqual(await disableExtension((p) => p, "aiti-demo"), { ok: false, error: "network down" });
  } finally {
    globalThis.fetch = realFetch;
  }
});
