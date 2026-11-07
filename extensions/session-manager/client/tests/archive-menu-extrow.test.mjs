/**
 * archive-menu 外部 agent 行（ext 行）菜单渲染回归 —— node --test。
 *
 * 事故（2026-09-21）：qoder/qodercn 等外部 agent 行点 📦，菜单里显示的字面量是
 * `[object Object][object Object]`，而不是「从列表移除 / 真归档」按钮。
 * 根因：`archive-menu.tsx` 的 ext 行分支把「移除按钮」与「真归档按钮」两个 JSX 元素
 * 用 `+` 相加（`{...} + (<button…/>)`）——React 元素是对象，`elemA + elemB` 走字符串
 * 拼接 → `"[object Object][object Object]"`（元素整体丢失）。
 *
 * 本测试钉死「ext 行菜单渲染出的是真按钮元素，且不含 [object Object] 字面量」，
 * 同时覆盖 pi 行（4 选项）不回归。
 *
 * 同批第二个缺陷：`sm.extTrueArchive`（真归档项）在任何 locale 表里都没声明——宿主 t()
 * 对缺失 key 返回 key 本身（非 undefined），故 `?? "真归档…"` 兜底永不生效，修好结构后
 * 按钮会显示字面量 "sm.extTrueArchive"。最后一条用例改为「菜单用到的每个 key 都必须在
 * index.ts 的每个 locale 表里存在」，把这类静默漏词条钉住。
 *
 * 「真归档」还是能力门控项：服务端 `archiveCapableAgents()`（实现了 A03 三原语的 adapter）
 * 随 /sessions 全量下发 → `store.extArchiveAgents` → 名单外的源（cursor-ide/trae/
 * antigravity/cline/codebuddy 与第三方 provider 源）菜单不再给出点了必报错的项；
 * 名单缺席/为空（旧服务端）则不做限制，照旧显示。
 *
 * 范式：镜像 archive-menu.tsx 到隔离目录 + stub 同级依赖（host-shim／store／
 * confirm-dialog／helpers），esbuild 打包（react → 极简 createElement 树桩）后直接
 * 调用组件函数取回元素树断言（同 folder-dock.test.mjs / pending-drafts.test.mjs 范式）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");

/* ── 极简 react 桩：createElement 返回可断言的元素树；hooks 取初值（单趟渲染足够）── */
const REACT_STUB = `
export const Fragment = Symbol.for("react.fragment");
export function createElement(type, props, ...children) {
  const p = { ...(props || {}) };
  if (children.length) p.children = children.length === 1 ? children[0] : children;
  return { type, props: p };
}
export function useState(v) { return [typeof v === "function" ? v() : v, () => {}]; }
export const useEffect = () => {};
export const useLayoutEffect = () => {};
export const useRef = (v) => ({ current: v ?? null });
export const useMemo = (f) => f();
export const useCallback = (f) => f;
export const memo = (f) => f;
`;
const JSX_RUNTIME_STUB = `
export const Fragment = Symbol.for("react.fragment");
export const jsx = (type, props) => ({ type, props });
export const jsxs = jsx;
export const jsxDEV = jsx;
`;
const HOST_SHIM_STUB = `export function t() { return undefined; }\n`;
/** store 桩：测试经 __setStore/__setKids 注入数据（不用 globalThis.__*，避免撞全局量灰名单门禁）。 */
const STORE_STUB = `
let _store = { sessions: [], archived: [] };
let _kids = [];
export function __setStore(s) { _store = s; }
export function __setKids(k) { _kids = k; }
export function useStore() { return _store; }
export function collectSubtreeIds() { return _kids; }
export const act = async () => true;
export const archiveSessions = async () => ({ ok: true, skippedIds: [] });
export const archiveExtSession = async () => ({ ok: true });
export const deleteLiveSession = async () => null;
export const hideExtSession = async () => true;
export const markPendingRemoval = () => {};
export const clearPendingRemoval = () => {};
`;
const CONFIRM_STUB = `export function showConfirm() {}\n`;
const HELPERS_STUB = `export function ensureReadability(c) { return c; }\nexport const SIc = () => null;\n`;
const ENTRY = `export * from "./archive-menu.tsx";\nexport { __setStore, __setKids } from "./store.ts";\n`;

