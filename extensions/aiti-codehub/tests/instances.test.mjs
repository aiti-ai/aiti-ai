/**
 * Multi-account instances: id rules, store CRUD, migration and delete cascade.
 *
 * The default instance keeps the platform id, so every pre-multi-account file/state key
 * must keep working untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import {
  deriveInstanceId,
  instanceIdOf,
  instanceLabel,
  isDefaultInstanceId,
  isValidInstanceId,
  normalizeAlias,
  platformOf,
  slugFromAlias,
  slugOf,
} from "../server/instances.ts";

function tempStore() {
  const root = mkdtempSync(join(tmpdir(), "codehub-inst-"));
  const store = new Store({ configDir: join(root, "config"), stateDir: join(root, "state"), cacheDir: join(root, "cache") });
  return { root, store, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("instance id helpers: platform / slug round-trip and validation", () => {
  assert.equal(platformOf("yunxiao"), "yunxiao");
  assert.equal(platformOf("yunxiao~work"), "yunxiao");
  assert.equal(slugOf("yunxiao~work"), "work");
  assert.equal(slugOf("yunxiao"), "");
  assert.equal(instanceIdOf("yunxiao", "work"), "yunxiao~work");
  assert.equal(instanceIdOf("yunxiao"), "yunxiao");
  assert.equal(isDefaultInstanceId("yunxiao"), true);
  assert.equal(isDefaultInstanceId("yunxiao~work"), false);
  assert.equal(isValidInstanceId("yunxiao~work"), true);
  assert.equal(isValidInstanceId("yunxiao~work-2"), true);
  assert.equal(isValidInstanceId("../evil"), false);
  assert.equal(isValidInstanceId("yunxiao~"), false);
  assert.equal(isValidInstanceId("Yunxiao"), false);
  assert.equal(isValidInstanceId("x".repeat(65)), false);
});

test("slug derivation falls back for non-latin aliases", () => {
  assert.equal(slugFromAlias("Work 2"), "work-2");
  assert.equal(slugFromAlias("cexp-ci"), "cexp-ci");
  assert.equal(slugFromAlias("公司云效"), null);
  assert.equal(slugFromAlias("!!!"), null);
  const taken = new Set(["github~work"]);
  assert.equal(deriveInstanceId("github", "Work", taken), "github~work-2");
  const zh = deriveInstanceId("yunxiao", "公司云效", new Set());
  assert.match(zh, /^yunxiao~inst-[a-z0-9]+$/);
});

test("alias normalization + label rules", () => {
  assert.equal(normalizeAlias("  个人云效  "), "个人云效");
  assert.throws(() => normalizeAlias("   "), /alias must not be empty/i);
  assert.throws(() => normalizeAlias("x".repeat(41)), /limited to 40/i);
  assert.equal(instanceLabel({ id: "yunxiao", platform: "yunxiao", alias: "" }, "云效"), "云效");
  assert.equal(instanceLabel({ id: "yunxiao~work", platform: "yunxiao", alias: "工作" }, "云效"), "工作");
  assert.equal(instanceLabel({ id: "yunxiao~work", platform: "yunxiao", alias: "" }, "云效"), "云效 work");
});

test("legacy platform file is the default instance; temp files are ignored", () => {
  const t = tempStore();
  try {
    t.store.saveProvider("yunxiao", { authType: "pat", token: "legacy" });
    const dir = join(t.store.dirs.configDir, "providers");
    writeFileSync(join(dir, "yunxiao~work.json.tmp-1-abcd"), "{}");
    writeFileSync(join(dir, "Yunxiao.json"), "{}");
    const list = t.store.instances();
    assert.deepEqual(list.map((i) => i.id), ["yunxiao"]);
    assert.equal(t.store.hasInstance("yunxiao"), true);
    assert.equal(t.store.provider("yunxiao").token, "legacy");
  } finally {
    t.cleanup();
  }
});

test("createInstance derives ids, enforces alias uniqueness and per-platform caps", () => {
  const t = tempStore();
  try {
    const a = t.store.createInstance("github", "Work");
    assert.equal(a.id, "github"); // first account materializes the default instance
    assert.equal(t.store.provider(a.id).alias, "Work");
    assert.equal(t.store.provider(a.id).aliasAuto, true);
    assert.equal(t.store.provider(a.id).platform, "github");

    assert.throws(() => t.store.createInstance("github", "work"), /Alias already in use/);
    const b = t.store.createInstance("github", "Second");
    assert.equal(b.id, "github~second");
  } finally {
    t.cleanup();
  }
});

test("createInstance keeps ids unique and supports 20 accounts max", () => {
  const t = tempStore();
  try {
    const ids = new Set();
    for (let i = 1; i <= 20; i += 1) {
      const inst = t.store.createInstance("yunxiao", `acct ${i}`);
      ids.add(inst.id);
      if (i === 1) {
        // duplicate alias hits the uniqueness guard, not the cap
        assert.throws(() => t.store.createInstance("yunxiao", "acct 1"), /Alias already in use/);
      }
    }
    assert.equal(ids.size, 20);
    assert.equal(t.store.instancesOf("yunxiao").length, 20);
    assert.throws(() => t.store.createInstance("yunxiao", "overflow"), /At most 20/);
  } finally {
    t.cleanup();
  }
});

test("rename keeps the id stable and blocks duplicate aliases", () => {
  const t = tempStore();
  try {
    const a = t.store.createInstance("yunxiao", "个人");
    const b = t.store.createInstance("yunxiao", "公司");
    t.store.renameInstance(a.id, "个人云效");
    assert.equal(t.store.provider(a.id).alias, "个人云效");
    assert.equal(t.store.provider(a.id).aliasAuto, false);
    assert.equal(existsSync(join(t.store.dirs.configDir, "providers", `${a.id}.json`)), true);
    assert.throws(() => t.store.renameInstance(a.id, "公司"), /Alias already in use/);
    assert.equal(t.store.renameInstance(b.id, "公司云效").alias, "公司云效");
    assert.throws(() => t.store.renameInstance("yunxiao~nope", "x"), /unknown account/);
  } finally {
    t.cleanup();
  }
});

test("resolveInstance matches alias, slug and instance id", () => {
  const t = tempStore();
  try {
    const a = t.store.createInstance("github", "working");
    assert.equal(t.store.resolveInstance("github", "working"), a.id);
    assert.equal(t.store.resolveInstance("github", "Working"), a.id);
    assert.equal(t.store.resolveInstance("github", "working"), a.id); // slug = alias here
    assert.equal(t.store.resolveInstance("github", "work"), undefined); // no prefix matching
    assert.equal(t.store.resolveInstance("github", a.id), a.id);
    assert.equal(t.store.resolveInstance("github", "nope"), undefined);
  } finally {
    t.cleanup();
  }
});

test("two accounts of one platform never share config or cache", () => {
  const t = tempStore();
  try {
    const a = t.store.createInstance("yunxiao", "A");
    const b = t.store.createInstance("yunxiao", "B");
    t.store.saveProvider(a.id, { token: "tok-a" });
    t.store.saveProvider(b.id, { token: "tok-b" });
    assert.equal(t.store.provider(a.id).token, "tok-a");
    assert.equal(t.store.provider(b.id).token, "tok-b");

    t.store.cacheSet(a.id, "tok-a", "k", { v: 1 });
    t.store.cacheSet(b.id, "tok-b", "k", { v: 2 });
    assert.deepEqual(t.store.cacheGet(a.id, "tok-a", "k", 60_000), { v: 1 });
    assert.deepEqual(t.store.cacheGet(b.id, "tok-b", "k", 60_000), { v: 2 });
    assert.deepEqual(t.store.cacheGet(b.id, "tok-a", "k", 60_000), undefined);
  } finally {
    t.cleanup();
  }
});

test("deleteInstance purges config, state, cache, pending oauth and default pointer", () => {
  const t = tempStore();
  try {
    const a = t.store.createInstance("yunxiao", "A");
    const b = t.store.createInstance("yunxiao", "B");
    t.store.saveProvider(a.id, { token: "x" });
    t.store.toggleFavorite(a.id, "repos", "o/r");
    t.store.toggleFavorite(b.id, "repos", "o/r2");
    t.store.addRecent({ provider: a.id, kind: "repo", id: "o/r", label: "r" });
    t.store.addRecent({ provider: b.id, kind: "repo", id: "o/r2", label: "r2" });
    t.store.markUsage(a.id, "1", "ai");
    t.store.markUsage(b.id, "2", "ai");
    t.store.putOauthPending({ state: "s-a", provider: a.id, instance: a.id, verifier: "v", redirectUri: "https://x/cb", clientId: "cid", createdAt: Date.now() });
    t.store.cacheSet(a.id, "x", "k", { v: 1 });
    t.store.saveGlobal({ defaultInstance: a.id });

    assert.equal(t.store.deleteInstance(a.id), true);
    assert.equal(t.store.hasInstance(a.id), false);
    assert.equal(t.store.hasInstance(b.id), true);
    assert.equal(existsSync(join(t.store.dirs.cacheDir, a.id)), false);

    const state = t.store.state();
    assert.equal(state.favorites[a.id], undefined);
    assert.deepEqual(state.recents.map((r) => r.provider), [b.id]);
    assert.equal(state.usage[`${a.id}:1`], undefined);
    assert.equal(state.usage[`${b.id}:2`] !== undefined, true);
    assert.equal(state.oauth["s-a"], undefined);
    assert.equal(t.store.global().defaultInstance, undefined);
    assert.equal(t.store.deleteInstance(a.id), false);
  } finally {
    t.cleanup();
  }
});
