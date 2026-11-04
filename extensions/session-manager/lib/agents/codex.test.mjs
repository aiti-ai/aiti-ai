/**
 * session-manager — codex adapter 结构化工具行（IndexedMessage.tool）。
 *
 * 钉死行为（2026-09-22：codex 冷恢复回放连工具痕迹都没有——rollout 的 function_call/
 * function_call_output 两行被整体丢弃，既无卡片也无输出）：
 *   1. response_item function_call/custom_tool_call → 自成一条 assistant 结构化工具行
 *     （tool{callID,name,input}，text 仍是 🛠 兜底行，搜索/预览/to-pi 消费方零感知）；
 *   2. 其后的 *_output 行按 call_id 回填 output（截 4000；无配对/空输出不回填）；
 *   3. event_msg item_completed 的 CommandExecution 等同一次调用的另一份 serde → 不重复入账。
 *
 * 真机样本：隔离 CODEX_HOME 跑 codex_exec 0.149.1（openrouter 免费模型）一次带 shell
 * 调用的会话，逐行取自其 rollout（长 instructions 正文截短，工具三行原样）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/session-manager/lib/agents/codex.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "codex-adapter-"));
process.env.AITI_CODEX_HOME = ROOT;

const { createCodexAdapter } = await import("./codex.ts");
const adapter = createCodexAdapter();

const TS = "2026-09-22T03:49:28.472Z";
const CALL_ID = "call-8cd559a6-306c-49b3-95e3-28c33bce6390";

function writeRollout(lines, name) {
  const dir = join(ROOT, "sessions", "2026", "09", "22");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const parse = (lines) => adapter.parse({ sid: "s1", path: writeRollout(lines, `${Math.random().toString(36).slice(2)}.jsonl`) });

const META = { type: "session_meta", timestamp: TS, payload: { id: "01a0c73b", cwd: "/tmp/codex-probe/work" } };
const TURN = { type: "turn_context", timestamp: TS, payload: { turn_id: "t1", model: "nvidia/nemotron-3.5-lightning:free" } };
const MSG = (role, text) => ({ type: "response_item", timestamp: TS, payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] } });
const CALL = (payload) => ({ type: "response_item", timestamp: TS, payload: { type: "function_call", ...payload } });
const OUTPUT = (payload) => ({ type: "response_item", timestamp: TS, payload: { type: "function_call_output", ...payload } });

test("真机样本：调用行带结构化 tool，结果行按 call_id 回填 output", () => {
  const parsed = parse([
    META, TURN,
    MSG("developer", "<skills_instructions>…"),
    MSG("user", "<environment_context>\n  <cwd>/tmp/codex-probe/work</cwd>\n</environment_context>"),
    MSG("user", "Use your shell tool to run exactly: echo CODEX-PROBE-OK"),
    {
      type: "response_item", timestamp: TS,
      payload: {
        type: "function_call", id: "fc_tmp_s0a80sj9qg", name: "exec_command",
        arguments: '{"cmd":"echo CODEX-PROBE-OK"}', call_id: CALL_ID,
        internal_chat_message_metadata_passthrough: { turn_id: "t1" },
      },
    },
    {
      type: "event_msg", timestamp: TS,
      payload: {
        type: "item_completed", thread_id: "01a0c73b", turn_id: "t1",
        item: {
          type: "CommandExecution", id: CALL_ID, process_id: "37277",
          command: ["/bin/bash", "-lc", "echo CODEX-PROBE-OK"], cwd: "file:///tmp/codex-probe/work",
          status: "completed", stdout: "CODEX-PROBE-OK\n", stderr: "",
          aggregated_output: "CODEX-PROBE-OK\n", exit_code: 0,
        },
      },
    },
    {
      type: "response_item", timestamp: TS,
      payload: {
        type: "function_call_output", id: "fco_01a0c73b", call_id: CALL_ID,
        output: "Chunk ID: fed65d\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\nCODEX-PROBE-OK\n",
      },
    },
    MSG("assistant", "DONE"),
  ]);

  assert.deepEqual(parsed.messages.map((m) => m.role), ["user", "assistant", "assistant"],
    "developer 与 environment_context 不成行；工具调用自成一行");
  assert.equal(parsed.messages[1].text, '🛠 exec_command {"cmd":"echo CODEX-PROBE-OK"}', "text 仍是兜底展示行");
  assert.deepEqual(parsed.messages[1].tool, {
    callID: CALL_ID,
    name: "exec_command",
    input: { cmd: "echo CODEX-PROBE-OK" },
    output: "Chunk ID: fed65d\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 4\nOutput:\nCODEX-PROBE-OK",
  }, "arguments JSON 串解析成对象；output 收掉尾换行");
  assert.equal(parsed.messages[1].toolName, "exec_command", "工具名单列（索引 messages.tool_name 消费）");
  assert.equal(parsed.messages.filter((m) => m.tool).length, 1, "item_completed 的 CommandExecution 是同一次调用，不再三入账");
  assert.equal(parsed.meta.model, "nvidia/nemotron-3.5-lightning:free");
  assert.equal(parsed.meta.cwd, "/tmp/codex-probe/work");
});

test("custom_tool_call：input 是补丁类纯文本 → 包一层 {input}，结果走 *_output", () => {
  const parsed = parse([
    { type: "response_item", timestamp: TS, payload: { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch\n*** Add File: a.txt\nhi\n*** End Patch" } },
    { type: "response_item", timestamp: TS, payload: { type: "custom_tool_call_output", call_id: "c1", output: "Success." } },
  ]);
  const tool = parsed.messages[0].tool;
  assert.deepEqual(tool.input, { input: "*** Begin Patch\n*** Add File: a.txt\nhi\n*** End Patch" });
  assert.equal(tool.output, "Success.");
  assert.match(parsed.messages[0].text, /^🛠 apply_patch \*\*\* Begin Patch/);
});

test("output 为 content 块数组（FunctionCallOutputBody）→ 取文本拼接", () => {
  const parsed = parse([
    CALL({ call_id: "c2", name: "exec_command", arguments: '{"cmd":"ls"}' }),
    OUTPUT({ call_id: "c2", output: [{ type: "input_text", text: "第一段" }, { type: "text", text: "第二段" }, { type: "encrypted_content", encrypted_content: "x" }] }),
  ]);
  assert.equal(parsed.messages[0].tool.output, "第一段\n第二段");
});

test("未收结果/空结果/无配对结果：调用行只有没 output，不凭空造", () => {
  const open = parse([CALL({ call_id: "c3", name: "exec_command", arguments: '{"cmd":"sleep 9"}' })]);
  assert.equal(open.messages[0].tool.output, undefined);

  const empty = parse([
    CALL({ call_id: "c4", name: "exec_command", arguments: "{}" }),
    OUTPUT({ call_id: "c4", output: "   \n" }),
  ]);
  assert.equal(empty.messages[0].tool.output, undefined, "全空输出不回填（回放侧只出调用卡）");

  const orphan = parse([
    CALL({ call_id: "c5", name: "exec_command", arguments: "{}" }),
    OUTPUT({ call_id: "c-other", output: "无人认领" }),
  ]);
  assert.equal(orphan.messages[0].tool.output, undefined);
});

test("缺 call_id 的调用仍出结构化行（无法配对，但不丢痕迹）；非 JSON 入参原文保住", () => {
  const parsed = parse([CALL({ name: "exec_command", arguments: "not json" })]);
  assert.deepEqual(parsed.messages[0].tool, { name: "exec_command", input: { input: "not json" } });
  assert.match(parsed.messages[0].text, /🛠 exec_command not json/);
});

test("巨型输出截断到 4000 字符（整段历史一次进 handle 内存）", () => {
  const parsed = parse([
    CALL({ call_id: "c6", name: "exec_command", arguments: "{}" }),
    OUTPUT({ call_id: "c6", output: "x".repeat(9000) }),
  ]);
  assert.equal(parsed.messages[0].tool.output.length, 4000);
});

test("脏行不断链：坏 JSON 行跳过，其余照常成行", () => {
  const dir = join(ROOT, "sessions", "2026", "09", "22");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "dirty.jsonl");
  writeFileSync(path, [
    JSON.stringify(META),
    "{坏行",
    JSON.stringify(MSG("user", "问")),
    "",
    JSON.stringify(MSG("assistant", "答")),
  ].join("\n"));
  const parsed = adapter.parse({ sid: "s1", path });
  assert.equal(parsed.messages.length, 2);
});

test("AITI_CODEX_HOME 决定会话根：roots/list 按 YYYY/MM/DD 递归取 rollout 文件名里的 sid", () => {
  const dir = join(ROOT, "sessions", "2026", "09", "22");
  mkdirSync(dir, { recursive: true });
  const sid = "01a0c73b-57ca-7dd2-9354-c6007e5e8370";
  writeFileSync(join(dir, `rollout-2026-09-22T11-49-10-${sid}.jsonl`), `${JSON.stringify(META)}\n${JSON.stringify(MSG("user", "hi"))}\n`);
  assert.deepEqual(adapter.roots(), [join(ROOT, "sessions")]);
  assert.deepEqual(adapter.list(), [{ sid, path: join(dir, `rollout-2026-09-22T11-49-10-${sid}.jsonl`) }]);
  assert.equal(adapter.probe().count, 1);
});

test.after(() => { rmSync(ROOT, { recursive: true, force: true }); });
