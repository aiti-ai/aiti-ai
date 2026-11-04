/**
 * _shared/task-list — 任务列表派生语义单测（从 aiti-zcode-agent 抽层时的行为钉子）。
 *
 * 钉死桌面端逆向语义（docs/aiti-zcode-agent-task-list-plan.md §1）与镜像更新语义：
 * 解析（键序/状态归一/all-or-nothing/字符串条目首项 in_progress）、工具名匹配、
 * 去重（同内容不重复回调）、回调给副本（外部改了不得污染镜像内部）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/task-list.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { TODO_PLAN_TOOL_RE, createTaskListMirror, extractTaskList, normalizeTaskStatus, parseTaskEntry } =
  await import("@aiti-ai/ext-shared/task-list");

test("工具名匹配：TodoWrite/TodoRead/MCP update_plan 变体命中，普通工具不命中", () => {
  for (const name of ["TodoWrite", "TodoRead", "todo_write", "mcp__x__update_plan", "Update-Plan", "mcp_todo_write"]) {
    assert.ok(TODO_PLAN_TOOL_RE.test(name), `应命中：${name}`);
  }
  for (const name of ["Read", "Bash", "todowriter", "mytodo_write", ""]) {
    assert.equal(TODO_PLAN_TOOL_RE.test(name), false, `不该命中：${name}`);
  }
});

test("状态归一：连字符转下划线 + 大小写；非法状态为 null", () => {
  assert.equal(normalizeTaskStatus("IN-PROGRESS"), "in_progress");
  assert.equal(normalizeTaskStatus("completed"), "completed");
  assert.equal(normalizeTaskStatus("doing"), null);
  assert.equal(normalizeTaskStatus(undefined), null);
});

test("parseTaskEntry：字段优先级 content>step>title>text>activeForm；非法条目弃", () => {
  assert.deepEqual(parseTaskEntry({ content: "A", step: "B", status: "pending" }, 0), { content: "A", status: "pending" });
  assert.deepEqual(parseTaskEntry({ title: "T", status: "in-progress", priority: "high" }, 1), { content: "T", status: "in_progress", priority: "high" });
  assert.equal(parseTaskEntry({ content: "无状态" }, 0), null);
  assert.equal(parseTaskEntry(null, 0), null);
  assert.equal(parseTaskEntry("   ", 0), null);
  // 纯字符串：首项 in_progress，其余 pending
  assert.deepEqual(parseTaskEntry("先做这个", 0), { content: "先做这个", status: "in_progress" });
  assert.deepEqual(parseTaskEntry("再做那个", 2), { content: "再做那个", status: "pending" });
});

test("extractTaskList：键序 todos>plan>steps>items；字符串先 JSON.parse；all-or-nothing", () => {
  assert.deepEqual(extractTaskList('{"todos":[{"content":"a","status":"pending"}]}'), [{ content: "a", status: "pending" }]);
  assert.deepEqual(extractTaskList({ plan: ["一", "二"] }), [
    { content: "一", status: "in_progress" },
    { content: "二", status: "pending" },
  ]);
  // 一条非法 → 整份弃（宁可不更新，也不显示半截计划）
  assert.equal(extractTaskList({ todos: [{ content: "a", status: "pending" }, { content: "缺状态" }] }), null);
  assert.equal(extractTaskList({ todos: [] }), null);
  assert.equal(extractTaskList("{ 坏 JSON"), null);
  assert.equal(extractTaskList([1, 2]), null);
});

test("mirror：全量替换 + JSON 去重 + 回调副本", () => {
  const seen = [];
  const m = createTaskListMirror((t) => seen.push(t));
  assert.deepEqual(m.current(), []);

  m.fromToolEvent("TodoWrite", { todos: [{ content: "a", status: "pending" }] });
  assert.equal(seen.length, 1);
  // 同内容重放（resume 快照 + 工具事件双通道）不再回调
  m.fromToolEvent("TodoWrite", { todos: [{ content: "a", status: "pending" }] });
  assert.equal(seen.length, 1);
  // 非 TodoWrite 族 / 解析失败 → 保持现状
  m.fromToolEvent("Read", { todos: [{ content: "b", status: "completed" }] });
  m.fromToolEvent("TodoWrite", "not json");
  assert.equal(seen.length, 1);
  assert.deepEqual(m.current(), [{ content: "a", status: "pending" }]);
  // input 优先、output 兜底（多候选值取首个可解析）
  m.fromToolEvent("TodoWrite", null, { todos: [{ content: "b", status: "completed" }] });
  assert.equal(seen.length, 2);
  assert.deepEqual(m.current(), [{ content: "b", status: "completed" }]);
  // 回调给的是副本：外部改写不污染镜像内部
  seen[1][0].content = "外部篡改";
  assert.equal(m.current()[0].content, "b");
});

test("mirror.seed：resume 快照逐条防御解析，空/非数组保持现状", () => {
  const seen = [];
  const m = createTaskListMirror((t) => seen.push(t));
  m.seed("不是数组");
  m.seed([]);
  assert.equal(seen.length, 0);
  m.seed([{ content: "a", status: "pending" }, { 坏: "条目" }, { content: "c", status: "completed" }]);
  assert.deepEqual(m.current(), [
    { content: "a", status: "pending" },
    { content: "c", status: "completed" },
  ]);
});
