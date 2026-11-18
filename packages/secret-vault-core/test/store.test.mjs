// Encrypted vault store: round-trip, rotation, scopes, fail-closed unlock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultStore, VaultError, CHECK_PLAINTEXT } from "../src/store.ts";
import { createKeyFile, encryptValue, writeFileAtomic } from "../src/crypto.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vault-store-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("first write creates keyfile + encrypted file; get round-trips", () => {
  withDir((dir) => {
    const store = new VaultStore({ dir, cwd: "/proj/a" });
    assert.equal(store.initialized, false);
    const res = store.add("openai-key", SECRET, { desc: "OpenAI", tags: ["llm"] });
    assert.equal(res.created, true);
    assert.equal(res.version, 1);
    assert.equal(res.scope, "global");
    assert.equal(store.initialized, true);
    // file contains metadata but never the value
    const raw = readFileSync(join(dir, "global.json"), "utf8");
    assert.ok(!raw.includes(SECRET));
    assert.ok(raw.includes("openai-key"));
    const got = store.get("openai-key");
    assert.equal(got.value, SECRET);
    assert.equal(got.info.desc, "OpenAI");
    assert.deepEqual(got.info.tags, ["llm"]);
  });
});

test("rotation keeps createdAt and increments version; lastUsed attribution", () => {
  withDir((dir) => {
    const store = new VaultStore({ dir, cwd: "/proj/a" });
    const first = store.add("k", SECRET);
    const second = store.add("k", "9pQrStUvWx3y4z5A6b7C8d9E0f1", { desc: "rotated" });
    assert.equal(second.created, false);
    assert.equal(second.version, 2);
    const got = store.get("k", { touch: true, sessionId: "s1" });
    assert.equal(got.value, "9pQrStUvWx3y4z5A6b7C8d9E0f1");
    assert.equal(got.info.version, 2);
    assert.equal(got.info.lastUsedSession, "s1");
    assert.ok(got.info.lastUsedAt);
    assert.equal(first.version, 1);
  });
});

test("project bucket shadows global; remove deletes both records", () => {
  withDir((dir) => {
    const store = new VaultStore({ dir, cwd: "/proj/a" });
    store.add("shared", SECRET);
    const project = store.add("shared", "9pQrStUvWx3y4z5A6b7C8d9E0f1", { project: true });
    assert.equal(project.scope, "project");
    assert.equal(store.get("shared").value, "9pQrStUvWx3y4z5A6b7C8d9E0f1");
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].scope, "project");
    assert.equal(store.remove("shared"), 2);
    assert.equal(store.list().length, 0);
  });
});

test("wrong keyfile fails closed with a clear error", () => {
  withDir((dir) => {
    const store = new VaultStore({ dir, cwd: "/p" });
    store.add("k", SECRET);
    // replace the key with a different one
    createKeyFile(join(dir, "master.key"));
    const other = new VaultStore({ dir, cwd: "/p" });
    try {
      other.get("k");
      assert.fail("expected a fail-closed error");
    } catch (e) {
      assert.ok(e instanceof VaultError);
      assert.equal(e.code, "bad-key");
      assert.match(e.message, /does not unlock/);
    }
  });
});

test("unknown alias and locked read produce actionable errors", () => {
  withDir((dir) => {
    const store = new VaultStore({ dir, cwd: "/p" });
    assert.throws(() => store.get("nope"), /not initialized/);
    store.add("k", SECRET);
    assert.throws(() => store.get("nope"), /no entry named "nope"/);
    store.lock();
    assert.equal(store.unlock().ok, true);
    assert.equal(store.status().globalEntries, 1);
  });
});

test("missing keyfile with existing vault data fails closed (no silent re-key)", () => {
  withDir((dir) => {
    const store = new VaultStore({ dir, cwd: "/p" });
    store.add("k", SECRET);
    rmSync(join(dir, "master.key"));
    const reopened = new VaultStore({ dir, cwd: "/p" });
    try {
      reopened.add("other", SECRET);
      assert.fail("expected missing-key error");
    } catch (e) {
      assert.ok(e instanceof VaultError);
      assert.equal(e.code, "missing-key");
      assert.match(e.message, /restore it/);
    }
  });
});

test("alias / value validation", () => {
  withDir((dir) => {
    const store = new VaultStore({ dir, cwd: "/p" });
    assert.throws(() => store.add("bad alias!", SECRET), /alias must be/);
    assert.throws(() => store.add("k", "abc"), /at least 6/);
  });
});

test("file permissions are 0600 where the platform supports it", { skip: process.platform === "win32" }, () => {
  withDir((dir) => {
    const store = new VaultStore({ dir, cwd: "/p" });
    store.add("k", SECRET);
    assert.equal(statSync(join(dir, "master.key")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "global.json")).mode & 0o777, 0o600);
  });
});

test("malformed vault file is rejected, not silently overwritten", () => {
  withDir((dir) => {
    const key = createKeyFile(join(dir, "master.key"));
    writeFileSync(join(dir, "global.json"), JSON.stringify({ version: 1, entries: {}, check: encryptValue(key, CHECK_PLAINTEXT) }));
    const store = new VaultStore({ dir, cwd: "/p" });
    assert.equal(store.list().length, 0);
    writeFileAtomic(join(dir, "global.json"), JSON.stringify({ nope: true }));
    assert.throws(() => store.list(), /not a v1 vault file/);
  });
});

test("status reports scopes without decrypting", () => {
  withDir((dir) => {
    const store = new VaultStore({ dir, cwd: "/p" });
    const st = store.status();
    assert.equal(st.initialized, false);
    assert.ok(st.scopes.project.includes("vault."));
    store.add("a", SECRET);
    store.add("b", SECRET.slice(1) + "x", { project: true });
    const st2 = store.status();
    assert.equal(st2.globalEntries, 1);
    assert.equal(st2.projectEntries, 1);
  });
});
