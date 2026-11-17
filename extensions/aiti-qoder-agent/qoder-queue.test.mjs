/**
 * aiti-qoder-agent — backend-queue 队列语义单测（ACP 驱动）。
 *
 * 钉死行为（2026-11-13 ACP 重写；共享层语义不变，接线面换 ACP）：
 *   1. 运行中发送：入队（session/prompt 不并发写），queue_update 上面板（rev 单调）；
 *   2. turn 收口自动续轮：队列清空 + 排队文本成为新一轮 session/prompt；
 *   3. queueManage：list / recall 撤回 / clear 返回被清内容；
 *   4. 进程死亡：队列丢弃，无续轮写入。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-queue.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 状态写盘隔离（session/new 换绑会 rename 模型状态文件）。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-queue-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const { QoderHandle } = await import("./index.ts");
const { makeReadyHandle, flush } = await import("./qoder-acp-stub.mjs");

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });

const prompts = (stub) => stub.sent.filter((f) => f.method === "session/prompt");
const promptTexts = (stub) => prompts(stub).map((f) => f.params.prompt.find((b) => b.type === "text")?.text);
const queueUpdates = (events) => events.filter((e) => e.type === "queue_update");

test("运行中发送：入队不并发 prompt，queue_update 上面板（rev 单调）", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle, { stubOpts: { autoAnswerPrompt: false } });
  h.prompt("第一条").catch(() => {}); // 挂起 → running=true
  await flush();
  await h.prompt("排队的话", { streamingBehavior: "followUp" });
  assert.equal(prompts(stub).length, 1, "运行中不得并发 session/prompt");
  const qu = queueUpdates(events).at(-1);
  assert.deepEqual(qu?.followUp, ["排队的话"]);
  assert.equal(typeof qu?.rev, "number");
  assert.ok(queueUpdates(events).every((e, i, a) => i === 0 || e.rev > a[i - 1].rev), "rev 单调递增");
  await h.dispose();
});

test("turn 收口自动续轮：队列清空 + 排队的文本成为新一轮 session/prompt", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle, { stubOpts: { autoAnswerPrompt: false } });
  h.prompt("第一条").catch(() => {});
  await flush();
  await h.prompt("排队 A", { streamingBehavior: "followUp" });
  await h.prompt("排队 B", { streamingBehavior: "steer" }); // ACP 无 steer 注入面 → 同样降级入队
  assert.deepEqual(queueUpdates(events).at(-1)?.followUp, ["排队 A", "排队 B"]);
  stub.answerPrompt({ stopReason: "end_turn" }); // 第一轮收口 → 续轮
  await flush();
  const texts = promptTexts(stub);
  assert.deepEqual(texts, ["第一条", "排队 A"], "settle 后续一轮（每次一条，B 等下一轮收口）");
  assert.deepEqual(queueUpdates(events).at(-1)?.followUp, ["排队 B"]);
  assert.ok(events.some((e) => e.type === "agent_settled"));
  stub.answerPrompt({ stopReason: "end_turn" }); // 第二轮收口 → 续 B
  await flush();
  assert.deepEqual(promptTexts(stub), ["第一条", "排队 A", "排队 B"]);
  await h.dispose();
});

test("queueManage：list / recall 撤回 / clear 返回被清内容", async () => {
  const { h, events, stub } = await makeReadyHandle(QoderHandle, { stubOpts: { autoAnswerPrompt: false } });
  h.prompt("第一条").catch(() => {});
  await flush();
  await h.followUp("要撤回的");
  const list = await h.queueManage({ action: "list" });
  assert.deepEqual(list.followUp, ["要撤回的"]);
  const recalled = await h.queueManage({ action: "recall", kind: "followUp", index: 0 });
  assert.equal(recalled.entry?.text, "要撤回的");
  assert.deepEqual((await h.queueManage({ action: "list" })).followUp, []);
  assert.deepEqual(queueUpdates(events).at(-1)?.followUp, [], "撤回后广播空队列");
  // clear 幂等路径（无内容时不抛）
  assert.deepEqual((await h.queueManage({ action: "clear" })).followUp, []);
  stub.answerPrompt({ stopReason: "end_turn" });
  await flush();
  assert.equal(prompts(stub).length, 1, "已撤回的条目不再续轮");
  await h.dispose();
});

test("进程死亡：队列丢弃，无续轮写入", async () => {
  const { h, stub } = await makeReadyHandle(QoderHandle, { stubOpts: { autoAnswerPrompt: false } });
  h.prompt("第一条").catch(() => {});
  await flush();
  await h.followUp("崩溃前排队");
  stub.answerPrompt({ stopReason: "end_turn" });
  await flush();
  assert.equal(prompts(stub).length, 2, "先确认正常续轮已发生");
  // 再排队一条后判死（markDead：dispose 队列）
  await h.followUp("死亡排队");
  h.dispose();
  await flush();
  assert.equal(prompts(stub).length, 2, "dispose 后不得再有续轮");
});
