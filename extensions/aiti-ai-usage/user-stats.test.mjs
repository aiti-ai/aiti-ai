/**
 * aiti-ai-usage — 用户输入统计/引用识别回归测试。
 *
 * 钉死四点：
 *   1) scanUserText 引用识别：`>` / `>>` / `>>>` / BBCode / 邮件回复头 / @file；
 *   2) looksMachinePrompt 机器注入模板（长度门槛防误杀短问句）；
 *   3) parseSessionJsonl → userRows：kind 判定（human/agent/external）+ fork 副本按 (msg_id, ts) 去重；
 *   4) syncLiveSessions 集成：父/子会话文件同消息只入 1 条 + 二次幂等。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-ai-usage/user-stats.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageDb } from "./lib/db.ts";
import { parseSessionJsonl, syncLiveSessions, insertUserRows, userMsgsRebuildPending, clearUserMsgsRebuild } from "./lib/ingest.ts";
import { scanUserText, looksMachinePrompt } from "./lib/user-quotes.ts";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "ai-user-stats-test-"));
}

function openTmpDb(root) {
  const usage = openUsageDb(join(root, "usage.sqlite"));
  usage.ensure();
  return usage;
}

const count = (usage, sql) => usage.db.prepare(sql).get().n;

// ---------------------------------------------------------------- scanUserText

test("scanUserText：Markdown `>` 引用（引用回复形态）", () => {
  const s = scanUserText("> 要我给 mock 加上这个 TLS 代理面吗？\n> 第二行引用\n\n是的，加上");
  assert.deepEqual(s.kinds, ["gt"]);
  assert.equal(s.quoteLines, 2);
  assert.equal(s.quoteHead, true, "首行是引用 → 引用回复形态");
  assert.ok(s.chars > 0 && s.lines === 4);
});

test("scanUserText：引用在中间（quoteHead=false）+ 缩进引用", () => {
  const s = scanUserText("先看这个：\n   > 缩进三空格内的引用\n然后呢");
  assert.deepEqual(s.kinds, ["gt"]);
  assert.equal(s.quoteLines, 1);
  assert.equal(s.quoteHead, false);
});

test("scanUserText：嵌套 `>>` 与 `> >`", () => {
  assert.deepEqual(scanUserText(">> 嵌套一层").kinds, ["gt", "gtnested"]);
  assert.deepEqual(scanUserText("> > 空格嵌套").kinds, ["gt", "gtnested"]);
});

test("scanUserText：Discord `>>>` 整段引用", () => {
  const s = scanUserText(">>> 整段引用第一行\n第二行也属于引用");
  assert.deepEqual(s.kinds, ["gt", "gt3"]);
  assert.equal(s.quoteLines, 1, ">>> 只按首行计入 > 行数");
});

test("scanUserText：BBCode / 邮件回复头 / @file", () => {
  assert.deepEqual(scanUserText("[quote=张三]被引内容[/quote]\n同意").kinds, ["bbcode"]);
  assert.deepEqual(scanUserText("On Mon, Sep 1, 2026 at 10:00 Alice wrote:\n> hello").kinds, ["gt", "attrib"]);
  assert.deepEqual(scanUserText("在 2026年9月1日，张三 写道：\n内容").kinds, ["attrib"]);
  assert.deepEqual(scanUserText("看下 @src/app.ts 和 #file:docs/plan.md").kinds, ["fileref"]);
});

test("scanUserText：普通消息零引用；空消息安全", () => {
  assert.deepEqual(scanUserText("帮我改个 bug，谢谢").kinds, []);
  assert.deepEqual(scanUserText("").kinds, []);
  assert.equal(scanUserText("").lines, 0);
});

// ---------------------------------------------------------------- 机器注入模板

test("looksMachinePrompt：扩展助手模板命中（长文本）", () => {
  assert.equal(looksMachinePrompt("你是 pi-web 扩展的 AI 助手。根据用户要求完成任务，可以读写文件、执行命令、调用工具。"), true);
  assert.equal(looksMachinePrompt("[任务] 你是页面卡顿调试助手（aiti-cpu-meter 外部版发起）：请检查页面性能"), true);
  assert.equal(looksMachinePrompt("Task: 你是一名严谨的代码审计员。工作区：/home/pi/workspace"), true);
  assert.equal(looksMachinePrompt("⚠ 页面错误   · 类型: console.error   · 消息: Uncaught TypeError xxxxx"), true);
});

test("looksMachinePrompt：短问句/正常输入不误杀", () => {
  assert.equal(looksMachinePrompt("你是助手吗？"), false, "短问句不应判为机器模板");
  assert.equal(looksMachinePrompt("你是 pi-web 扩展的 AI 助手"), false, "不足 30 字不触发");
  assert.equal(looksMachinePrompt("帮我看看这个 bug，为什么跑了之后报错"), false);
});

// ---------------------------------------------------------------- parseSessionJsonl → userRows

function userMsg(id, ts, text) {
  return { type: "message", id, timestamp: new Date(ts).toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: ts } };
}

test("parseSessionJsonl：userRows 提取 + 引用特征 + kind 判定", async () => {
  const t0 = Date.UTC(2026, 8, 1, 10, 0, 0);
  const lines = [
    { type: "session", id: "sess-u1", cwd: "/w/proj", timestamp: new Date(t0).toISOString() },
    { type: "session_info", name: "普通会话" },
    userMsg("u0000001", t0, "> 引用一整行\n\n是的"),
    userMsg("u0000002", t0 + 1000, "普通问题"),
    userMsg("u0000003", t0 + 2000, "@src/a.ts 这里报错"),
  ];
  const parsed = await parseSessionJsonl(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "fallback");
  assert.equal(parsed.userRows.length, 3);
  const [a, b, c] = parsed.userRows;
  assert.equal(a.kind, "human");
  assert.equal(a.quote_lines, 1);
  assert.equal(a.quote_head, 1);
  assert.equal(a.quote_kinds, "gt");
  assert.equal(b.kind, "human");
  assert.equal(b.quote_lines, 0);
  assert.equal(c.quote_kinds, "fileref");
  assert.equal(a.session_id, "sess-u1");
  assert.equal(a.day, "2026-09-01");
});

test("parseSessionJsonl：subagent 会话整会话 agent / 导入会话 external / 首条模板 agent", async () => {
  const t0 = Date.UTC(2026, 8, 2, 10, 0, 0);
  const sub = [
    { type: "session", id: "sess-sub", cwd: "/w", timestamp: new Date(t0).toISOString() },
    { type: "session_info", name: "subagent-reviewer-abc-1" },
    userMsg("u1000001", t0, "Task: 你是一名严谨的代码审计员。工作区：/home/pi/workspace"),
    userMsg("u1000002", t0 + 1000, "继续"),
  ];
  const p1 = await parseSessionJsonl(sub.map((l) => JSON.stringify(l)).join("\n") + "\n", "x");
  assert.deepEqual(p1.userRows.map((r) => r.kind), ["agent", "agent"], "subagent 会话整会话归 agent");

  const ext = [
    { type: "session", id: "sess-ext", cwd: "/w", timestamp: new Date(t0).toISOString() },
    { type: "session_info", name: "[codebuddy] 01a0", external: true, importedFrom: "codebuddy:01a0" },
    userMsg("u2000001", t0, "Count from 1 to 8, one number per line."),
  ];
  const p2 = await parseSessionJsonl(ext.map((l) => JSON.stringify(l)).join("\n") + "\n", "x");
  assert.equal(p2.userRows[0].kind, "external", "导入外部会话归 external");

  const aih = [
    { type: "session", id: "sess-aih", cwd: "/tmp", timestamp: new Date(t0).toISOString() },
    userMsg("u3000001", t0, "你是 pi-web 扩展的 AI 助手。根据用户要求完成任务，可以读写文件、执行命令、调用工具。"),
    userMsg("u3000002", t0 + 1000, "再帮我看看"),
  ];
  const p3 = await parseSessionJsonl(aih.map((l) => JSON.stringify(l)).join("\n") + "\n", "x");
  assert.deepEqual(p3.userRows.map((r) => r.kind), ["agent", "human"], "仅首条模板消息为 agent，后续用户追问仍是 human");
});

// ---------------------------------------------------------------- 入库与去重

test("insertUserRows：幂等 + fork 副本 (msg_id, ts) 全局去重 + 冲突刷新扫描字段", () => {
  const root = tmpRoot();
  const usage = openTmpDb(root);
  const row = {
    msg_id: "uabcdef1", ts: 1000, day: "2026-09-01", session_id: "sess-a",
    kind: "human", chars: 10, lines: 1, image: 0, quote_lines: 1, quote_head: 1, quote_kinds: "gt",
  };
  insertUserRows(usage, [row]);
  insertUserRows(usage, [{ ...row, session_id: "sess-fork", quote_lines: 2, quote_kinds: "gt,gtnested" }]);
  assert.equal(count(usage, "SELECT COUNT(*) n FROM user_msgs"), 1, "同 (msg_id, ts) 只留一行");
  const got = usage.db.prepare("SELECT * FROM user_msgs").get();
  assert.equal(got.session_id, "sess-a", "session_id 保持首写");
  assert.equal(got.quote_lines, 2, "扫描字段刷新到最新");
  assert.equal(got.quote_kinds, "gt,gtnested");
  usage.close();
});

// ---------------------------------------------------------------- 老库升级 bootstrap

test("user_msgs 重建标记：schema 版本落后才安排；force 重扫回填历史", async () => {
  const root = tmpRoot();
  const dbPath = join(root, "usage.sqlite");
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const t0 = Date.UTC(2026, 8, 4, 10, 0, 0);
  const lines = [
    { type: "session", id: "sess-r", cwd: "/w", timestamp: new Date(t0).toISOString() },
    userMsg("u6000001", t0, "> 被引用\n\n回答"),
  ];
  writeFileSync(join(sessions, "r.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  // ① 首次开库（user_msgs 表新建）→ 标记存在
  let usage = openUsageDb(dbPath);
  usage.ensure();
  assert.equal(userMsgsRebuildPending(usage.db), true, "新表应安排一次全量重扫");
  // 模拟老库水位：先扫一轮（不带 force，标记不自动消费——消费责任在 runtime/worker）
  await syncLiveSessions({ usage, sessionsDir: sessions });
  assert.equal(count(usage, "SELECT COUNT(*) n FROM user_msgs"), 1);
  usage.db.prepare("DELETE FROM user_msgs").run();
  // ② 文件未变化，普通增量不补历史
  assert.equal(await syncLiveSessions({ usage, sessionsDir: sessions }), 0);
  assert.equal(count(usage, "SELECT COUNT(*) n FROM user_msgs"), 0, "增量跳过水位内文件");
  // ③ force 忽略水位 → userRows 回填
  assert.equal(await syncLiveSessions({ usage, sessionsDir: sessions }, { force: true }), 1);
  assert.equal(count(usage, "SELECT COUNT(*) n FROM user_msgs"), 1, "force 重扫回填历史数据");
  clearUserMsgsRebuild(usage.db);
  assert.equal(userMsgsRebuildPending(usage.db), false);
  usage.close();

  // ④ 重新开库（schema 版本已写）→ 不再重设标记
  usage = openUsageDb(dbPath);
  usage.ensure();
  assert.equal(userMsgsRebuildPending(usage.db), false, "schema 一致不重复安排重建");
  // ⑤ 模拟引用识别口径升级：版本号落后 → 再次 ensure 重新安排重建
  usage.db.prepare("UPDATE meta SET v='0' WHERE k='user_msgs_schema'").run();
  usage.close();
  usage = openUsageDb(dbPath);
  usage.ensure();
  assert.equal(userMsgsRebuildPending(usage.db), true, "schema 版本落后应重新安排重建");
  clearUserMsgsRebuild(usage.db);
  usage.close();
});

test("syncLiveSessions：父会话 + fork 文件同消息只入 1 条 + 二次幂等", async () => {
  const root = tmpRoot();
  const sessions = join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const t0 = Date.UTC(2026, 8, 3, 10, 0, 0);
  const parent = [
    { type: "session", id: "sess-p", cwd: "/w", timestamp: new Date(t0).toISOString() },
    userMsg("u5000001", t0, "> 引用内容\n\n确认"),
    userMsg("u5000002", t0 + 1000, "被 fork 复制的历史"),
  ];
  const fork = [
    { type: "session", id: "sess-f", cwd: "/w", timestamp: new Date(t0).toISOString(), parentSession: "sess-p" },
    userMsg("u5000001", t0, "> 引用内容\n\n确认"),
    userMsg("u5000002", t0 + 1000, "被 fork 复制的历史"),
    userMsg("u5000003", t0 + 2000, "fork 后的新输入"),
  ];
  writeFileSync(join(sessions, "p.jsonl"), parent.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(sessions, "f.jsonl"), fork.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const usage = openTmpDb(root);
  const ctx = { usage, sessionsDir: sessions };
  assert.equal(await syncLiveSessions(ctx), 2);
  assert.equal(count(usage, "SELECT COUNT(*) n FROM user_msgs"), 3, "去重后 3 条（2 条历史 + 1 条新）");
  assert.equal(count(usage, "SELECT COUNT(*) n FROM user_msgs WHERE quote_lines > 0"), 1);
  assert.equal(await syncLiveSessions(ctx), 0, "无变化不重复处理");
  assert.equal(count(usage, "SELECT COUNT(*) n FROM user_msgs"), 3, "二次运行幂等");
  usage.close();
});
