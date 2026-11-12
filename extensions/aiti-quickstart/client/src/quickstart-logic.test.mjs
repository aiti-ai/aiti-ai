/**
 * aiti-quickstart · quickstart-logic 纯逻辑单测 + manifest/client 一致性 + i18n key 全覆盖。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-quickstart/client/src/quickstart-logic.test.mjs
 *
 * 桩：localStorage（内存 Map）——import 前就位（app-registry.test.mjs 同范式）。
 * 一致性断言防漂移：manifest 静态条目 ↔ client 注册条目同源（WIDGET_METAS）↔ 图标/协议/文档键。
 * v2：[URL 规范] cwd 不进 URL——resolveQuickstartCwd 源链 = tab/session/recent/home。
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

/* ── resolveQuickstartCwd：tab → 会话 → 最近项目 → home → null（[URL 规范] 无 URL 源） ── */

test("resolveQuickstartCwd：tab-session 优先、逐级回退", () => {
  assert.equal(logic.resolveQuickstartCwd({ tabCwd: "/tab/cwd", sessionCwd: "/sess/cwd", recentRoot: "/recent", home: "/home" }), "/tab/cwd");
  assert.equal(logic.resolveQuickstartCwd({ tabCwd: null, sessionCwd: "/sess/cwd", recentRoot: "/recent", home: "/home" }), "/sess/cwd");
  assert.equal(logic.resolveQuickstartCwd({ tabCwd: "", sessionCwd: null, recentRoot: "/recent", home: "/home" }), "/recent");
  assert.equal(logic.resolveQuickstartCwd({ tabCwd: null, sessionCwd: null, recentRoot: null, home: "/home" }), "/home");
  assert.equal(logic.resolveQuickstartCwd({ tabCwd: null, sessionCwd: null, recentRoot: null, home: null }), null);
});

test("resolveQuickstartCwd：空白串视为缺失、全空放弃", () => {
  assert.equal(logic.resolveQuickstartCwd({ tabCwd: "   ", sessionCwd: "/s", recentRoot: null, home: null }), "/s");
  assert.equal(logic.resolveQuickstartCwd({ tabCwd: null, sessionCwd: "", recentRoot: "", home: "" }), null);
});

/* ── topRecentRoot：/api/sessions 派生最近项目 top1 ── */

