/**
 * aiti-ai-usage — 外部 agent 摄入（第四路）回归测试。
 *
 * 钉死四点：
 *   1) 四源（claude-like / qodercn / codebuddy / zcode）会话 → ext_usage 正确入库；
 *   2) 二次运行幂等（jsonl mtime/size 水位 + zcode rev 水位）；
 *   3) flushDaily 把 ext_usage 并入 daily_model（与 msg_usage 同 provider 合并，不撞 PK）；
 *   4) 摄入期间事件循环保持可响应（与 ingest.test.mjs 同防冻结断言）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-ai-usage/ext-ingest.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openUsageDb } from "./lib/db.ts";
import { syncExtUsage } from "./lib/ext-ingest.ts";
import { flushDaily } from "./lib/ingest.ts";

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "ai-ext-usage-test-"));
}

function openTmpDb(root) {
  const usage = openUsageDb(join(root, "usage.sqlite"));
  usage.ensure();
  return usage;
}

const count = (usage, sql) => usage.db.prepare(sql).get().n;

/** CC 同构 assistant 行。 */
function claudeLikeAssistant(tsIso, model, usage, extra = {}) {
  return { type: "assistant", timestamp: tsIso, message: { role: "assistant", model, usage, ...extra } };
}

test("四源会话 → ext_usage 入库 + 幂等水位 + 增量", async () => {
  const root = tmpRoot();
  const env = {
    claudeHome: join(root, "claude"), qodercnHome: join(root, "qodercn"),
    codebuddyHome: join(root, "codebuddy"), zcodeHome: join(root, "zcode"),
    // A11 P1 model-only 三源：测试隔离——指向不存在目录（probe=false → 源跳过）
    codexHome: join(root, "codex"), opencodeHome: join(root, "opencode"), cursorHome: join(root, "cursor"),
  };
  // claude-like 源（claude + qodercn 共用同一目录结构，各自 root 隔离）
  mkdirSync(join(env.claudeHome, "-home-w"), { recursive: true });
  mkdirSync(join(env.qodercnHome, "-home-w"), { recursive: true });
  mkdirSync(join(env.codebuddyHome, "home-w"), { recursive: true });

  // claude：CC 真实 usage（glm-5.3 → provider zhipu）
  writeFileSync(join(env.claudeHome, "-home-w", "aaaaaaaa-1111-2222-3333-444444444444.jsonl"), [
    JSON.stringify(claudeLikeAssistant("2026-09-01T10:00:01Z", "glm-5.3",
      { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 })),
  ].join("\n") + "\n");
  // qodercn：model + credits（token 恒 0）
  writeFileSync(join(env.qodercnHome, "-home-w", "bbbbbbbb-1111-2222-3333-444444444444.jsonl"), [
    JSON.stringify(claudeLikeAssistant("2026-09-01T11:00:01Z", "qmodel_38max",
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, credits: 5.5 })),
  ].join("\n") + "\n");
  // codebuddy：providerData.rawUsage
  writeFileSync(join(env.codebuddyHome, "home-w", "cccccccc-1111-2222-3333-444444444444.jsonl"), [
    JSON.stringify({ type: "message", timestamp: 1789057352340, role: "assistant",
      providerData: { model: "hy4-preview", rawUsage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 } } }),
  ].join("\n") + "\n");

  // zcode：SQLite（tokens 累积差分）
  const zdb = join(env.zcodeHome, "cli", "db");
  mkdirSync(zdb, { recursive: true });
  const db = new DatabaseSync(join(zdb, "db.sqlite"));
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, sequence INTEGER, time_created INTEGER);
  `);
  db.prepare("INSERT INTO session (id, directory, time_created, time_updated) VALUES ('z-s1', '/tmp/x', 1788664736000, 1788664739000)").run();
  db.prepare("INSERT INTO message (id, session_id, data, sequence, time_created) VALUES ('m1', 'z-s1', ?, 0, 1788664736131)").run(
    JSON.stringify({ role: "assistant", modelID: "GLM-5.3-Flash", providerID: "bigmodel",
      time: { created: 1788664736131 },
      tokens: { total: 38889, input: 38562, output: 327, cache: { read: 16384, write: 0 } } }));
  db.prepare("INSERT INTO message (id, session_id, data, sequence, time_created) VALUES ('m2', 'z-s1', ?, 1, 1788664736132)").run(
    JSON.stringify({ role: "assistant", modelID: "GLM-5.3-Flash", providerID: "bigmodel",
      time: { created: 1788664736132 },
      tokens: { total: 39456, input: 39374, output: 82, cache: { read: 38528, write: 0 } } }));
  db.close();

  const usage = openTmpDb(root);
  const ctx = { usage, env };

  // ① 全量（claude/qodercn/codebuddy 各 1 个 jsonl 会话 + 1 个 zcode 会话 → 1+1+1+2 行）
  const first = await syncExtUsage(ctx);
  assert.equal(first, 4, "首次应处理 4 个会话（3 jsonl + 1 zcode）");
  assert.equal(count(usage, "SELECT COUNT(*) n FROM ext_usage"), 5);
  assert.equal(count(usage, "SELECT COUNT(*) n FROM ext_files"), 4, "水位 4 条");

  // 明细抽查
  const rows = usage.db.prepare("SELECT agent, provider, model, input, output, total_tokens, credits FROM ext_usage ORDER BY agent, ts").all();
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent, r]));
  assert.equal(byAgent.claude.provider, "zhipu");
  assert.equal(byAgent.claude.input, 100);
  assert.equal(byAgent.claude.total_tokens, 120, "claude total = input+output（不含 cache）");
  assert.equal(byAgent.qodercn.credits, 5.5);
  assert.equal(byAgent.qodercn.model, "qmodel_38max");
  assert.equal(byAgent.codebuddy.input, 1000);
  assert.equal(byAgent.codebuddy.total_tokens, 1050);
  // zcode 两条（差分后）
  const zrows = usage.db.prepare("SELECT input, output, cache_read, total_tokens FROM ext_usage WHERE agent='zcode' ORDER BY ts").all();
  assert.equal(zrows.length, 2);
  assert.equal(zrows[0].input, 38562);
  assert.equal(zrows[0].cache_read, 16384);
  assert.equal(zrows[1].input, 812, "zcode 差分：39374-38562");
  assert.equal(zrows[1].cache_read, 22144, "zcode 差分：38528-16384");
  assert.equal(zrows[1].total_tokens, 39456 - 38889);

  // ② 二次运行幂等（水位命中 → 0 会话）
  assert.equal(await syncExtUsage(ctx), 0, "无变化时全部命中水位");

  // ③ jsonl 增量：claude 会话 append 一行 → 只重扫 1 会话
  const claudeFile = join(env.claudeHome, "-home-w", "aaaaaaaa-1111-2222-3333-444444444444.jsonl");
  appendFileSync(claudeFile,
    JSON.stringify(claudeLikeAssistant("2026-09-01T10:00:02Z", "glm-5.3",
      { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 60, cache_creation_input_tokens: 0 })) + "\n");
  assert.equal(await syncExtUsage(ctx), 1, "只重扫 claude 那个变化会话");
  assert.equal(count(usage, "SELECT COUNT(*) n FROM ext_usage"), 6);

  // ④ zcode rev 增量：time_updated 前移 → 重扫；幂等键不重复插入
  const db2 = new DatabaseSync(join(zdb, "db.sqlite"));
  db2.prepare("UPDATE session SET time_updated = 1788664749000 WHERE id='z-s1'").run();
  db2.close();
  assert.equal(await syncExtUsage(ctx), 1, "zcode rev 变化 → 重扫 1 会话");
  assert.equal(count(usage, "SELECT COUNT(*) n FROM ext_usage"), 6, "幂等 PK 去重，不新增行");

  // ⑤ flushDaily 并入 daily_model（同 provider 跨表合并，不撞 PK）
  await flushDaily(usage);
  const dm = usage.db.prepare(
    "SELECT provider, model, msgs, input FROM daily_model WHERE provider='zhipu' AND model='glm-5.3'").get();
  assert.ok(dm, "ext claude(zhipu/glm-5.3) 已并入 daily_model");
  assert.equal(dm.input, 300, "claude 两轮 input 100+200 合并");
  const zdm = usage.db.prepare(
    "SELECT provider, model, msgs, input FROM daily_model WHERE provider='bigmodel' AND model='GLM-5.3-Flash'").get();
  assert.equal(zdm.input, 39374, "zcode 差分后 input 总量 = 38562+812");

  // 清理（zcode fixture db 防 tmp 残留）
  rmSync(join(zdb, "db.sqlite"), { force: true });
  rmSync(join(zdb, "db.sqlite-wal"), { force: true });
  rmSync(join(zdb, "db.sqlite-shm"), { force: true });
});

test("ext 摄入期间事件循环可响应（防冻结）", async () => {
  const root = tmpRoot();
  const env = {
    claudeHome: join(root, "claude"), qodercnHome: join(root, "qodercn"),
    codebuddyHome: join(root, "codebuddy"), zcodeHome: join(root, "zcode"),
    // A11 P1 model-only 三源测试隔离（同上）
    codexHome: join(root, "codex"), opencodeHome: join(root, "opencode"), cursorHome: join(root, "cursor"),
  };
  mkdirSync(join(env.claudeHome, "proj"), { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 30; i++) {
    const lines = [];
    for (let j = 0; j < 10; j++) {
      lines.push(JSON.stringify(claudeLikeAssistant(
        new Date(now + i * 1000 + j).toISOString(), "glm-5.3",
        { input_tokens: 100 + j, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 })));
    }
    // 文件名须匹配 SID_UUID_RE（uuid 形态）；前 8 字符 hex 即满足
    const sid = String(i).padStart(2, "0") + "aaaaaa";
    writeFileSync(join(env.claudeHome, "proj", `${sid}-1111-2222-3333-444444444444.jsonl`), lines.join("\n") + "\n");
  }
  const usage = openTmpDb(root);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const n = await syncExtUsage({ usage, env });
  clearInterval(timer);
  assert.equal(n, 30);
  assert.equal(count(usage, "SELECT COUNT(*) n FROM ext_usage"), 300);
  assert.ok(ticks > 0, `ext 摄入期间事件循环应可响应，实际 tick=${ticks}`);
});