// /secret command handling + persistence logic (drive the pure handler).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSecretCommand, savePersist, loadPersist, clearPersist, PERSIST_PATH } from "../src/commands.ts";
// SecretState type is only used structurally here (plain .mjs test file).
import { Registry } from "../src/mask.ts";

const SECRET = "7fJk2mN9pQrStUvWx3y4z5A6b7C8d9E0";

function mkState() {
  return { registry: new Registry(), enabled: true, salt: "salt", cwd: "/proj/a", persisted: false };
}

test("help and unknown subcommand", async () => {
  const s = mkState();
  const h = await handleSecretCommand(s, "", {});
  assert.match(h.text, /secret-mask commands/);
  const bad = await handleSecretCommand(s, "wat", {});
  assert.equal(bad.ok, false);
});

test("add with alias, list, remove", async () => {
  const s = mkState();
  const add = await handleSecretCommand(s, `add ${SECRET} as github-token`, {});
  assert.ok(add.ok);
  assert.match(add.text, /\[REDACTED:github-token\]/);
  const addNoAlias = await handleSecretCommand(s, `add ${SECRET.slice(1)}x`, {});
  assert.ok(addNoAlias.ok);
  const list = await handleSecretCommand(s, "list", {});
  assert.match(list.text, /2 value\(s\)/);
  assert.match(list.text, /manual/);
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
  assert.match(add.text, /\[REDACTED:my-pem\]/);
  // alias parse must not swallow values containing "as"
  const v = "abc123 as456 def789 as real-one";
  const add2 = await handleSecretCommand(s, `add ${v}`, {});
  assert.ok(add2.ok);
  assert.match(add2.text, /\[REDACTED:real-one\]/);
  assert.equal(s.registry.byPlaceholderLookup("[REDACTED:real-one]")?.value, "abc123 as456 def789");
});

test("masked interactive add", async () => {
  const s = mkState();
  const add = await handleSecretCommand(s, "add", { input: async () => SECRET });
  assert.ok(add.ok);
  assert.equal(s.registry.size, 1);
  const cancel = await handleSecretCommand(s, "add", { input: async () => "" });
  assert.equal(cancel.ok, false);
});

test("on/off/status", async () => {
  const s = mkState();
  await handleSecretCommand(s, "off", {});
  assert.equal(s.enabled, false);
  const st = await handleSecretCommand(s, "status", {});
  assert.match(st.text, /OFF/);
  await handleSecretCommand(s, "on", {});
  assert.match((await handleSecretCommand(s, "status", {})).text, /ON/);
});

test("too-short value rejected", async () => {
  const s = mkState();
  const add = await handleSecretCommand(s, "add abc", {});
  assert.equal(add.ok, false);
  assert.match(add.text, /rejected/);
});

test("save/load/unload persistence round-trip (temp path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-mask-test-"));
  const path = join(dir, "secret-mask.json");
  try {
    const s = mkState();
    s.registry.registerManual(SECRET, "persisted-key");
    const err = savePersist(s, path);
    assert.equal(err, undefined);
    assert.ok(existsSync(path));
    const raw = readFileSync(path, "utf8");
    assert.ok(!raw.includes("\"projects\": {}"), "bucket written");
    // fresh registry, same cwd → loads back
    const s2 = mkState();
    const n = loadPersist(s2, path);
    assert.equal(n, 1);
    assert.equal(s2.registry.size, 1);
    assert.ok(s2.registry.restore("[REDACTED:persisted-key]").text.includes(SECRET));
    // different cwd bucket does not load
    const s3 = mkState();
    s3.cwd = "/other/proj";
    assert.equal(loadPersist(s3, path), 0);
    // unload removes the bucket
    assert.equal(clearPersist("/proj/a", path), undefined);
    assert.equal(loadPersist(mkState(), path), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send-audit: payload proof scan + command toggle + evidence log", async () => {
  const { auditPayload } = await import("../src/mask.ts");
  const { appendAuditLog, readAuditTail } = await import("../src/commands.ts");
  const s = mkState();
  s.registry.registerManual(SECRET, "audit-key");
  s.registry.registerManual("9pQrStUvWx3y4z5A6b7C8d9E0f1", "audit-key-2");

  // payload where the model saw placeholders and a tool echoed one raw value back
  const dirty = {
    messages: [
      { role: "user", content: "put [REDACTED:audit-key] into config" },
      { role: "assistant", content: [{ type: "text", text: "using [REDACTED:audit-key] and [REDACTED:audit-key-2]" }] },
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
  const on = await handleSecretCommand(s, "audit on", {});
  assert.match(on.text, /ON/);
  const off = await handleSecretCommand(s, "audit off", {});
  assert.match(off.text, /OFF/);
  await handleSecretCommand(s, "audit on", {});
  const dir = mkdtempSync(join(tmpdir(), "secret-mask-audit-"));
  try {
    const log = join(dir, "audit.log");
    assert.equal(appendAuditLog({ time: "t", sessionId: "s", strings: 3, placeholders: 3, leaks: 1, leakedLabels: ["audit-key"] }, log), undefined);
    assert.equal(readAuditTail(5, log).length, 1);
    assert.ok(readAuditTail(5, log)[0].includes("audit-key"), "labels recorded, raw values never");
    assert.ok(!readAuditTail(5, log)[0].includes(SECRET), "raw value never in the evidence log");
    const show = await handleSecretCommand(s, "audit show", {});
    assert.match(show.text, /no audit evidence yet|audit evidence/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
