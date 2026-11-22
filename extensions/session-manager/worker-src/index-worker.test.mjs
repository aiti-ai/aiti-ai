/**
 * session-manager — index worker 消息处理与 vacuum 单测（不开真线程，直接调导出函数）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/session-manager/worker-src/index-worker.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const { runCommand, runVacuumOn } = await import("./index-worker.ts");
const { openSessionIndex } = await import("../lib/session-index.ts");

/** 假适配器（记录 parse 调用）。 */
function fakeAdapter(id) {
  return {
    id,
    label: id,
    roots: () => [],
    probe: () => ({ ok: true, count: 0, watermarkMs: 0 }),
    list: () => [],
    parse: (ref) => ({
      meta: {
        path: ref.path, id: ref.sid, cwd: "/p", name: ref.sid,
        created: "2026-09-12T00:00:00.000Z", modified: "2026-09-12T00:00:00.000Z",
        messageCount: 1, firstMessage: "f", lastMessage: "l",
      },
      messages: [{ entryId: "e0", role: "user", ts: null, text: "t" }],
      files: [],
    }),
  };
}

test("runCommand: sync 走 index.sync", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-worker-test-"));
  try {
    // sync 只索引真实存在的会话文件（不存在的路径静默跳过）——造一个最小 pi jsonl
    const { writeFileSync } = await import("node:fs");
    const f = join(dir, "s.jsonl");
    writeFileSync(f, [
      JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-09-12T00:00:00Z", cwd: dir }),
      JSON.stringify({ type: "message", id: "m1", timestamp: "2026-09-12T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "hello worker" }] } }),
    ].join("\n") + "\n");
    const index = openSessionIndex(join(dir, "i.sqlite"));
    const r = await runCommand(index, new Map(), { cmd: "sync", sessions: [{ path: f, id: "x", cwd: dir }] });
    assert.equal(r.indexed, 1);
    index.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runCommand: syncExt 内置适配器在 worker 内 parse；未知 agent 报 NO_ADAPTER", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-worker-test-"));
  try {
    const index = openSessionIndex(join(dir, "i.sqlite"));
    const adapters = new Map([["zcode", fakeAdapter("zcode")]]);
    const r = await runCommand(index, adapters, {
      cmd: "syncExt", agent: "zcode",
      refs: [{ sid: "a", path: "/tmp/db#session:a", rev: 7 }],
    });
    assert.equal(r.indexed, 1);
    await assert.rejects(
      () => runCommand(index, adapters, { cmd: "syncExt", agent: "third-party-proxy", refs: [] }),
      /NO_ADAPTER/,
    );
    index.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runVacuumOn: 首次 full + auto_vacuum 持久化；二次 incremental；无 freelist noop", () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-worker-test-"));
  try {
    const dbPath = join(dir, "v.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t(a TEXT)");
    for (let i = 0; i < 300; i++) db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(120));
    db.exec("DELETE FROM t");
    db.close();

    const r1 = runVacuumOn(dbPath);
    assert.equal(r1.mode, "full");
    assert.ok(r1.freedPages > 0);

    const db2 = new DatabaseSync(dbPath, { readOnly: true });
    const av = Object.values(db2.prepare("PRAGMA auto_vacuum").get())[0];
    db2.close();
    assert.equal(av, 2, "auto_vacuum=INCREMENTAL 已持久化");

    const r2 = runVacuumOn(dbPath); // 无 freelist → noop
    assert.equal(r2.mode, "noop");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("runVacuumOn: 跨实例锁——锁活着时 skipped-locked，陈旧锁接管", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-worker-test-"));
  try {
    const dbPath = join(dir, "v.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE t(a TEXT)"); db.prepare("INSERT INTO t VALUES ('x')").run();
    db.exec("DELETE FROM t"); // 造 freelist
    db.close();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${dbPath}.vacuum-lock`, "999999999:1"); // 刚写的锁 mtime 新 → 视为活锁
    const r = runVacuumOn(dbPath);
    assert.equal(r.mode, "skipped-locked");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
