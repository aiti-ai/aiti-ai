/**
 * waitForLiveSessionById — the wake signal of the lazy agent SSE stream.
 *
 * Opening a cold provider-owned pi session must not spawn it: the SSE route
 * stays pending and wakes when a real interaction registers the backend handle.
 * The waiter must therefore observe the handle store (registration) in addition
 * to the local running set, and must not miss a session that is already live.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { waitForLiveSessionById } = await jiti.import("./live-wait.ts");
const { putHandle, removeHandle } = await jiti.import("./handle-store.ts");

/** Minimal SessionHandle for the adapter (alive + event subscription surface). */
function fakeHandle(id) {
  return {
    id,
    source: "lazy-live-wait",
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

test("wakes when a provider handle is registered after the wait starts", async () => {
  const ready = Promise.withResolvers();
  const stop = waitForLiveSessionById("lazy-live-wait-later", (session) => ready.resolve(session));
  try {
    putHandle(fakeHandle("lazy-live-wait-later"));
    const session = await ready.promise;
    assert.equal(session.isAlive(), true, "the handle-store registration is the spawn wake signal");
  } finally {
    stop();
    removeHandle("lazy-live-wait-later");
  }
});

test("delivers an already-live handle synchronously (no missed window)", () => {
  putHandle(fakeHandle("lazy-live-wait-now"));
  let delivered;
  const stop = waitForLiveSessionById("lazy-live-wait-now", (session) => { delivered = session; });
  try {
    assert.ok(delivered, "a pending SSE opening right after the spawn must attach immediately");
    assert.equal(delivered.isAlive(), true);
  } finally {
    stop();
    removeHandle("lazy-live-wait-now");
  }
});

test("stop() cancels the wait (stream closed while still pending)", async () => {
  let delivered = false;
  const stop = waitForLiveSessionById("lazy-live-wait-stop", () => { delivered = true; });
  stop();
  putHandle(fakeHandle("lazy-live-wait-stop"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivered, false);
  removeHandle("lazy-live-wait-stop");
});
