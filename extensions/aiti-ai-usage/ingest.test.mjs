/**
 * aiti-ai-usage — 异步分批摄入回归测试（2026-09-12 生产事故修复）。
 *
 * 背景：全量 syncLiveSessions 曾同步 readFileSync 1GB JSONL 并逐行 autocommit 写
 * SQLite，主线程冻结数分钟 → pi-web-guard 探活失败反复重启 → 服务长时间不可用。
 * 本测试钉死三点：
 *   1) 全量入库正确 + 二次运行幂等 + 单文件改动增量；
 *   2) 摄入期间事件循环保持可响应（setInterval 有 tick —— 防冻结回归核心断言）；
 *   3) withTx 异常回滚。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-ai-usage/ingest.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageDb } from "./lib/db.ts";
import { syncLiveSessions, flushDaily, withTx } from "./lib/ingest.ts";
import { syncArchives } from "./lib/archives.ts";
import { brotliCompressSync } from "node:zlib";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "ai-usage-test-"));
}

/** 合成一条 assistant 消息（字段形态对齐 pi session jsonl 的 message 记录）。 */
function assistantMsg(i, model = "gpt-4o", ts = Date.now()) {
  return {
    type: "message",
    timestamp: new Date(ts).toISOString(),
    message: {
      role: "assistant",
      provider: "openai",
      model,
      timestamp: ts,
      usage: { input: 10 + i, output: 5, totalTokens: 15 + i, cost: { total: 0.01 } },
    },
  };
}

function writeSession(dir, name, id, cwd, msgs) {
  const lines = [JSON.stringify({ type: "session", id, cwd, timestamp: new Date().toISOString() })];
  for (const m of msgs) lines.push(JSON.stringify(m));
  const file = join(dir, name);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function openTmpDb(root) {
  const usage = openUsageDb(join(root, "usage.sqlite"));
  usage.ensure();
  return usage;
}

const count = (usage, sql) => usage.db.prepare(sql).get().n;

test("全量同步：正确入库 + 二次幂等 + 单文件增量", async () => {
  const root = tmpRoot();
  const sessions = join(root, "sessions");
  mkdirSync(join(sessions, "proj-a"), { recursive: true });
  const now = Date.now();
  writeSession(join(sessions, "proj-a"), "s1.jsonl", "sess-1", "/home/w/pa",
    [assistantMsg(1, "gpt-4o", now), assistantMsg(2, "gpt-4o", now + 1000)]);
  writeSession(join(sessions, "proj-a"), "s2.jsonl", "sess-2", "/home/w/pa",
    [assistantMsg(3, "claude-sonnet", now)]);
  writeSession(sessions, "s3.jsonl", "sess-3", "/home/w/pb", [assistantMsg(4, "gpt-4o", now)]);

  const usage = openTmpDb(root);
  const ctx = { usage, sessionsDir: sessions };

  // ① 全量
  assert.equal(await syncLiveSessions(ctx), 3, "首次应处理全部 3 个文件");
  assert.equal(count(usage, "SELECT COUNT(*) n FROM msg_usage"), 4, "4 条 assistant 明细");
  assert.equal(count(usage, "SELECT COUNT(*) n FROM sessions"), 3);
  assert.equal(count(usage, "SELECT COUNT(*) n FROM files"), 3);

  // ② 二次运行幂等（mtime/size 未变 → 跳过）
  assert.equal(await syncLiveSessions(ctx), 0, "无变化时不应重复处理");

  // ③ 单文件增量（append 一条即 size/mtime 变化）
  appendFileSync(join(sessions, "proj-a", "s1.jsonl"),
    JSON.stringify(assistantMsg(5, "gpt-4o", now + 2000)) + "\n");
  assert.equal(await syncLiveSessions(ctx), 1, "只处理变化的 1 个文件");
  assert.equal(count(usage, "SELECT COUNT(*) n FROM msg_usage"), 5);

  // ④ 会话聚合与日汇总
  const agg = usage.db.prepare("SELECT msgs, total_tokens FROM sessions WHERE id='sess-1'").get();
  assert.equal(agg.msgs, 3, "sess-1 聚合应重算为 3 条");
  await flushDaily(usage);
  assert.ok(count(usage, "SELECT COUNT(*) n FROM daily_model") > 0, "flushDaily 应生成日汇总");
});

test("摄入期间事件循环可响应（防冻结回归）", async () => {
  const root = tmpRoot();
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 40; i++) {
    const msgs = [];
    for (let j = 0; j < 20; j++) msgs.push(assistantMsg(j, "m" + (j % 3), now + j * 1000));
    writeSession(sessions, `f${i}.jsonl`, `sess-${i}`, "/w", msgs);
  }
  const usage = openTmpDb(root);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const n = await syncLiveSessions({ usage, sessionsDir: sessions });
  clearInterval(timer);
  assert.equal(n, 40);
  assert.equal(count(usage, "SELECT COUNT(*) n FROM msg_usage"), 800);
  // 旧同步实现（整段跑完不让出）此处 tick 恒为 0；新实现每文件 yield，必有 tick。
  assert.ok(ticks > 0, `摄入期间事件循环应可响应，实际 tick=${ticks}`);
});

test("withTx 异常回滚", async () => {
  const root = tmpRoot();
  const usage = openTmpDb(root);
  assert.throws(() => {
    withTx(usage.db, () => {
      usage.db.prepare("INSERT INTO meta (k,v) VALUES ('x','1')").run();
      throw new Error("boom");
    });
  }, /boom/);
  assert.equal(count(usage, "SELECT COUNT(*) n FROM meta WHERE k='x'"), 0, "回滚后不应残留写入");
});

test("归档 .pwarc 扫描（异步解析路径 + 幂等）", async () => {
  const root = tmpRoot();
  const arcDir = join(root, "archive");
  mkdirSync(arcDir, { recursive: true });
  const now = Date.now();
  const text = [
    JSON.stringify({ type: "session", id: "arch-s1", cwd: "/w", timestamp: new Date(now).toISOString() }),
    JSON.stringify(assistantMsg(1, "gpt-4o", now)),
    JSON.stringify(assistantMsg(2, "gpt-4o", now + 1000)),
  ].join("\n") + "\n";
  // .pwarc = "PWARC1\n" + brotli 块 + manifest JSON + u32 len + u32 magic
  const header = Buffer.from("PWARC1\n");
  const body = brotliCompressSync(Buffer.from(text, "utf8"));
  const manifest = { files: [{ sessionId: "arch-s1", offset: header.length, brotliSize: body.length }] };
  const mJson = Buffer.from(JSON.stringify(manifest), "utf8");
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(mJson.length, 0);
  footer.writeUInt32LE(0x43524157, 4);
  writeFileSync(join(arcDir, "pkg1.pwarc"), Buffer.concat([header, body, mJson, footer]));

  const usage = openTmpDb(root);
  assert.equal(await syncArchives(usage, arcDir), 1, "应处理 1 个归档包");
  assert.equal(count(usage, "SELECT COUNT(*) n FROM msg_usage"), 2);
  const s = usage.db.prepare("SELECT archived, state FROM sessions WHERE id='arch-s1'").get();
  assert.equal(s.archived, 1);
  assert.equal(s.state, "archived");
  assert.equal(await syncArchives(usage, arcDir), 0, "包未变时跳过");
});
