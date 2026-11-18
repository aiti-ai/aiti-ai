// /vault command surface, AI tools (vault_list/vault_get) and landing adapter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "@aiti-ai/secret-mask-core";
import { VaultStore } from "../src/store.ts";
import { handleVaultCommand } from "../src/commands.ts";
import { vaultGet, vaultList } from "../src/tools.ts";
import { landValueInVault } from "../src/landing.ts";
import { parseEnvFile, importEnvFile, importProcessEnv, aliasFromEnvName } from "../src/entries.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";
const OTHER = "9pQrStUvWx3y4z5A6b7C8d9E0f1";

function mk(dir, cwd = "/proj/a") {
  const store = new VaultStore({ dir, cwd });
  const registry = new Registry();
  registry.salt = "salt";
  return { store, registry, state: { store, registry, sessionId: "s1", cwd } };
}

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "vault-cmd-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("add (masked input) → list → get mounts a stable placeholder", async () => {
  await withDir(async (dir) => {
    const { state } = mk(dir);
    const add = await handleVaultCommand(state, "add openai-key OpenAI production --tags llm,prod", { input: async () => SECRET });
    assert.ok(add.ok, add.text);
    assert.match(add.text, /added "openai-key" v1 \[global\]/);
    assert.ok(!add.text.includes(SECRET));

    const list = await handleVaultCommand(state, "list", {});
    assert.match(list.text, /openai-key \[global\] v1 — OpenAI production \(llm,prod\)/);
    assert.ok(!list.text.includes(SECRET));

    const got = await handleVaultCommand(state, "get openai-key", {});
    assert.ok(got.ok);
    const ph = state.registry.entries()[0].placeholder;
    assert.match(ph, /^rsec_[0-9a-f]{8}$/);
    assert.ok(got.text.includes(ph));
    assert.equal(state.registry.getOutputForTest, undefined); // no such API; value access below
    assert.equal(state.registry.restore(ph).text, SECRET);
  });
});

test("add without input surface fails closed; aliases validated", async () => {
  await withDir(async (dir) => {
    const { state } = mk(dir);
    assert.equal((await handleVaultCommand(state, "add k", {})).ok, false);
    const bad = await handleVaultCommand(state, "add bad@alias", { input: async () => SECRET });
    assert.equal(bad.ok, false);
  });
});

test("rotate via set bumps version and remounts the same placeholder", async () => {
  await withDir(async (dir) => {
    const { state } = mk(dir);
    await handleVaultCommand(state, "add k", { input: async () => SECRET });
    await handleVaultCommand(state, "get k", {});
    const ph = state.registry.entries()[0].placeholder;
    const rot = await handleVaultCommand(state, "set k", { input: async () => OTHER });
    assert.ok(rot.ok);
    assert.match(rot.text, /rotated "k" v2/);
    const got = await handleVaultCommand(state, "get k", {});
    assert.ok(got.ok);
    assert.equal(state.registry.entries()[0].placeholder, ph, "stable placeholder survives rotation");
    assert.equal(state.registry.restore(ph).text, OTHER);
    const missing = await handleVaultCommand(state, "set nope", { input: async () => OTHER });
    assert.equal(missing.ok, false);
  });
});

test("reveal never prints the value; requires a UI surface", async () => {
  await withDir(async (dir) => {
    const { state } = mk(dir);
    await handleVaultCommand(state, "add k", { input: async () => SECRET });
    const noUi = await handleVaultCommand(state, "reveal k", {});
    assert.equal(noUi.ok, false);
    assert.ok(!noUi.text.includes(SECRET));
    let shown = "";
    let copied = "";
    const res = await handleVaultCommand(state, "reveal k", {
      show: (_title, value) => {
        shown = value;
      },
      copy: (value) => {
        copied = value;
      },
    });
    assert.ok(res.ok);
    assert.equal(shown, SECRET);
    assert.equal(copied, SECRET);
    assert.ok(!res.text.includes(SECRET), "value never in the returned text");
  });
});

test("remove requires confirmation and invalidates the mount", async () => {
  await withDir(async (dir) => {
    const { state } = mk(dir);
    await handleVaultCommand(state, "add k", { input: async () => SECRET });
    await handleVaultCommand(state, "get k", {});
    const ph = state.registry.entries()[0].placeholder;
    const cancelled = await handleVaultCommand(state, "remove k", { confirm: async () => false });
    assert.equal(cancelled.ok, false);
    assert.ok(state.store.find("k"));
    const removed = await handleVaultCommand(state, "remove k", { confirm: async () => true });
    assert.ok(removed.ok);
    assert.equal(state.store.find("k"), undefined);
    assert.equal(state.registry.restore(ph).count, 0, "forget-style removal: no redirect");
  });
});

test("forget unmounts vault aliases only", async () => {
  await withDir(async (dir) => {
    const { state } = mk(dir);
    await handleVaultCommand(state, "add k", { input: async () => SECRET });
    await handleVaultCommand(state, "get k", {});
    state.registry.registerManual(OTHER, "session-only");
    const res = await handleVaultCommand(state, "forget", {});
    assert.ok(res.ok);
    const aliases = state.registry.entries().map((e) => e.alias);
    assert.deepEqual(aliases, ["session-only"]);
  });
});

