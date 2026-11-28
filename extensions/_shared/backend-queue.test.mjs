/**
 * backend-queue shared-layer tests (docs/backend-queue-manager-plan.md §5-1).
 * Routing / CRUD / steer degradation / image preservation / follow-up-turn idempotence / dispose.
 */
import assert from "node:assert/strict";
import test from "node:test";

const modPath = new URL("./backend-queue.ts", import.meta.url).pathname;
const { createBackendQueueSupport } = await import(modPath);

/** Test rig: programmable running state + event/dispatch recording. */
function rig({ steer } = {}) {
  const events = [];
  const dispatched = [];
  let running = false;
  let alive = true;
  const steerCalls = [];
  const q = createBackendQueueSupport({
    isRunning: () => running,
    alive: () => alive,
    dispatch: (text, images) => { dispatched.push({ text, images }); },
    ...(steer ? { steer: (text, images) => { steerCalls.push({ text, images }); if (steer.reject) return Promise.reject(new Error(steer.rejectMsg || "steer down")); } } : {}),
    onEvent: (ev) => events.push(ev),
  });
  const setRunning = (v) => { running = v; };
  return { q, events, dispatched, steerCalls, setRunning, kill: () => { alive = false; } };
}

test("running + followUp behavior → local queue (queued) + queue_update broadcast", async () => {
  const t = rig();
  t.setRunning(true);
  const action = await t.q.routePrompt("hi", { streamingBehavior: "followUp" });
  assert.equal(action, "queued");
  assert.deepEqual(t.q.snapshot().followUp, ["hi"]);
  const last = t.events.at(-1);
  assert.equal(last.type, "queue_update");
  assert.deepEqual(last.followUp, ["hi"]);
  assert.deepEqual(t.dispatched, []);
});

test("running + steer available → steered; once the mirror is fed via registerSteer it appears in the steering group", async () => {
  const t = rig({ steer: {} });
  t.setRunning(true);
  const action = await t.q.routePrompt("inject");
  assert.equal(action, "steered");
  assert.deepEqual(t.q.snapshot().steering, []);
  t.q.registerSteer("pid-1", "inject");
  assert.deepEqual(t.q.snapshot().steering, ["inject"]);
  t.q.drainSteer(["pid-1"]);
  assert.deepEqual(t.q.snapshot().steering, []);
});

test("running + no steer capability → auto-degraded to local queue (plan §1.3 degradation semantics)", async () => {
  const t = rig();
  t.setRunning(true);
  const action = await t.q.routePrompt("no-steer-backend");
  assert.equal(action, "queued");
  assert.deepEqual(t.q.snapshot().followUp, ["no-steer-backend"]);
});

test("running + steer reject → degraded into the local queue (R9 generalization: message not lost)", async () => {
  const t = rig({ steer: { reject: true } });
  t.setRunning(true);
  const action = await t.q.routePrompt("will-fail");
  assert.equal(action, "queued");
  assert.deepEqual(t.q.snapshot().followUp, ["will-fail"]);
  assert.deepEqual(t.q.snapshot().steering, []);
});

test("idle routePrompt → dispatch (with images) and returns dispatched", async () => {
  const t = rig();
  const imgs = [{ data: "AAA", mimeType: "image/png" }];
  const action = await t.q.routePrompt("go", { images: imgs });
  assert.equal(action, "dispatched");
  assert.deepEqual(t.dispatched, [{ text: "go", images: imgs }]);
});

