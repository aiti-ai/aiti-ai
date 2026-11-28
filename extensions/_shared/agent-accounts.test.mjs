/**
 * agent-accounts shared engine tests (single-file store / snapshot / switching / automatic safety net / logout).
 *
 * Run: node --test pi-web-ext/_shared/agent-accounts.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  emptyStore, readAccountsStore, writeAccountsStore,
  sanitizeAlias, autoAlias,
  currentSignature, hasAnySlotContent, isCurrentCovered,
  listAccounts, saveAccount, switchAccount, restoreAccount, removeAccount, clearSlots,
} = await import("./agent-accounts.ts");

function tmpDir(tag) {
  return mkdtempSync(join(tmpdir(), `agent-accounts-${tag}-`));
}

function write(p, s) {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
}

test("sanitizeAlias: valid/invalid (path traversal, reserved prefix, over-long, whitespace)", () => {
  assert.equal(sanitizeAlias("main account"), "main account");
  assert.equal(sanitizeAlias("work-2"), "work-2");
  assert.equal(sanitizeAlias(" Team A "), "Team A");
  assert.equal(sanitizeAlias("_auto-before-switch"), null, "reserved prefix rejected");
  assert.equal(sanitizeAlias("../evil"), null);
  assert.equal(sanitizeAlias("a/b"), null);
  assert.equal(sanitizeAlias("a\\b"), null);
  assert.equal(sanitizeAlias(""), null);
  assert.equal(sanitizeAlias("x".repeat(33)), null);
  assert.equal(sanitizeAlias(".hidden"), null, "first char is not a letter/digit");
  assert.equal(sanitizeAlias("a..b"), null);
});

test("store read/write: missing/bad JSON → empty store; writes read back (atomic)", () => {
  const dir = tmpDir("store");
  const file = join(dir, "agent-accounts.json");
  assert.deepEqual(readAccountsStore(file), emptyStore(), "missing → empty");
  write(file, "{broken json");
  assert.deepEqual(readAccountsStore(file), emptyStore(), "bad JSON → empty");
  const st = emptyStore();
  st.accounts.claude = { x: { savedAt: 1, files: {} } };
  writeAccountsStore(file, st);
  const back = readAccountsStore(file);
  assert.equal(back.accounts.claude.x.savedAt, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("saveAccount: throws without content; with content records signature/current/note", () => {
  const dir = tmpDir("save");
  const slots = [
    { key: "k1", label: "Credential 1", path: join(dir, "a", "one.json") },
    { key: "k2", label: "Credential 2", path: join(dir, "a", "two.json") },
  ];
  const store = emptyStore();
  assert.throws(() => saveAccount(store, "claude", "acc", slots), /no login state to back up/);

  write(slots[0].path, '{"token":"aaa"}');
  const r = saveAccount(store, "claude", "acc", slots, { note: "user@x", account: { user: "Li Yong", uin: "330116798388", expiresAt: 1797048848890 } });
  assert.equal(r.overwritten, false);
  assert.equal(r.entry.alias, "acc");
  assert.equal(r.entry.slotCount, 1, "only slots with content were collected");
  assert.equal(r.entry.note, "user@x");
  assert.equal(r.entry.user, "Li Yong", "account display metadata surfaced");
  assert.equal(r.entry.uin, "330116798388");
  assert.equal(r.entry.expiresAt, 1797048848890);
  assert.equal(r.entry.auto, false);
  const list = listAccounts(store, "claude", slots);
  assert.equal(list.length, 1);
  assert.equal(list[0].current, true, "just saved from the current state → current");

  // overwrite the same-named profile
  write(slots[0].path, '{"token":"bbb"}');
  const r2 = saveAccount(store, "claude", "acc", slots);
  assert.equal(r2.overwritten, true);
  rmSync(dir, { recursive: true, force: true });
});

test("switchAccount: restores content + deletes missing slots + current changes", () => {
  const dir = tmpDir("switch");
  const slots = [
    { key: "one", label: "one", path: join(dir, "one.json") },
    { key: "two", label: "two", path: join(dir, "two.json") },
  ];
  const store = emptyStore();
  write(slots[0].path, "AAA");
  write(slots[1].path, "B1");
  saveAccount(store, "codex", "alpha", slots);

  write(slots[0].path, "CCC");
  rmSync(slots[1].path, { force: true });
  saveAccount(store, "codex", "beta", slots);

  const r = switchAccount(store, "codex", "alpha", slots);
  assert.equal(readFileSync(slots[0].path, "utf8"), "AAA");
  assert.equal(readFileSync(slots[1].path, "utf8"), "B1", "slots present in the profile are written back");
  assert.equal(r.entry.current, true);
  const list = listAccounts(store, "codex", slots);
  assert.equal(list.find((e) => e.alias === "alpha").current, true);
  assert.equal(list.find((e) => e.alias === "beta").current, false);

  // switch back to beta: alpha gained two.json, but beta's profile lacks it → delete, keeping things clean
  switchAccount(store, "codex", "beta", slots);
  assert.equal(readFileSync(slots[0].path, "utf8"), "CCC");
  assert.equal(existsSync(slots[1].path), false, "slots missing from the target profile → delete the current file");
  rmSync(dir, { recursive: true, force: true });
});

test("switchAccount: current not saved → automatic safety net _auto-before-switch (incl. unnamed new logins)", () => {
  const dir = tmpDir("auto");
  const slots = [{ key: "c", label: "cred", path: join(dir, "cred.json") }];
  const store = emptyStore();
  write(slots[0].path, "OLD");
  saveAccount(store, "cursor", "old acct", slots);

  write(slots[0].path, "NEW-UNSAVED");
  assert.equal(isCurrentCovered(store, "cursor", slots), false, "the current state is not covered by any profile");
  const r = switchAccount(store, "cursor", "old acct", slots);
  assert.equal(r.autoSaved, true);
  const auto = store.accounts.cursor[autoAlias("switch")];
  assert.ok(auto, "the automatic safety profile exists");
  assert.equal(auto.files.c.data, "NEW-UNSAVED", "the safety profile saved the pre-switch content");
  assert.equal(auto.auto, true);
  assert.equal(readFileSync(slots[0].path, "utf8"), "OLD");
  rmSync(dir, { recursive: true, force: true });
});

test("isCurrentCovered: matching profile → no safety profile; no content → false", () => {
  const dir = tmpDir("covered");
  const slots = [{ key: "c", label: "cred", path: join(dir, "cred.json") }];
  const store = emptyStore();
  assert.equal(hasAnySlotContent(slots), false);
  assert.equal(isCurrentCovered(store, "zcode", slots), false);
  write(slots[0].path, "X");
  saveAccount(store, "zcode", "acct", slots);
  assert.equal(isCurrentCovered(store, "zcode", slots), true);
  const r = switchAccount(store, "zcode", "acct", slots);
  assert.equal(r.autoSaved, false, "already covered → no duplicate safety net");
  assert.equal(store.accounts.zcode[autoAlias("switch")], undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("switchAccount: throws when the target profile is missing; removeAccount deletes including automatic profiles", () => {
  const dir = tmpDir("rm");
  const slots = [{ key: "c", label: "cred", path: join(dir, "cred.json") }];
  const store = emptyStore();
  assert.throws(() => switchAccount(store, "claude", "missing", slots), /account profile does not exist/);
  write(slots[0].path, "X");
  saveAccount(store, "claude", "A", slots);
  saveAccount(store, "claude", "B", slots);
  saveAccount(store, "claude", autoAlias("logout"), slots, { auto: true });
  assert.equal(removeAccount(store, "claude", autoAlias("logout")), true);
  assert.equal(removeAccount(store, "claude", "nonexistent"), false);
  assert.equal(removeAccount(store, "claude", "B"), true);
  const list = listAccounts(store, "claude", slots);
  assert.deepEqual(list.map((e) => e.alias), ["A"]);
  rmSync(dir, { recursive: true, force: true });
});

test("clearSlots: deletes existing files (logout) and returns paths; no error when absent", () => {
  const dir = tmpDir("clear");
  const slots = [
    { key: "a", label: "a", path: join(dir, "a.json") },
    { key: "b", label: "b", path: join(dir, "b.json") },
  ];
  write(slots[0].path, "A");
  const removed = clearSlots(slots);
  assert.deepEqual(removed, [slots[0].path]);
  assert.equal(existsSync(slots[0].path), false);
  assert.deepEqual(clearSlots(slots), [], "clearing again does not error");
  rmSync(dir, { recursive: true, force: true });
});

test("binary content base64 round-trip + restoreAccount direct restore", () => {
  const dir = tmpDir("b64");
  const p = join(dir, "user.bin");
  const slots = [{ key: "bin", label: "bin", path: p }];
  const raw = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x01]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, raw);
  const store = emptyStore();
  saveAccount(store, "qoder", "profile", slots);
  assert.equal(store.accounts.qoder["profile"].files.bin.b64, true, "non-UTF-8 → b64");
  rmSync(p, { force: true });
  restoreAccount(store, "qoder", "profile", slots);
  assert.deepEqual(readFileSync(p), raw, "byte-level round-trip identical");
  rmSync(dir, { recursive: true, force: true });
});

test("currentSignature: content change changes the signature; empty slot-set signature stable", () => {
  const dir = tmpDir("sig");
  const slots = [{ key: "c", label: "c", path: join(dir, "c.json") }];
  const empty1 = currentSignature(slots);
  const empty2 = currentSignature([]);
  assert.equal(empty1, empty2, "no content = empty signature");
  write(slots[0].path, "1");
  const s1 = currentSignature(slots);
  write(slots[0].path, "2");
  const s2 = currentSignature(slots);
  assert.notEqual(s1, s2);
  assert.notEqual(s1, empty1);
  rmSync(dir, { recursive: true, force: true });
});

test("identity: automatic token refresh (content rotation) still judged current; same identity no duplicate safety net", () => {
  const dir = tmpDir("identity");
  const slots = [{ key: "c", label: "c", path: join(dir, "cred.json") }];
  const store = emptyStore();
  write(slots[0].path, "TOKEN-1");
  saveAccount(store, "codebuddy", "alpha", slots, { identity: "Li Yong|123" });
  write(slots[0].path, "TOKEN-2"); // the CLI refreshes the token in the background
  const list = listAccounts(store, "codebuddy", slots, { identity: "Li Yong|123" });
  assert.equal(list[0].current, true, "same identity → still marked current (no longer loses the mark to token rotation)");
  assert.equal(isCurrentCovered(store, "codebuddy", slots, "Li Yong|123"), true);
  assert.equal(isCurrentCovered(store, "codebuddy", slots, "someone|456"), false, "different identity → not covered");
  const r = switchAccount(store, "codebuddy", "alpha", slots, { identity: "Li Yong|123" });
  assert.equal(r.autoSaved, false, "switching to itself with the same identity → no safety profile");
  assert.equal(store.accounts.codebuddy[autoAlias("switch")], undefined);
  rmSync(dir, { recursive: true, force: true });
});
