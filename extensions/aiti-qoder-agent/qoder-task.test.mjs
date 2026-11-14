/**
 * aiti-qoder-agent — 任务列表镜像单测（ACP plan 帧 + TodoWrite 工具事件双通道）。
 *
 * 钉死行为（2026-11-13 ACP 重写）：
 *   1. session/update:plan → task_update（entries → todos 换算，status/priority 归一）；
 *   2. 重放去重：同一列表不重复推；变化才推新帧；
 *   3. TodoWrite 族工具入参/结果回显 = 兜底通道（非 todo 工具不动面板）；
 *   4. 快照落盘 + 休眠兜底（sessionDormantState 服务读回 {tasks}）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-task.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 状态写盘隔离：session/new 换绑会读写模型状态；startup 需要 configDir 落队列/任务快照根。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-task-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle, default: ext } = await import("./index.ts");
const { makeReadyHandle, flush } = await import("./qoder-acp-stub.mjs");

const capturedServices = {};
await ext.server.startup({
  configDir: join(sandbox, "ext-data"),
  sessionProviders: { register: () => "k" },
  services: { provide: (key, impl) => { capturedServices[key] = impl; return () => {}; } },
});

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });

const taskUpdates = (events) => events.filter((e) => e.type === "task_update");

test("ACP plan 帧 → task_update（entries 换算 + status/priority 归一）", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  stub.notify({
    sessionUpdate: "plan",
    entries: [
      { content: "步骤一", status: "in_progress" },
      { content: "步骤二", status: "PENDING", priority: "high" },
    ],
  });
  await flush();

  const tus = taskUpdates(events);
  assert.equal(tus.length, 1, "一轮 task_update");
  assert.deepEqual(tus[0].todos, [
    { content: "步骤一", status: "in_progress", priority: "medium" },
    { content: "步骤二", status: "pending", priority: "high" },
  ]);
  const snapshot = await h.taskList();
  assert.deepEqual(snapshot.todos, tus[0].todos, "taskList() 应答 todos 键（宿主 get_state 取 .todos）");
  await h.dispose();
});

test("重放去重：同一列表不重复推；变化才推新帧", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  const entries = [{ content: "A", status: "pending" }];
  stub.notify({ sessionUpdate: "plan", entries });
  stub.notify({ sessionUpdate: "plan", entries }); // CLI 重放同一帧
  await flush();
  assert.equal(taskUpdates(events).length, 1, "内容未变不重复推");

  stub.notify({ sessionUpdate: "plan", entries: [{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }] });
  await flush();
  const tus = taskUpdates(events);
  assert.equal(tus.length, 2);
  assert.deepEqual(tus[1].todos.map((t) => t.status), ["completed", "in_progress"]);
  await h.dispose();
});

test("非 todo 工具不动面板；TodoWrite 工具事件 = 兜底通道", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle);
  stub.notify({ sessionUpdate: "tool_call", toolCallId: "r1", status: "pending", title: "Read", rawInput: { path: "a.ts" } });
  stub.notify({ sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed", rawOutput: "文件内容" });
  await flush();
  assert.equal(taskUpdates(events).length, 0, "Read 与任务无关");

  // TodoWrite 工具事件（入参带列表）→ 面板更新
  stub.notify({ sessionUpdate: "tool_call", toolCallId: "t9", status: "pending", title: "Plan", rawInput: { todos: [{ content: "入参里的任务", status: "pending" }] }, _meta: { qoder: { toolName: "TodoWrite" } } });
  await flush();
  const tus = taskUpdates(events);
  assert.equal(tus.length, 1);
  assert.deepEqual(tus[0].todos, [{ content: "入参里的任务", status: "pending" }]);
  await h.dispose();
});

test("快照 + 休眠兜底：真实 sid 换绑后落盘，dormant 服务读回 {tasks}", async () => {
  const sid = "5f0c1a2b-3d4e-4f50-8a9b-c0d1e2f3a4b5";
  const { h, events, stub } = await makeReadyHandle(QoderHandle, { sessionId: sid, stubOpts: { sessionId: sid } });
  assert.ok(h.id.endsWith(sid), "接管会话 id 即真实 sid");

  stub.notify({ sessionUpdate: "plan", entries: [{ content: "落盘任务", status: "in_progress" }] });
  await flush();
  assert.equal(taskUpdates(events).length, 1);

  const dormant = capturedServices["aiti-qoder-agent.sessionDormantState"];
  assert.equal(typeof dormant, "function", "startup 已 provide 休眠兜底服务");
  const snap = await dormant(`qodercn:${sid}`);
  assert.deepEqual(snap?.tasks, [{ content: "落盘任务", status: "in_progress", priority: "medium" }], "休眠应答 tasks 键");
  await h.dispose();
});
