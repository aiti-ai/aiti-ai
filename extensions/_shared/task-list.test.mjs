/**
 * _shared/task-list — unit tests for the task-list derivation semantics (behavior pins from the
 * aiti-zcode-agent extraction).
 *
 * Pins the desktop reverse-engineering semantics (docs/aiti-zcode-agent-task-list-plan.md §1) and the
 * mirror update semantics: parsing (key order / status normalization / all-or-nothing / string entries
 * first-in_progress), tool-name matching, dedupe (identical content does not re-callback), and
 * copy-on-callback (external mutation must not pollute the mirror's internals).
 *
 * Run: node --experimental-strip-types --test pi-web-ext/_shared/task-list.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { TODO_PLAN_TOOL_RE, createTaskListMirror, extractTaskList, normalizeTaskStatus, parseTaskEntry } =
  await import("@aiti-ai/ext-shared/task-list");

test("tool-name matching: TodoWrite/TodoRead/MCP update_plan variants hit, ordinary tools don't", () => {
  for (const name of ["TodoWrite", "TodoRead", "todo_write", "mcp__x__update_plan", "Update-Plan", "mcp_todo_write"]) {
    assert.ok(TODO_PLAN_TOOL_RE.test(name), `should hit: ${name}`);
  }
  for (const name of ["Read", "Bash", "todowriter", "mytodo_write", ""]) {
    assert.equal(TODO_PLAN_TOOL_RE.test(name), false, `should not hit: ${name}`);
  }
});

test("status normalization: hyphens to underscores + case; invalid status is null", () => {
  assert.equal(normalizeTaskStatus("IN-PROGRESS"), "in_progress");
  assert.equal(normalizeTaskStatus("completed"), "completed");
  assert.equal(normalizeTaskStatus("doing"), null);
  assert.equal(normalizeTaskStatus(undefined), null);
});

test("parseTaskEntry: field priority content>step>title>text>activeForm; invalid entries dropped", () => {
  assert.deepEqual(parseTaskEntry({ content: "A", step: "B", status: "pending" }, 0), { content: "A", status: "pending" });
  assert.deepEqual(parseTaskEntry({ title: "T", status: "in-progress", priority: "high" }, 1), { content: "T", status: "in_progress", priority: "high" });
  assert.equal(parseTaskEntry({ content: "no-status" }, 0), null);
  assert.equal(parseTaskEntry(null, 0), null);
  assert.equal(parseTaskEntry("   ", 0), null);
  // Pure strings: the first is in_progress, the rest pending
  assert.deepEqual(parseTaskEntry("do this first", 0), { content: "do this first", status: "in_progress" });
  assert.deepEqual(parseTaskEntry("then that", 2), { content: "then that", status: "pending" });
});

test("extractTaskList: key order todos>plan>steps>items; strings JSON.parse first; all-or-nothing", () => {
  assert.deepEqual(extractTaskList('{"todos":[{"content":"a","status":"pending"}]}'), [{ content: "a", status: "pending" }]);
  assert.deepEqual(extractTaskList({ plan: ["one", "two"] }), [
    { content: "one", status: "in_progress" },
    { content: "two", status: "pending" },
  ]);
  // One invalid entry -> the whole set is dropped (better to skip the update than show half a plan)
  assert.equal(extractTaskList({ todos: [{ content: "a", status: "pending" }, { content: "missing-status" }] }), null);
  assert.equal(extractTaskList({ todos: [] }), null);
  assert.equal(extractTaskList("{ broken JSON"), null);
  assert.equal(extractTaskList([1, 2]), null);
});

test("mirror: full replacement + JSON dedupe + copy-on-callback", () => {
  const seen = [];
  const m = createTaskListMirror((t) => seen.push(t));
  assert.deepEqual(m.current(), []);

  m.fromToolEvent("TodoWrite", { todos: [{ content: "a", status: "pending" }] });
  assert.equal(seen.length, 1);
  // Same-content replay (resume snapshot + tool event dual channels) does not re-callback
  m.fromToolEvent("TodoWrite", { todos: [{ content: "a", status: "pending" }] });
  assert.equal(seen.length, 1);
  // Non-TodoWrite family / parse failure -> keep the current state
  m.fromToolEvent("Read", { todos: [{ content: "b", status: "completed" }] });
  m.fromToolEvent("TodoWrite", "not json");
  assert.equal(seen.length, 1);
  assert.deepEqual(m.current(), [{ content: "a", status: "pending" }]);
  // input first, output as fallback (multiple candidates take the first parseable one)
  m.fromToolEvent("TodoWrite", null, { todos: [{ content: "b", status: "completed" }] });
  assert.equal(seen.length, 2);
  assert.deepEqual(m.current(), [{ content: "b", status: "completed" }]);
  // The callback hands out a copy: external mutation does not pollute the mirror's internals
  seen[1][0].content = "tampered";
  assert.equal(m.current()[0].content, "b");
});

test("mirror.seed: resume snapshot parsed defensively per entry; empty/non-array keeps the current state", () => {
  const seen = [];
  const m = createTaskListMirror((t) => seen.push(t));
  m.seed("not an array");
  m.seed([]);
  assert.equal(seen.length, 0);
  m.seed([{ content: "a", status: "pending" }, { broken: "entry" }, { content: "c", status: "completed" }]);
  assert.deepEqual(m.current(), [
    { content: "a", status: "pending" },
    { content: "c", status: "completed" },
  ]);
});
