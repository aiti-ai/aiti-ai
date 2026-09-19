import { test } from "node:test";
import assert from "node:assert/strict";

// handle-store depends on the process global globalThis.__sessionHandles — tests must clear
// the field first and clean up afterwards, to avoid polluting other test files.
const g = globalThis;
function resetStore() {
  g.__sessionHandles = undefined;
}

function stub(id, { running = false, alive = true, source = "test" } = {}) {
  const h = {
    id,
    source,
    capabilities: {},
    cwd: "",
    running,
    alive: () => alive,
    isRunning: () => h.running,
    subscribe: () => () => {},
    dispose: async () => {},
  };
  return h;
}

// dynamic import: lets the store initialize in a clean state in this test process
async function load() {
  resetStore();
  return import("./handle-store.ts");
}

test("getRunningHandleIds covers the placeholder uuid (Map key) and handle.id (composite id)", async () => {
  const { putHandle, putHandleAt, getRunningHandleIds } = await load();
  try {
    // simulates a zcode history session reviving: openExternalSession putHandle(handle) (key = composite id),
    // then resolvePlaceholderSession putHandleAt(placeholder uuid). The sidebar row id = placeholder uuid.
    const h = stub("zcode:sess_abc", { running: true });
    putHandle(h);
    putHandleAt("b74cd851-cad2-446c-be77-7c1bcf5b1241", h);

    const ids = getRunningHandleIds();
    assert.ok(ids.includes("b74cd851-cad2-446c-be77-7c1bcf5b1241"), "the placeholder uuid must be in the running set (sidebar row id matching)");
    assert.ok(ids.includes("zcode:sess_abc"), "handle.id (composite id) must be in the running set too");
  } finally {
    resetStore();
  }
});

test("getRunningHandleIds filters attach file-path keys (starting with /)", async () => {
  const { putHandle, putHandleAt, getRunningHandleIds } = await load();
  try {
    const h = stub("aaaa-1111-2222-3333", { running: true });
    putHandle(h); // key = handle.id (uuid)
    putHandleAt("/home/pi/.pi/agent/sessions/xxx_aaaa-1111-2222-3333.jsonl", h); // compat reuse key

    const ids = getRunningHandleIds();
    assert.ok(ids.includes("aaaa-1111-2222-3333"));
    assert.ok(!ids.some((id) => id.startsWith("/")), "file-path keys are internal reuse and must not leak into the running set");
  } finally {
    resetStore();
  }
});

test("getRunningHandleIds only contains running live handles; non-running ones are absent", async () => {
  const { putHandle, getRunningHandleIds } = await load();
  try {
    putHandle(stub("idle-sess", { running: false }));
    putHandle(stub("running-sess", { running: true }));
    const ids = getRunningHandleIds();
    assert.ok(ids.includes("running-sess"));
    assert.ok(!ids.includes("idle-sess"));
  } finally {
    resetStore();
  }
});

test("notifyHandleRunningChange broadcasts the merged full set only when the running set changes", async () => {
  const { putHandle, notifyHandleRunningChange, subscribeRunningHandles } = await load();
  try {
    let count = 0;
    let last = null;
    const unsub = subscribeRunningHandles((ids) => { count++; last = ids; });

    const h = stub("sess-1", { running: false });
    putHandle(h);
    // the first frame broadcasts the initial snapshot (empty set); afterwards an unchanged empty set is not re-broadcast
    notifyHandleRunningChange();
    assert.equal(count, 1);
    assert.deepEqual(last, []);
    notifyHandleRunningChange();
    assert.equal(count, 1, "running set unchanged (empty→empty) should not re-broadcast");

    // running set changed (handle entered running) → broadcast the merged full set
    h.running = true;
    notifyHandleRunningChange();
    assert.equal(count, 2);
    assert.deepEqual([...last].sort(), ["sess-1"]);

    unsub();
  } finally {
    resetStore();
  }
});

// ── disposeAllHandles: in-flight handles are destroyed with a delay (the 2026-09-07 reload-kills-turns incident) ──