test("topRecentRoot：projectRoot 优先、去重取最新、空/缺字段安全", () => {
  assert.equal(logic.topRecentRoot([
    { cwd: "/a", projectRoot: "/proj/a", modified: 100 },
    { cwd: "/a/wt", projectRoot: "/proj/a", modified: 200 },
    { cwd: "/b", modified: 150 },
  ]), "/proj/a");
  assert.equal(logic.topRecentRoot([{ cwd: "/x" }]), "/x");
  assert.equal(logic.topRecentRoot([]), null);
  assert.equal(logic.topRecentRoot("not-array"), null);
  assert.equal(logic.topRecentRoot([{ modified: "2026-11-07T00:00:00Z", cwd: "/iso" }]), "/iso");
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

test("WIDGET_METAS：4 枚、布局与方案一致、尺寸在宿主 clamp 范围内", () => {
  assert.deepEqual(logic.WIDGET_METAS.map((m) => m.id), ["guide", "shortcuts", "streaming", "examples"]);
  const byId = new Map(logic.WIDGET_METAS.map((m) => [m.id, m]));
  // guide p=-1 + h=1：先于 builtin:recent(p0) 占行1 独占整行——曾因同 p0 注册序在后
  // 掉行2/3 三行叠加致 top 区内滚裁切（快捷操作卡显示不全）
  // shortcuts w8（与 guide 同宽整行）；areas 全开双区（⚙ 可跨 top/bottom 挪动）
  // streaming p15：任务运行时概念卡（图标复刻宿主流式按钮区，卡片即按钮图例）
  const BOTH = ["top", "bottom"];
  assert.deepEqual(byId.get("guide"), { id: "guide", areas: BOTH, defaultArea: "top", w: 8, h: 1, priority: -1 });
  assert.deepEqual(byId.get("shortcuts"), { id: "shortcuts", areas: BOTH, defaultArea: "top", w: 8, h: 1, priority: 10 });
  assert.deepEqual(byId.get("streaming"), { id: "streaming", areas: BOTH, defaultArea: "top", w: 8, h: 1, priority: 15 });
  assert.deepEqual(byId.get("examples"), { id: "examples", areas: BOTH, defaultArea: "bottom", w: 8, h: 1, priority: 20 });
  for (const m of logic.WIDGET_METAS) {
    assert.ok(m.w >= 1 && m.w <= 8, `w 越界: ${m.id}`);
    assert.ok(m.h >= 1 && m.h <= 3, `h 越界: ${m.id}`);
    assert.ok(m.areas.includes(m.defaultArea), `defaultArea 必须在 areas 内: ${m.id}`);
  }
});

test("RUNTIME_ROWS：5 行（fork/侧聊/插队/排队/继续）、descKey 成对", () => {
  assert.deepEqual(logic.RUNTIME_ROWS.map((r) => r.key), ["qs.rt.fork", "qs.rt.sideChat", "qs.rt.steer", "qs.rt.followUp", "qs.rt.continue"]);
  for (const r of logic.RUNTIME_ROWS) {
    assert.ok(r.descKey === `${r.key}Desc`, `descKey 命名约定: ${r.key}`);
    assert.ok(r.key && r.descKey);
  }
});

test("WIDGET_TITLE_KEYS 覆盖全部 widget id", () => {
  for (const m of logic.WIDGET_METAS) assert.ok(logic.WIDGET_TITLE_KEYS[m.id], `缺标题 key: ${m.id}`);
});

/* ── v2：parseGitUrl（clone 来源解析，arg-array 安全） ── */

test("parseGitUrl：https .git 带 #branch", () => {
  const p = logic.parseGitUrl("https://github.com/acme/repo.git#dev");
  assert.ok(p);
  assert.equal(p.ref, "https://github.com/acme/repo.git");
  assert.equal(p.branch, "dev");
  assert.equal(p.name, "repo");
  assert.equal(p.local, false);
});

test("parseGitUrl：https github/gitlab 无 .git（无 branch）", () => {
  const p = logic.parseGitUrl("https://github.com/acme/my.repo");
  assert.ok(p);
  assert.equal(p.ref, "https://github.com/acme/my.repo");
  assert.equal(p.branch, undefined);
  assert.equal(p.name, "my.repo");
});

test("parseGitUrl：git@ scp 形态", () => {
  const p = logic.parseGitUrl("git@github.com:acme/repo.git");
  assert.ok(p);
  assert.equal(p.ref, "git@github.com:acme/repo.git");
  assert.equal(p.name, "repo");
  assert.equal(p.local, false);
});

test("parseGitUrl：git: 前缀带 #branch", () => {
  const p = logic.parseGitUrl("git:https://example.com/x/repo.git#main");
  assert.ok(p);
  assert.equal(p.ref, "https://example.com/x/repo.git");
  assert.equal(p.branch, "main");
});

test("parseGitUrl：本地绝对路径 / ~ / 盘符（内网友好）", () => {
  const p = logic.parseGitUrl("/home/pi/proj");
  assert.ok(p);
  assert.equal(p.ref, "/home/pi/proj");
  assert.equal(p.name, "proj");
  assert.equal(p.branch, undefined);
  assert.equal(p.local, true);
  assert.equal(logic.parseGitUrl("~/work/proj")?.local, true);
  assert.equal(logic.parseGitUrl("~/work/proj")?.name, "proj");
  assert.equal(logic.parseGitUrl("D:\\repos\\proj")?.local, true);
});

test("parseGitUrl：非法输入拒绝（空/不识别/选项注入/控制字符/非法分支）", () => {
  assert.equal(logic.parseGitUrl(""), null);
  assert.equal(logic.parseGitUrl("   "), null);
  assert.equal(logic.parseGitUrl("not a url"), null);
  assert.equal(logic.parseGitUrl("ftp://x/repo.git"), null); // 非 https/git@/git:/本地
  assert.equal(logic.parseGitUrl("-evil.git"), null);
  assert.equal(logic.parseGitUrl("git:--upload-pack=x"), null);
  assert.equal(logic.parseGitUrl("https://github.com/a/repo.git#-bad"), null);
  assert.equal(logic.parseGitUrl("git@h:x\u0000repo"), null);
});

/* ── v2：splitKbdHint（快捷操作卡行式布局） ── */

test("splitKbdHint：首空格拆 kbd/描述、单符号与空串", () => {
  assert.deepEqual(logic.splitKbdHint("Ctrl+Alt+N 新建会话"), { kbd: "Ctrl+Alt+N", desc: "新建会话" });
  assert.deepEqual(logic.splitKbdHint("@ 引用文件"), { kbd: "@", desc: "引用文件" });
  assert.deepEqual(logic.splitKbdHint("/ 命令菜单"), { kbd: "/", desc: "命令菜单" });
  assert.deepEqual(logic.splitKbdHint("Enter 发送消息"), { kbd: "Enter", desc: "发送消息" });
  assert.deepEqual(logic.splitKbdHint("@@."), { kbd: "@@.", desc: "" }); // 无空格
  assert.deepEqual(logic.splitKbdHint("  "), { kbd: "", desc: "" });
  assert.deepEqual(logic.splitKbdHint(undefined), { kbd: "", desc: "" });
});

/* ── v2：pickFinalName 防覆盖顺延 ── */

test("pickFinalName：无冲突原样 / 冲突 -2 -3 / 极端全占用时间戳兜底", () => {
  assert.equal(logic.pickFinalName("repo", () => false), "repo");
  const taken = new Set(["repo", "repo-2"]);
  assert.equal(logic.pickFinalName("repo", (n) => taken.has(n)), "repo-3");
  assert.equal(logic.pickFinalName("repo", () => true).startsWith("repo-"), true);
});

/* ── v2：deriveOnboardingState 三态 ── */

test("deriveOnboardingState：fresh（无 cwd 无历史）/ hasWorkspace（有工作区无模型）/ full（齐备）", () => {
  assert.equal(logic.deriveOnboardingState({ cwd: null, recentRootCount: 0, modelCount: 0 }), "fresh");
  assert.equal(logic.deriveOnboardingState({ cwd: "  ", recentRootCount: 0, modelCount: 5 }), "fresh");
  assert.equal(logic.deriveOnboardingState({ cwd: "/w", recentRootCount: 0, modelCount: 0 }), "hasWorkspace");
  assert.equal(logic.deriveOnboardingState({ cwd: null, recentRootCount: 3, modelCount: 0 }), "hasWorkspace");
  assert.equal(logic.deriveOnboardingState({ cwd: "/w", recentRootCount: 2, modelCount: 1 }), "full");
});

/* ── v2：mergeWorkspaceHistory（记录 + 扫描合并） ── */

test("mergeWorkspaceHistory：记录优先、root 去重、扫描 time 降序殿后、截 topLimit", () => {
  const recorded = [
    { id: "clone:/a", source: "clone", root: "/a", name: "a", time: 10, url: "u" },
    { id: "upload:/b", source: "upload", root: "/b", name: "b", time: 20 },
  ];
  const merged = logic.mergeWorkspaceHistory(recorded, [
    { root: "/b", time: 999 }, // 重复 → 记录胜出
    { root: "/c", time: 5 },
    { root: "/d", time: 300 },
  ], 3);
  assert.deepEqual(merged.map((r) => r.root), ["/a", "/b", "/d"]);
  assert.equal(merged[2].source, "scan");
  assert.equal(merged[2].id, "scan:/d");
  assert.equal(merged[2].name, "d");
});

test("mergeWorkspaceHistory：空输入/非法输入安全", () => {
  assert.deepEqual(logic.mergeWorkspaceHistory([], []), []);
  assert.ok(Array.isArray(logic.mergeWorkspaceHistory("x", "y"))); // 非数组输入不抛（返回空结果）
  const m = logic.mergeWorkspaceHistory([{ id: "x", source: "clone", root: "/r", name: "", time: 1 }], []);
  assert.equal(m[0].name, "r"); // name 缺省从 root 尾段派生
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

test("manifest 基本字段：id/client/sidebarFooter/图标/协议/v2 新增面", () => {
  assert.equal(manifest.id, logic.EXT_ID);
  assert.equal(manifest.client, "dist/aiti-quickstart-client.mjs");
  assert.equal(manifest.ui.sidebarFooter.length, 1);
  assert.equal(manifest.ui.sidebarFooter[0].id, logic.FOOTER_ITEM_ID);
  assert.equal(manifest.icon, "icons/rocket.svg");
  assert.ok(existsSync(resolve(extRoot, "..", "_shared", "icons", "rocket.svg")), "_shared/icons/rocket.svg 缺失");
  assert.equal(pkg.aitiExtProtocol, "1.0");
  assert.ok(pkg.name.startsWith("@aiti-ai/aiti-quickstart"));
  // v2：server API（宿主 registry 经 ext.ext.server.api 调用——必须 server.api 形）+ workspacePickerActions + 上传软依赖
  assert.equal(typeof manifest.server?.api, "function", "manifest.server.api（server 端点）必须导出");
  assert.equal(manifest.api, undefined, "顶层 api 导出不被宿主识别（registry 读 ext.ext.server.api）——禁止回退");
  assert.equal(manifest.ui.workspacePickerActions.length, 1);
  assert.equal(manifest.ui.workspacePickerActions[0].id, "acquire");
  assert.ok(Array.isArray(manifest.optionalDependsOn) && manifest.optionalDependsOn.includes("session-manager"));
  assert.ok(Array.isArray(manifest.dependencies) === false); // dependencies 在 package.json
  assert.ok(pkg.dependencies?.["@aiti-ai/ext-shared"], "server clone 依赖 ext-shared（whichBin）须声明");
  assert.ok(existsSync(resolve(extRoot, "server", "clone.ts")), "server/clone.ts 缺失");
  assert.ok(existsSync(resolve(extRoot, "server", "api.ts")), "server/api.ts 缺失");
});

/* ── i18n key 全覆盖（zh-CN / en 同集合 + 源码引用逐 key 在册） ── */

test("ui.i18n：zh-CN 与 en key 集合一致且非空", () => {
  const zh = Object.keys(manifest.ui.i18n["zh-CN"]).sort();
  const en = Object.keys(manifest.ui.i18n.en).sort();
  assert.ok(zh.length > 0);
  assert.deepEqual(zh, en);
});

test("源码引用的 qs.* key 全部在 i18n 在册（zh+en）", () => {
  const zh = manifest.ui.i18n["zh-CN"];
  const en = manifest.ui.i18n.en;
  const files = ["quickstart.tsx", "workspace-hub.tsx", "entry.tsx", "quickstart-logic.ts"];
  const used = new Set();
  for (const f of files) {
    const p = resolve(srcDir, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    // 抓全部 "qs.*" 字面（t() 直调 + key 常量数组都收）
    for (const m of text.matchAll(/"(qs\.[^"]+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 25, `引用 key 过少（${used.size}），正则可能失配`); // hub/ui 文件就位后自然 >30
  const missing = [];
  for (const key of used) {
    if (!(key in zh)) missing.push(`zh-CN 缺 key: ${key}`);
    if (!(key in en)) missing.push(`en 缺 key: ${key}`);
  }
  assert.deepEqual(missing, []);
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