test("queueManage CRUD: move/remove/recall/requeue/clear + index out of range", async () => {
  const t = rig();
  t.setRunning(true);
  await t.q.routePrompt("a", { streamingBehavior: "followUp" });
  await t.q.routePrompt("b", { streamingBehavior: "followUp" });
  await t.q.routePrompt("c", { streamingBehavior: "followUp" });
  // move
  await t.q.queueManage({ action: "move", from: 0, to: 2 });
  assert.deepEqual(t.q.snapshot().followUp, ["b", "c", "a"]);
  // remove → entry + removed (QueueTrashItem shape)
  const rm = await t.q.queueManage({ action: "remove", index: 1 });
  assert.equal(rm.entry.text, "c");
  assert.equal(rm.removed.kind, "followUp");
  assert.equal(rm.removed.hasImages, false);
  assert.deepEqual(rm.followUp, ["b", "a"]);
  // requeue (retrieval and restoration)
  await t.q.queueManage({ action: "requeue", index: 1, text: "c" });
  assert.deepEqual(t.q.snapshot().followUp, ["b", "c", "a"]);
  // steer-group ops → human-readable error (the protocol has no recall entry)
  await assert.rejects(() => t.q.queueManage({ action: "remove", kind: "steer", index: 0 }), /does not support recall/);
  // out of range
  await assert.rejects(() => t.q.queueManage({ action: "remove", index: 99 }), /out of range/);
  // clear: the return must carry the "pre-clear" texts (pi clearQueue contract — the frontend's "edit all" backfills the input box)
  const cl = await t.q.queueManage({ action: "clear" });
  assert.deepEqual(t.q.snapshot().followUp, []);
  assert.deepEqual(cl.followUp, ["b", "c", "a"]);
});

test("R4 closure: followUp queued with images → follow-up dispatch re-attaches them; remove returns hasImages", async () => {
  const t = rig();
  t.setRunning(true);
  const imgs = [{ data: "BBB", mimeType: "image/jpeg", filename: "x.jpg" }];
  await t.q.routePrompt("look at the pic", { images: imgs, streamingBehavior: "followUp" });
  const rm = await t.q.queueManage({ action: "remove", index: 0 });
  assert.equal(rm.removed.hasImages, true);
  assert.deepEqual(rm.entry.images, imgs);
  // re-enqueue → follow-up dispatch after settle carries the images
  t.q.enqueueFollowUp("look at the pic", imgs);
  assert.deepEqual(t.events.at(-1).followUp, ["look at the pic"]); // the wire carries text only
  t.setRunning(false);
  t.q.scheduleDrain();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.dispatched, [{ text: "look at the pic", images: imgs }]);
});

test("scheduleDrain idempotent: no-op while running; microtask follow-up; empty queue only broadcasts", async () => {
  const t = rig();
  t.setRunning(true);
  t.q.enqueueFollowUp("n1");
  t.setRunning(true);
  t.q.scheduleDrain(); // running → no-op
  assert.deepEqual(t.dispatched, []);
  t.setRunning(false);
  t.q.scheduleDrain();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.dispatched, [{ text: "n1", images: undefined }]);
  t.q.scheduleDrain(); // queue empty → only broadcast, no dispatch
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.dispatched.length, 1);
  const last = t.events.at(-1);
  assert.equal(last.type, "queue_update");
  assert.deepEqual(last.followUp, []);
});

test("convert followUp → steer: injected while running (reject falls back to the queue); dispatched when idle", async () => {
  const t1 = rig({ steer: {} });
  t1.setRunning(true);
  await t1.q.routePrompt("x", { streamingBehavior: "followUp" });
  await t1.q.queueManage({ action: "convert", index: 0, targetKind: "steer" });
  assert.equal(t1.steerCalls.length, 1);
  assert.deepEqual(t1.q.snapshot().followUp, []);

  const t2 = rig({ steer: { reject: true } });
  t2.setRunning(true);
  await t2.q.routePrompt("y", { streamingBehavior: "followUp" });
  await t2.q.queueManage({ action: "convert", index: 0, targetKind: "steer" });
  assert.deepEqual(t2.q.snapshot().followUp, ["y"], "steer failure degrades back into the queue");

  const t3 = rig({ steer: {} });
  t3.setRunning(true);
  await t3.q.routePrompt("z", { streamingBehavior: "followUp" });
  t3.setRunning(false);
  await t3.q.queueManage({ action: "convert", index: 0, targetKind: "steer" });
  assert.deepEqual(t3.dispatched, [{ text: "z", images: undefined }], "idle convert = start a new turn");

  // no native steer (codex / zcode 3.11.2 degraded form): jump the queue = move to the queue head (follow-up sent first after settle), no immediate dispatch
  const t4 = rig();
  t4.setRunning(true);
  await t4.q.routePrompt("a", { streamingBehavior: "followUp" });
  await t4.q.routePrompt("b", { streamingBehavior: "followUp" });
  await t4.q.queueManage({ action: "convert", index: 1, targetKind: "steer" });
  assert.deepEqual(t4.q.snapshot().followUp, ["b", "a"], "no steer: jump the queue = move to the queue head");
  assert.deepEqual(t4.dispatched, [], "convert while running does not dispatch immediately");
});

