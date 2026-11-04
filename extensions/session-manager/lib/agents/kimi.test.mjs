/**
 * session-manager — Kimi adapter tests（fixture 双代格式；HOME 隔离到临时目录）。
 *
 * v1 = kimi-code 0.x：state.json {title, workDir, updatedAt ISO} + agents/main/wire.jsonl
 *      {type:"message", message:{role,content}} 帧（protocol_version 1.4）。
 * v2 = kimi-code 2.5.0：state.json {cwd, updatedAt epoch-ms, custom:{}}（version:2）+
 *      wire.jsonl {type:"context.append_message", message:{role,content}} 帧
 *      （protocol_version 1.5；注入类 user 帧带 <system-reminder> 须被剔除）。
 *
 * Run: node --test pi-web-ext/session-manager/lib/agents/kimi.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "kimi-adapter-test-"));
// adapter BASES() = $HOME/.kimi{,-code}/sessions —— 先改 HOME 再 import
process.env.HOME = ROOT;
const { createKimiAdapter } = await import("./kimi.ts");

const BASE = () => join(homedir(), ".kimi-code", "sessions");

function makeSession(dir, state, wireLines) {
  mkdirSync(join(dir, "agents", "main"), { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  if (wireLines) writeFileSync(join(dir, "agents", "main", "wire.jsonl"), wireLines.join("\n") + "\n");
}

test("kimi v2 (kimi-code 2.5.0): cwd 从 state.cwd、append_message 帧解析、reminder 注入剔除", () => {
  const sid = "session_v2a";
  const dir = join(BASE(), "wd_demo", sid);
  makeSession(dir,
    {
      id: sid, version: 2, cwd: "/tmp/proj", archived: false,
      createdAt: 1793808198112, updatedAt: 1793808349988, custom: {}, isCustomTitle: false,
    },
    [
      JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1793808198215 }),
      JSON.stringify({ type: "environment.set_binding", environmentId: "local", agentId: "main", time: 1793808198241 }),
      JSON.stringify({
        type: "context.append_message", agentId: "main", time: 1793808198376,
        message: { role: "user", content: [{ type: "text", text: "Reply with exactly: ok" }], toolCalls: [], id: "msg_1", origin: { kind: "user" } },
      }),
      // 注入帧：system-reminder 包裹的 user 文本 → 剔除后为空，不得计入
      JSON.stringify({
        type: "context.append_message", agentId: "main", time: 1793808198401,
        message: { role: "user", content: [{ type: "text", text: "<system-reminder>\nAuto permission mode is active.\n</system-reminder>" }], toolCalls: [], origin: { kind: "injection" } },
      }),
      JSON.stringify({
        type: "context.append_message", agentId: "main", time: 1793808350000,
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], toolCalls: [], id: "msg_2", origin: { kind: "model" } },
      }),
      // 非消息帧（事件嵌在 .event）不得误收
      JSON.stringify({ type: "context.append_loop_event", agentId: "main", event: { type: "step.begin", turnId: "0", step: 1 }, time: 1793808198414 }),
    ]);
  const a = createKimiAdapter();
  const ref = a.list().find((r) => r.sid === sid);
  assert.ok(ref, "session listed");
  const p = a.parse(ref);
  assert.ok(p);
  assert.equal(p.meta.cwd, "/tmp/proj");
  assert.equal(p.meta.messageCount, 2);
  assert.equal(p.messages[0].role, "user");
  assert.equal(p.messages[0].text, "Reply with exactly: ok");
  assert.equal(p.messages[1].role, "assistant");
  assert.equal(p.messages[1].text, "ok");
  assert.equal(p.meta.created, new Date(1793808349988).toISOString());
});

test("kimi v1 (kimi-code 0.x): workDir/title 旧字段照旧解析", () => {
  const sid = "session_v1a";
  const dir = join(BASE(), "wd_old", sid);
  makeSession(dir,
    {
      createdAt: "2026-09-15T17:16:56.894Z", updatedAt: "2026-09-15T17:20:00.000Z",
      title: "New Session", isCustomTitle: false, custom: {}, workDir: "/tmp",
    },
    [
      JSON.stringify({ type: "metadata", protocol_version: "1.4", created_at: 1789492617419 }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi kimi" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello!" }] } }),
    ]);
  const a = createKimiAdapter();
  const ref = a.list().find((r) => r.sid === sid);
  assert.ok(ref, "session listed");
  const p = a.parse(ref);
  assert.ok(p);
  assert.equal(p.meta.cwd, "/tmp");
  assert.equal(p.meta.name, "New Session");
  assert.equal(p.meta.messageCount, 2);
  assert.equal(p.messages[1].text, "hello!");
});

test("kimi v2 命名会话：custom.title 生效", () => {
  const sid = "session_v2b";
  const dir = join(BASE(), "wd_demo", sid);
  makeSession(dir,
    { id: sid, version: 2, cwd: "/x", archived: false, createdAt: 1, updatedAt: 2, custom: { title: "My Plan" }, isCustomTitle: true },
    [
      JSON.stringify({ type: "context.append_message", agentId: "main", message: { role: "user", content: [{ type: "text", text: "plan it" }] }, time: 3 }),
    ]);
  const a = createKimiAdapter();
  const ref = a.list().find((r) => r.sid === sid);
  const p = a.parse(ref);
  assert.equal(p.meta.name, "My Plan");
});

test("kimi archived 会话（两代字段）parse 返回 null", () => {
  const a = createKimiAdapter();
  const v1 = a.list().find((r) => r.sid === "session_arch1");
  const v2 = a.list().find((r) => r.sid === "session_arch2");
  for (const ref of [v1, v2]) {
    if (!ref) continue;
    assert.equal(a.parse(ref), null);
  }
});

// archived fixtures（放在用例后仍会被 list 扫到，parse 阶段拒绝）
makeSession(join(BASE(), "wd_old", "session_arch1"),
  { createdAt: "2026-09-15T17:16:56.894Z", updatedAt: "2026-09-15T17:20:00.000Z", title: "done", archived: true, workDir: "/tmp" },
  [JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "x" }] } })]);
makeSession(join(BASE(), "wd_demo", "session_arch2"),
  { id: "session_arch2", version: 2, cwd: "/x", archived: true, createdAt: 1, updatedAt: 2, custom: {} },
  [JSON.stringify({ type: "context.append_message", agentId: "main", message: { role: "user", content: [{ type: "text", text: "x" }] }, time: 3 })]);

process.on("exit", () => { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* tmp */ } });
