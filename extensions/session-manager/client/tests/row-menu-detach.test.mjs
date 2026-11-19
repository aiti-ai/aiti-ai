/**
 * row-menu "Start · survive restarts" / "Start in process" regression — node --test.
 *
 * Hosting mode is fixed at spawn time (no fd handover), so the menu entries are
 * only meaningful for COLD sessions:
 *   - cold session  → "survive restarts" appears; clicking POSTs /api/sessions/<id>/detach
 *   - running       → absent (the core could only answer `already`)
 *   - host without a runner (409) / already running → toast carries the reason
 *   - "Start in process" only on cold sessions carrying the detachPref row flag;
 *     clicking POSTs /api/sessions/<id>/attach
 *
 * Also pins the i18n contract: every key the menu uses must exist in the en and
 * zh-CN tables — the host's t() returns the key itself for a missing entry (truthy),
 * so a `t(k) ?? "fallback"` never kicks in.
 *
 * Same pattern as archive-menu-extrow.test.mjs: mirror the source, stub sibling
 * modules, bundle with esbuild, assert on the element tree from a minimal react stub.
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
/** host-shim: t() always undefined (so the component's `?? "fallback"` applies), apiUrl identity. */
const HOST_SHIM_STUB = `
export function t() { return undefined; }
export function apiUrl(p) { return p; }
export function getCtx() { return undefined; }
`;
const HELPERS_STUB = `
export function ensureReadability(c) { return c; }
export function sessionTitle(s) { return s.title || s.id; }
export const SIc = () => null;
`;
const STORE_STUB = `
export function refreshSessions() {}
export function applySessionNameLocal() {}
`;
const RELATED_STUB = `export function showRelatedDocs() {}\n`;
const TOAST_STUB = `export function showToast(m) { globalThis.__smToast = m; }\n`;
const ENTRY = `export * from "./row-menu.tsx";\n`;

async function loadRowMenu(t) {
  const dir = mkdtempSync(join(tmpdir(), "sm-rowmenu-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, "client", "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "row-menu.tsx"), readFileSync(join(srcRoot, "row-menu.tsx"), "utf8"));
  writeFileSync(join(src, "host-shim.ts"), HOST_SHIM_STUB);
  writeFileSync(join(src, "helpers.ts"), HELPERS_STUB);
  writeFileSync(join(src, "store.ts"), STORE_STUB);
  writeFileSync(join(src, "related-docs.ts"), RELATED_STUB);
  writeFileSync(join(src, "toast.ts"), TOAST_STUB);
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

function menuKeys(items) {
  return items.map((i) => i.key);
}

test("cold session gets a 'survive restarts' menu item; a running one does not", async (t) => {
  const mod = await loadRowMenu(t);
  const base = { sess: { id: "11111111-1111-1111-1111-111111111111", cwd: "/tmp" }, startRename: () => {}, onMove: () => {} };
  const cold = mod.buildLivePiRowMenuItems({ ...base, running: false });
  const detach = cold.find((i) => i.key === "detach-start");
  assert.ok(detach, `cold session must offer detach-start, got ${JSON.stringify(menuKeys(cold))}`);
  assert.equal(detach.label, "跨重启启动");

  const running = mod.buildLivePiRowMenuItems({ ...base, running: true });
  assert.equal(running.some((i) => i.key === "detach-start"), false,
    `running session must not offer detach-start, got ${JSON.stringify(menuKeys(running))}`);
});

test("'Start in process' only appears on cold sessions carrying the detachPref flag", async (t) => {
  const mod = await loadRowMenu(t);
  const mk = (sess) => ({ sess, startRename: () => {}, onMove: () => {} });
  const id = "22222222-3333-4444-5555-666666666666";

  const coldMarked = mod.buildLivePiRowMenuItems({ ...mk({ id, cwd: "/tmp", detachPref: true }), running: false });
  const inproc = coldMarked.find((i) => i.key === "inprocess-start");
  assert.ok(inproc, `marked cold session must offer inprocess-start, got ${JSON.stringify(menuKeys(coldMarked))}`);
  assert.equal(inproc.label, "进程内启动");

  const coldPlain = mod.buildLivePiRowMenuItems({ ...mk({ id, cwd: "/tmp" }), running: false });
  assert.equal(coldPlain.some((i) => i.key === "inprocess-start"), false,
    `unmarked cold session must not offer inprocess-start, got ${JSON.stringify(menuKeys(coldPlain))}`);

  const runningMarked = mod.buildLivePiRowMenuItems({ ...mk({ id, cwd: "/tmp", detachPref: true }), running: true });
  assert.equal(runningMarked.some((i) => i.key === "inprocess-start"), false,
    `running session must not offer inprocess-start, got ${JSON.stringify(menuKeys(runningMarked))}`);
});

test("reopenDetached posts to the session detach endpoint and reports the runner", async (t) => {
  const mod = await loadRowMenu(t);
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init?.method]);
    return { ok: true, status: 200, json: async () => ({ ok: true, already: false, runner: "systemd-run" }) };
  };
  t.after(() => { globalThis.fetch = previous; });
  await mod.reopenDetached("abc-123");
  assert.deepEqual(calls, [["/api/sessions/abc-123/detach", "POST"]]);
  assert.match(String(globalThis.__smToast), /跨重启|systemd-run/);
});

test("startInProcess posts to the session attach endpoint and toasts success", async (t) => {
  const mod = await loadRowMenu(t);
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init?.method]);
    return { ok: true, status: 200, json: async () => ({ ok: true, already: false, started: true }) };
  };
  t.after(() => { globalThis.fetch = previous; });
  await mod.startInProcess("abc-123");
  assert.deepEqual(calls, [["/api/sessions/abc-123/attach", "POST"]]);
  assert.match(String(globalThis.__smToast), /进程内|常规模式/);
});

test("reopenDetached surfaces the host's reason (409) and the already-running case", async (t) => {
  const mod = await loadRowMenu(t);
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });

  globalThis.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: "nope", reason: "systemctl unavailable" }) });
  await mod.reopenDetached("abc-123");
  assert.match(String(globalThis.__smToast), /systemctl unavailable/);

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, already: true }) });
  await mod.reopenDetached("abc-123");
  assert.match(String(globalThis.__smToast), /已在运行/);
});

/* ── i18n key coverage (same approach as archive-menu): a missing entry renders the literal key ── */
function localeTables(indexSrc) {
  const lines = indexSrc.split("\n");
  const start = lines.findIndex((l) => /^\s*i18n: \{$/.test(l));
  assert.ok(start >= 0, "index.ts 里找不到 i18n 块");
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

test("row-menu 用到的 i18n key 必须在 en/zh-CN 表里都有词条", () => {
  const used = [...readFileSync(join(srcRoot, "row-menu.tsx"), "utf8").matchAll(/\bt\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length >= 5, `应抓到菜单里的 i18n key，实际 ${used.length} 个`);
  const tables = localeTables(readFileSync(join(here, "..", "..", "index.ts"), "utf8"));
  const full = ["en", "zh-CN"];
  for (const l of full) assert.ok(tables[l]?.size > 200, `locale 表解析异常：${l} → ${tables[l]?.size ?? "无"}`);
  for (const key of new Set(used)) {
    const miss = full.filter((l) => !tables[l].has(key));
    assert.equal(miss.length, 0, `${key} 缺 ${miss.join("/")} 词条（界面会显示字面量 key）`);
  }
});
