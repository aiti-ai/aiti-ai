// Server API: status/entries/add/reveal/remove/lock/mode/sessions (no pi host needed).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultStore, writeSessionRecord } from "@aiti-ai/secret-vault-core";
import { createVaultApi } from "../index.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";

function fakeKeychain() {
  const m = new Map();
  return {
    backend: "linux-secret-tool",
    available: () => true,
    get: () => m.get("k"),
    set: (v) => m.set("k", v),
    delete: () => m.delete("k"),
  };
}

function mk() {
  const dir = mkdtempSync(join(tmpdir(), "sv-ext-"));
  const keychain = fakeKeychain();
  const store = new VaultStore({ dir, cwd: "/proj", keychain, modePath: join(dir, "config.json") });
  const sessionStatePath = join(dir, "session-state.json");
  const api = createVaultApi({ store, sessionStatePath });
  const call = (method, path, body) =>
    api(new Request(`http://local/api/extensions/aiti-secret-vault/${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }), { path: path.split("/").filter(Boolean) });
  return { dir, store, api, call, sessionStatePath, keychain };
}

async function withTmp(fn) {
  const ctx = mk();
  try {
    return await fn(ctx);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
}

test("status → add → entries → reveal → remove", async () => {
  await withTmp(async ({ call }) => {
    let res = await (await call("GET", "status")).json();
    assert.equal(res.ok, true);
    assert.equal(res.status.initialized, false);

    res = await (await call("POST", "entries", { alias: "openai-key", value: SECRET, desc: "OpenAI", tags: "llm,prod" })).json();
    assert.equal(res.ok, true);
    assert.equal(res.result.alias, "openai-key");

    const list = await (await call("GET", "entries")).json();
    assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0].desc, "OpenAI");
    assert.deepEqual(list.entries[0].tags, ["llm", "prod"]);
    assert.ok(!JSON.stringify(list).includes(SECRET), "values never in list responses");

    const reveal = await (await call("POST", "entries/openai-key/reveal")).json();
    assert.equal(reveal.value, SECRET);

    const gone = await (await call("DELETE", "entries/openai-key")).json();
    assert.equal(gone.ok, true);
    assert.equal((await (await call("DELETE", "entries/openai-key")).json()).ok, false);
  });
});

test("lock/unlock and mode switching", async () => {
  await withTmp(async ({ call, store }) => {
    await call("POST", "entries", { alias: "k", value: SECRET });
    let res = await (await call("POST", "lock")).json();
    assert.equal(res.ok, true);
    assert.equal(res.status.locked, true);
    res = await (await call("POST", "unlock")).json();
    assert.equal(res.ok, true);
    res = await (await call("POST", "mode", { mode: "keychain" })).json();
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(store.mode, "keychain");
    assert.equal(res.status.mode, "keychain");
    // invalid mode is rejected
    const bad = await (await call("POST", "mode", { mode: "nope" })).json();
    assert.equal(bad.ok, false);
  });
});

test("validation errors and 404", async () => {
  await withTmp(async ({ call }) => {
    assert.equal((await (await call("POST", "entries", { alias: "", value: "" })).json()).ok, false);
    assert.equal((await (await call("POST", "entries", { alias: "x", value: "short" })).json()).ok, false);
    assert.equal((await call("GET", "nope")).status, 404);
  });
});

test("sessions endpoint returns the zero-value records", async () => {
  await withTmp(async ({ call, sessionStatePath }) => {
    mkdirSync(join(sessionStatePath, ".."), { recursive: true });
    writeSessionRecord(sessionStatePath, "sess-1", { cwd: "/proj", landing: "vault", mounted: ["openai-key"] });
    const res = await (await call("GET", "sessions")).json();
    assert.deepEqual(res.sessions["sess-1"].mounted, ["openai-key"]);
    const status = await (await call("GET", "status")).json();
    assert.ok(status.sessions["sess-1"]);
  });
});
