/**
 * Read-path attach gate (pi-web lazy session open, 2026-11-23).
 *
 * Opening a session must never pull an agent process up:
 *   attachIfBridged(file, { create: false }) — reuse live handles, adopt live
 *   detached wrappers, and attach providers declared `attachOnly` (they only
 *   connect to a running socket); a provider that can only satisfy
 *   createSession by spawning is skipped so the caller reads the file from disk.
 *
 * Write paths keep the historical behavior (default create = true).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const sessionIndex = await jiti.import("./index.ts");
const { registerProvider, removeProvider } = await jiti.import("./providers.ts");

const { attachIfBridged, removeHandle } = sessionIndex;

const FAKE_FILE = "/tmp/lazy-attach-gate/session.jsonl";

/** Minimal SessionHandle — enough for putHandle/watchHandleRunning/HandleSessionAdapter. */
function fakeHandle(id) {
  return {
    id,
    source: "lazy-attach-gate",
    cwd: "",
    capabilities: {},
    alive: () => true,
    isAlive: () => true,
    isRunning: () => false,
    getModel: () => undefined,
    subscribe: () => () => {},
    dispose: async () => {},
  };
}

/** Register a claiming fake; returns its registry key (registerProvider returns void) plus its create call counter. */
function registerClaimingFake({ type, attachOnly, createImpl }) {
  const calls = { count: 0 };
  registerProvider({
    type,
    label: `lazy attach gate ${type}`,
    ...(attachOnly ? { attachOnly } : {}),
    ownsFile: () => true,
    async createSession() {
      calls.count++;
      return createImpl ? createImpl() : fakeHandle(`${type}-handle`);
    },
  });
  return { key: type, calls };
}

test("create:false never calls a spawning provider's createSession (opening stays read-only)", async () => {
  const { key, calls } = registerClaimingFake({ type: "lazy-gate-spawn", createImpl: () => fakeHandle("lazy-gate-spawn-handle") });
  try {
    const attached = await attachIfBridged(FAKE_FILE, { create: false });
    assert.equal(attached, undefined, "an unclaimed-for-read file falls back to the disk read");
    assert.equal(calls.count, 0, "createSession (spawn) must not run on a read path");
  } finally {
    removeHandle(FAKE_FILE);
    removeHandle("lazy-gate-spawn-handle");
    removeProvider(key);
  }
});

test("default create (write path) still creates the provider session exactly once", async () => {
  const { key, calls } = registerClaimingFake({ type: "lazy-gate-write", createImpl: () => fakeHandle("lazy-gate-write-handle") });
  try {
    const attached = await attachIfBridged(FAKE_FILE);
    assert.ok(attached, "the write path must attach through the claiming provider");
    assert.equal(attached.isAlive(), true);
    assert.equal(calls.count, 1);
  } finally {
    removeHandle(FAKE_FILE);
    removeHandle("lazy-gate-write-handle");
    removeProvider(key);
  }
});

test("attachOnly providers are still called on read paths (TUI bridge keeps its live stream)", async () => {
  const { key, calls } = registerClaimingFake({
    type: "lazy-gate-attach-only",
    attachOnly: true,
    createImpl: () => fakeHandle("lazy-gate-attach-only-handle"),
  });
  try {
    const attached = await attachIfBridged(FAKE_FILE, { create: false });
    assert.ok(attached, "attachOnly createSession only connects to a live socket and is allowed on reads");
    assert.equal(calls.count, 1);
  } finally {
    removeHandle(FAKE_FILE);
    removeHandle("lazy-gate-attach-only-handle");
    removeProvider(key);
  }
});

test("an alive handle is reused on read paths without touching any provider", async () => {
  const { putHandleAt } = await jiti.import("./handle-store.ts");
  // A spawning provider: if the reuse path were skipped, this read would create.
  const { key, calls } = registerClaimingFake({ type: "lazy-gate-reuse" });
  const handle = fakeHandle("lazy-gate-reuse-handle");
  putHandleAt(FAKE_FILE, handle);
  try {
    const attached = await attachIfBridged(FAKE_FILE, { create: false });
    assert.ok(attached, "a live (already attached) handle must be reused");
    assert.equal(calls.count, 0, "reuse must not create a second handle");
  } finally {
    removeHandle(FAKE_FILE);
    removeHandle("lazy-gate-reuse-handle");
    removeProvider(key);
  }
});

test("in-flight dedupe keeps read and write flights apart", async () => {
  const gate = Promise.withResolvers();
  // A spawning provider: the pending write flight must not be joined by the read
  // flight (the read would then receive a freshly spawned process).
  const { key, calls } = registerClaimingFake({
    type: "lazy-gate-flight",
    createImpl: async () => {
      await gate.promise;
      return fakeHandle("lazy-gate-flight-handle");
    },
  });
  try {
    const write = attachIfBridged(FAKE_FILE, { create: true });
    // Let the write flight get past its awaits and call createSession (gated).
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.count, 1, "the write flight is in flight (createSession pending)");
    const readAttached = await attachIfBridged(FAKE_FILE, { create: false });
    assert.equal(readAttached, undefined, "the read must resolve on its own, not join the write flight");
    assert.equal(calls.count, 1, "the read did not create a second backend");
    gate.resolve();
    const written = await write;
    assert.ok(written, "the write flight still resolves with its own handle");
  } finally {
    removeHandle(FAKE_FILE);
    removeHandle("lazy-gate-flight-handle");
    removeProvider(key);
  }
});
