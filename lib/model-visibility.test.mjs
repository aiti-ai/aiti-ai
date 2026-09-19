// model-visibility pure-logic unit tests: temporary-disable filtering + availability annotation (provider-wide rate limiting)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDisabledModels, annotateVisibleModels, parseModelCheckState } from "./model-visibility.ts";

const visible = [
  { id: "ma", name: "模型A", provider: "pa" },
  { id: "mb", name: "模型B", provider: "pa" },
  { id: "mc", name: "模型C", provider: "pb" },
];

test("parseDisabledModels: provider-level + model-level disabled markers", () => {
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

test("annotateVisibleModels: filters disabled providers and disabled models", () => {
  const cfg = { pa: { enabled: false, models: [] }, pb: { models: [{ id: "mc" }] } };
  const out = annotateVisibleModels(visible, cfg, new Map());
  assert.deepEqual(out.map((m) => m.id), ["mc"]);
});

test("annotateVisibleModels: model-level disable filtering (only that model)", () => {
  const cfg = { pa: { models: [{ id: "ma" }, { id: "mb", enabled: false }] }, pb: { models: [] } };
  const out = annotateVisibleModels(visible, cfg, new Map());
  assert.deepEqual(out.map((m) => m.id), ["ma", "mc"]);
});

test("annotateVisibleModels: avail annotation (ok/rl/err/unprobed)", () => {
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

test("annotateVisibleModels: provider-wide rate-limit flag (all enabled models rl)", () => {
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
    ["pb/md", "ok"], // pb has an ok model → not provider-wide limiting
  ]);
  const out = annotateVisibleModels(visible2, { pa: { models: [] }, pb: { models: [] } }, avail);
  const pa = out.filter((m) => m.provider === "pa");
  const pb = out.filter((m) => m.provider === "pb");
  assert.ok(pa.every((m) => m.providerRL === true), "all pa models rl → provider-wide limiting");
  assert.ok(pb.every((m) => m.providerRL === undefined), "pb has an ok model → not provider-wide limiting");
});

test("annotateVisibleModels: no avail data (empty Map) → no annotation", () => {
  const out = annotateVisibleModels(visible, { pa: { models: [] }, pb: { models: [] } }, new Map());
  assert.ok(out.every((m) => m.avail === undefined && m.providerRL === undefined));
});

test("annotateVisibleModels: disabled models excluded from provider-wide rate-limit stats", () => {
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
  assert.ok(out.every((m) => m.providerRL === true), "enabled models all rl → provider-wide limiting");
});

test("parseModelCheckState: state.json → availability Map (unprobed/ok/rl/err states + corrupt-data tolerance)", () => {
  const out = parseModelCheckState({
    updatedAt: 1,
    models: {
      "pa/ma": { lastProbedAt: 1, lastOk: true, rateLimited: false },
      "pa/mb": { lastProbedAt: 2, lastOk: false, rateLimited: true },
      "pa/mc": { lastProbedAt: 3, lastOk: false, rateLimited: false },
      "pa/md": { /* never probed */ },
      "pa/me": null, // corrupt entry → skipped
      "pa/mf": { lastProbedAt: 4 }, // missing lastOk → treated as error
    },
  });
  assert.deepEqual([...out], [
    ["pa/ma", "ok"],
    ["pa/mb", "rl"],
    ["pa/mc", "err"],
    ["pa/md", "unprobed"],
    ["pa/mf", "err"],
  ]);
  // empty/corrupt input → empty Map (silent degradation, never throws)
  assert.equal(parseModelCheckState(null).size, 0);
  assert.equal(parseModelCheckState({}).size, 0);
  assert.equal(parseModelCheckState({ models: "nope" }).size, 0);
});