test("dispose: clears the queue + pending follow-up no longer dispatches", async () => {
  const t = rig();
  t.setRunning(true);
  t.q.enqueueFollowUp("late");
  t.setRunning(false);
  t.kill();
  t.q.scheduleDrain(); // alive=false → does not start
  t.q.dispose();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.q.snapshot(), { steering: [], followUp: [] });
  assert.deepEqual(t.dispatched, []);
});

test("userBubble: message_end role=user blocks content (adapter string defense compatible)", () => {
  const t = rig();
  t.q.userBubble("queued text");
  const ev = t.events.at(-1);
  assert.equal(ev.type, "message_end");
  assert.equal(ev.message.role, "user");
  assert.deepEqual(ev.message.content, [{ type: "text", text: "queued text" }]);
});

test("rev monotonic version: queue_update and queueManage results increment on the same axis; snapshot reads do not increment", async () => {
  const t = rig({ steer: {} });
  t.setRunning(true);
  // three content changes: enqueue → registerSteer → drainSteer; with one idempotent register in between (no broadcast)
  await t.q.routePrompt("r1", { streamingBehavior: "followUp" });
  t.q.registerSteer("pid-1", "r2");
  const countAfterRegister = t.events.filter((e) => e.type === "queue_update").length;
  t.q.registerSteer("pid-1", "r2");
  assert.equal(
    t.events.filter((e) => e.type === "queue_update").length,
    countAfterRegister,
    "duplicate registerSteer with the same id is idempotent: no broadcast, no increment",
  );
  t.q.drainSteer(["pid-1"]);
  const evs = t.events.filter((e) => e.type === "queue_update");
  assert.equal(evs.length, 3, "exactly three broadcast frames");
  const revs = evs.map((e) => e.rev);
  assert.ok(revs.every((r) => typeof r === "number" && r > 0), "all carry a positive rev");
  assert.ok(revs.every((r, i) => i === 0 || r > revs[i - 1]), "rev strictly monotonically increasing");
  // the list snapshot carries the current rev; consecutive reads leave it alone (snapshot is not a mutation)
  const l1 = await t.q.queueManage({ action: "list" });
  assert.equal(l1.rev, revs.at(-1), "list matches the most recent event's version");
  const l2 = await t.q.queueManage({ action: "list" });
  assert.equal(l2.rev, l1.rev, "snapshot reads do not increment");
  // mutating actions: result rev = the post-change version (same value as the accompanying queue_update)
  const mv = await t.q.queueManage({ action: "move", from: 0, to: 0 });
  assert.ok(mv.rev > l1.rev, "mutation increments");
  const evAfter = t.events.filter((e) => e.type === "queue_update").at(-1);
  assert.equal(evAfter.rev, mv.rev, "the RPC result and the accompanying event share the same rev");
});

// ---- sidecar persistence (docs/aiti-remote-queue-and-sidecar-plan.md §3) ----
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { createQueueFilePersistence } = await import(modPath);

function persistedRig(file) {
  const persistence = createQueueFilePersistence(() => file, (m) => logs.push(m));
  const logs = [];
  const t = rig();
  // injecting persistence into the rig's q is awkward (the rig builds its own support) — just rebuild a rig with persistence
  const events = [];
  const dispatched = [];
  let running = false;
  const q2 = createBackendQueueSupport({
    isRunning: () => running,
    dispatch: (text) => { dispatched.push(text); },
    onEvent: (ev) => events.push(ev),
    persistence,
    log: (m) => logs.push(m),
  });
  return { q: q2, events, dispatched, setRunning: (v) => { running = v; }, logs, persistence };
}

