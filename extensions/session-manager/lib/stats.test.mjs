/**
 * session-manager §14.3 stats tests: totals / byModel / heatmap aggregation.
 * Run: node --experimental-strip-types --test ~/.pi/web/extensions/session-manager/lib/stats.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { openSessionIndex } = await import("./session-index.ts");

function makeSessionRaw(id, cwd, ts, messages) {
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: ts, cwd })];
  for (const m of messages) lines.push(JSON.stringify(m));
  return lines.join("\n") + "\n";
}
function userMsg(id, ts, text) { return { type: "message", id, parentId: null, timestamp: ts, message: { role: "user", content: text } }; }
function asstMsg(id, ts, text, model = "claude") { return { type: "message", id, parentId: null, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }], model, provider: "p" } }; }

const now = new Date();
const iso = (daysAgo, h = 10) => {
  const d = new Date(now.getTime() - daysAgo * 86400000);
  d.setHours(h, 0, 0, 0);
  return d.toISOString();
};

test("stats: totals + byModel + heatmap across indexed sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-stats-"));
  const idx = openSessionIndex(join(dir, "i.sqlite"));
  // session A: today, claude x2 + gemini x1
  writeFileSync(join(dir, "a.jsonl"), makeSessionRaw("a", "/w", iso(0), [
    userMsg("m1", iso(0), "今天的问题"),
    asstMsg("m2", iso(0), "回答 A", "claude"),
    asstMsg("m3", iso(0), "回答 B", "gemini"),
  ]));
  // session B: 3 days ago, claude x1
  writeFileSync(join(dir, "b.jsonl"), makeSessionRaw("b", "/w2", iso(3), [
    userMsg("m4", iso(3), "三天前"),
    asstMsg("m5", iso(3), "回答 C", "claude"),
  ]));
  // session C: 10 days ago (outside heatmap window if days<10), tool-only
  writeFileSync(join(dir, "c.jsonl"), makeSessionRaw("c", "/w3", iso(10), [
    userMsg("m6", iso(10), "十天前"),
  ]));
  await idx.sync([{ path: join(dir, "a.jsonl"), id: "a", cwd: "/w" },
            { path: join(dir, "b.jsonl"), id: "b", cwd: "/w2" },
            { path: join(dir, "c.jsonl"), id: "c", cwd: "/w3" }]);

  const s = idx.stats(["a"]);
  assert.equal(s.totals.totalSessions, 3);
  assert.equal(s.totals.runningSessions, 1);
  assert.equal(s.totals.totalMessages, 6); // A3 + B2 + C1
  assert.equal(s.totals.todaySessions, 1); // only A modified today
  assert.equal(s.totals.todayMessages, 3);
  assert.equal(s.totals.weekMessages, 5); // A(3) + B(2)

  // byModel: claude 2 sessions / 3 messages, gemini 1/1
  const cm = s.byModel.find((m) => m.model === "claude");
  assert.equal(cm.sessions, 2);
  assert.equal(cm.messages, 2); // A m2 + B m5
  const gm = s.byModel.find((m) => m.model === "gemini");
  assert.equal(gm.sessions, 1);

  // heatmap: 30-day window contains exactly 3 non-zero days
  const h = idx.stats([], 30).heatmap;
  assert.equal(h.length, 30);
  const nonZero = h.filter((p) => p.messages > 0);
  assert.equal(nonZero.length, 3);
  const todayPt = h[h.length - 1];
  assert.equal(todayPt.messages, 3);
  assert.equal(todayPt.sessions, 1);
  assert.ok(todayPt.level >= 1 && todayPt.level <= 4);

  idx.close();
  rmSync(dir, { recursive: true, force: true });
});

test("stats: runningSessions 不统计不可见孤儿 running id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-stats3-"));
  const idx = openSessionIndex(join(dir, "i.sqlite"));
  writeFileSync(join(dir, "a.jsonl"), makeSessionRaw("a", "/w", iso(0), [
    userMsg("m1", iso(0), "标题"),
    asstMsg("m2", iso(0), "回复 A", "claude"),
  ]));
  // sync：a 进列表；b 是孤儿（文件存在但没 sync，或无对应索引行）
  await idx.sync([{ path: join(dir, "a.jsonl"), id: "a", cwd: "/w" }]);
  // runningSessionIds 含真实在册 a + 孤儿 ghost（如嵌套 fork 子代理 id）
  const s = idx.stats(["a", "ghost"]);
  assert.equal(s.totals.runningSessions, 1);
  idx.close();
  rmSync(dir, { recursive: true, force: true });
});

test("stats: lastMessage is the final user/assistant text (not tool output)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-stats2-"));
  const idx = openSessionIndex(join(dir, "i.sqlite"));
  writeFileSync(join(dir, "a.jsonl"), makeSessionRaw("a", "/w", iso(0), [
    userMsg("m1", iso(0), "第一条"),
    { type: "message", id: "m2", parentId: null, timestamp: iso(0), message: { role: "toolResult", toolCallId: "tc", content: [{ type: "text", text: "工具输出" }] } },
    asstMsg("m3", iso(0), "最终回复", "claude"),
  ]));
  await idx.sync([{ path: join(dir, "a.jsonl"), id: "a", cwd: "/w" }]);
  const row = idx.getSession("a");
  assert.equal(row.lastMessage, "最终回复");
  assert.equal(row.firstMessage, "第一条");
  idx.close();
  rmSync(dir, { recursive: true, force: true });
});

// ===== 数据分层配套：computeStatsCached TTL 结果缓存（§2.4 遗留收口） =====
test("stats: computeStatsCached TTL 内命中缓存，不同 key 各自计算", async () => {
  const { computeStatsCached } = await import("./session-stats.ts");
  let n = 0;
  const fakeDb = {
    prepare(sql) {
      n++;
      return {
        get: (...a) => (sql.includes("COUNT(*) AS n") ? { n: 0 } : { totalSessions: 0, archivedSessions: 0, totalMessages: 0, todaySessions: 0, todayMessages: 0, weekMessages: 0 }),
        all: () => [],
      };
    },
  };
  const a = computeStatsCached(fakeDb, "k1", ["a"]);
  const before = n;
  const b = computeStatsCached(fakeDb, "k1", ["a"]);
  assert.equal(n, before, "TTL 内二次调用不得再触库");
  assert.deepEqual(a, b);
  const c = computeStatsCached(fakeDb, "k2", ["a"]);
  assert.deepEqual(Object.keys(c).sort(), ["byModel", "heatmap", "totals"]);
  assert.equal(c.byModel.length, 0);
  assert.ok(Array.isArray(c.heatmap) && c.heatmap.length > 0);
  assert.notEqual(c, b, "不同 key 各自计算");
});
