/**
 * aiti-qoder-agent — 运行中排队单测（backend-queue 共享层接入，对齐 claude-code 后端语义）。
 *
 * 钉死：
 *   1. running 中 prompt(streamingBehavior=followUp) → 不写 stdin、入本地队列、queue_update 带 rev；
 *   2. result 收口 → scheduleDrain 自动续轮（队列清空事件 + 该文本真正写入 stdin 成新轮）；
 *   3. queueManage 原语：list 快照 / recall 取回（面板撤回）/ clear 返回被清内容；
 *   4. 进程死亡（markDead）→ 队列丢弃，不再有续轮。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-queue.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";

const { QoderHandle } = await import("./index.ts");

function makeHandle(id = "qodercn:new-queue-test") {
  const stdout = new PassThrough();
  const stdinWrites = [];
  const child = {
    stdout,
    stderr: { on() {} },
    once() {},
    stdin: { write: (s) => { stdinWrites.push(String(s)); return true; }, writable: true, on() {} },
    kill() {},
    exitCode: null,
  };
  const h = new QoderHandle(id, child, null, "/tmp", "cn");
  const events = [];
  h.subscribe((e) => events.push(e));
  const write = (frame) => stdout.write(JSON.stringify(frame) + "\n");
  return { h, events, stdinWrites, write };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
const userWrites = (stdinWrites) => stdinWrites.map((s) => JSON.parse(s)).filter((f) => f.type === "user");
const queueUpdates = (events) => events.filter((e) => e.type === "queue_update");

test("运行中发送：入队不写 stdin，queue_update 上面板（rev 单调）", async () => {
  const { h, events, stdinWrites, write } = makeHandle();
  await h.prompt("第一条"); // 空闲 → 直发
  assert.equal(userWrites(stdinWrites).length, 1);
  write({ type: "stream_event", event: { type: "message_start" } }); // 开轮（running 保持 true）
  await h.prompt("排队的话", { streamingBehavior: "followUp" });
  assert.equal(userWrites(stdinWrites).length, 1, "运行中不得写 stdin");
  const qu = queueUpdates(events).at(-1);
  assert.deepEqual(qu?.followUp, ["排队的话"]);
  assert.equal(typeof qu?.rev, "number");
  assert.ok(queueUpdates(events).every((e, i, a) => i === 0 || e.rev > a[i - 1].rev), "rev 单调递增");
});

test("result 收口自动续轮：队列清空 + 排队的文本成为新一轮 stdin 写入", async () => {
  const { h, events, stdinWrites, write } = makeHandle();
  await h.prompt("第一条");
  await h.prompt("排队 A", { streamingBehavior: "followUp" });
  await h.prompt("排队 B", { streamingBehavior: "steer" }); // 无 steer 注入面 → 同样降级入队
  assert.deepEqual(queueUpdates(events).at(-1)?.followUp, ["排队 A", "排队 B"]);
  write({ type: "result", result: "ok", total_credits: 1 });
  await flush();
  const texts = userWrites(stdinWrites).map((f) => f.message.content.find((b) => b.type === "text")?.text);
  assert.deepEqual(texts, ["第一条", "排队 A"], "settle 后续一轮（每次一条，B 等下一轮收口）");
  assert.deepEqual(queueUpdates(events).at(-1)?.followUp, ["排队 B"]);
  assert.ok(events.some((e) => e.type === "agent_settled"));
});

test("queueManage：list / recall 撤回 / clear 返回被清内容", async () => {
  const { h, events, stdinWrites, write } = makeHandle();
  await h.prompt("第一条");
  await h.followUp("要撤回的");
  const list = await h.queueManage({ action: "list" });
  assert.deepEqual(list.followUp, ["要撤回的"]);
  const recalled = await h.queueManage({ action: "recall", kind: "followUp", index: 0 });
  assert.equal(recalled.entry?.text, "要撤回的");
  assert.deepEqual((await h.queueManage({ action: "list" })).followUp, []);
  assert.deepEqual(queueUpdates(events).at(-1)?.followUp, [], "撤回后广播空队列");
  // clear 幂等路径（无内容时不抛）
  assert.deepEqual((await h.queueManage({ action: "clear" })).followUp, []);
  write({ type: "result", result: "ok" });
  await flush();
  assert.equal(userWrites(stdinWrites).length, 1, "已撤回的条目不再续轮");
});

test("进程死亡：队列丢弃，无续轮写入", async () => {
  const { h, stdinWrites, write } = makeHandle();
  await h.prompt("第一条");
  await h.followUp("崩溃前排队");
  write({ type: "result", result: "ok" });
  await flush();
  assert.equal(userWrites(stdinWrites).length, 2, "先确认正常续轮已发生");
  // 再排队一条后判死（markDead：stdout 行溢出 → dispose 队列）
  await h.followUp("死亡排队");
  h.dispose();
  await flush();
  assert.equal(userWrites(stdinWrites).length, 2, "dispose 后不得再有续轮");
});
