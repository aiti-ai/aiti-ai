import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// running-journal locates its file via dataRoot() (PI_WEB_DATA_DIR); env is read at call time.
// Each test uses an isolated temp dir plus a cleared in-memory cache to simulate independent "process restarts".
const tmpDirs = [];
const { bootRollRunningJournal, recordRunningEntries, listInterrupted, setInterruptedState, removeInterrupted, runningJournalPath } =
  await import("./running-journal.ts");

/** New data dir + cleared in-memory cache (test setup). */
function newDataDir() {
  process.env.PI_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), "piweb-journal-"));
  tmpDirs.push(process.env.PI_WEB_DATA_DIR);
  // The module captured the store object reference, so reset by clearing .file rather than replacing the globalThis key
  (globalThis).__piRunningJournal.file = null;
}

/** Simulate a process restart within the same data dir: only clear the in-memory cache; the next access re-reads from disk. */
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

  // Restart: boot scan migration
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

  // Roll again (idempotent): no duplicate migration
  assert.equal(bootRollRunningJournal(), 0);
  assert.equal(listInterrupted().length, 2);
});

test("re-interrupting a dismissed session refreshes timestamps but keeps the dismiss decision", () => {
  newDataDir();
  recordRunningEntries([entry("s1", "/x/s1.jsonl", 1111)]);
  restart();
  bootRollRunningJournal();
  assert.equal(setInterruptedState("/x/s1.jsonl", "dismissed"), true);

  // User runs another long task on the same session and hits the next restart
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
  // The next write recovers (boot roll creates a fresh file)
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

  // After boot roll (same-process simulation) the pid is unchanged and still enumerable
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
  await new Promise((r) => setTimeout(r, 50)); // wait for the pid to be ready

  const dir = join(runningJournalPath(), "..");
  mkdirSync(dir, { recursive: true });
  const writeOther = (port, pid) => writeFileSync(join(dir, `running-journal-${port}.json`), JSON.stringify({
    version: 1, bootId: "x", bootStartedAt: 1, pid, updatedAt: 3,
    entries: [{ id: "s9", sessionFile: "/x/shared.jsonl", cwd: "/x", kind: "local", updatedAt: 3 }],
    interrupted: [],
  }));

  // Live instance holds the file -> hit returns that instance's key
  writeOther("99991", victim.pid);
  assert.equal(findOtherInstanceRunner("/x/shared.jsonl"), "99991");
  assert.equal(findOtherInstanceRunner("/x/other.jsonl"), null);

  // Instance dead -> leftover entries no longer count as "running"
  victim.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(findOtherInstanceRunner("/x/shared.jsonl"), null);

  // Own key never matches (even if entries reference the same file)
  writeOther(selfKey, victim.pid);
  recordRunningEntries([entry("self", "/x/self.jsonl")]);
  assert.equal(findOtherInstanceRunner("/x/self.jsonl"), null);

  try { victim.kill("SIGKILL"); } catch { /* already dead */ }
});

test("empty snapshot is written delayed: crash within window keeps last running set", async () => {
  const { recordRunningEntries: record } = await import("./running-journal.ts");
  newDataDir();
  record([entry("s1", "/x/s1.jsonl")]);
  assert.equal(JSON.parse(readFileSync(runningJournalPath(), "utf8")).entries.length, 1);

  // Empty set (e.g. dispose clearing on shutdown): an immediate disk read should keep the non-empty snapshot
  record([]);
  assert.equal(JSON.parse(readFileSync(runningJournalPath(), "utf8")).entries.length, 1);

  // Only after the 2s window does the empty set hit disk
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(JSON.parse(readFileSync(runningJournalPath(), "utf8")).entries.length, 0);

  // A new run writes immediately and cancels the pending empty-set write
  record([]);
  record([entry("s2", "/x/s2.jsonl")]);
  assert.equal(JSON.parse(readFileSync(runningJournalPath(), "utf8")).entries.length, 1);
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(JSON.parse(readFileSync(runningJournalPath(), "utf8")).entries.length, 1);
});

test("cleanup", () => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});
