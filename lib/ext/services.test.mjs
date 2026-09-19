/**
 * ExtServicesRegistry + ctx.services/ctx.features wiring unit tests (node --test)
 *
 * Covers (DI plan P0 acceptance): provide/get, key prefix validation (anti-impersonation),
 * disposer idempotence and guards, onChange up/down, require event-driven hit/wait/timeout,
 * revokeExt/clear rollback, status service listing, registry wiring (extension startup provide
 * → get; reload rollback and re-online; core.* presets; features.get/on).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const { ExtServicesRegistry, assertServiceKey } = await import("./services.ts");
const { ExtRegistryImpl } = await import("./registry.ts");

// Test isolation: point the jiti fsCache at a throwaway dir (same as registry.test.mjs) —
// tmp extensions' cache keys must not land in the real <webRoot()>/.cache/jiti.
process.env.PI_WEB_JITI_CACHE_DIR ??= mkdtempSync(join(tmpdir(), "pi-jiti-cache-test-"));

// ── kernel: provide / get ──────────────────────────────────────────────────────

test("provide/get round-trip; absent → undefined", () => {
  const r = new ExtServicesRegistry();
  assert.equal(r.get("a.svc"), undefined);
  const off = r.provide("a", "a.svc", { hello: 1 });
  assert.deepEqual(r.get("a.svc"), { hello: 1 });
  off();
  assert.equal(r.get("a.svc"), undefined);
});

test("key prefix validation: impersonating another extension / core.* are both rejected", () => {
  const r = new ExtServicesRegistry();
  assert.throws(() => r.provide("a", "b.svc", 1), /prefix/);
  assert.throws(() => r.provide("a", "core.sessions", 1), /prefix/);
  assert.throws(() => r.provide("a", "a", 1), /prefix/); // missing the name segment
  assert.doesNotThrow(() => r.provide("core", "core.sessions", {}));
});

test("repeated provide with the same key: same extension replaces the impl without re-emitting up", () => {
  const r = new ExtServicesRegistry();
  const events = [];
  r.onChange((key, phase) => events.push(`${key}:${phase}`));
  const off1 = r.provide("a", "a.svc", 1);
  const off2 = r.provide("a", "a.svc", 2); // same extension re-providing = replace (still up, no up/down emitted)
  assert.equal(r.get("a.svc"), 2);
  assert.deepEqual(events, ["a.svc:up"]);
  off1(); // the old registration's disposer: impl was replaced, the guard kicks in → no removal
  assert.equal(r.get("a.svc"), 2);
  assert.deepEqual(events, ["a.svc:up"]);
  off2(); // the current registration's disposer: normal removal + down
  assert.equal(r.get("a.svc"), undefined);
  assert.deepEqual(events, ["a.svc:up", "a.svc:down"]);
});

test("disposer is idempotent; down is emitted exactly once", () => {
  const r = new ExtServicesRegistry();
  const events = [];
  r.onChange((key, phase) => events.push(phase));
  const off = r.provide("a", "a.svc", 1);
  off();
  off();
  assert.deepEqual(events, ["up", "down"]);
});

// ── kernel: onChange / require ────────────────────────────────────────────────

test("require: hit returns immediately (event-driven, zero wait)", async () => {
  const r = new ExtServicesRegistry();
  r.provide("a", "a.svc", "impl");
  assert.equal(await r.require("a.svc"), "impl");
});

test("require: miss suspends, resolves on provide (no polling)", async () => {
  const r = new ExtServicesRegistry();
  const p = r.require("a.svc", 1000);
  setTimeout(() => r.provide("a", "a.svc", "late"), 20);
  assert.equal(await p, "late");
});

test("require: timeout rejects (error contains the key and the timeout duration)", async () => {
  const r = new ExtServicesRegistry();
  await assert.rejects(r.require("a.missing", 30), /a\.missing.*30ms/);
});

test("revokeExt rollback + clear + list (status service listing)", () => {
  const r = new ExtServicesRegistry();
  r.provide("a", "a.x", 1);
  r.provide("a", "a.y", 2);
  r.provide("b", "b.x", 3);
  r.provide("core", "core.sessions", {});
  const down = [];
  r.onChange((key, phase) => { if (phase === "down") down.push(key); });
  assert.deepEqual(r.list().sort((x, y) => x.key.localeCompare(y.key)), [
    { key: "a.x", extId: "a" }, { key: "a.y", extId: "a" },
    { key: "b.x", extId: "b" }, { key: "core.sessions", extId: "core" },
  ]);
  assert.deepEqual(r.revokeExt("a").sort(), ["a.x", "a.y"]);
  assert.equal(r.get("a.x"), undefined);
  assert.equal(r.get("b.x"), 3);
  assert.deepEqual(down.sort(), ["a.x", "a.y"]);
  r.clear();
  assert.deepEqual(r.list(), []);
  assert.equal(down.includes("b.x") && down.includes("core.sessions"), true);
});

// ── registry wiring: ctx.services / ctx.features / core.* / reload rollback ────────

const FAKE_CORE = {
  async listSessions() { return []; },
  async getRunningSessionIds() { return []; },
  async getHomeDir() { return "/home/test"; },
};

function writeExt(root, id, entry) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), entry);
  const clientDir = join(dir, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "demo.mjs"), "export default {}\n");
  return dir;
}

test("registry wiring: startup provide → services.get; features.get/on; reload rolls back and re-onlines", async () => {
  const root = mkdtempSync(join(tmpdir(), "ext-services-"));
  try {
    writeExt(root, "provider", `
      export default {
        id: "provider", name: "P", version: "1.0.0", client: "client/demo.mjs",
        ui: { toolbar: [{ id: "t1", label: "T1" }] },
        features: [{ id: "gate", label: "G", type: "boolean", default: true }],
        server: {
          startup(ctx) {
            ctx.services.provide("provider.svc", { n: 42 });
            globalThis.__tFeaturesDefault = ctx.features.get("gate");            // this extension, default true
            globalThis.__tFeaturesOther = ctx.features.get("provider", "gate");  // explicit extId + fid
            globalThis.__tOff = ctx.features.on(() => { globalThis.__tFeatureChanged = (globalThis.__tFeatureChanged || 0) + 1; });
          },
          shutdown() {},
        },
      };
    `);
    writeExt(root, "consumer", `
      export default {
        id: "consumer", name: "C", version: "1.0.0", client: "client/demo.mjs",
        server: {
          startup(ctx) {
            globalThis.__tGotSvc = ctx.services.get("provider.svc") ?? null;
            globalThis.__tRequire = null;
            ctx.services.require("provider.svc", 1000).then((s) => { globalThis.__tRequire = s; });
            globalThis.__tServiceDowns = globalThis.__tServiceDowns || 0;
            ctx.services.onChange((key, phase) => { if (key === "provider.svc" && phase === "down") globalThis.__tServiceDowns += 1; });
          },
        },
      };
    `);

    delete globalThis.__tGotSvc;
    delete globalThis.__tRequire;
    delete globalThis.__tFeaturesDefault;
    delete globalThis.__tFeaturesOther;
    delete globalThis.__tFeatureChanged;
    delete globalThis.__tServiceDownSeen;

    const reg = new ExtRegistryImpl({
      core: FAKE_CORE,
      extensionsRootOverride: root,
      extraExtensionsRootsOverride: [],
      devExtensionsRootOverride: null,
      bundledExtensionsRootOverride: join(root, "_none"),
      dataRootOverride: join(root, "_data"),
    });

    await reg.loadAll();
    await reg.startAll();

    // core.* presets + extension services are all in the listing
    const keys = reg.services.list().map((s) => s.key);
    assert.equal(keys.includes("core.sessions"), true);
    assert.equal(keys.includes("core.registry"), true);
    assert.equal(keys.includes("provider.svc"), true);

    // consumer startup order is not guaranteed (in this test consumer sorts before provider alphabetically — the plan's R2 reality):
    // a soft get may be absent during startup; require (event wait) is the right answer for startup-time hard deps — after the
    // provider provides, the waiter is resolved event-driven.
    assert.equal(globalThis.__tGotSvc, null);
    assert.deepEqual(globalThis.__tRequire, { n: 42 });

    // core.sessions read-only view (globalThis.__piSessions read lazily)
    globalThis.__piSessions = new Map([["s1", { id: "s1" }]]);
    const sessions = reg.services.get("core.sessions");
    assert.deepEqual(sessions.ids(), ["s1"]);
    assert.deepEqual(sessions.get("s1"), { id: "s1" });
    assert.equal(sessions.has("nope"), false);

    // core.registry projection (including the ui read-only view — the extman slot-details consumption surface)
    const proj = reg.services.get("core.registry").get("provider");
    assert.equal(proj.name, "P");
    assert.equal(typeof reg.services.get("core.registry").status(), "object");
    const ui = reg.services.get("core.registry").ui("provider");
    assert.deepEqual(ui.toolbar?.map((x) => x.id), ["t1"]); // the ui declaration is readable (read-only view)
    assert.equal(reg.services.get("core.registry").ui("nope"), null);

    // features: declared default true; after setFeatureValue the on callback fires
    assert.equal(globalThis.__tFeaturesDefault, true);
    assert.equal(globalThis.__tFeaturesOther, true);
    reg.setFeatureValue("provider", "gate", false);
    assert.equal(reg.featureValue("provider", "gate"), false);
    assert.equal(globalThis.__tFeatureChanged, 1);

    // reload: shutdown rolls back (consumer sees down) → startAll brings it back online
    await reg.reload();
    assert.equal(globalThis.__tServiceDowns >= 1, true);
    assert.equal(reg.services.get("provider.svc")?.n, 42);
    const keys2 = reg.services.list().map((s) => s.key);
    assert.equal(keys2.includes("provider.svc") && keys2.includes("core.sessions"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    for (const k of ["__tGotSvc", "__tRequire", "__tFeaturesDefault", "__tFeaturesOther", "__tFeatureChanged", "__tServiceDowns", "__tOff", "__piSessions"]) delete globalThis[k];
  }
});

test("assertServiceKey: the directly exported validator behaves identically", () => {
  assert.throws(() => assertServiceKey("x", "y.z"), /prefix/);
  assert.doesNotThrow(() => assertServiceKey("x", "x.z"));
});
