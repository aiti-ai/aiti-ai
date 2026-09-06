import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// running-journal 按 dataRoot()（PI_WEB_DATA_DIR）定位文件；env 在调用时读取。
// 每个用例用独立临时目录 + 清空内存缓存，模拟互不相关的「进程重启」。
const tmpDirs = [];
const { bootRollRunningJournal, recordRunningEntries, listInterrupted, setInterruptedState, removeInterrupted, runningJournalPath } =
  await import("./running-journal.ts");

/** 新数据目录 + 清内存缓存（用例初始化）。 */
function newDataDir() {
  process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "piweb-journal-"));
  tmpDirs.push(process.env.PI_WEB_DATA_DIR);
  // 模块捕获的是 store 对象引用，重置须改 .file 而非替换 globalThis 键
  (globalThis).__piRunningJournal.file = null;
}

/** 同一数据目录下模拟进程重启：仅清内存缓存，下次访问从磁盘重读。 */
function restart() {
  (globalThis).__piRunningJournal.file = null;
}

const entry = (id, file, updatedAt = 1000) => ({ id, sessionFile: file, cwd: "/x", kind: "local", updatedAt });

test("boot on fresh install creates an empty journal and migrates nothing", () => {
  newDataDir();
  const migrated = bootRollRunningJournal();
  assert.equal(migrated, 0);
  assert.deepEqual(listInterrupted(), []);
});

test("entries from a previous boot migrate to interrupted with pending state", () => {
  newDataDir();
  recordRunningEntries([entry("s1", "/x/s1.jsonl"), entry("s2", "/x/s2.jsonl", 2000)]);
  let raw = JSON.parse(readFileSync(runningJournalPath(), "utf8"));
  assert.equal(raw.entries.length, 2);
  const oldBootId = raw.bootId;

  // 重启：boot 扫描迁移
  restart();
  const migrated = bootRollRunningJournal();
  assert.equal(migrated, 2);
  raw = JSON.parse(readFileSync(runningJournalPath(), "utf8"));
  assert.notEqual(raw.bootId, oldBootId);
  assert.equal(raw.entries.length, 0);
  assert.equal(raw.interrupted.length, 2);
  assert.ok(raw.interrupted.every((e) => e.state === "pending"));
  const s2 = raw.interrupted.find((e) => e.id === "s2");
  assert.equal(s2.updatedAt, 2000);

  // 再 roll 一次（幂等）：不重复迁移
  assert.equal(bootRollRunningJournal(), 0);
  assert.equal(listInterrupted().length, 2);
});

test("re-interrupting a dismissed session refreshes timestamps but keeps the dismiss decision", () => {
  newDataDir();
  recordRunningEntries([entry("s1", "/x/s1.jsonl", 1111)]);
  restart();
  bootRollRunningJournal();
  assert.equal(setInterruptedState("/x/s1.jsonl", "dismissed"), true);

  // 用户再次在同会话上跑长任务并遇到下一次重启
  recordRunningEntries([entry("s1", "/x/s1.jsonl", 2222)]);
  restart();
  bootRollRunningJournal();
  const items = listInterrupted();
  assert.equal(items.length, 1);
  assert.equal(items[0].state, "dismissed");
  assert.equal(items[0].updatedAt, 2222);
});

test("setInterruptedState / removeInterrupted", () => {
  newDataDir();
  recordRunningEntries([entry("s1", "/x/s1.jsonl")]);
  restart();
  bootRollRunningJournal();
  assert.equal(setInterruptedState("/x/s1.jsonl", "dismissed"), true);
  assert.equal(setInterruptedState("/x/missing.jsonl", "dismissed"), false);
  assert.equal(listInterrupted()[0].state, "dismissed");
  removeInterrupted("/x/s1.jsonl");
  assert.equal(listInterrupted().length, 0);
});

test("corrupt journal file degrades to empty instead of throwing", () => {
  newDataDir();
  mkdirSync(join(runningJournalPath(), ".."), { recursive: true });
  writeFileSync(runningJournalPath(), "{not json", "utf8");
  restart();
  assert.deepEqual(listInterrupted(), []);
  // 下一次写入能恢复正常（boot roll 建全新文件）
  assert.equal(bootRollRunningJournal(), 0);
  const raw = JSON.parse(readFileSync(runningJournalPath(), "utf8"));
  assert.equal(raw.version, 1);
});

test("missing entries/interrupted arrays are treated as empty", () => {
  newDataDir();
  mkdirSync(join(runningJournalPath(), ".."), { recursive: true });
  writeFileSync(runningJournalPath(), JSON.stringify({ version: 1, bootId: "x" }), "utf8");
  restart();
  assert.deepEqual(listInterrupted(), []);
});

test("journal path is isolated per instance (PI_WEB_INSTANCE / PORT)", async () => {
  newDataDir();
  const before = runningJournalPath();
  process.env.PI_WEB_INSTANCE = "other";
  try {
    const other = runningJournalPath();
    assert.notEqual(other, before);
    assert.ok(other.includes("running-journal-other.json"), other);
  } finally {
    delete process.env.PI_WEB_INSTANCE;
  }
  assert.equal(runningJournalPath(), before);
});

test("journal stamps writing pid; boot roll refreshes it", async () => {
  const { bootRollRunningJournal: roll, listInstanceJournals: list } = await import("./running-journal.ts");
  const selfKey = process.env.PORT || "local";
  newDataDir();
  recordRunningEntries([entry("s1", "/x/s1.jsonl")]);
  const raw = JSON.parse(readFileSync(runningJournalPath(), "utf8"));
  assert.equal(raw.pid, process.pid);

  // boot roll（同进程模拟）后 pid 不变且仍可枚举
  roll();
  const journals = list();
  assert.equal(journals.length, 1);
  assert.equal(journals[0].key, selfKey);
  assert.equal(journals[0].pid, process.pid);
});

test("findOtherInstanceRunner ignores dead instances and own key", async () => {
  const { spawn } = await import("node:child_process");
  const { findOtherInstanceRunner } = await import("./running-journal.ts");
  const selfKey = process.env.PORT || "local";
  newDataDir();
  const victim = spawn("sleep", ["30"]);
  await new Promise((r) => setTimeout(r, 50)); // 等 pid 就绪

  const dir = join(runningJournalPath(), "..");
  mkdirSync(dir, { recursive: true });
  const writeOther = (port, pid) => writeFileSync(join(dir, `running-journal-${port}.json`), JSON.stringify({
    version: 1, bootId: "x", bootStartedAt: 1, pid, updatedAt: 3,
    entries: [{ id: "s9", sessionFile: "/x/shared.jsonl", cwd: "/x", kind: "local", updatedAt: 3 }],
    interrupted: [],
  }));

  // 活实例占用 → 命中返回实例 key
  writeOther("99991", victim.pid);
  assert.equal(findOtherInstanceRunner("/x/shared.jsonl"), "99991");
  assert.equal(findOtherInstanceRunner("/x/other.jsonl"), null);

  // 实例死亡 → 残留 entries 不算「运行中」
  victim.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(findOtherInstanceRunner("/x/shared.jsonl"), null);

  // 自己的 key 永不命中（即使 entries 里有同文件）
  writeOther(selfKey, victim.pid);
  recordRunningEntries([entry("self", "/x/self.jsonl")]);
  assert.equal(findOtherInstanceRunner("/x/self.jsonl"), null);

  try { victim.kill("SIGKILL"); } catch { /* already dead */ }
});

test("cleanup", () => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});
