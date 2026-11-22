/**
 * session-manager — syncExt per-session rev 水位测试（2026-09-12 直读改造配套）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/session-manager/lib/session-index-rev.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { openSessionIndex } = await import("./session-index.ts");
const { EXT_ARCHIVE_REF } = await import("./session-index.ts");

test.after(() => {
  try { rmSync(join(tmpdir(), "sm-rev-test-baseline"), { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 造一个最小 parsed 会话。 */
function parsed(id, nMessages = 2) {
  return {
    meta: {
      path: `virtual://${id}`,
      id,
      cwd: "/tmp/proj",
      name: `会话 ${id}`,
      created: "2026-09-12T00:00:00.000Z",
      modified: "2026-09-12T00:01:00.000Z",
      messageCount: nMessages,
      firstMessage: "first",
      lastMessage: "last",
    },
    messages: Array.from({ length: nMessages }, (_, i) => ({
      entryId: `e${i}`, role: i % 2 ? "assistant" : "user", ts: null, text: `msg ${i} ${id}`,
    })),
    files: [],
  };
}

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "sm-rev-test-"));
  return { dir, idx: openSessionIndex(join(dir, "index.sqlite")) };
}

test("syncExt rev 水位：首轮全量、同 rev 跳过、rev 变化只重解析变更会话", async () => {
  const { dir, idx } = tmpDb();
  const refs = [
    { sid: "a", path: "/tmp/fake/db.sqlite#session:a", rev: 1000 },
    { sid: "b", path: "/tmp/fake/db.sqlite#session:b", rev: 2000 },
    { sid: "c", path: "/tmp/fake/db.sqlite#session:c", rev: 3000 },
  ];
  const parsedCalls = [];
  const parse = (ref) => { parsedCalls.push(ref.sid); return parsed(ref.sid); };

  // 首轮：全部入索引
  let r = await idx.syncExt("zcode", refs, parse);
  assert.equal(r.indexed, 3);
  assert.deepEqual(parsedCalls.sort(), ["a", "b", "c"]);

  // 同 rev 第二轮：零 parse（水位命中 + 行在）
  parsedCalls.length = 0;
  r = await idx.syncExt("zcode", refs, parse);
  assert.equal(r.indexed, 0);
  assert.deepEqual(parsedCalls, [], "rev 未变 → 全部跳过");

  // 一个会话 rev 前进：只重解析它（物理 db 文件 stat 恒变不再参与判定）
  parsedCalls.length = 0;
  r = await idx.syncExt("zcode", [
    { sid: "a", path: "/tmp/fake/db.sqlite#session:a", rev: 1000 },
    { sid: "b", path: "/tmp/fake/db.sqlite#session:b", rev: 2500 },
    { sid: "c", path: "/tmp/fake/db.sqlite#session:c", rev: 3000 },
  ], parse);
  assert.equal(r.indexed, 1);
  assert.deepEqual(parsedCalls, ["b"], "只重解析 rev 变化的会话");

  // 行被外部删除（自愈场景）：rev 未变也强制重 parse 重建
  // （refs 用当前 rev——真实场景 refs 每轮来自适配器 list()，不会回退到旧 rev）
  idx.removeSession("zcode:c");
  parsedCalls.length = 0;
  r = await idx.syncExt("zcode", [
    { sid: "a", path: "/tmp/fake/db.sqlite#session:a", rev: 1000 },
    { sid: "b", path: "/tmp/fake/db.sqlite#session:b", rev: 2500 },
    { sid: "c", path: "/tmp/fake/db.sqlite#session:c", rev: 3000 },
  ], parse);
  assert.equal(r.indexed, 1);
  assert.deepEqual(parsedCalls, ["c"], "行缺席 → 水位命中也重建");

  idx.close();
  rmSync(dir, { recursive: true, force: true });
});

test("syncExt rev 水位：无 rev 的 ref 走 stat 路径（其他适配器零影响）", async () => {
  const { dir, idx } = tmpDb();
  // 真 stat 路径需要存在的文件
  const { writeFileSync } = await import("node:fs");
  const f = join(dir, "session.jsonl");
  writeFileSync(f, "{}");
  const parsedCalls = [];
  const parse = (ref) => { parsedCalls.push(ref.sid); return parsed(ref.sid); };

  let r = await idx.syncExt("claude", [{ sid: "x", path: f }], parse);
  assert.equal(r.indexed, 1);
  parsedCalls.length = 0;
  r = await idx.syncExt("claude", [{ sid: "x", path: f }], parse);
  assert.equal(r.indexed, 0);
  assert.deepEqual(parsedCalls, [], "文件未变 → stat 水位跳过（旧行为保持）");

  idx.close();
  rmSync(dir, { recursive: true, force: true });
});

test("ensure：旧 copyDb 副本水位行一次性清理", async () => {
  const { dir, idx } = tmpDb();
  // 直接往 files 表塞旧副本行（zcode 269MB 副本时代的残留形态）
  idx.close();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dir, "index.sqlite"));
  db.prepare("INSERT INTO files (path, mtime_ms, size, indexed_at) VALUES (?, ?, ?, ?)")
    .run("/tmp/sm-zcode-cache/zcode-copy.db#session:old1", 268607488, 268607488, "2026-09-11T00:00:00.000Z");
  db.prepare("INSERT INTO files (path, mtime_ms, size, indexed_at) VALUES (?, ?, ?, ?)")
    .run("/tmp/sm-opencode-cache/opencode-copy.db#session:old2", 1, 1, "2026-09-11T00:00:00.000Z");
  db.close();
  // 重新 open（ensure 跑清理）
  const idx2 = openSessionIndex(join(dir, "index.sqlite"));
  const { DatabaseSync: DS2 } = await import("node:sqlite");
  const db2 = new DS2(join(dir, "index.sqlite"), { readOnly: true });
  const left = db2.prepare("SELECT count(*) as c FROM files WHERE path LIKE '/tmp/sm-%-cache%'").get();
  db2.close();
  assert.equal(left.c, 0, "旧副本水位行被清理");
  idx2.close();
  rmSync(dir, { recursive: true, force: true });
  void EXT_ARCHIVE_REF;
});
