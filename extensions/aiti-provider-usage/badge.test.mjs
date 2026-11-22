/**
 * aiti-provider-usage chatOverlay 徽标接线测试（P3 去核化）：entry 在 sessionInfoPanel 之外
 * 额外注册 chatOverlay usage-badge item；feature 关停时两处一并 dispose。
 */
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { runEsbuild } from "../_shared/esbuild-bin.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function writeStubs(dir) {
  const reactStub = join(dir, "react-stub.js");
  writeFileSync(reactStub, [
    "export const Fragment = Symbol.for('react.fragment');",
    "export const createElement = (type, props, ...children) => ({ type, props, children });",
    "export const useState = (v) => [v, () => {}];",
    "export const useEffect = () => {};",
    "export const useCallback = (fn) => fn;",
    "export const useMemo = (fn) => fn();",
    "export const useRef = () => ({ current: null });",
    "export const useContext = () => null;",
  ].join("\n"));
  const jsxStub = join(dir, "jsx-stub.js");
  writeFileSync(jsxStub, [
    "export const Fragment = Symbol.for('react.fragment');",
    "export function jsx(type, props, key) { const p = { ...props }; if (key !== undefined) p.key = key; return { type, props: p }; }",
    "export const jsxs = jsx;",
  ].join("\n"));
  return { reactStub, jsxStub };
}

test("entry 注册 sessionInfoPanel + chatOverlay usage-badge；关停时一并 dispose", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pu-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { reactStub, jsxStub } = writeStubs(dir);

  const outfile = join(dir, "bundle.mjs");
  // 派生形态（Linux 原生 ELF / Windows 官方 .exe，或 node 直跑 JS 入口）由 esbuild-bin 收口
  await runEsbuild(
    join(here, "..", "aiti-float", "node_modules", "esbuild", "bin", "esbuild"),
    [
      join(here, "client", "src", "entry.tsx"), "--bundle", "--format=esm", "--platform=node",
      "--jsx=automatic", "--alias:react=" + reactStub, "--alias:react/jsx-runtime=" + jsxStub,
      "--outfile=" + outfile, "--log-level=error"],
  );

  const registered = [];
  const disposed = [];
  const makeCtx = (features) => ({
    registerItems: (slot, items) => { registered.push({ slot, items }); return () => {}; },
    disposeItems: (slot, ids) => { disposed.push({ slot, ids }); },
    getFeatures: () => features,
    onFeatureChange: () => {},
  });

  const mod = await import(pathToFileURL(outfile).href);
  mod.default(makeCtx({}));
  const slots = registered.map((r) => r.slot).sort();
  assert.deepEqual(slots, ["chatOverlay", "sessionInfoPanel"]);
  const overlay = registered.find((r) => r.slot === "chatOverlay");
  assert.equal(overlay.items[0].id, "usage-badge");

  registered.length = 0;
  disposed.length = 0;
  mod.default(makeCtx({ "providerUsage.enabled": false }));
  const disposedSlots = disposed.map((d) => d.slot).sort();
  assert.deepEqual(disposedSlots, ["chatOverlay", "sessionInfoPanel"]);
  assert.equal(registered.length, 0);
});
