// model-visibility 纯逻辑单元测试：临时禁用过滤 + 可用性标注（provider 整体限流）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDisabledModels, annotateVisibleModels } from "./model-visibility.ts";

const visible = [
  { id: "ma", name: "模型A", provider: "pa" },
  { id: "mb", name: "模型B", provider: "pa" },
  { id: "mc", name: "模型C", provider: "pb" },
];

test("parseDisabledModels：provider 级 + 模型级禁用标记", () => {
  const cfg = {
    pa: { enabled: false, models: [{ id: "ma" }, { id: "mb", enabled: false }] },
    pb: { models: [{ id: "mc" }] },
  };
  const { disabledProviders, disabledModelIds } = parseDisabledModels(cfg);
  assert.ok(disabledProviders.has("pa"));
  assert.equal(disabledProviders.has("pb"), false);
  assert.deepEqual([...(disabledModelIds.get("pa") || [])], ["mb"]);
  assert.equal(disabledModelIds.has("pb"), false);
});

test("annotateVisibleModels：过滤禁用 provider 与禁用模型", () => {
  const cfg = { pa: { enabled: false, models: [] }, pb: { models: [{ id: "mc" }] } };
  const out = annotateVisibleModels(visible, cfg, new Map());
  assert.deepEqual(out.map((m) => m.id), ["mc"]);
});

test("annotateVisibleModels：模型级禁用过滤（只滤该模型）", () => {
  const cfg = { pa: { models: [{ id: "ma" }, { id: "mb", enabled: false }] }, pb: { models: [] } };
  const out = annotateVisibleModels(visible, cfg, new Map());
  assert.deepEqual(out.map((m) => m.id), ["ma", "mc"]);
});

test("annotateVisibleModels：avail 标注（ok/rl/err/unprobed）", () => {
  const avail = new Map([
    ["pa/ma", "ok"],
    ["pa/mb", "rl"],
    ["pb/mc", "err"],
  ]);
  const out = annotateVisibleModels(visible, { pa: { models: [] }, pb: { models: [] } }, avail);
  const byId = Object.fromEntries(out.map((m) => [m.id, m]));
  assert.equal(byId.ma.avail, "ok");
  assert.equal(byId.mb.avail, "rl");
  assert.equal(byId.mc.avail, "err");
  assert.equal(byId.ma.providerRL, undefined);
});

test("annotateVisibleModels：provider 整体限流标记（全部启用模型都 rl）", () => {
  const visible2 = [
    { id: "ma", name: "A", provider: "pa" },
    { id: "mb", name: "B", provider: "pa" },
    { id: "mc", name: "C", provider: "pb" },
    { id: "md", name: "D", provider: "pb" },
  ];
  const avail = new Map([
    ["pa/ma", "rl"],
    ["pa/mb", "rl"],
    ["pb/mc", "rl"],
    ["pb/md", "ok"], // pb 有 ok 模型 → 非整体限流
  ]);
  const out = annotateVisibleModels(visible2, { pa: { models: [] }, pb: { models: [] } }, avail);
  const pa = out.filter((m) => m.provider === "pa");
  const pb = out.filter((m) => m.provider === "pb");
  assert.ok(pa.every((m) => m.providerRL === true), "pa 全 rl → 整体限流");
  assert.ok(pb.every((m) => m.providerRL === undefined), "pb 有 ok 模型 → 非整体限流");
});

test("annotateVisibleModels：无 avail 数据（空 Map）→ 无标注", () => {
  const out = annotateVisibleModels(visible, { pa: { models: [] }, pb: { models: [] } }, new Map());
  assert.ok(out.every((m) => m.avail === undefined && m.providerRL === undefined));
});

test("annotateVisibleModels：禁用模型不计入 provider 整体限流统计", () => {
  const avail = new Map([
    ["pa/mb", "rl"],
    ["pa/mc", "rl"],
  ]);
  const visiblePa = [
    { id: "ma", name: "a", provider: "pa" },
    { id: "mb", name: "b", provider: "pa" },
    { id: "mc", name: "c", provider: "pa" },
  ];
  const cfg = { pa: { models: [{ id: "ma", enabled: false }, { id: "mb" }, { id: "mc" }] } };
  const out = annotateVisibleModels(visiblePa, cfg, avail);
  assert.deepEqual(out.map((m) => m.id), ["mb", "mc"]);
  assert.ok(out.every((m) => m.providerRL === true), "启用模型全 rl → 整体限流");
});
