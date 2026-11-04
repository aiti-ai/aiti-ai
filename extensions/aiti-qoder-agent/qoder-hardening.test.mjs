/**
 * aiti-qoder-agent — 加固行为单测（P1 四处行为错误的回归钉子）。
 *
 *   1. lineReader 溢出闸门必须真的可达（原实现在切行循环里 return，检查成了死代码
 *      → 单行超阈值时无限累积 Buffer）；
 *   2. recycle 的占位 id（`qoder:new-<uuid>`，从没收到过 init 帧）不得当成真实 sid
 *      去 --resume——共享层约定 sessionId 空串 = 只 dispose 不重建；
 *   3. init 帧换绑判据（endsWith）：占位 → 真实 sid 一次，重复 init 不二次换绑；
 *   4. abort() 在 handle 自认空闲时也必须给前端一帧收口（停止按钮不得永挂）；
 *   5. 队列 sidecar 文件名去冒号（NTFS 冒号是 ADS 流分隔符，win32 上多会话互相踩踏）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-hardening.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

// 状态写盘隔离：init 帧换绑会 rename 模型状态文件并持久化 selected（不隔离就写进真实
// ~/.pi/agent/ext-agents）。必须在 import 扩展前设好（读点在函数调用时，越早越稳）。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-hardening-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle, lineReader, parseRecycleId, sidecarBase } = await import("./index.ts");

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });

const flush = () => new Promise((r) => setTimeout(r, 2));

function makeHandle(id = "qodercn:new-hardening") {
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
  return { h, events, write: (frame) => stdout.write(JSON.stringify(frame) + "\n") };
}

test("lineReader：单行超阈值 → onOverflow 触发且停止累积（闸门可达，非死代码）", async () => {
  const s = new PassThrough();
  const lines = [];
  let overflow = 0;
  lineReader(s, (line) => lines.push(line), { maxLineBytes: 64, onOverflow: (n) => { overflow = n; } });
  s.write(Buffer.from("A".repeat(200)));
  s.write(Buffer.from("B".repeat(200)));
  await flush();
  assert.equal(lines.length, 0);
  assert.ok(overflow >= 200, `应报出溢出字节数，实得 ${overflow}`);
  // 溢出后彻底哑火（由调用方 markDead 收口）：不得再无限累积
  const before = overflow;
  s.write(Buffer.from("C".repeat(500)));
  await flush();
  assert.equal(overflow, before);
});

test("lineReader：完整行照常切分，跨 chunk 的中文不碎成 U+FFFD", async () => {
  const s = new PassThrough();
  const lines = [];
  lineReader(s, (line) => lines.push(line));
  const buf = Buffer.from('{"t":"中文正文"}\n{"t":"第二行"}\n', "utf8");
  const cut = buf.indexOf(0xe4) + 1; // 落在一个多字节字符中间
  s.write(buf.subarray(0, cut));
  s.write(buf.subarray(cut));
  await flush();
  assert.deepEqual(lines, ['{"t":"中文正文"}', '{"t":"第二行"}']);
});

test("parseRecycleId：占位 id → 空 sessionId（只释放不重建）；真实 sid 直通", () => {
  assert.deepEqual(parseRecycleId("qoder:new-3f2a1b"), { sessionId: "", providerType: "aiti-qoder-agent/qoder" });
  assert.deepEqual(parseRecycleId("qodercn:new-9d3f2a"), { sessionId: "", providerType: "aiti-qoder-agent/qoder-cn" });
  assert.deepEqual(parseRecycleId("qoder:0f3d2c1b-aaaa"), { sessionId: "0f3d2c1b-aaaa", providerType: "aiti-qoder-agent/qoder" });
  assert.deepEqual(parseRecycleId("qodercn:0f3d2c1b-bbbb"), { sessionId: "0f3d2c1b-bbbb", providerType: "aiti-qoder-agent/qoder-cn" });
  assert.equal(parseRecycleId("claude:0f3d2c1b"), null);
});

test("abort()：空闲态也发 aborted 收口帧（前端停止按钮不得永挂）", async () => {
  const { h, events } = makeHandle();
  await h.abort();
  assert.deepEqual(events.map((e) => e.type), ["agent_end", "agent_settled"]);
  assert.equal(events[1].stopReason, "aborted");
});

test("init 帧换绑：占位 id → 真实 sid（前缀随 variant），重复 init 不二次换绑", async () => {
  const { h, events, write } = makeHandle("qodercn:new-abc123");
  write({ type: "system", subtype: "init", session_id: "real-sid", model: "m1" });
  await flush();
  assert.equal(h.id, "qodercn:real-sid");
  assert.equal(events.find((e) => e.type === "session_backend_ready")?.oldId, "qodercn:new-abc123");
  write({ type: "system", subtype: "init", session_id: "real-sid", model: "m1" });
  await flush();
  assert.equal(events.filter((e) => e.type === "session_backend_ready").length, 1);
});

test("init 帧能力面快照：tools/slash_commands/permissionMode → getAllTools/getCommands/getPermissionMode", async () => {
  const { h, write } = makeHandle();
  assert.deepEqual(await h.getAllTools(), [], "init 前空态不抛");
  assert.deepEqual(await h.getCommands(), []);
  write({
    type: "system",
    subtype: "init",
    session_id: "cap-sid",
    model: "m1",
    tools: ["Bash", "Read", "Edit"],
    slash_commands: ["compact", "review"],
    permissionMode: "bypassPermissions",
  });
  await flush();
  assert.deepEqual((await h.getAllTools()).map((t) => t.name), ["Bash", "Read", "Edit"]);
  assert.deepEqual(await h.getCommands(), [
    { name: "compact", source: "skill" },
    { name: "review", source: "skill" },
  ]);
  assert.equal(h.getPermissionMode(), "bypassPermissions");
  // 重复 init（CLI 会再发一次）覆盖为最近一轮，且不得因模型未变而误报 model_select
  write({ type: "system", subtype: "init", session_id: "cap-sid", model: "m1", tools: ["Bash"] });
  await flush();
  assert.deepEqual((await h.getAllTools()).map((t) => t.name), ["Bash"]);
});

test("sidecar 文件名：win32 去冒号（NTFS ADS 分隔符），非 win 保持原样", () => {
  const got = sidecarBase("qoder:new-abc");
  if (process.platform === "win32") {
    assert.equal(got, "qoder_new-abc.json");
    assert.ok(!got.includes(":"), "win32 上不得含冒号");
  } else {
    assert.equal(got, "qoder:new-abc.json");
  }
});
