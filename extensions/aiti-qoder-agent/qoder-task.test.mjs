/**
 * aiti-qoder-agent — 任务列表（TodoWrite working plan）单测。
 *
 * CC stream-json 协议没有 todo 事件，面板数据只能从 TodoWrite 族工具调用派生（共享层
 * _shared/task-list.ts）。钉死：
 *   1. assistant 帧的 TodoWrite 入参 → task_update（前端 normalizeTasks 消费 todos 键）；
 *   2. 同一份列表重放不重复推（JSON 去重）；列表变化推新帧；
 *   3. 非 todo 工具（Read/Bash）不得动面板；工具结果回显新列表 = 第二通道；
 *   4. taskList() 应答 `{todos}`（宿主 handle-adapter get_state 取 .todos）；
 *   5. 快照落盘 <stateDir>/task-lists/<sid>.json + sessionDormantState 休眠兜底
 *      （应答 `{tasks}`，与 AgentStateResponse wire 对齐；占位 id/他家会话 → null）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-task.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// 状态写盘隔离：init 帧换绑会读写模型状态；startup 需要 configDir 落队列/任务快照根。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-task-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle, default: ext } = await import("./index.ts");

const capturedServices = {};
await ext.server.startup({
  configDir: join(sandbox, "ext-data"),
  sessionProviders: { register: () => "k" },
  services: { provide: (key, impl) => { capturedServices[key] = impl; return () => {}; } },
});

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });

const flush = () => new Promise((r) => setTimeout(r, 4));

function makeHandle(id = "qodercn:new-task") {
  const stdout = new PassThrough();
  const child = {
    stdout,
    stderr: { on() {} },
    once() {},
    stdin: { write: () => true, writable: true, on() {} },
    kill() {},
    exitCode: null,
  };
  const h = new QoderHandle(id, child, null, "/tmp", "cn");
  const events = [];
  h.subscribe((e) => events.push(e));
  const write = (frame) => stdout.write(JSON.stringify(frame) + "\n");
  return { h, events, write };
}

const taskUpdates = (events) => events.filter((e) => e.type === "task_update");
const todoFrame = (todos, id = "t1") => ({
  type: "assistant",
  message: { model: "qfmodel", content: [{ type: "tool_use", id, name: "TodoWrite", input: { todos } }] },
});

test("TodoWrite 入参 → task_update（todos 键 + status/priority 归一）", async () => {
  const { h, events, write } = makeHandle();
  write(todoFrame([
    { content: "步骤一", status: "in_progress" },
    { content: "步骤二", status: "PENDING", priority: "high" },
  ]));
  await flush();

  const tus = taskUpdates(events);
  assert.equal(tus.length, 1, "一轮 task_update");
  assert.deepEqual(tus[0].todos, [
    { content: "步骤一", status: "in_progress" },
    { content: "步骤二", status: "pending", priority: "high" },
  ]);
  const snapshot = await h.taskList();
  assert.deepEqual(snapshot.todos, tus[0].todos, "taskList() 应答 todos 键（宿主 get_state 取 .todos）");
});

test("重放去重：同一列表不重复推；变化才推新帧", async () => {
  const { events, write } = makeHandle();
  const list = [{ content: "A", status: "pending" }];
  write(todoFrame(list));
  write(todoFrame(list)); // CLI 重放同一帧
  await flush();
  assert.equal(taskUpdates(events).length, 1, "内容未变不重复推");

  write(todoFrame([{ content: "A", status: "completed" }, { content: "B", status: "in_progress" }], "t2"));
  await flush();
  const tus = taskUpdates(events);
  assert.equal(tus.length, 2);
  assert.deepEqual(tus[1].todos.map((t) => t.status), ["completed", "in_progress"]);
});

test("非 todo 工具不动面板；tool_result 回显新列表 = 第二通道", async () => {
  const { events, write } = makeHandle();
  write({ type: "assistant", message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: { path: "a.ts" } }] } });
  write({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "r1", content: "文件内容" }] } });
  await flush();
  assert.equal(taskUpdates(events).length, 0, "Read 与任务无关");

  // 部分 CLI 把新列表回显在工具结果里（input 无列表 → output 兜底）
  write({ type: "assistant", message: { content: [{ type: "tool_use", id: "t9", name: "TodoWrite", input: {} }] } });
  write({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t9", content: JSON.stringify({ todos: [{ content: "结果里的任务", status: "pending" }] }) }] },
  });
  await flush();
  const tus = taskUpdates(events);
  assert.equal(tus.length, 1);
  assert.deepEqual(tus[0].todos, [{ content: "结果里的任务", status: "pending" }]);
});

test("快照 + 休眠兜底：init 换绑后落盘，dormant 服务读回 {tasks}", async () => {
  const { h, events, write } = makeHandle();
  const sid = "5f0c1a2b-3d4e-4f50-8a9b-c0d1e2f3a4b5";
  write({ type: "system", subtype: "init", session_id: sid });
  await flush();
  assert.ok(h.id.endsWith(sid), "init 换绑真实 sid");

  write(todoFrame([{ content: "落盘任务", status: "in_progress" }]));
  await flush();
  assert.equal(taskUpdates(events).length, 1);

  const dormant = capturedServices["aiti-qoder-agent.sessionDormantState"];
  assert.equal(typeof dormant, "function", "startup 已 provide 休眠兜底服务");
  const snap = await dormant(`qodercn:${sid}`);
  assert.deepEqual(snap?.tasks, [{ content: "落盘任务", status: "in_progress" }], "休眠应答 tasks 键");

  // 内存镜像被清空（模拟 handle 空闲 GC 后重建的同 sid handle）→ taskList() 回退快照
  const reopened = makeHandle(`qodercn:${sid}`);
  assert.deepEqual((await reopened.h.taskList()).todos, snap.tasks, "新 handle 无镜像时读快照");

  assert.equal(await dormant("qodercn:new-placeholder"), null, "占位 id 未落库 → null");
  assert.equal(await dormant(`pi:${sid}`), null, "他家后端会话不认领（不得串台）");
  assert.equal(await dormant("qoder:sess-missing"), null, "无快照文件 → null");
  assert.equal(await dormant("qodercn:../../etc/passwd"), null, "路径穿越 → null");
});
