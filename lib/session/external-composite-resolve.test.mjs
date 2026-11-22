/**
 * resolveExternalCompositeSession unit tests — cold recovery of composite external ids (zcode:sess_x etc.).
 * Run: node --experimental-strip-types --test lib/session/external-composite-resolve.test.mjs
 * (or npm test at the repo root). HOME/PI_WEB_DATA_DIR point at temp dirs for full isolation (placeholder-file write isolation).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "extcomp-home-"));
process.env.HOME = home;
process.env.PI_WEB_DATA_DIR = join(home, "data");

const { registerExtensionProvider, unregisterExtensionProviders } = await import("./providers.ts");
const { resolveExternalCompositeSession, listHandleIds } = await import("./index.ts");

function fakeHandle(id, alive = true) {
  const subscribers = new Set();
  return {
    id,
    alive: () => alive,
    isRunning: () => false,
    subscribe: (l) => {
      subscribers.add(l);
      return () => subscribers.delete(l);
    },
    prompt: async () => {},
    abort: async () => {},
    dispose: async () => {},
    getModel: () => undefined,
    capabilities: {},
    source: "fake",
  };
}

test("non-composite id / pi: prefix / placeholder sid → undefined (backend untouched)", async () => {
  assert.equal(await resolveExternalCompositeSession("0189f70c-9643-7335-a090-e70a9070b852"), undefined);
  assert.equal(await resolveExternalCompositeSession("pi:0189f70c-9643-7335-a090-e70a9070b852"), undefined);
  assert.equal(await resolveExternalCompositeSession("zcode:new-abc"), undefined);
});

test("no provider can drive it → undefined (fast return, no suspension)", async () => {
  assert.equal(await resolveExternalCompositeSession("nosuchagent:sess_abc"), undefined);
});

test("a provider can drive it: cold recovery stored, second call reuses the handle", async () => {
  let created = 0;
  registerExtensionProvider("ext-test", {
    type: "zcode",
    label: "fake zcode",
    maxCapabilities: {},
    agentKey: "zcode",
    createSession: async (opts) => {
      created += 1;
      return fakeHandle(`zcode:${opts.sessionId}`);
    },
  });
  try {
    const s1 = await resolveExternalCompositeSession("zcode:sess_abc");
    assert.ok(s1?.isAlive(), "first resolve should return a live adapter");
    assert.equal(created, 1);
    assert.ok(listHandleIds().includes("zcode:sess_abc"), "handle registered under composite id");

    const s2 = await resolveExternalCompositeSession("zcode:sess_abc");
    assert.ok(s2?.isAlive());
    assert.equal(created, 1, "second resolve must reuse the stored handle");
  } finally {
    unregisterExtensionProviders("ext-test");
  }
});

test("backend cannot be opened (handle not alive) → undefined", async () => {
  registerExtensionProvider("ext-dead", {
    type: "zcode",
    label: "dead zcode",
    maxCapabilities: {},
    agentKey: "zcode",
    createSession: async () => fakeHandle("zcode:sess_dead", false),
  });
  try {
    // openExternalSession's existing semantics: createSession results are stored before the caller checks aliveness
    // (same as the placeholder path; all consumers guard with isAlive) — here we only assert the helper does not let a dead handle through.
    assert.equal(await resolveExternalCompositeSession("zcode:sess_dead"), undefined);
  } finally {
    unregisterExtensionProviders("ext-dead");
  }
});
