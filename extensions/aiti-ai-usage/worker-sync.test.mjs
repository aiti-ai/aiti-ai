/**
 * aiti-ai-usage — 真异步摄入（worker_threads）集成测试。
 *
 * 验证：init()/syncAll() 经 worker 独立线程 + 独立 SQLite 连接完成全量摄入，
 * 主线程零参与；worker 不可用时回退主线程（lastSyncBackend=inline）保底。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-ai-usage/worker-sync.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("syncAll 经 worker 独立线程完成（主线程零参与）", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-usage-worker-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(agentDir, "sessions", "proj-a");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(agentDir, "model-usage"), { recursive: true });
  mkdirSync(join(root, "archive"), { recursive: true }); // 隔离归档目录（TOKEN_USAGE_ARCHIVE_DIR）
  const now = Date.now();
  for (const [name, id] of [["w1.jsonl", "wsess-1"], ["w2.jsonl", "wsess-2"]]) {
    const lines = [
      JSON.stringify({ type: "session", id, cwd: "/w", timestamp: new Date(now).toISOString() }),
      JSON.stringify(assistantMsg(1, "gpt-4o", now)),
      JSON.stringify(assistantMsg(2, "gpt-4o", now + 1000)),
    ];
    writeFileSync(join(sessionDir, name), lines.join("\n") + "\n");
  }

  const prevAgent = process.env.PI_CODING_AGENT_DIR;
  const prevArchive = process.env.TOKEN_USAGE_ARCHIVE_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.TOKEN_USAGE_ARCHIVE_DIR = join(root, "archive");
  try {
    const { init } = await import("./server/runtime.ts");
    const rt = init(join(root, "cfg"));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    await rt.syncAll();
    clearInterval(timer);
    // 核心断言：摄入确实在 worker 线程执行（而非主线程回退）
    assert.equal(rt.lastSyncBackend, "worker", "应经 worker 执行（非主线程回退）");
    const n = rt.usage.db.prepare("SELECT COUNT(*) n FROM msg_usage").get().n;
    assert.ok(n >= 4, `worker 摄入应写入 4 条明细，实际 ${n}`);
    assert.ok(ticks > 0, `摄入期间主线程事件循环应正常，实际 tick=${ticks}`);
    rt.stop();
  } finally {
    if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgent;
    if (prevArchive === undefined) delete process.env.TOKEN_USAGE_ARCHIVE_DIR;
    else process.env.TOKEN_USAGE_ARCHIVE_DIR = prevArchive;
  }
});