test("the running flag clears only after the settled event (prompt finally timing) → the delayed one-tick recompute catches it, no lingering spinner", async () => {
  const { putHandle, subscribeRunningHandles } = await load();
  try {
    const frames = [];
    const unsub = subscribeRunningHandles((ids) => frames.push([...ids]));
    const busy = eventStub("zcode:sess_race", { running: true });
    putHandle(busy); // putHandle attaches watchHandleRunning
    busy.emit("agent_start"); // turn-start event → first frame [zcode:sess_race]
    assert.deepEqual(frames.at(-1), ["zcode:sess_race"]);

    // backend-verified timing (same across zcode/codex/… six backends): the settled event fires first
    // (isRunning still true at that moment → the snapshot diff swallows the frame), and the running
    // flag clears afterwards in prompt()'s finally (no further events after that)
    busy.emit("agent_settled");
    assert.equal(frames.length, 1, "flag not yet cleared during the synchronous recompute; snapshot unchanged → no broadcast");
    busy.running = false;
    await sleep(5); // watchHandleRunning's delayed one-tick recompute
    assert.deepEqual(frames.at(-1), [], "after the flag clears there must be one empty-set frame broadcast (sidebar spinner cleared)");

    unsub();
  } finally {
    resetStore();
  }
});

/** Stub with event broadcasting: subscribe collects the listener, emit triggers it manually. */
function eventStub(id, { running = false, alive = true } = {}) {
  const listeners = new Set();
  const h = {
    id,
    source: "test",
    capabilities: {},
    cwd: "",
    running,
    disposed: false,
    alive: () => h.aliveFlag,
    aliveFlag: alive,
    isRunning: () => h.running,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    dispose: async () => { h.disposed = true; },
    emit: (type) => { for (const fn of [...listeners]) fn({ type }); },
  };
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("disposeAllHandles: idle handles destroyed immediately, in-flight handles kept along with their alias keys", async () => {
  const { putHandle, putHandleAt, listHandleIds, getHandle, disposeAllHandles } = await load();
  try {
    const idle = eventStub("ext:idle");
    const busy = eventStub("ext:busy", { running: true });
    putHandle(idle);
    putHandle(busy);
    putHandleAt("placeholder-uuid-busy", busy); // alias double registration

    const count = await disposeAllHandles();
    assert.equal(count, 3, "return value = total key count before disposal");
    assert.equal(idle.disposed, true, "idle handle disposed immediately");
    assert.equal(busy.disposed, false, "an in-flight handle must not be killed by reload");
    assert.ok(listHandleIds().includes("ext:busy"), "the in-flight handle's composite id key is kept");
    assert.ok(listHandleIds().includes("placeholder-uuid-busy"), "the in-flight handle's placeholder uuid alias key is kept");
    assert.equal(getHandle("ext:idle"), undefined, "the idle handle is out of the store");
  } finally {
    resetStore();
  }
});

test("disposeAllHandles: after an in-flight handle settles it auto-disposes + leaves the store (alias keys too)", async () => {
  const { putHandle, putHandleAt, listHandleIds, getHandle, disposeAllHandles } = await load();
  try {
    const busy = eventStub("ext:busy", { running: true });
    putHandle(busy);
    putHandleAt("placeholder-uuid-busy", busy);
    await disposeAllHandles();

    busy.running = false;
    busy.emit("agent_settled");
    await sleep(1200); // recheck delay 1s

    assert.equal(busy.disposed, true, "delayed dispose after settle");
    assert.equal(getHandle("ext:busy"), undefined, "composite id key out of the store");
    assert.equal(getHandle("placeholder-uuid-busy"), undefined, "alias key out of the store too");
    assert.equal(listHandleIds().length, 0);
  } finally {
    resetStore();
  }
});

test("disposeAllHandles: re-running within the settle recheck window → not disposed, keeps running", async () => {
  const { putHandle, getHandle, disposeAllHandles } = await load();
  try {
    const busy = eventStub("ext:busy", { running: true });
    putHandle(busy);
    await disposeAllHandles();

    // a queued continuation starts agent_start right after agent_end: still running at recheck time
    busy.emit("agent_end");
    await sleep(50);
    busy.running = true;
    busy.emit("agent_start");
    await sleep(1200);

    assert.equal(busy.disposed, false, "re-running within the recheck window → must not be destroyed");
    assert.ok(getHandle("ext:busy"), "handle still in the store");
  } finally {
    resetStore();
  }
});