/** 镜像源文件 + stub 同级依赖 → esbuild 打包 → 动态 import。 */
async function loadArchiveMenu(t) {
  const dir = mkdtempSync(join(tmpdir(), "sm-amenu-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, "client", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "archive-menu.tsx"), readFileSync(join(srcRoot, "archive-menu.tsx"), "utf8"));
  writeFileSync(join(src, "host-shim.ts"), HOST_SHIM_STUB);
  writeFileSync(join(src, "store.ts"), STORE_STUB);
  writeFileSync(join(src, "confirm-dialog.ts"), CONFIRM_STUB);
  writeFileSync(join(src, "helpers.ts"), HELPERS_STUB);
  writeFileSync(join(src, "__test-entry.ts"), ENTRY);
  const reactStub = join(dir, "react-stub.js");
  const runtimeStub = join(dir, "jsx-runtime-stub.js");
  writeFileSync(reactStub, REACT_STUB);
  writeFileSync(runtimeStub, JSX_RUNTIME_STUB);
  const outfile = join(dir, "bundle.mjs");
  await build({
    entryPoints: [join(src, "__test-entry.ts")],
    bundle: true, format: "esm", platform: "node", jsx: "automatic",
    alias: { react: reactStub, "react/jsx-runtime": runtimeStub },
    outfile, logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

/** 元素树遍历：收集文本节点与 button 元素。 */
function walk(node, out) {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.texts.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out; }
  if (typeof node === "object") {
    if (node.type === "button") out.buttons.push(node);
    walk(node.props?.children, out);
  }
  return out;
}
function snapshot(tree) {
  const out = walk(tree, { texts: [], buttons: [] });
  return { texts: out.texts, buttons: out.buttons, buttonTexts: out.buttons.map((b) => walk(b.props?.children, { texts: [], buttons: [] }).texts.join("")) };
}

const TRIGGER = { getBoundingClientRect: () => ({ top: 80, bottom: 100, left: 60, right: 100, width: 40, height: 20 }) };

/** 服务端实发名单（archiveCapableAgents() 结果节选）——测试里默认行都在名单内。 */
const CAPABLE = ["claude", "qoder", "qodercn", "zcode", "codex"];

async function render(t, sessionId, rows, kids = [], archiveAgents = CAPABLE) {
  const mod = await loadArchiveMenu(t);
  globalThis.window = { innerWidth: 1600, innerHeight: 900 };
  t.after(() => { delete globalThis.window; });
  mod.__setStore({ sessions: rows, archived: [], extArchiveAgents: archiveAgents });
  mod.__setKids(kids);
  mod.openArchiveMenuAt(sessionId, TRIGGER);
  const tree = mod.ArchiveMenuHost();
  assert.ok(tree, "菜单应已展开（openArchiveMenuAt 后组件应渲染）");
  return snapshot(tree);
}

test("ext 行（qoder，无子会话）：渲染真按钮，不得出现 [object Object] 字面量", async (t) => {
  const snap = await render(t, "qoder:s1", [{ id: "qoder:s1", agent: "qoder" }]);
  assert.equal(snap.texts.filter((x) => x.includes("[object Object]")).length, 0,
    `菜单文本不得含 [object Object]，实际文本：${JSON.stringify(snap.texts)}`);
  assert.ok(snap.buttonTexts.some((x) => x.includes("从列表移除")), `应含「从列表移除」按钮，实际：${JSON.stringify(snap.buttonTexts)}`);
  assert.ok(snap.buttonTexts.some((x) => x.includes("真归档")), `应含「真归档」按钮，实际：${JSON.stringify(snap.buttonTexts)}`);
});

test("ext 行（qodercn，带子会话）：平铺「同时移除 / 只移除主会话」+ 真归档，无 [object Object]", async (t) => {
  const snap = await render(t, "qodercn:s1", [{ id: "qodercn:s1", agent: "qodercn" }], ["qodercn:s1", "qodercn:s2"]);
  assert.equal(snap.texts.filter((x) => x.includes("[object Object]")).length, 0,
    `菜单文本不得含 [object Object]，实际文本：${JSON.stringify(snap.texts)}`);
  assert.ok(snap.buttonTexts.some((x) => x.includes("同时移除 2 个子会话")), `实际：${JSON.stringify(snap.buttonTexts)}`);
  assert.ok(snap.buttonTexts.some((x) => x.includes("只移除主会话")), `实际：${JSON.stringify(snap.buttonTexts)}`);
  assert.ok(snap.buttonTexts.some((x) => x.includes("真归档")), `实际：${JSON.stringify(snap.buttonTexts)}`);
});

test("pi 行：4 选项（已解决/未解决/直接归档/彻底删除）不回归", async (t) => {
  const snap = await render(t, "pi-1", [{ id: "pi-1" }]);
  assert.equal(snap.texts.filter((x) => x.includes("[object Object]")).length, 0,
    `菜单文本不得含 [object Object]，实际文本：${JSON.stringify(snap.texts)}`);
  for (const label of ["已解决归档", "未解决归档", "直接归档", "彻底删除"]) {
    assert.ok(snap.buttonTexts.some((x) => x.includes(label)), `应含「${label}」按钮，实际：${JSON.stringify(snap.buttonTexts)}`);
  }
});

/* ── 能力门控：名单外的源不给「真归档」（点了必被服务端拒绝） ── */
test("ext 行（codebuddy，无 remove 原语）：只给「从列表移除」，隐藏「真归档」", async (t) => {
  const snap = await render(t, "codebuddy:s1", [{ id: "codebuddy:s1", agent: "codebuddy" }]);
  assert.ok(snap.buttonTexts.some((x) => x.includes("从列表移除")), `实际：${JSON.stringify(snap.buttonTexts)}`);
  assert.equal(snap.buttonTexts.filter((x) => x.includes("真归档")).length, 0,
    `能力名单外的源不得显示「真归档」，实际：${JSON.stringify(snap.buttonTexts)}`);
});

test("ext 行（claude，名单内）：「真归档」照旧显示", async (t) => {
  const snap = await render(t, "claude:s1", [{ id: "claude:s1", agent: "claude" }]);
  assert.ok(snap.buttonTexts.some((x) => x.includes("真归档")), `实际：${JSON.stringify(snap.buttonTexts)}`);
});

test("能力名单为空（旧服务端未下发 archiveAgents）：不做限制", async (t) => {
  const snap = await render(t, "codebuddy:s1", [{ id: "codebuddy:s1", agent: "codebuddy" }], [], []);
  assert.ok(snap.buttonTexts.some((x) => x.includes("真归档")),
    `名单缺席时保持旧行为（显示，点击后由服务端守卫报错），实际：${JSON.stringify(snap.buttonTexts)}`);
});

/* ── i18n 词条覆盖：菜单用到的 key 必须在每个 locale 表里都有 ──
   宿主 makeClientContext().t = (key) => interpolate(table[key] ?? key)：缺词条返回
   key 本身（真值），组件里的 `t(k) ?? "中文"` 兜底永不生效 → 界面显示字面量 key。 */
function localeTables(indexSrc) {
  const lines = indexSrc.split("\n");
  const start = lines.findIndex((l) => /^\s*i18n: \{$/.test(l));
  const ind = lines[start].match(/^\s*/)[0].length;
  const isEnd = new RegExp(`^\\s{${ind}}\\},?$`);
  const isLoc = new RegExp(`^\\s{${ind + 2}}"?([A-Za-z]{2}(?:-[A-Za-z]{2})?)"?: \\{$`);
  const isKey = new RegExp(`^\\s{${ind + 4}}"([^"]+)"\\s*:`);
  const tables = {};
  let cur = null;
  for (let i = start + 1; i < lines.length && !isEnd.test(lines[i]); i++) {
    const loc = lines[i].match(isLoc);
    if (loc) { cur = tables[loc[1]] = new Set(); continue; }
    const key = lines[i].match(isKey);
    if (key && cur) cur.add(key[1]);
  }
  return tables;
}

test("archive-menu 用到的 i18n key 必须在 en/zh-CN 表里都有词条", () => {
  const used = [...readFileSync(join(srcRoot, "archive-menu.tsx"), "utf8").matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length >= 10, `应抓到菜单里的 i18n key，实际 ${used.length} 个`);
  const tables = localeTables(readFileSync(join(here, "..", "..", "index.ts"), "utf8"));
  // 只判全量维护的两张表：zh-TW 是历史半覆盖表（107/289），补全是另一件事
  const full = ["en", "zh-CN"];
  for (const l of full) assert.ok(tables[l]?.size > 200, `locale 表解析异常：${l} → ${tables[l]?.size ?? "无"}`);
  for (const key of new Set(used)) {
    const miss = full.filter((l) => !tables[l].has(key));
    assert.equal(miss.length, 0, `${key} 缺 ${miss.join("/")} 词条（界面会显示字面量 key）`);
  }
});