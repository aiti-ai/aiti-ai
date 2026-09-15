// 只读命令离线化（2026-09-15）：无 wrapper 时 get_session_stats 直接从会话文件
// 聚合应答，绝不冷启动 runtime——「打开会话页/点开统计面板只为看一眼」不该拉起
// 完整 agent（连扩展/MCP/子进程），更不该在本实例造出陈旧内存 wrapper。
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST: sendAgentCommand } = await jiti.import("./[id]/route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("@/lib/session-reader");

test("无 wrapper 时 get_session_stats 离线应答（文件聚合）且不创建 runtime", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-agent-offline-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piSessions = new Map();
  let sessionId;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    globalThis.__piSessions = previousRegistry;
    if (sessionId) invalidateSessionPathCache(sessionId);
    await rm(dir, { recursive: true, force: true });
  });

  const manager = SessionManager.create(dir);
  manager.appendMessage({ role: "user", content: "offline stats fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
    timestamp: Date.now(),
  });
  sessionId = manager.getSessionId();
  const filePath = manager.getSessionFile();
  assert.ok(filePath && existsSync(filePath), "session file must be flushed");
  cacheSessionPath(sessionId, filePath);

  const response = await sendAgentCommand(
    new Request(`http://localhost/api/agent/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "get_session_stats" }),
    }),
    { params: Promise.resolve({ id: sessionId }) },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.data.sessionId, sessionId);
  assert.equal(body.data.sessionFile, filePath);
  assert.equal(body.data.userMessages, 1);
  assert.equal(body.data.assistantMessages, 1);
  assert.equal(body.data.totalMessages, 2);
  assert.equal(body.data.tokens.input, 10);
  assert.equal(body.data.tokens.output, 5);
  // 关键契约：离线应答不得就地创建 runtime（wrapper）。
  assert.equal(globalThis.__piSessions.size, 0, "get_session_stats must not spin up an rpc wrapper");
});
