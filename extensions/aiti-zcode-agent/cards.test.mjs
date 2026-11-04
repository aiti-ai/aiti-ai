/**
 * aiti-zcode-agent client 卡接线测试：entry 注册 sessionRequestCard 的 provider_headers 验证码卡，
 * meta.backend="zcode"（只有 zcode 会话认领）——「agent 扩展自带专属能力 UI」样板（去核化 §3.2）。
 * esbuild 打包 + react/jsx-runtime 桩（cards 测试同范式）。
 */
import { test, after } from "node:test";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { runEsbuild } from "../_shared/esbuild-bin.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("client entry 注册 provider_headers 卡（backend=zcode + priority 压通用兜底）", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const reactStub = join(dir, "react-stub.js");
  writeFileSync(reactStub, [
    "export const Fragment = Symbol.for('react.fragment');",
    "export const createElement = (type, props, ...children) => ({ type, props, children });",
    "export const useState = (v) => [v, () => {}];",
    "export const useEffect = () => {};",
    "export const useCallback = (fn) => fn;",
    "export const useRef = () => ({ current: null });",
  ].join("\n"));
  const jsxStub = join(dir, "jsx-stub.js");
  writeFileSync(jsxStub, [
    "export const Fragment = Symbol.for('react.fragment');",
    "export function jsx(type, props, key) { const p = { ...props }; if (key !== undefined) p.key = key; return { type, props: p }; }",
    "export const jsxs = jsx;",
  ].join("\n"));

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
  const ctx = {
    registerItems: (slot, items) => { registered.push({ slot, items }); return () => {}; },
  };
  const mod = await import(pathToFileURL(outfile).href);
  mod.default(ctx);

  assert.equal(registered.length, 1);
  assert.equal(registered[0].slot, "sessionRequestCard");
  const item = registered[0].items[0];
  assert.equal(item.id, "provider-headers");
  assert.deepEqual(item.meta.kinds, ["provider_headers"]);
  assert.equal(item.meta.backend, "zcode");
  assert.equal(item.meta.priority, 10);
});
