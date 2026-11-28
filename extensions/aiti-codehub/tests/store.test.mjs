import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, fingerprintOf, recentScore, redactProviderConfig } from "../server/store.ts";

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "codehub-store-"));
  const store = new Store({ configDir: join(root, "config"), stateDir: join(root, "state"), cacheDir: join(root, "cache") });
  return { root, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("global config defaults + merge", () => {
  const t = tempStore();
  try {
    const g = t.store.global();
    assert.equal(g.pageSize, 50);
    assert.equal(g.excludeClosed, true);
    assert.equal(g.templates.branch, "{type}_{id}");
    const saved = t.store.saveGlobal({ pageSize: 999, templates: { paste: "X {id}", ai: "", branch: "{id}" } });
    assert.equal(saved.pageSize, 100); // clamped
    assert.equal(saved.templates.paste, "X {id}");
    assert.equal(saved.templates.ai, ""); // empty string is a valid template
    assert.equal(saved.templates.branch, "{id}");
    assert.equal(t.store.global().pageSize, 100);
  } finally { t.cleanup(); }
});

test("provider config is 0600 and secrets are redacted", () => {
  const t = tempStore();
  try {
    t.store.saveProvider("yunxiao", { authType: "pat", token: "secret-token-123", orgId: "o1" });
    const file = join(t.store.dirs.configDir, "providers", "yunxiao.json");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(raw.token, "secret-token-123");
    const red = redactProviderConfig(t.store.provider("yunxiao"));
    assert.equal(red.token, undefined);
    assert.equal(red.hasToken, true);
    assert.equal(red.orgId, "o1");
  } finally { t.cleanup(); }
});

test("saveProvider merge semantics: undefined keeps, null clears", () => {
  const t = tempStore();
  try {
    t.store.saveProvider("github", { token: "abc", clientId: "cid", clientSecret: "sec" });
    t.store.saveProvider("github", { orgId: "x" }); // token untouched
    assert.equal(t.store.provider("github").token, "abc");
    t.store.saveProvider("github", { token: null, clientSecret: null });
    const p = t.store.provider("github");
    assert.equal(p.token, undefined);
    assert.equal(p.clientSecret, undefined);
    assert.equal(p.clientId, "cid");
  } finally { t.cleanup(); }
});

test("setTokens stores expiry and keeps refresh token when omitted", () => {
  const t = tempStore();
  try {
    t.store.saveProvider("yunxiao", { refreshToken: "r1" });
    t.store.setTokens("yunxiao", { accessToken: "a1", expiry: Date.now() + 1000 });
    const p = t.store.provider("yunxiao");
    assert.equal(p.token, "a1");
    assert.equal(p.refreshToken, "r1");
    assert.ok(p.expiry > Date.now());
    assert.equal(p.needsLogin, false);
  } finally { t.cleanup(); }
});

test("recents: score ordering + per-provider de-dup + cap", () => {
  const t = tempStore();
  try {
    const now = Date.now();
    t.store.addRecent({ provider: "a", kind: "workitem", id: "1", label: "old", at: now - 30 * 86400000 });
    t.store.addRecent({ provider: "a", kind: "workitem", id: "2", label: "new", at: now });
    t.store.addRecent({ provider: "a", kind: "workitem", id: "2", label: "new2", at: now });
    const list = t.store.state().recents;
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "2");
    assert.equal(list[0].count, 2);
    assert.ok(recentScore({ at: now, count: 3 }) > recentScore({ at: now - 7 * 86400000, count: 1 }));
    for (let i = 0; i < 80; i++) t.store.addRecent({ provider: "b", kind: "workitem", id: String(i), label: "x", at: now - i });
    assert.equal(t.store.state().recents.length, 50);
  } finally { t.cleanup(); }
});

test("favorites toggle + usage markers", () => {
  const t = tempStore();
  try {
    assert.equal(t.store.toggleFavorite("yunxiao", "repos", "g/r"), true);
    assert.deepEqual(t.store.favorites("yunxiao").yunxiao.repos, ["g/r"]);
    assert.equal(t.store.toggleFavorite("yunxiao", "repos", "g/r"), false);
    assert.deepEqual(t.store.favorites("yunxiao").yunxiao.repos, []);
    t.store.markUsage("yunxiao", "w1", "ai");
    t.store.markUsage("yunxiao", "w1", "branch", "b1");
    const u = t.store.usage("yunxiao", "w1");
    assert.ok(u.sentToAIAt);
    assert.equal(u.branch, "b1");
  } finally { t.cleanup(); }
});

test("pending OAuth is one-shot and expires", () => {
  const t = tempStore();
  try {
    const state = "s1";
    t.store.putOauthPending({ state, provider: "yunxiao", verifier: "v", redirectUri: "http://x/cb", clientId: "c", createdAt: Date.now() });
    assert.equal(t.store.takeOauthPending(state).clientId, "c");
    assert.equal(t.store.takeOauthPending(state), undefined);
    t.store.putOauthPending({ state: "s2", provider: "yunxiao", verifier: "v", redirectUri: "http://x/cb", clientId: "c", createdAt: Date.now() - 11 * 60 * 1000 });
    t.store.pruneOauthPending();
    assert.equal(t.store.state().oauth.s2, undefined);
  } finally { t.cleanup(); }
});

test("cache: TTL + token fingerprint isolation", () => {
  const t = tempStore();
  try {
    t.store.cacheSet("yunxiao", "token-a", "k", { v: 1 });
    assert.deepEqual(t.store.cacheGet("yunxiao", "token-a", "k", 1000), { v: 1 });
    assert.equal(t.store.cacheGet("yunxiao", "token-b", "k", 1000), undefined);
    assert.equal(t.store.cacheGet("yunxiao", "token-a", "k", -1), undefined);
    assert.notEqual(fingerprintOf("a"), fingerprintOf("b"));
    assert.equal(fingerprintOf(undefined), "anon");
  } finally { t.cleanup(); }
});
