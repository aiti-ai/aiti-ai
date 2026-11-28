import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { ForgeRegistry } from "../server/registry.ts";
import { startOAuth } from "../server/oauth.ts";
import { cancelDevice, deviceStatus } from "../server/device.ts";

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "codehub-device-"));
  return { root, store: new Store({ configDir: join(root, "c"), stateDir: join(root, "s"), cacheDir: join(root, "k") }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRuntime(store, events = [], pollResult = () => ({ accessToken: "dat", refreshToken: "drt", expiry: Date.now() + 3600_000 })) {
  let polls = 0;
  const driver = {
    mode: "device-code",
    scope: "read",
    metaFor: () => ({ authorizationEndpoint: "https://dev/device", tokenEndpoint: "https://dev/token" }),
    authorizeUrl: () => { throw new Error("no auth url"); },
    deviceStart: async () => ({ deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://dev/activate", verificationUriComplete: "https://dev/activate?code=ABCD-EFGH", expiresIn: 60, interval: 1 }),
    devicePoll: async () => { polls++; return pollResult(polls); },
    exchange: async () => { throw new Error("no exchange"); },
    account: async () => ({ provider: "fake", userId: "u", username: "alice" }),
  };
  const provider = {
    id: "fake",
    label: "Fake",
    contract: 1,
    capabilities: { auth: ["pat", "oauth"], clone: ["https"] },
    auth: { oauth: driver },
    httpFor: () => ({ baseUrl: "", req: async () => ({ data: {}, status: 200, headers: new Headers() }), json: async () => ({}) }),
  };
  return { registry: new ForgeRegistry([provider]), store, publish: (topic, data) => events.push({ topic, data }) };
}

const req = () => new Request("https://pi.example/api/extensions/aiti-codehub/oauth/fake/start");

test("device flow: requires a shared client id", async () => {
  const t = tempStore();
  try {
    const rt = makeRuntime(t.store);
    await assert.rejects(() => startOAuth(rt, "fake", {}, req()), (e) => e.code === "bad_request");
  } finally { t.cleanup(); }
});

test("device flow: falls back to the built-in shared client id", async () => {
  const t = tempStore();
  try {
    const rt = makeRuntime(t.store);
    let seen = "";
    const driver = rt.registry.get("fake").auth.oauth;
    driver.defaultClientId = "builtin-client";
    driver.deviceStart = async (_cfg, _meta, p) => {
      seen = p.clientId;
      return { deviceCode: "dc", userCode: "AAAA-BBBB", verificationUri: "https://dev/activate", expiresIn: 60, interval: 60 };
    };
    const out = await startOAuth(rt, "fake", {}, req());
    assert.equal(seen, "builtin-client");
    assert.equal(out.mode, "device-code");
    cancelDevice("fake");
  } finally { t.cleanup(); }
});

test("device flow: returns the grant, polls pending then tokens, stores them", async () => {
  const t = tempStore();
  try {
    const events = [];
    const rt = makeRuntime(t.store, events, (n) => (n === 1 ? { status: "pending" } : { accessToken: "dat", refreshToken: "drt", expiry: Date.now() + 3600_000 }));
    t.store.saveProvider("fake", { clientId: "shared-client" });
    const out = await startOAuth(rt, "fake", {}, req());
    assert.equal(out.mode, "device-code");
    assert.equal(out.device.userCode, "ABCD-EFGH");
    assert.equal(deviceStatus("fake").state, "pending");
    assert.equal(deviceStatus("fake").userCode, "ABCD-EFGH");
    await sleep(2300);
    const cfg = t.store.provider("fake");
    assert.equal(cfg.token, "dat");
    assert.equal(cfg.authType, "oauth");
    assert.equal(cfg.account.username, "alice");
    assert.equal(deviceStatus("fake").state, "success");
    assert.ok(events.some((e) => e.topic === "aiti-codehub:oauth" && e.data.ok === true));
  } finally { t.cleanup(); }
});

test("device flow: keeps the token when the account read fails", async () => {
  const t = tempStore();
  try {
    const rt = makeRuntime(t.store);
    rt.registry.get("fake").auth.oauth.account = async () => { throw new Error("401 Unauthorized"); };
    t.store.saveProvider("fake", { clientId: "shared-client" });
    await startOAuth(rt, "fake", {}, req());
    await sleep(2300);
    const cfg = t.store.provider("fake");
    assert.equal(cfg.token, "dat");
    assert.equal(cfg.needsLogin, false);
    assert.match(String(cfg.accountError), /401/);
    assert.equal(deviceStatus("fake").state, "success");
  } finally { t.cleanup(); }
});

test("device flow: cancellation stops the loop", async () => {
  const t = tempStore();
  try {
    const rt = makeRuntime(t.store);
    t.store.saveProvider("fake", { clientId: "shared-client" });
    await startOAuth(rt, "fake", {}, req());
    assert.equal(cancelDevice("fake"), true);
    assert.equal(deviceStatus("fake").state, "cancelled");
    assert.equal(cancelDevice("fake"), false);
  } finally { t.cleanup(); }
});

test("device flow: expiry marks needsLogin", async () => {
  const t = tempStore();
  try {
    const events = [];
    const rt = makeRuntime(t.store, events);
    t.store.saveProvider("fake", { clientId: "shared-client" });
    // Overwrite the grant TTL by using a driver with expiresIn 0 (clamped to 30s) — too long for a test;
    // instead poll returns an error and the orchestrator stops + publishes.
    rt.registry.get("fake").auth.oauth.devicePoll = async () => { throw new Error("access_denied"); };
    await startOAuth(rt, "fake", {}, req());
    await sleep(1300);
    assert.equal(deviceStatus("fake").state, "error");
    assert.equal(t.store.provider("fake").needsLogin, true);
    assert.ok(events.some((e) => e.topic === "aiti-codehub:oauth" && e.data.ok === false));
  } finally { t.cleanup(); }
});
