/**
 * aiti-quickstart · quickstart-logic 纯逻辑单测 + manifest/client 一致性 + i18n key 全覆盖。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-quickstart/client/src/quickstart-logic.test.mjs
 *
 * 桩：localStorage（内存 Map）——import 前就位（app-registry.test.mjs 同范式）。
 * 一致性断言防漂移：manifest 静态条目 ↔ client 注册条目同源（WIDGET_METAS）↔ 图标/协议/文档键。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const srcDir = dirname(fileURLToPath(import.meta.url)); // client/src
const extRoot = resolve(srcDir, "..", ".."); // pi-web-ext/aiti-quickstart

const logic = await import("./quickstart-logic.ts");
const manifest = (await import(pathToFileURL(resolve(extRoot, "index.ts")).href)).default;
const pkg = JSON.parse(readFileSync(resolve(extRoot, "package.json"), "utf8"));

/* ── resolveQuickstartCwd：?cwd → 会话 cwd → home 兜底 → null ── */

test("resolveQuickstartCwd：URL ?cwd 优先", () => {
  assert.equal(logic.resolveQuickstartCwd("?cwd=/home/x/proj&foo=1", "/home"), "/home/x/proj");
  assert.equal(logic.resolveQuickstartCwd("?other=1", "/home"), "/home");
  assert.equal(logic.resolveQuickstartCwd("", "/home"), "/home");
});

test("resolveQuickstartCwd：会话 cwd 次级、home 兜底", () => {
  assert.equal(logic.resolveQuickstartCwd("?other=1", "/home", "/sess/cwd"), "/sess/cwd"); // 无 ?cwd → 会话 cwd
  assert.equal(logic.resolveQuickstartCwd("?other=1", null, "/sess/cwd"), "/sess/cwd");
  assert.equal(logic.resolveQuickstartCwd("?cwd=/url/cwd", "/home", "/sess/cwd"), "/url/cwd"); // URL 仍优先
  assert.equal(logic.resolveQuickstartCwd("?other=1", "/home", ""), "/home"); // 会话 cwd 空 → home
  assert.equal(logic.resolveQuickstartCwd("?other=1", null, null), null);
});

test("resolveQuickstartCwd：空白/缺失回退与放弃", () => {
  assert.equal(logic.resolveQuickstartCwd("?cwd=", "/home"), "/home"); // 空串视为缺失
  assert.equal(logic.resolveQuickstartCwd("?cwd=   ", "/home"), "/home"); // 空白视为缺失
  assert.equal(logic.resolveQuickstartCwd("?cwd=/x", null), "/x");
  assert.equal(logic.resolveQuickstartCwd("", null), null);
  assert.equal(logic.resolveQuickstartCwd("", ""), null);
  assert.equal(logic.resolveQuickstartCwd("not-a-query", null), null); // 非法 search 不抛
});

/* ── 引导卡关闭态 ── */

test("readSidebarDismissed/writeSidebarDismissed：roundtrip + false 清键", () => {
  assert.equal(logic.readSidebarDismissed(), false);
  logic.writeSidebarDismissed(true);
  assert.equal(logic.readSidebarDismissed(), true);
  assert.equal(store.get(logic.DISMISS_KEY), "1");
  logic.writeSidebarDismissed(false);
  assert.equal(logic.readSidebarDismissed(), false);
  assert.equal(store.has(logic.DISMISS_KEY), false);
});

/* ── widget 元数据 ── */

test("WIDGET_METAS：3 枚、布局与方案一致、尺寸在宿主 clamp 范围内", () => {
  assert.deepEqual(logic.WIDGET_METAS.map((m) => m.id), ["guide", "shortcuts", "examples"]);
  const byId = new Map(logic.WIDGET_METAS.map((m) => [m.id, m]));
  assert.deepEqual(byId.get("guide"), { id: "guide", areas: ["top"], defaultArea: "top", w: 8, h: 2, priority: 0 });
  assert.deepEqual(byId.get("shortcuts"), { id: "shortcuts", areas: ["top"], defaultArea: "top", w: 4, h: 1, priority: 10 });
  assert.deepEqual(byId.get("examples"), { id: "examples", areas: ["bottom"], defaultArea: "bottom", w: 8, h: 1, priority: 20 });
  for (const m of logic.WIDGET_METAS) {
    assert.ok(m.w >= 1 && m.w <= 8, `w 越界: ${m.id}`);
    assert.ok(m.h >= 1 && m.h <= 3, `h 越界: ${m.id}`);
    assert.ok(m.areas.includes(m.defaultArea), `defaultArea 必须在 areas 内: ${m.id}`);
  }
});

