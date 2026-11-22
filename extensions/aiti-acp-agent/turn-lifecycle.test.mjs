/**
 * aiti-acp-agent — 轮次收口单测（prompt 失败 / abort / 迟到帧）。
 *
 * 回归重点（2026-09-12 线上事故 codebuddy:01a0959c-…）：一轮 session/prompt 的
 * result 帧丢失 → rpc 600s 超时后旧实现只 throw 不复位 running，句柄永久
 * 「运行中」；此后按停止（abort）只写 session/cancel 也不复位 → 前端「停止中」
 * 永挂（用户症状：无法停止）。本测试钉死：
 *   1. prompt 失败（超时/进程死亡）必须复位 running 并发唯一 agent_settled；
 *   2. abort 在途轮次写 session/cancel，agent 吞 result 时兜底到期强制收口；
 *   3. abort 空闲句柄幂等补发 aborted（失步兜底）；
 *   4. 收口幂等——迟到 result/超时不重复发终态、不弹迟到错误；
 *   5. 迟到的 agent_message_chunk 不复活 running。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-acp-agent/turn-lifecycle.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { AcpHandle } = await import("./index.ts");

/** 造一个不 spawn 进程的裸 handle（私有状态直接注入，测试专用）。 */
function makeHandle() {
  const h = new AcpHandle("codebuddy", "/bin/true", [], "codebuddy");
  const written = [];
  const events = [];
  h.aliveFlag = true;
  h.id = "codebuddy:test-session";
  h.child = { stdin: { write: (s) => { written.push(s); return true; } } };
  h.subscribe((e) => events.push(e));
  return { h, written, events };
}

const settledOf = (events) => events.filter((e) => e.type === "agent_settled");

test("prompt 失败（rpc 超时）→ running 复位 + 唯一 agent_settled(error)", async () => {
  const { h, events } = makeHandle();
  h.rpc = () => Promise.reject(new Error("[acp] session/prompt timed out after 600000ms"));

  await assert.rejects(() => h.prompt("hi"), /timed out/);
  assert.equal(h.isRunning(), false);
  assert.equal(settledOf(events).length, 1);
  assert.equal(settledOf(events)[0].stopReason, "error");
  assert.equal(h.turnInflight, false);
});

test("abort 空闲句柄：补发 aborted 复位（重复调用无害）", async () => {
  const { h, written, events } = makeHandle();

  await h.abort();
  await h.abort();
  assert.equal(h.isRunning(), false);
  assert.equal(written.length, 0);
  assert.deepEqual(events.map((e) => e.type), ["agent_settled", "agent_settled"]);
  assert.equal(events[0].stopReason, "aborted");
});

test("abort 在途轮次：写 session/cancel；agent 吞 result → 兜底到期强制收口", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { h, written, events } = makeHandle();
  h.turnSeq = 1;
  h.turnInflight = true;
  h.running = true;

  await h.abort();
  assert.equal(h.isRunning(), true); // 等 agent 应答，不立即复位
  assert.equal(written.length, 1);
  assert.match(written[0], /"method":"session\/cancel"/);
  assert.match(written[0], /"sessionId":"test-session"/);
  assert.equal(settledOf(events).length, 0); // 未到期前不发终态

  t.mock.timers.tick(6_000);
  assert.equal(h.isRunning(), false);
  assert.equal(settledOf(events).length, 1);
  assert.equal(settledOf(events)[0].stopReason, "aborted");
});

test("cancel 应答正常收口 + 迟到超时被忽略（不重复 settled、不 reject）", async () => {
  const { h, events } = makeHandle();
  let rejectPrompt;
  h.rpc = () => new Promise((_resolve, reject) => { rejectPrompt = reject; });

  const p = h.prompt("hi"); // 在途
  await h.abort();          // 用户点停止（agent 应答前 running 仍 true）
  assert.equal(h.isRunning(), true);

  // agent 应答 cancelled：走 finishTurn（内部单点）收口
  assert.equal(h.finishTurn(1, "cancelled"), true);
  assert.equal(h.finishTurn(1, "cancelled"), false); // 幂等
  assert.equal(h.isRunning(), false);

  // 迟到 10 分钟后 RPC 才超时：不得再发终态、不得 reject 给 pi-web 补弹错误
  rejectPrompt(new Error("[acp] session/prompt timed out after 600000ms"));
  await p;
  assert.equal(settledOf(events).length, 1);
  assert.equal(settledOf(events)[0].stopReason, "cancelled");
});

test("迟到的 agent_message_chunk 不复活已收口轮次（running 保持 false）", () => {
  const { h, events } = makeHandle();
  assert.equal(h.isRunning(), false);

  h.onLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "late" } } },
  }));
  assert.equal(h.isRunning(), false);
  assert.equal(events.filter((e) => e.type === "message_update").length, 1); // 内容帧照常上屏
});

test("进程死亡（markDead）：在途轮次收口 error，prompt 上抛供 prompt_error", async () => {
  const { h, events } = makeHandle();
  let rejectPrompt;
  h.rpc = () => new Promise((_resolve, reject) => { rejectPrompt = reject; });

  const p = h.prompt("hi");
  h.markDead("process exited (1)");
  assert.equal(h.isRunning(), false);
  assert.equal(settledOf(events).length, 1);
  assert.equal(settledOf(events)[0].stopReason, "error");

  // 在途 RPC 被拒：轮次已收口但不是用户停止 → 照常上抛（pi-web 补 prompt_error）
  rejectPrompt(new Error("[acp] dead: process exited (1)"));
  await assert.rejects(() => p, /dead/);
  assert.equal(settledOf(events).length, 1); // 不双发终态
});
