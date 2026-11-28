/**
 * aiti-provider-usage 挂载点接线测试（去核化 P3 + 徽标迁移）：
 * entry 注册 sessionStatsInline 额度 chip（order 20）+ sessionInfoPanel 面板；
 * 两个 feature 各自独立开关（关 → 对应挂载点 dispose 后不再注册）；
 * chip 在无数据 / 窄屏时渲染 null，悬停摘要读最后可见快照。
 */
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { runEsbuild } from "@aiti-ai/ext-shared/esbuild-bin";
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

test("entry 注册 sessionInfoPanel + sessionStatsInline quota-chip；feature 各自独立开关", async (t) => {
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

  let registered = [];
  let disposed = [];
  const makeCtx = (features) => ({
    registerItems: (slot, items) => { registered.push({ slot, items }); return () => {}; },
    disposeItems: (slot, ids) => { disposed.push({ slot, ids }); },
    getFeatures: () => features,
    onFeatureChange: () => {},
  });

  const mod = await import(pathToFileURL(outfile).href);
  mod.default(makeCtx({}));
  assert.deepEqual(registered.map((r) => r.slot).sort(), ["sessionInfoPanel", "sessionStatsInline"]);
  assert.equal(registered.find((r) => r.slot === "sessionInfoPanel").items[0].id, "panel");
  const chipItem = registered.find((r) => r.slot === "sessionStatsInline").items[0];
  assert.equal(chipItem.id, "quota-chip");
  // order 20 → after the sysmon chips (order 10) at the stats-row tail
  assert.equal(chipItem.meta.order, 20);
  assert.equal(typeof chipItem.meta.tooltip, "function");

  // Chip output through the slot render path: render → ChipSlot element → StatsChip element.
  const renderChip = (extra) => {
    const slot = chipItem.render(extra);
    const chip = slot.type(slot.props);
    return chip.type(chip.props);
  };
  assert.equal(renderChip({}), null, "no backend usage → no chip");
  assert.equal(renderChip({ backendUsage: { inputTokens: 3 } }), null, "usage without credits/quota → no chip");
  assert.equal(renderChip({ backendUsage: { credits: { remaining: 665 } }, isMobile: true }), null, "mobile → no chip");
  assert.equal(renderChip({ backendUsage: { credits: { remaining: 665 } }, isCompact: true }), null, "compact → no chip");
  const chip = renderChip({ backendUsage: { credits: { remaining: 665, usedPercent: 93, unit: "credits" }, buckets: [{ name: "user_quota", remaining: 0, total: 6000 }] } });
  assert.equal(chip.type, "span");
  assert.equal(chip.props.children, "◈665", "one remaining-capacity value");

  // The hover summary reads the last visible snapshot (host appends it to the stats tooltip).
  const tip = chipItem.meta.tooltip();
  assert.match(tip, /^providerUsage\.chip\.tooltip:/);
  assert.match(tip, /665 credits \(93%\)/);
  assert.match(tip, /user_quota 0\/6000/);

  // Exhausted → ⊘
  const exhausted = renderChip({ backendUsage: { quotaExceeded: true, credits: { remaining: 0 } } });
  assert.equal(exhausted.props.children, "⊘");

  // Panel-only off: chip stays registered, panel slot disposed.
  registered = [];
  disposed = [];
  mod.default(makeCtx({ "providerUsage.enabled": false }));
  assert.deepEqual(registered.map((r) => r.slot), ["sessionStatsInline"]);
  assert.deepEqual(disposed.map((d) => d.slot).sort(), ["sessionInfoPanel", "sessionStatsInline"]);

  // Chip-only off: panel stays registered, chip disposed.
  registered = [];
  disposed = [];
  mod.default(makeCtx({ usageChip: false }));
  assert.deepEqual(registered.map((r) => r.slot), ["sessionInfoPanel"]);
  assert.deepEqual(disposed.map((d) => d.slot).sort(), ["sessionInfoPanel", "sessionStatsInline"]);

  // Both off: nothing registered.
  registered = [];
  mod.default(makeCtx({ "providerUsage.enabled": false, usageChip: false }));
  assert.equal(registered.length, 0);
});
