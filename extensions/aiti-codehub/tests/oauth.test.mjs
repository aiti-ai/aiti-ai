import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { ForgeRegistry } from "../server/registry.ts";
import { finishOAuth, landingUrl, manualOAuth, pkcePair, refreshIfNeeded, startOAuth } from "../server/oauth.ts";
import { landingHtml } from "../server/landing.ts";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "codehub-oauth-"));
  return { root, store: new Store({ configDir: join(root, "c"), stateDir: join(root, "s"), cacheDir: join(root, "k") }), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeRuntime(store, events = []) {
  const driver = {
    mode: "dcr-pkce",
    metaFor: () => ({ authorizationEndpoint: "https://auth.example/authorize", tokenEndpoint: "https://auth.example/token", registrationEndpoint: "https://auth.example/register" }),
    register: async (_cfg, _meta, redirectUris) => { events.push({ registerUris: redirectUris }); return { clientId: "cid" }; },
    authorizeUrl: (_cfg, meta, i) => `${meta.authorizationEndpoint}?${new URLSearchParams({ client_id: i.clientId, redirect_uri: i.redirectUri, state: i.state, code_challenge: i.codeChallenge, code_challenge_method: "S256" })}`,
    exchange: async () => ({ accessToken: "at", refreshToken: "rt", expiry: Date.now() + 3600_000 }),
    refresh: async () => ({ accessToken: "at2", refreshToken: "rt2", expiry: Date.now() + 3600_000 }),
    account: async () => ({ provider: "fake", userId: "u", username: "alice", extra: { orgId: "org1" } }),
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

function req(headers = {}) {
  return new Request("https://pi.example/dev/api/extensions/aiti-codehub/oauth/fake/start", {
    headers: { host: "pi.example.com:57442", "x-forwarded-proto": "https", ...headers },
  });
}

test("pkcePair produces a valid S256 challenge", () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.equal(challenge, b64url(createHash("sha256").update(verifier).digest()));
});

test("landingUrl appends the middleware path and preserves basePath", () => {
  assert.equal(landingUrl("http://127.0.0.1:30141", "yunxiao"), "http://127.0.0.1:30141/aiti-codehub/oauth/yunxiao");
  assert.equal(landingUrl("http://127.0.0.1:30142/dev/", "yunxiao"), "http://127.0.0.1:30142/dev/aiti-codehub/oauth/yunxiao");
  const html = landingHtml("yunxiao");
  assert.match(html, /oauth\//);
  assert.match(html, /exchange/);
  assert.match(html, /history\.replaceState/);
});

test("default callback uses oauthCallbackBase (30141 by default); page mode uses the request origin", async () => {
  const t = tempStore();
  const oldBase = process.env.PI_WEB_BASE_PATH;
  process.env.PI_WEB_BASE_PATH = "/dev";
  try {
    const rt = makeRuntime(t.store);
    const a = await startOAuth(rt, "fake", { callbackMode: "default" }, req());
    assert.equal(a.redirectUri, "http://127.0.0.1:30141/aiti-codehub/oauth/fake");
    const b = await startOAuth(rt, "fake", { callbackMode: "page" }, req());
    assert.equal(b.redirectUri, "https://pi.example.com:57442/dev/aiti-codehub/oauth/fake");
    // DCR registered both variants
    const reg = rt.store.state().oauth;
    assert.ok(Object.keys(reg).length >= 2);
    const registered = rt.store.provider("fake").clientRedirects;
    assert.ok(registered.includes("http://127.0.0.1:30141/aiti-codehub/oauth/fake"));
    assert.ok(registered.includes("https://pi.example.com:57442/dev/aiti-codehub/oauth/fake"));
  } finally {
    if (oldBase === undefined) delete process.env.PI_WEB_BASE_PATH; else process.env.PI_WEB_BASE_PATH = oldBase;
    t.cleanup();
  }
});

test("custom callback base is validated and used", async () => {
  const t = tempStore();
  try {
    const rt = makeRuntime(t.store);
    await assert.rejects(() => startOAuth(rt, "fake", { callbackMode: "custom", customBase: "http://evil.example" }, req()), (e) => e.code === "bad_request");
    const a = await startOAuth(rt, "fake", { callbackMode: "custom", customBase: "http://127.0.0.1:30141/dev" }, req());
    assert.equal(a.redirectUri, "http://127.0.0.1:30141/dev/aiti-codehub/oauth/fake");
  } finally { t.cleanup(); }
});

test("finishOAuth exchanges the code, stores tokens and publishes an event", async () => {
  const t = tempStore();
  try {
    const events = [];
    const rt = makeRuntime(t.store, events);
    const out = await startOAuth(rt, "fake", { callbackMode: "default" }, req());
    const state = new URL(out.url).searchParams.get("state");
    const result = await finishOAuth(rt, "fake", "the-code", state);
    assert.equal(result.ok, true);
    const cfg = t.store.provider("fake");
    assert.equal(cfg.token, "at");
    assert.equal(cfg.refreshToken, "rt");
    assert.equal(cfg.authType, "oauth");
    assert.equal(cfg.orgId, "org1");
    assert.equal(cfg.account.username, "alice");
    assert.ok(cfg.expiry > Date.now());
    assert.ok(events.some((e) => e.topic === "aiti-codehub:oauth" && e.data.ok === true));
    const again = await finishOAuth(rt, "fake", "the-code", state);
    assert.equal(again.ok, false);
    assert.match(again.error, /state/);
  } finally { t.cleanup(); }
});

test("manualOAuth parses a pasted redirect URL", async () => {
  const t = tempStore();
  try {
    const rt = makeRuntime(t.store);
    const out = await startOAuth(rt, "fake", { callbackMode: "default" }, req());
    const state = new URL(out.url).searchParams.get("state");
    const url = `http://127.0.0.1:30141/aiti-codehub/oauth/fake?code=abc&state=${state}`;
    const r = await manualOAuth(rt, "fake", { url });
    assert.equal(r.ok, true);
    assert.equal(t.store.provider("fake").token, "at");
    const bad = await manualOAuth(rt, "fake", { url: "not a url" });
    assert.equal(bad.ok, false);
  } finally { t.cleanup(); }
});

test("refreshIfNeeded refreshes an expiring token and marks needsLogin on failure", async () => {
  const t = tempStore();
  try {
    const rt = makeRuntime(t.store);
    t.store.saveProvider("fake", { authType: "oauth", token: "old", refreshToken: "r", expiry: Date.now() + 1000, clientId: "cid" });
    const cfg = await refreshIfNeeded(rt, "fake");
    assert.equal(cfg.token, "at2");
    assert.equal(cfg.refreshToken, "rt2");
    assert.equal(cfg.needsLogin, false);
    t.store.saveProvider("fake", { token: "old", refreshToken: null, expiry: Date.now() + 1000 });
    await assert.rejects(() => refreshIfNeeded(rt, "fake"), (e) => e.code === "auth");
    assert.equal(t.store.provider("fake").needsLogin, true);
  } finally { t.cleanup(); }
});

test("the landing path is platform-scoped while the state owns the account", async () => {
  assert.equal(landingUrl("http://127.0.0.1:30141", "yunxiao"), "http://127.0.0.1:30141/aiti-codehub/oauth/yunxiao");
  const t = tempStore();
  const events = [];
  const rt = makeRuntime(t.store, events);
  try {
    const first = await startOAuth(rt, "fake~work", {}, req());
    assert.equal(first.mode, "dcr-pkce");
    const state = new URL(first.url).searchParams.get("state");
    assert.equal(t.store.state().oauth[state].instance, "fake~work");
    assert.equal(t.store.state().oauth[state].platform, "fake");
    // One redirect URI per platform: required for a shared DCR client.
    assert.equal(first.redirectUri.includes("/oauth/fake"), true);
    assert.equal(first.redirectUri.includes("~"), false);

    // A direct finish pinned to another account must not consume the code.
    const wrong = await finishOAuth(rt, { instance: "fake" }, "code", state);
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /state/);

    // The platform exchange path resolves the account from the state.
    const second = await startOAuth(rt, "fake~work", {}, req());
    const state2 = new URL(second.url).searchParams.get("state");
    const done = await finishOAuth(rt, { platform: "fake" }, "code", state2);
    assert.equal(done.ok, true);
    assert.equal(t.store.provider("fake~work").token, "at");
    assert.equal(t.store.provider("fake").token, undefined);
    assert.equal(events.some((e) => e.topic === "aiti-codehub:oauth" && e.data.instance === "fake~work"), true);

    // A callback that lands on another platform is rejected.
    const third = await startOAuth(rt, "fake~work", {}, req());
    const state3 = new URL(third.url).searchParams.get("state");
    const wrongPlatform = await finishOAuth(rt, { platform: "github" }, "code", state3);
    assert.equal(wrongPlatform.ok, false);
  } finally {
    t.cleanup();
  }
});


test("accounts on the same site reuse one DCR registration", async () => {
  const t = tempStore();
  const events = [];
  const rt = makeRuntime(t.store, events);
  const site = "https://yunxiao.example.com";
  const registrations = () => events.filter((e) => e.registerUris).length;
  try {
    t.store.saveProvider("fake", { baseUrl: site, authType: "oauth" });
    await startOAuth(rt, "fake", {}, req());
    assert.equal(registrations(), 1);
    const clientId = t.store.provider("fake").clientId;
    assert.ok(clientId);

    // Second account, same site: no new registration, same client.
    t.store.saveProvider("fake~work", { baseUrl: site, authType: "oauth" });
    await startOAuth(rt, "fake~work", {}, req());
    assert.equal(registrations(), 1);
    assert.equal(t.store.provider("fake~work").clientId, clientId);

    // A different site still registers its own client.
    t.store.saveProvider("fake~work", { baseUrl: "https://other.example.com" });
    t.store.saveProvider("fake~work", { clientId: null, clientRedirects: null });
    await startOAuth(rt, "fake~work", {}, req());
    assert.equal(registrations(), 2);
  } finally {
    t.cleanup();
  }
});
