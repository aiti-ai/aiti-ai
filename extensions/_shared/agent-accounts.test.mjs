/**
 * agent-accounts 共享引擎测试（单文件存储 / 快照 / 切换 / 自动保险 / 登出）。
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

test("sanitizeAlias：合法/非法（路径穿越、保留前缀、超长、空白）", () => {
  assert.equal(sanitizeAlias("主账号"), "主账号");
  assert.equal(sanitizeAlias("work-2"), "work-2");
  assert.equal(sanitizeAlias(" Team A "), "Team A");
  assert.equal(sanitizeAlias("_auto-before-switch"), null, "保留前缀拒绝");
  assert.equal(sanitizeAlias("../evil"), null);
  assert.equal(sanitizeAlias("a/b"), null);
  assert.equal(sanitizeAlias("a\\b"), null);
  assert.equal(sanitizeAlias(""), null);
  assert.equal(sanitizeAlias("x".repeat(33)), null);
  assert.equal(sanitizeAlias(".hidden"), null, "首字符非字母数字中文");
  assert.equal(sanitizeAlias("a..b"), null);
});

test("store 读写：缺失/坏 JSON → 空 store；写入可读回（原子）", () => {
  const dir = tmpDir("store");
  const file = join(dir, "agent-accounts.json");
  assert.deepEqual(readAccountsStore(file), emptyStore(), "缺失 → 空");
  write(file, "{broken json");
  assert.deepEqual(readAccountsStore(file), emptyStore(), "坏 JSON → 空");
  const st = emptyStore();
  st.accounts.claude = { x: { savedAt: 1, files: {} } };
  writeAccountsStore(file, st);
  const back = readAccountsStore(file);
  assert.equal(back.accounts.claude.x.savedAt, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("saveAccount：无内容抛错；有内容记录签名/current/note", () => {
  const dir = tmpDir("save");
  const slots = [
    { key: "k1", label: "凭据 1", path: join(dir, "a", "one.json") },
    { key: "k2", label: "凭据 2", path: join(dir, "a", "two.json") },
  ];
  const store = emptyStore();
  assert.throws(() => saveAccount(store, "claude", "acc", slots), /无登录态可备份/);

  write(slots[0].path, '{"token":"aaa"}');
  const r = saveAccount(store, "claude", "acc", slots, { note: "user@x", account: { user: "李永", uin: "330116798388", expiresAt: 1797048848890 } });
  assert.equal(r.overwritten, false);
  assert.equal(r.entry.alias, "acc");
  assert.equal(r.entry.slotCount, 1, "只收了有内容的槽位");
  assert.equal(r.entry.note, "user@x");
  assert.equal(r.entry.user, "李永", "账号展示元数据透出");
  assert.equal(r.entry.uin, "330116798388");
  assert.equal(r.entry.expiresAt, 1797048848890);
  assert.equal(r.entry.auto, false);
  const list = listAccounts(store, "claude", slots);
  assert.equal(list.length, 1);
  assert.equal(list[0].current, true, "刚刚从当前状态存下 → current");

  // 覆盖同名档
  write(slots[0].path, '{"token":"bbb"}');
  const r2 = saveAccount(store, "claude", "acc", slots);
  assert.equal(r2.overwritten, true);
  rmSync(dir, { recursive: true, force: true });
});

test("switchAccount：恢复内容 + 缺槽位删除 + current 变化", () => {
  const dir = tmpDir("switch");
  const slots = [
    { key: "one", label: "one", path: join(dir, "one.json") },
    { key: "two", label: "two", path: join(dir, "two.json") },
  ];
  const store = emptyStore();
  write(slots[0].path, "AAA");
  write(slots[1].path, "B1");
  saveAccount(store, "codex", "甲", slots);

  write(slots[0].path, "CCC");
  rmSync(slots[1].path, { force: true });
  saveAccount(store, "codex", "乙", slots);

  const r = switchAccount(store, "codex", "甲", slots);
  assert.equal(readFileSync(slots[0].path, "utf8"), "AAA");
  assert.equal(readFileSync(slots[1].path, "utf8"), "B1", "档里有的槽位写回");
  assert.equal(r.entry.current, true);
  const list = listAccounts(store, "codex", slots);
  assert.equal(list.find((e) => e.alias === "甲").current, true);
  assert.equal(list.find((e) => e.alias === "乙").current, false);

  // 切回乙：甲多了 two.json，但乙档没有 → 删除，保证干净
  switchAccount(store, "codex", "乙", slots);
  assert.equal(readFileSync(slots[0].path, "utf8"), "CCC");
  assert.equal(existsSync(slots[1].path), false, "目标档没有的槽位 → 删除当前文件");
  rmSync(dir, { recursive: true, force: true });
});

test("switchAccount：当前未存档 → 自动保险 _auto-before-switch（含未命名的新登录）", () => {
  const dir = tmpDir("auto");
  const slots = [{ key: "c", label: "cred", path: join(dir, "cred.json") }];
  const store = emptyStore();
  write(slots[0].path, "OLD");
  saveAccount(store, "cursor", "老号", slots);

  write(slots[0].path, "NEW-UNSAVED");
  assert.equal(isCurrentCovered(store, "cursor", slots), false, "当前状态未被任何档覆盖");
  const r = switchAccount(store, "cursor", "老号", slots);
  assert.equal(r.autoSaved, true);
  const auto = store.accounts.cursor[autoAlias("switch")];
  assert.ok(auto, "自动保险档存在");
  assert.equal(auto.files.c.data, "NEW-UNSAVED", "保险档保存的是切换前内容");
  assert.equal(auto.auto, true);
  assert.equal(readFileSync(slots[0].path, "utf8"), "OLD");
  rmSync(dir, { recursive: true, force: true });
});

test("isCurrentCovered：有档匹配 → 不生成保险档；无内容 → false", () => {
  const dir = tmpDir("covered");
  const slots = [{ key: "c", label: "cred", path: join(dir, "cred.json") }];
  const store = emptyStore();
  assert.equal(hasAnySlotContent(slots), false);
  assert.equal(isCurrentCovered(store, "zcode", slots), false);
  write(slots[0].path, "X");
  saveAccount(store, "zcode", "号", slots);
  assert.equal(isCurrentCovered(store, "zcode", slots), true);
  const r = switchAccount(store, "zcode", "号", slots);
  assert.equal(r.autoSaved, false, "已覆盖 → 不重复保险");
  assert.equal(store.accounts.zcode[autoAlias("switch")], undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("switchAccount：目标档不存在抛错；removeAccount 删除含自动档", () => {
  const dir = tmpDir("rm");
  const slots = [{ key: "c", label: "cred", path: join(dir, "cred.json") }];
  const store = emptyStore();
  assert.throws(() => switchAccount(store, "claude", "没有", slots), /账号档不存在/);
  write(slots[0].path, "X");
  saveAccount(store, "claude", "A", slots);
  saveAccount(store, "claude", "B", slots);
  saveAccount(store, "claude", autoAlias("logout"), slots, { auto: true });
  assert.equal(removeAccount(store, "claude", autoAlias("logout")), true);
  assert.equal(removeAccount(store, "claude", "不存在"), false);
  assert.equal(removeAccount(store, "claude", "B"), true);
  const list = listAccounts(store, "claude", slots);
  assert.deepEqual(list.map((e) => e.alias), ["A"]);
  rmSync(dir, { recursive: true, force: true });
});

test("clearSlots：删除现有文件（登出）并返回路径；不存在不报错", () => {
  const dir = tmpDir("clear");
  const slots = [
    { key: "a", label: "a", path: join(dir, "a.json") },
    { key: "b", label: "b", path: join(dir, "b.json") },
  ];
  write(slots[0].path, "A");
  const removed = clearSlots(slots);
  assert.deepEqual(removed, [slots[0].path]);
  assert.equal(existsSync(slots[0].path), false);
  assert.deepEqual(clearSlots(slots), [], "再清不报错");
  rmSync(dir, { recursive: true, force: true });
});

test("二进制内容 base64 往返 + restoreAccount 直接恢复", () => {
  const dir = tmpDir("b64");
  const p = join(dir, "user.bin");
  const slots = [{ key: "bin", label: "bin", path: p }];
  const raw = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x01]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, raw);
  const store = emptyStore();
  saveAccount(store, "qoder", "档", slots);
  assert.equal(store.accounts.qoder["档"].files.bin.b64, true, "非 UTF-8 → b64");
  rmSync(p, { force: true });
  restoreAccount(store, "qoder", "档", slots);
  assert.deepEqual(readFileSync(p), raw, "字节级往返一致");
  rmSync(dir, { recursive: true, force: true });
});

test("currentSignature：内容变化签名变化；空槽位集合签名稳定", () => {
  const dir = tmpDir("sig");
  const slots = [{ key: "c", label: "c", path: join(dir, "c.json") }];
  const empty1 = currentSignature(slots);
  const empty2 = currentSignature([]);
  assert.equal(empty1, empty2, "无内容 = 空签名");
  write(slots[0].path, "1");
  const s1 = currentSignature(slots);
  write(slots[0].path, "2");
  const s2 = currentSignature(slots);
  assert.notEqual(s1, s2);
  assert.notEqual(s1, empty1);
  rmSync(dir, { recursive: true, force: true });
});

test("identity：token 自动刷新（内容轮换）仍判 current；同身份不重复保险", () => {
  const dir = tmpDir("identity");
  const slots = [{ key: "c", label: "c", path: join(dir, "cred.json") }];
  const store = emptyStore();
  write(slots[0].path, "TOKEN-1");
  saveAccount(store, "codebuddy", "甲", slots, { identity: "李永|123" });
  write(slots[0].path, "TOKEN-2"); // CLI 后台刷新 token
  const list = listAccounts(store, "codebuddy", slots, { identity: "李永|123" });
  assert.equal(list[0].current, true, "同身份 → 仍标当前（不再因 token 轮换掉标记）");
  assert.equal(isCurrentCovered(store, "codebuddy", slots, "李永|123"), true);
  assert.equal(isCurrentCovered(store, "codebuddy", slots, "别人|456"), false, "不同身份 → 未覆盖");
  const r = switchAccount(store, "codebuddy", "甲", slots, { identity: "李永|123" });
  assert.equal(r.autoSaved, false, "同身份切向自身 → 不生成保险档");
  assert.equal(store.accounts.codebuddy[autoAlias("switch")], undefined);
  rmSync(dir, { recursive: true, force: true });
});
