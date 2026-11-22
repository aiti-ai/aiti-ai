// /secret command handling + explicit snapshot logic (drive the pure handler).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSecretCommand, saveSnapshot, loadSnapshot, legacyPersistExists } from "../src/commands.ts";
import { Registry } from "../src/mask.ts";
import { RulesSource } from "../src/rules.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";
const PLACEHOLDER = /rsec_[0-9a-f]{8}/;

function mkState(overrides = {}) {
  return {
    registry: new Registry(),
    enabled: true,
    salt: "salt",
    cwd: "/proj/a",
    persisted: false,
    audit: false,
    persistPath: "/tmp/secret-mask-core-test/secret-mask.json",
    auditPath: "/tmp/secret-mask-core-test/audit.log",
    landing: "plain",
    guard: true,
    strict: false,
    ...overrides,
  };
}

test("help and unknown subcommand", async () => {
  const s = mkState();
  const h = await handleSecretCommand(s, "", {});
  assert.match(h.text, /secret-mask commands/);
  assert.match(h.text, /landing/);
  const bad = await handleSecretCommand(s, "wat", {});
  assert.equal(bad.ok, false);
});

test("add with alias, list shows placeholder → alias, remove", async () => {
  const s = mkState();
  const add = await handleSecretCommand(s, `add ${SECRET} as github-token`, {});
  assert.ok(add.ok);
  assert.match(add.text, PLACEHOLDER);
  const placeholder = s.registry.entries()[0].placeholder;
  const addNoAlias = await handleSecretCommand(s, `add ${SECRET.slice(1)}x`, {});
  assert.ok(addNoAlias.ok);
  const list = await handleSecretCommand(s, "list", {});
  assert.match(list.text, /2 value\(s\)/);
  assert.ok(list.text.includes(`${placeholder} → github-token`), "human-readable mapping");
  assert.ok(!list.text.includes(SECRET), "full value never shown");
  const rm = await handleSecretCommand(s, "remove github-token", {});
  assert.ok(rm.ok);
  assert.equal(s.registry.size, 1);
  const rmMissing = await handleSecretCommand(s, "remove nope", {});
  assert.equal(rmMissing.ok, false);
});

test("value with spaces + trailing as-alias parse", async () => {
  const s = mkState();
  const pem = `-----BEGIN RSA PRIVATE KEY-----\nAbCdEfGhIjKlMnOp\n-----END RSA PRIVATE KEY-----`;
  const add = await handleSecretCommand(s, `add ${pem} as my-pem`, {});
  assert.ok(add.ok);
  assert.equal(s.registry.entries()[0].alias, "my-pem");
  // alias parse must not swallow values containing "as"
  const v = "abc123 as456 def789 as real-one";
  const add2 = await handleSecretCommand(s, `add ${v}`, {});
  assert.ok(add2.ok);
  assert.equal(s.registry.entries().find((e) => e.alias === "real-one")?.value, "abc123 as456 def789");
});

test("masked interactive add (with and without explicit alias)", async () => {
  const s = mkState();
  const add = await handleSecretCommand(s, "add", { input: async () => SECRET });
  assert.ok(add.ok);
  assert.equal(s.registry.size, 1);
  const named = await handleSecretCommand(s, "add --alias prod-key", { input: async () => "9pQrStUvWx3y4z5A6b7C8d9E0f1" });
  assert.ok(named.ok);
  assert.equal(s.registry.entries().find((e) => e.alias === "prod-key")?.source, "manual");
  const cancel = await handleSecretCommand(s, "add", { input: async () => "" });
  assert.equal(cancel.ok, false);
});

test("on/off/status/landing/guard/strict", async () => {
  const s = mkState();
  await handleSecretCommand(s, "off", {});
  assert.equal(s.enabled, false);
  assert.match((await handleSecretCommand(s, "status", {})).text, /OFF/);
  await handleSecretCommand(s, "on", {});
  const st = (await handleSecretCommand(s, "status", {})).text;
  assert.match(st, /landing plain/);
  assert.match(st, /guard ON/);
  assert.match(st, /strict OFF/);

  const land = await handleSecretCommand(s, "landing ephemeral", {});
  assert.ok(land.ok);
  assert.equal(s.landing, "ephemeral");
  assert.match(land.text, /not persisted/);
  const bad = await handleSecretCommand(s, "landing vault", {});
  assert.equal(bad.ok, false, "mask-only hosts cannot land in the vault");
  const show = await handleSecretCommand(s, "landing", {});
  assert.match(show.text, /current: ephemeral/);

  await handleSecretCommand(s, "guard off", {});
  assert.equal(s.guard, false);
  await handleSecretCommand(s, "strict on", {});
  assert.equal(s.strict, true);
});

test("too-short value rejected", async () => {
  const s = mkState();
  const add = await handleSecretCommand(s, "add abc", {});
  assert.equal(add.ok, false);
  assert.match(add.text, /rejected/);
});