test("status / scope / mode / lock / unlock", async () => {
  await withDir(async (dir) => {
    const { state } = mk(dir);
    assert.match((await handleVaultCommand(state, "status", {})).text, /not initialized/);
    assert.match((await handleVaultCommand(state, "mode", {})).text, /keyfile/);
    const kc = await handleVaultCommand(state, "mode keychain", {});
    assert.ok(kc.ok, kc.text);
    assert.equal(state.store.mode, "keychain");
    const back = await handleVaultCommand(state, "mode keyfile", {});
    assert.ok(back.ok, back.text);
    assert.equal(state.store.mode, "keyfile");
    await handleVaultCommand(state, "add k", { input: async () => SECRET });
    assert.match((await handleVaultCommand(state, "scope", {})).text, /global:.*global\.json/);
    assert.match((await handleVaultCommand(state, "lock", {})).text, /locked/);
    assert.match((await handleVaultCommand(state, "unlock", {})).text, /unlocked/);
    const st = (await handleVaultCommand(state, "status", {})).text;
    assert.match(st, /1 global/);
    assert.match(st, /mode: keyfile/);
  });
});

test("capture stores command stdout without echoing it", async () => {
  await withDir(async (dir) => {
    const { state } = mk(dir);
    const cmd = process.platform === "win32" ? `echo ${SECRET}` : `printf '%s' "${SECRET}"`;
    const res = await handleVaultCommand(state, `capture cap-key -- ${cmd}`, {});
    assert.ok(res.ok, res.text);
    assert.ok(!res.text.includes(SECRET));
    const got = await handleVaultCommand(state, "get cap-key", {});
    assert.ok(got.ok);
    assert.equal(state.registry.restore(state.registry.entries()[0].placeholder).text, SECRET);
    // empty output and failing commands are refused
    const big = await handleVaultCommand(state, `capture big -- ${process.platform === "win32" ? "type nul" : "true"}`, {});
    assert.equal(big.ok, false, "empty capture refused (too short)");
    const failing = await handleVaultCommand(state, `capture bad -- ${process.platform === "win32" ? "exit 3" : "exit 3"}`, {});
    assert.equal(failing.ok, false, "non-zero exit refused");
    assert.match(failing.text, /exited with 3/);
  });
}, { timeout: 30_000 });

test("import .env file + env scan", async () => {
  await withDir(async (dir) => {
    const { state } = mk(dir);
    const file = join(dir, "test.env");
    writeFileSync(file, `# comment\nexport API_TOKEN="${SECRET}"\nPLAIN_VAR=short\n`);
    const res = await handleVaultCommand(state, `import ${file} --project`, {});
    assert.ok(res.ok, res.text);
    assert.match(res.text, /1 added/);
    assert.equal(state.store.find("api_token")?.scope, "project");
    const envRes = importProcessEnv(state.store, { env: { MY_SERVICE_SECRET: OTHER, PATH: "/usr/bin", SHORT_TOKEN: "abc" } });
    assert.equal(envRes.added, 1);
    assert.ok(state.store.find("my_service_secret"));
    assert.equal(aliasFromEnvName("MY-SERVICE SECRET"), "my-service-secret");
    assert.deepEqual(parseEnvFile("A=1\nB='x y'\n"), [{ key: "A", value: "1" }, { key: "B", value: "x y" }]);
  });
});

test("AI tools: vault_list returns metadata only, vault_get mounts", () => {
  withDir((dir) => {
    const { state } = mk(dir);
    state.store.add("openai-key", SECRET, { desc: "OpenAI" });
    const list = vaultList(state);
    assert.match(list.content[0].text, /openai-key/);
    assert.ok(!list.content[0].text.includes(SECRET));
    const got = vaultGet(state, { alias: "openai-key" });
    const text = got.content[0].text;
    assert.match(text, /^rsec_[0-9a-f]{8}\n/);
    assert.match(text, /This token IS a working credential/);
    assert.ok(!text.includes(SECRET));
    const ph = got.details.placeholder;
    assert.equal(state.registry.restore(ph).text, SECRET);
    // missing alias → actionable error
    assert.throws(() => vaultGet(state, { alias: "nope" }), /no entry named "nope"/);
    assert.throws(() => vaultGet(state, {}), /requires \{ alias \}/);
    // empty vault list is a hint, not an error
    const empty = vaultList({ store: new VaultStore({ dir: join(dir, "empty"), cwd: "/p" }), registry: new Registry() });
    assert.match(empty.content[0].text, /no entries/);
  });
});

test("vault landing: auto-captures once and reuses the alias", () => {
  withDir((dir) => {
    const { state } = mk(dir);
    const first = landValueInVault(state, SECRET, "GITHUB_TOKEN");
    assert.ok(first);
    assert.equal(first.created, true);
    assert.match(first.alias, /^auto-github-token-/);
    assert.equal(state.store.find(first.alias)?.tags?.[0], "auto");
    const second = landValueInVault(state, SECRET, "GITHUB_TOKEN");
    assert.equal(second.alias, first.alias);
    assert.equal(second.created, false);
    assert.equal(state.store.list().length, 1);
  });
});

test("landing keeps working when the vault is unreadable (returns undefined)", () => {
  withDir((dir) => {
    const { state } = mk(dir);
    state.store.add("k", SECRET);
    // corrupt the file → landing must not throw into the hook chain
    writeFileSync(join(dir, "global.json"), "not json");
    assert.equal(landValueInVault(state, OTHER, "X"), undefined);
  });
});
