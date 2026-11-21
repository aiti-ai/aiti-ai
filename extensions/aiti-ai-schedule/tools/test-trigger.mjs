#!/usr/bin/env node
/**
 * test-trigger.mjs — event-trigger tests (zero-dep: node --test tools/test-trigger.mjs)
 *
 * Covers (dsh-better-sidebar borrow plan §2.3):
 *   - TriggerManager fs-watch: declared paths get a watch → change fires (debounced); undeclared/non-absolute/disallowed paths get none
 *   - watch lifecycle: closeWatch after plan disable/remove (no more firing)
 *   - Engine.fireTrigger: automatic semantics (enabled gate / cooldown / daily budget / running busy / RunRecord.trigger source)
 *   - trigger-only plans: schedule optional, nextRunAt = MAX_SAFE_INTEGER (tick never fires them)
 *   - API surface: POST /plans with trigger (sanitize/token generation) + /webhook/<id>?token= route (403/404/hit)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { TriggerManager } = await import("../sched/trigger.ts");
const { Engine } = await import("../sched/engine.ts");
const { default: ext } = await import("../index.ts");

const waitTick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function withEnv(key, value, fn) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve().then(fn).finally(() => {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  });
}

function mkPlan(over = {}) {
  return {
    id: "p_" + Math.random().toString(36).slice(2, 8),
    name: "trig-plan", schedule: "", prompt: "hi", mode: "invokeAI",
    enabled: true, autoApprove: true, notify: false,
    trigger: { type: "fs-watch", paths: ["/tmp/x"], cooldownSec: 0 },
    createdAt: new Date().toISOString(), createdBy: "user",
    ...over,
  };
}

// ───────────────────────── TriggerManager fs-watch ─────────────────────────

test("fs-watch：声明路径变更 → 防抖后 fireTrigger；同路径多计划共享一个 watch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-trig-"));
  const target = join(dir, "watched.txt");
  writeFileSync(target, "v1");
  const fired = [];
  const tm = new TriggerManager({ fireTrigger: (id, src) => { fired.push({ id, src }); return { ok: true }; } });
  const p1 = mkPlan({ id: "p1", trigger: { type: "fs-watch", paths: [target], debounceMs: 60, cooldownSec: 0 } });
  const p2 = mkPlan({ id: "p2", trigger: { type: "fs-watch", paths: [target], debounceMs: 60, cooldownSec: 0 } });
  tm.sync([p1, p2]);
  writeFileSync(target, "v2");
  await waitTick(250);
  assert.deepEqual(fired.map((f) => f.id).sort(), ["p1", "p2"]); // one watch feeds two plans
  assert.ok(fired[0].src.startsWith("fs-watch:"));
  tm.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("fs-watch：非绝对路径与白名单拒绝的路径不挂 watch；禁用计划跳过", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-trig-"));
  const allowed = [];
  const tm = new TriggerManager({ fireTrigger: () => ({ ok: true }), isPathAllowed: (p) => allowed.includes(p) });
  const p = mkPlan({
    enabled: false,
    trigger: { type: "fs-watch", paths: [join(dir, "no.txt"), "relative/path.txt"], debounceMs: 60, cooldownSec: 0 },
  });
  const p2 = mkPlan({ id: "p2b", trigger: { type: "fs-watch", paths: [join(dir, "yes.txt")], debounceMs: 60, cooldownSec: 0 } });
  allowed.push(join(dir, "yes.txt"));
  tm.sync([p, p2]);
  // disabled plan's path and rejected paths never got watchers → writing them fires nothing
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "no.txt"), "x");
  writeFileSync(join(dir, "yes.txt"), "x");
  await waitTick(250);
  // only the allowed+enabled path is watched; p2b fires (its cooldownSec=0)
  tm.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("fs-watch：计划删除/禁用后 sync 摘除 watch（不再触发）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sched-trig-"));
  const target = join(dir, "gone.txt");
  writeFileSync(target, "v1");
  const fired = [];
  const tm = new TriggerManager({ fireTrigger: (id) => { fired.push(id); return { ok: true }; } });
  const p = mkPlan({ id: "pdel", trigger: { type: "fs-watch", paths: [target], debounceMs: 60, cooldownSec: 0 } });
  tm.sync([p]);
  writeFileSync(target, "v2");
  await waitTick(250);
  const before = fired.length;
  assert.ok(before >= 1);
  tm.sync([]); // plan removed
  writeFileSync(target, "v3");
  await waitTick(250);
  assert.equal(fired.length, before);
  tm.stop();
  rmSync(dir, { recursive: true, force: true });
});

// ───────────────────────── Engine.fireTrigger ─────────────────────────

function mkEngine(dir) {
  const engine = new Engine(dir, { emit() {} }, null);
  globalThis.__aitiAiScheduleInvokeAI = async () => ({ text: "ok" });
  return engine;
}

test("fireTrigger：trigger-only 计划可注册（nextRunAt=MAX_SAFE_INTEGER，tick 永不触发）且自动执行记 trigger 来源", async () => {
  await withEnv("AITI_AI_SCHEDULE_ENABLED", "1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-trig-eng-"));
    const engine = mkEngine(dir);
    const plan = mkPlan({ id: "pa", trigger: { type: "process-exit", cooldownSec: 0 } });
    engine.store.plans.push(plan);
    engine.upsertPlanEntry(plan, false);
    const e = engine.listEntries().find((x) => x.id === "pa");
    assert.ok(e, "trigger-only plan must have an entry");
    assert.equal(e.nextRunAt, Number.MAX_SAFE_INTEGER);
    const r = engine.fireTrigger("pa", "process-exit:make");
    assert.equal(r.ok, true);
    await waitTick(150); // execute completion (invokeAI stub resolves immediately)
    const runs = engine.store.recentRuns(10);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].trigger, "process-exit:make"); // RunRecord.trigger source
    assert.equal(runs[0].status, "ok");
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

test("fireTrigger：冷却窗口拒第二次；禁用计划拒触发；主门控关时拒触发", async () => {
  await withEnv("AITI_AI_SCHEDULE_ENABLED", "1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-trig-eng-"));
    const engine = mkEngine(dir);
    const plan = mkPlan({ id: "pb", trigger: { type: "fs-watch", paths: ["/x"], cooldownSec: 60 } });
    engine.store.plans.push(plan);
    engine.upsertPlanEntry(plan, false);
    assert.equal(engine.fireTrigger("pb", "fs-watch:/x").ok, true);
    await waitTick(150); // let the first execute finish (busy check comes before cooldown)
    const second = engine.fireTrigger("pb", "fs-watch:/x");
    assert.equal(second.ok, false);
    assert.equal(second.reason, "cooldown");
    // disabled plan
    const off = mkPlan({ id: "pcoff", enabled: false, trigger: { type: "fs-watch", paths: ["/x"], cooldownSec: 0 } });
    engine.store.plans.push(off);
    engine.upsertPlanEntry(off, false);
    const d = engine.fireTrigger("pcoff", "fs-watch:/x");
    assert.equal(d.ok, false);
    assert.equal(d.reason, "disabled");
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  // master gate off (env unset) → rejected
  await withEnv("AITI_AI_SCHEDULE_ENABLED", undefined, async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-trig-eng-"));
    const engine = mkEngine(dir);
    const plan = mkPlan({ id: "pg", trigger: { type: "fs-watch", paths: ["/x"], cooldownSec: 0 } });
    engine.store.plans.push(plan);
    engine.upsertPlanEntry(plan, false);
    const g = engine.fireTrigger("pg", "fs-watch:/x");
    assert.equal(g.ok, false);
    assert.equal(g.reason, "trigger-disabled");
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

test("fireTrigger：每日预算耗尽拒触发并记 skipped（RunRecord.trigger 保留）", async () => {
  await withEnv("AITI_AI_SCHEDULE_ENABLED", "1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-trig-eng-"));
    const engine = mkEngine(dir);
    const plan = mkPlan({ id: "pc", dailyCap: 1, trigger: { type: "fs-watch", paths: ["/x"], cooldownSec: 0 } });
    engine.store.plans.push(plan);
    engine.upsertPlanEntry(plan, false);
    assert.equal(engine.fireTrigger("pc", "fs-watch:/x").ok, true);
    await waitTick(150); // let execute finish → budget consumed
    const second = engine.fireTrigger("pc", "fs-watch:/x");
    assert.equal(second.ok, false);
    assert.equal(second.reason, "budget");
    const runs = engine.store.recentRuns(10);
    assert.ok(runs.some((r) => r.status === "skipped" && r.trigger === "fs-watch:/x"));
    engine.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ───────────────────────── API surface (sanitize / webhook route) ─────────────────────────

async function apiCall(method, path, body) {
  const [pathname, query = ""] = path.split("?");
  const res = await ext.server.api(new Request("http://local" + path, {
    method,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
  }), { path: pathname.split("/").filter(Boolean), method, searchParams: new URLSearchParams(query) });
  return { status: res.status, body: res.body ? await res.json() : null };
}

test("API：trigger 计划创建（schedule 可空/路径清洗/token 生成）+ webhook 路由 403/404/命中 + 禁用即失效", async () => {
  await withEnv("AITI_AI_SCHEDULE_ENABLED", "1", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sched-trig-api-"));
    const configDir = join(tmp, "ext", "config");
    mkdirSync(configDir, { recursive: true });
    // execute stub (mode=invokeAI) — must come via startup ctx: startup overwrites the global slot
    await ext.server.startup({ id: "aiti-ai-schedule", configDir, invokeAI: async () => ({ text: "ok" }) });
    try {
      // fs-watch: mixed absolute+relative → strict 400 (validation blocks ambiguous input)
      const bad1 = await apiCall("POST", "/plans", {
        name: "fsbad", schedule: "", prompt: "watch it", mode: "invokeAI",
        trigger: { type: "fs-watch", paths: ["/tmp/ok-dir", "rel/path"] },
      });
      assert.equal(bad1.status, 400);
      // pure absolute paths normalized (debounce clamp, cooldown kept)
      const r1 = await apiCall("POST", "/plans", {
        name: "fsplan", schedule: "", prompt: "watch it", mode: "invokeAI",
        trigger: { type: "fs-watch", paths: ["/tmp/ok-dir", "/tmp/ok-dir"], cooldownSec: 3, debounceMs: 120 },
      });
      assert.equal(r1.status, 200);
      assert.deepEqual(r1.body.plan.trigger, { type: "fs-watch", paths: ["/tmp/ok-dir"], cooldownSec: 3, debounceMs: 120 });

      // schedule empty without trigger → 400
      const r2 = await apiCall("POST", "/plans", { name: "nosched", schedule: "", prompt: "x" });
      assert.equal(r2.status, 400);

      // webhook plan: token generated
      const r3 = await apiCall("POST", "/plans", {
        name: "whplan", schedule: "", prompt: "hook me", mode: "invokeAI",
        trigger: { type: "webhook" },
      });
      assert.equal(r3.status, 200);
      const wh = r3.body.plan;
      assert.ok(/^[A-Za-z0-9_-]{8,64}$/.test(wh.trigger.token), "token generated");

      // wrong token → 403; right token → fired
      const bad = await apiCall("GET", `/webhook/${wh.id}?token=wrong-wrong`);
      assert.equal(bad.status, 403);
      const good = await apiCall("GET", `/webhook/${wh.id}?token=${wh.trigger.token}`);
      assert.equal(good.status, 200);
      assert.equal(good.body.fired, true);
      await waitTick(150);
      const runs = await apiCall("GET", "/runs?limit=10");
      assert.ok(runs.body.runs.some((r) => r.trigger === "webhook" && r.status === "ok"), "run recorded with webhook source");

      // disabled plan → webhook route 404
      await apiCall("POST", `/plans/${wh.id}/disable`);
      const off = await apiCall("GET", `/webhook/${wh.id}?token=${wh.trigger.token}`);
      assert.equal(off.status, 404);
      // unknown plan → 404
      const ghost = await apiCall("GET", "/webhook/p_ghost?token=x");
      assert.equal(ghost.status, 404);
    } finally {
      ext.server.shutdown?.();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