test("explicit snapshot round-trip preserves placeholders (no implicit state)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-mask-test-"));
  const path = join(dir, "snapshot.json");
  try {
    const s = mkState();
    const ph = s.registry.registerManual(SECRET, "persisted-key", { salt: s.salt }).entry.placeholder;
    const save = await handleSecretCommand(s, `save ${path}`, {});
    assert.ok(save.ok);
    assert.ok(existsSync(path));
    assert.ok(readFileSync(path, "utf8").includes(ph));
    // fresh registry loads the same token back
    const s2 = mkState();
    const load = await handleSecretCommand(s2, `load ${path}`, {});
    assert.ok(load.ok);
    assert.equal(s2.registry.size, 1);
    assert.equal(s2.registry.entries()[0].placeholder, ph);
    assert.equal(s2.registry.restore(ph).text, SECRET);
    // idempotent second load
    assert.equal(loadSnapshot(s2.registry, path).loaded, 0);
    // no file argument → usage error (nothing implicit)
    assert.equal((await handleSecretCommand(s, "save", {})).ok, false);
    assert.equal((await handleSecretCommand(s, "load", {})).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy v1 persist file still loads (migration)", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-mask-legacy-"));
  const path = join(dir, "secret-mask.json");
  try {
    const legacy = {
      version: 1,
      projects: { "/proj/a": [{ placeholder: "[REDACTED:old-key]", value: SECRET, label: "old-key", source: "manual" }] },
    };
    writeFileSync(path, JSON.stringify(legacy));
    const registry = new Registry();
    const res = loadSnapshot(registry, path, { cwd: "/proj/a" });
    assert.equal(res.loaded, 1);
    assert.equal(registry.restore("[REDACTED:old-key]").text, SECRET);
    assert.equal(legacyPersistExists(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send-audit: payload proof scan + command toggle + evidence log", async () => {
  const { auditPayload } = await import("../src/mask.ts");
  const { appendAuditLog, readAuditTail } = await import("../src/commands.ts");
  const s = mkState();
  const ph1 = s.registry.registerManual(SECRET, "audit-key").entry.placeholder;
  const ph2 = s.registry.registerManual("9pQrStUvWx3y4z5A6b7C8d9E0f1", "audit-key-2").entry.placeholder;

  // payload where the model saw placeholders and a tool echoed one raw value back
  const dirty = {
    messages: [
      { role: "user", content: `put ${ph1} into config` },
      { role: "assistant", content: [{ type: "text", text: `using ${ph1} and ${ph2}` }] },
      { role: "toolResult", content: [{ type: "text", text: `echoed ${SECRET}` }] },
    ],
  };
  const a = auditPayload(dirty, s.registry);
  assert.equal(a.placeholders, 3);
  assert.equal(a.leaks, 1);
  assert.deepEqual(a.leakedLabels, ["audit-key"]);

  const clean = auditPayload({ messages: [{ role: "user", content: "nothing here" }] }, s.registry);
  assert.equal(clean.leaks, 0);
  assert.equal(clean.placeholders, 0);

  // toggle + evidence log round-trip
  assert.match((await handleSecretCommand(s, "audit on", {})).text, /ON/);
  assert.match((await handleSecretCommand(s, "audit off", {})).text, /OFF/);
  await handleSecretCommand(s, "audit on", {});
  const dir = mkdtempSync(join(tmpdir(), "secret-mask-audit-"));
  try {
    const log = join(dir, "audit.log");
    assert.equal(appendAuditLog({ time: "t", sessionId: "s", purpose: "conversation", strings: 3, placeholders: 3, leaks: 1, leakedLabels: ["audit-key"] }, log), undefined);
    s.auditPath = log;
    const show = await handleSecretCommand(s, "audit show", {});
    assert.match(show.text, /audit evidence/);
    assert.ok(show.text.includes("audit-key"), "labels recorded, raw values never");
    assert.ok(!show.text.includes(SECRET), "raw value never in the evidence log");
    assert.equal(readAuditTail(5, log).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custom rules: add via command, hot reload, remove", async () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-mask-rules-"));
  const path = join(dir, "secret-mask-rules.json");
  try {
    const source = new RulesSource(path, "/proj/a");
    const s = mkState({
      rulesPath: path,
      rules: [],
      reloadRules() {
        this.rules = source.reload();
      },
    });
    const add = await handleSecretCommand(s, "rule add corp-token regex acme_[0-9a-f]{16} --global", {
      reloadRules: () => {
        s.rules = source.reload();
      },
    });
    assert.ok(add.ok, add.text);
    assert.equal(s.rules.length, 1);
    assert.equal(s.rules[0].label, "corp-token");
    assert.match((await handleSecretCommand(s, "rule list", {})).text, /corp-token/);
    const rm = await handleSecretCommand(s, "rule remove corp-token", {
      reloadRules: () => {
        s.rules = source.reload();
      },
    });
    assert.ok(rm.ok);
    assert.equal(s.rules.length, 0);
    const bad = await handleSecretCommand(s, "rule add broken regex ([", {});
    assert.equal(bad.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
