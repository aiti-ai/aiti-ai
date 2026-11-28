/**
 * aiti-zcode-agent client card wiring test: the entry registers the sessionRequestCard
 * provider_headers verification card with meta.backend="zcode" (only zcode sessions claim it)
 * — the "agent extension ships its own capability UI" template (de-nucleation §3.2).
 * esbuild bundling + react/jsx-runtime stubs (same pattern as the cards tests).
 */
import { test, after } from "node:test";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { runEsbuild } from "@aiti-ai/ext-shared/esbuild-bin";
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
  // derived variants (Linux native ELF / Windows official .exe, or running the JS entry with node) are handled by esbuild-bin
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