test("WIDGET_TITLE_KEYS 覆盖全部 widget id", () => {
  for (const m of logic.WIDGET_METAS) assert.ok(logic.WIDGET_TITLE_KEYS[m.id], `缺标题 key: ${m.id}`);
});

/* ── manifest ↔ client 一致性（防漂移） ── */

test("manifest 静态条目与 WIDGET_METAS 同源同值", () => {
  const staticWidgets = manifest.ui.newSessionWidgets;
  assert.equal(staticWidgets.length, logic.WIDGET_METAS.length);
  for (const s of staticWidgets) {
    const m = logic.WIDGET_METAS.find((x) => x.id === s.id);
    assert.ok(m, `manifest 出现未知 widget: ${s.id}`);
    assert.ok(typeof s.meta.title === "string" && s.meta.title.length > 0, `静态条目 title 缺失: ${s.id}`); // zh 字面（静态条目约定，client 接管后走 t()）
    assert.deepEqual(s.meta.areas, m.areas);
    assert.equal(s.meta.defaultArea, m.defaultArea);
    assert.equal(s.meta.w, m.w);
    assert.equal(s.meta.h, m.h);
    assert.equal(s.meta.priority, m.priority);
  }
});

test("manifest 基本字段：id/client/sidebarFooter id/图标/协议", () => {
  assert.equal(manifest.id, logic.EXT_ID);
  assert.equal(manifest.client, "dist/aiti-quickstart-client.mjs");
  assert.equal(manifest.ui.sidebarFooter.length, 1);
  assert.equal(manifest.ui.sidebarFooter[0].id, logic.FOOTER_ITEM_ID);
  assert.equal(manifest.icon, "icons/rocket.svg");
  assert.ok(existsSync(resolve(extRoot, "..", "_shared", "icons", "rocket.svg")), "_shared/icons/rocket.svg 缺失");
  assert.equal(pkg.aitiExtProtocol, "1.0");
  assert.equal(pkg.name, "@aiti-ai/aiti-quickstart");
});

/* ── i18n key 全覆盖（zh-CN / en 同集合 + 代码引用逐 key 在册） ── */

test("ui.i18n：zh-CN 与 en key 集合一致且非空", () => {
  const zh = Object.keys(manifest.ui.i18n["zh-CN"]).sort();
  const en = Object.keys(manifest.ui.i18n.en).sort();
  assert.ok(zh.length > 0);
  assert.deepEqual(zh, en);
});

test("代码引用的 qs.* key 全部在 i18n 在册（zh+en）", () => {
  const zh = manifest.ui.i18n["zh-CN"];
  const en = manifest.ui.i18n.en;
  const files = ["quickstart.tsx", "entry.tsx", "quickstart-logic.ts"];
  const used = new Set();
  for (const f of files) {
    const text = readFileSync(resolve(srcDir, f), "utf8");
    // 抓全部 "qs.*" 字面（t() 直调 + GUIDE_STEP_KEYS 等 key 数组都收）
    for (const m of text.matchAll(/"(qs\.[^"]+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 20, `引用 key 过少（${used.size}），正则可能失配`);
  for (const key of used) {
    assert.ok(key in zh, `zh-CN 缺 key: ${key}`);
    assert.ok(key in en, `en 缺 key: ${key}`);
  }
  for (const m of logic.WIDGET_METAS) {
    const tk = logic.WIDGET_TITLE_KEYS[m.id];
    assert.ok(tk in zh && tk in en, `widget 标题 key 不在册: ${tk}`);
  }
});

test("isQuickstartWidgetId：组合 id 前缀判定", () => {
  assert.equal(logic.isQuickstartWidgetId("aiti-quickstart:guide"), true);
  assert.equal(logic.isQuickstartWidgetId("builtin:recent"), false);
  assert.equal(logic.isQuickstartWidgetId("aiti-quickstart"), false);
  assert.equal(logic.isQuickstartWidgetId(""), false);
});