test("sidecar: enqueue persists → a new support lazily recovers (triggered by list) → clear/remove closes out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bq-sidecar-"));
  const file = join(dir, "sess-a.json");

  // segment 1: enqueue two → file persisted
  const t1 = persistedRig(file);
  t1.setRunning(true);
  await t1.q.routePrompt("m1", { streamingBehavior: "followUp" });
  await t1.q.routePrompt("m2", { streamingBehavior: "followUp" });
  assert.ok(existsSync(file), "the sidecar should exist after enqueue");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.entries.map((e) => e.text), ["m1", "m2"]);

  // segment 2: simulate restart — new support, same file → list triggers lazy recovery
  const t2 = persistedRig(file);
  assert.deepEqual((await t2.q.queueManage({ action: "list" })).followUp, ["m1", "m2"], "list should trigger recovery");
  // after recovery, clear returns the pre-clear texts + the sidecar is emptied to disk
  const cleared = await t2.q.queueManage({ action: "clear" });
  assert.deepEqual(cleared.followUp, ["m1", "m2"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).entries, []);

  // dispose → sidecar file deleted (session closed normally)
  t2.q.dispose();
  assert.ok(!existsSync(file), "dispose should delete the sidecar");
});

test("sidecar: recovered entries auto-dispatch after settle; no file = no recovery, no error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bq-sidecar-"));
  const file = join(dir, "sess-b.json");
  writeFileSync(file, JSON.stringify({ version: 1, entries: [{ text: "old", queuedAt: 1 }] }));

  const t = persistedRig(file);
  t.setRunning(false);
  t.q.scheduleDrain(); // triggers lazy recovery + immediate follow-up
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(t.dispatched, ["old"], "recovered entries should be dispatched in the follow-up");
  assert.deepEqual((await t.q.queueManage({ action: "list" })).followUp, []);

  const t3 = persistedRig(join(dir, "not-exist.json"));
  assert.deepEqual((await t3.q.queueManage({ action: "list" })).followUp, []);
});

test("sidecar: >7-day stale files are cleaned up opportunistically on save", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bq-sidecar-"));
  const stale = join(dir, "stale-sess.json");
  writeFileSync(stale, JSON.stringify({ version: 1, entries: [] }));
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  const file = join(dir, "fresh.json");
  const t = persistedRig(file);
  t.setRunning(true);
  await t.q.routePrompt("x", { streamingBehavior: "followUp" });
  assert.ok(!existsSync(stale), "the expired sidecar should be cleaned up");
  assert.ok(existsSync(file));
});

// ---- id rebinding migration (placeholder id → real id; audit §4.3 claude-code orphan fix) ----
const { migrateQueueSidecar, sidecarFileName } = await import(modPath);

test("migrateQueueSidecar: content restorable as-is after rebinding migration; existing target overwritten; missing source/same id/no dir are no-ops", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bq-migrate-"));
  const from = join(dir, "queues", sidecarFileName("claude:new-1"));
  mkdirSync(join(dir, "queues"), { recursive: true });
  writeFileSync(from, JSON.stringify({ version: 1, entries: [{ text: "early", queuedAt: 1 }] }));

  const logs = [];
  migrateQueueSidecar(dir, "claude:new-1", "claude:sess_real", (m) => logs.push(m));
  const to = join(dir, "queues", sidecarFileName("claude:sess_real"));
  assert.ok(!existsSync(from), "the old id file should disappear");
  assert.ok(existsSync(to), "the new id file should be in place");
  // the migration product can be restored as-is by the persistence layer (version/entries untouched)
  const restored = createQueueFilePersistence(() => to).load();
  assert.deepEqual(restored.map((e) => e.text), ["early"]);
  assert.ok(logs.some((m) => m.includes("claude:new-1")), "the migration should log");

  // target already exists: overwrite (Windows rename does not overwrite an existing target → pre-delete path)
  writeFileSync(from, JSON.stringify({ version: 1, entries: [{ text: "fresh", queuedAt: 2 }] }));
  migrateQueueSidecar(dir, "claude:new-1", "claude:sess_real");
  assert.deepEqual(JSON.parse(readFileSync(to, "utf8")).entries[0].text, "fresh", "an existing target should be overwritten");

  // no-op surface: source missing / from==to / dir not captured
  migrateQueueSidecar(dir, "ghost", "x");
  migrateQueueSidecar(dir, "a", "a");
  migrateQueueSidecar(undefined, "a", "b");
  assert.ok(!existsSync(join(dir, "queues", "x.json")));
});
