// Unlock-mode switching: keyfile ↔ OS keychain (fake backend), re-encryption.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultStore, MODE_FILE } from "../src/store.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";

function fakeKeychain(initial) {
  const store = new Map();
  if (initial) store.set("master-key", initial);
  return {
    backend: "linux-secret-tool",
    available: () => true,
    get: () => store.get("master-key"),
    set: (v) => store.set("master-key", v),
    delete: () => store.delete("master-key"),
    _store: store,
  };
}

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vault-keychain-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("keyfile → keychain: re-encrypts, moves the key out of the vault dir", () => {
  withDir((dir) => {
    const keychain = fakeKeychain();
    const store = new VaultStore({ dir, cwd: "/p", keychain, modePath: join(dir, MODE_FILE) });
    store.add("k", SECRET);
    assert.equal(store.mode, "keyfile");
    assert.ok(existsSync(join(dir, "master.key")));
    const res = store.rekeyTo("keychain");
    assert.deepEqual(res, { ok: true, files: 1 });
    assert.equal(store.mode, "keychain");
    assert.ok(!existsSync(join(dir, "master.key")), "keyfile removed");
    assert.ok(keychain.get(), "key stored in the fake keychain");
    assert.ok(!readFileSync(join(dir, "global.json"), "utf8").includes(SECRET));
    // a fresh store reads the key from the keychain and decrypts the same value
    const reopened = new VaultStore({ dir, cwd: "/p", keychain, modePath: join(dir, MODE_FILE) });
    assert.equal(reopened.get("k").value, SECRET);
  });
});

test("keychain → keyfile: writes a keyfile and clears the keychain entry", () => {
  withDir((dir) => {
    const keychain = fakeKeychain();
    const store = new VaultStore({ dir, cwd: "/p", keychain, modePath: join(dir, MODE_FILE) });
    store.add("k", SECRET);
    store.rekeyTo("keychain");
    const res = store.rekeyTo("keyfile");
    assert.equal(res.files, 1);
    assert.equal(store.mode, "keyfile");
    assert.ok(existsSync(join(dir, "master.key")));
    assert.equal(keychain.get(), undefined, "keychain entry deleted");
    const reopened = new VaultStore({ dir, cwd: "/p", keychain, modePath: join(dir, MODE_FILE) });
    assert.equal(reopened.get("k").value, SECRET);
  });
});

test("switching mode before any data just persists the preference", () => {
  withDir((dir) => {
    const keychain = fakeKeychain();
    const store = new VaultStore({ dir, cwd: "/p", keychain, modePath: join(dir, MODE_FILE) });
    assert.deepEqual(store.rekeyTo("keychain"), { ok: true, files: 0 });
    assert.equal(store.mode, "keychain");
    // first write creates the key directly in the keychain
    store.add("k", SECRET);
    assert.ok(keychain.get());
    assert.ok(!existsSync(join(dir, "master.key")));
  });
});

test("keychain mode without a backend fails closed", () => {
  withDir((dir) => {
    const keychain = { ...fakeKeychain(), available: () => false, get: () => undefined };
    const store = new VaultStore({ dir, cwd: "/p", keychain, modePath: join(dir, MODE_FILE) });
    assert.throws(() => store.rekeyTo("keychain"), /no OS keychain backend/);
  });
});

test("status exposes mode and backend", () => {
  withDir((dir) => {
    const keychain = fakeKeychain();
    const store = new VaultStore({ dir, cwd: "/p", keychain, modePath: join(dir, MODE_FILE) });
    store.rekeyTo("keychain");
    const st = store.status();
    assert.equal(st.mode, "keychain");
    assert.equal(st.keychainBackend, "linux-secret-tool");
  });
});
