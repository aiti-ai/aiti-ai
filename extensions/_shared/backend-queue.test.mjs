/**
 * backend-queue 共享层测试（docs/backend-queue-manager-plan.md §5-1）。
 * 分流 / CRUD / steer 降级 / 图片保持 / 续轮幂等 / dispose。
 */
import assert from "node:assert/strict";
import test from "node:test";

const modPath = new URL("./backend-queue.ts", import.meta.url).pathname;
const { createBackendQueueSupport } = await import(modPath);

/** 测试台架：可编程 running 状态 + 事件/分发记录。 */
function rig({ steer } = {}) {
  const events = [];
  const dispatched = [];
  let running = false;
  let alive = true;
  const steerCalls = [];
  const q = createBackendQueueSupport({
    isRunning: () => running,
    alive: () => alive,
    dispatch: (text, images) => { dispatched.push({ text, images }); },
    ...(steer ? { steer: (text, images) => { steerCalls.push({ text, images }); if (steer.reject) return Promise.reject(new Error(steer.rejectMsg || "steer down")); } } : {}),
    onEvent: (ev) => events.push(ev),
  });
  const setRunning = (v) => { running = v; };
  return { q, events, dispatched, steerCalls, setRunning, kill: () => { alive = false; } };
}

test("running + followUp behavior → 本地排队（queued）+ queue_update 广播", async () => {
  const t = rig();
  t.setRunning(true);
  const action = await t.q.routePrompt("hi", { streamingBehavior: "followUp" });
  assert.equal(action, "queued");
  assert.deepEqual(t.q.snapshot().followUp, ["hi"]);
  const last = t.events.at(-1);
  assert.equal(last.type, "queue_update");
  assert.deepEqual(last.followUp, ["hi"]);
  assert.deepEqual(t.dispatched, []);
});

test("running + steer 可用 → steered；镜像经 registerSteer 喂入后出现在 steering 组", async () => {
  const t = rig({ steer: {} });
  t.setRunning(true);
  const action = await t.q.routePrompt("inject");
  assert.equal(action, "steered");
  assert.deepEqual(t.q.snapshot().steering, []);
  t.q.registerSteer("pid-1", "inject");
  assert.deepEqual(t.q.snapshot().steering, ["inject"]);
  t.q.drainSteer(["pid-1"]);
  assert.deepEqual(t.q.snapshot().steering, []);
});

test("running + 无 steer 能力 → 自动降级本地排队（plan §1.3 降级语义）", async () => {
  const t = rig();
  t.setRunning(true);
  const action = await t.q.routePrompt("no-steer-backend");
  assert.equal(action, "queued");
  assert.deepEqual(t.q.snapshot().followUp, ["no-steer-backend"]);
});

test("running + steer reject → 降级入本地队列（R9 泛化：消息不丢）", async () => {
  const t = rig({ steer: { reject: true } });
  t.setRunning(true);
  const action = await t.q.routePrompt("will-fail");
  assert.equal(action, "queued");
  assert.deepEqual(t.q.snapshot().followUp, ["will-fail"]);
  assert.deepEqual(t.q.snapshot().steering, []);
});

test("空闲 routePrompt → dispatch（带图片）并返回 dispatched", async () => {
  const t = rig();
  const imgs = [{ data: "AAA", mimeType: "image/png" }];
  const action = await t.q.routePrompt("go", { images: imgs });
  assert.equal(action, "dispatched");
  assert.deepEqual(t.dispatched, [{ text: "go", images: imgs }]);
});

test("queueManage CRUD：move/remove/recall/requeue/clear + 索引越界", async () => {
  const t = rig();
  t.setRunning(true);
  await t.q.routePrompt("a", { streamingBehavior: "followUp" });
  await t.q.routePrompt("b", { streamingBehavior: "followUp" });
  await t.q.routePrompt("c", { streamingBehavior: "followUp" });
  // move
  await t.q.queueManage({ action: "move", from: 0, to: 2 });
  assert.deepEqual(t.q.snapshot().followUp, ["b", "c", "a"]);
  // remove → entry + removed（QueueTrashItem 形状）
  const rm = await t.q.queueManage({ action: "remove", index: 1 });
  assert.equal(rm.entry.text, "c");
  assert.equal(rm.removed.kind, "followUp");
  assert.equal(rm.removed.hasImages, false);
  assert.deepEqual(rm.followUp, ["b", "a"]);
  // requeue（取回还原）
  await t.q.queueManage({ action: "requeue", index: 1, text: "c" });
  assert.deepEqual(t.q.snapshot().followUp, ["b", "c", "a"]);
  // steer 组操作 → 人话错误（协议无撤回入口）
  await assert.rejects(() => t.q.queueManage({ action: "remove", kind: "steer", index: 0 }), /不支持撤回/);
  // 越界
  await assert.rejects(() => t.q.queueManage({ action: "remove", index: 99 }), /越界/);
  // clear：返回值须带回「清空前」的文本（pi clearQueue 契约——前端「全部编辑」回填输入框）
  const cl = await t.q.queueManage({ action: "clear" });
  assert.deepEqual(t.q.snapshot().followUp, []);
  assert.deepEqual(cl.followUp, ["b", "c", "a"]);
});

test("R4 闭环：followUp 带图排队 → 续轮 dispatch 回挂图片；remove 返回 hasImages", async () => {
  const t = rig();
  t.setRunning(true);
  const imgs = [{ data: "BBB", mimeType: "image/jpeg", filename: "x.jpg" }];
  await t.q.routePrompt("看图", { images: imgs, streamingBehavior: "followUp" });
  const rm = await t.q.queueManage({ action: "remove", index: 0 });
  assert.equal(rm.removed.hasImages, true);
  assert.deepEqual(rm.entry.images, imgs);
  // 重新入队 → settle 后续轮 dispatch 带 images
  t.q.enqueueFollowUp("看图", imgs);
  assert.deepEqual(t.events.at(-1).followUp, ["看图"]); // wire 只传文本
  t.setRunning(false);
  t.q.scheduleDrain();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.dispatched, [{ text: "看图", images: imgs }]);
});

test("scheduleDrain 幂等：running 中 no-op；微任务续轮；队列空只广播", async () => {
  const t = rig();
  t.setRunning(true);
  t.q.enqueueFollowUp("n1");
  t.setRunning(true);
  t.q.scheduleDrain(); // running 中 → no-op
  assert.deepEqual(t.dispatched, []);
  t.setRunning(false);
  t.q.scheduleDrain();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.dispatched, [{ text: "n1", images: undefined }]);
  t.q.scheduleDrain(); // 队列空 → 只广播，不 dispatch
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.dispatched.length, 1);
  const last = t.events.at(-1);
  assert.equal(last.type, "queue_update");
  assert.deepEqual(last.followUp, []);
});

test("convert followUp → steer：running 时注入（reject 回落队列）；空闲时 dispatch", async () => {
  const t1 = rig({ steer: {} });
  t1.setRunning(true);
  await t1.q.routePrompt("x", { streamingBehavior: "followUp" });
  await t1.q.queueManage({ action: "convert", index: 0, targetKind: "steer" });
  assert.equal(t1.steerCalls.length, 1);
  assert.deepEqual(t1.q.snapshot().followUp, []);

  const t2 = rig({ steer: { reject: true } });
  t2.setRunning(true);
  await t2.q.routePrompt("y", { streamingBehavior: "followUp" });
  await t2.q.queueManage({ action: "convert", index: 0, targetKind: "steer" });
  assert.deepEqual(t2.q.snapshot().followUp, ["y"], "steer 失败降级回队列");

  const t3 = rig({ steer: {} });
  t3.setRunning(true);
  await t3.q.routePrompt("z", { streamingBehavior: "followUp" });
  t3.setRunning(false);
  await t3.q.queueManage({ action: "convert", index: 0, targetKind: "steer" });
  assert.deepEqual(t3.dispatched, [{ text: "z", images: undefined }], "空闲 convert = 开新轮");

  // 无原生 steer（codex / zcode 3.11.2 降级形态）：插队 = 移到队首（settle 后优先续轮），不立即 dispatch
  const t4 = rig();
  t4.setRunning(true);
  await t4.q.routePrompt("a", { streamingBehavior: "followUp" });
  await t4.q.routePrompt("b", { streamingBehavior: "followUp" });
  await t4.q.queueManage({ action: "convert", index: 1, targetKind: "steer" });
  assert.deepEqual(t4.q.snapshot().followUp, ["b", "a"], "无 steer：插队 = 移到队首");
  assert.deepEqual(t4.dispatched, [], "运行中 convert 不立即 dispatch");
});

test("dispose：清队列 + 未决续轮不再 dispatch", async () => {
  const t = rig();
  t.setRunning(true);
  t.q.enqueueFollowUp("late");
  t.setRunning(false);
  t.kill();
  t.q.scheduleDrain(); // alive=false → 不启动
  t.q.dispose();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.q.snapshot(), { steering: [], followUp: [] });
  assert.deepEqual(t.dispatched, []);
});

test("userBubble：message_end role=user blocks content（adapter string 防御兼容）", () => {
  const t = rig();
  t.q.userBubble("queued text");
  const ev = t.events.at(-1);
  assert.equal(ev.type, "message_end");
  assert.equal(ev.message.role, "user");
  assert.deepEqual(ev.message.content, [{ type: "text", text: "queued text" }]);
});

test("rev 单调版本号：queue_update 与 queueManage 结果同数轴递增；快照读取不递增", async () => {
  const t = rig({ steer: {} });
  t.setRunning(true);
  // 三次内容变化：enqueue → registerSteer → drainSteer；中间插一次幂等 register（不广播）
  await t.q.routePrompt("r1", { streamingBehavior: "followUp" });
  t.q.registerSteer("pid-1", "r2");
  const countAfterRegister = t.events.filter((e) => e.type === "queue_update").length;
  t.q.registerSteer("pid-1", "r2");
  assert.equal(
    t.events.filter((e) => e.type === "queue_update").length,
    countAfterRegister,
    "同 id 重复 registerSteer 幂等：不广播不递增",
  );
  t.q.drainSteer(["pid-1"]);
  const evs = t.events.filter((e) => e.type === "queue_update");
  assert.equal(evs.length, 3, "恰好三帧广播");
  const revs = evs.map((e) => e.rev);
  assert.ok(revs.every((r) => typeof r === "number" && r > 0), "全部携带正数 rev");
  assert.ok(revs.every((r, i) => i === 0 || r > revs[i - 1]), "rev 严格单调递增");
  // list 快照携带当前 rev；连续读取不动（快照非变更）
  const l1 = await t.q.queueManage({ action: "list" });
  assert.equal(l1.rev, revs.at(-1), "list 与最近事件同版本");
  const l2 = await t.q.queueManage({ action: "list" });
  assert.equal(l2.rev, l1.rev, "快照读取不递增");
  // 变更类 action：结果 rev = 变更后版本（与随行 queue_update 同值）
  const mv = await t.q.queueManage({ action: "move", from: 0, to: 0 });
  assert.ok(mv.rev > l1.rev, "变更递增");
  const evAfter = t.events.filter((e) => e.type === "queue_update").at(-1);
  assert.equal(evAfter.rev, mv.rev, "RPC 结果与随行事件同 rev");
});

// ---- sidecar 持久化（docs/aiti-remote-queue-and-sidecar-plan.md §3）----
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { createQueueFilePersistence } = await import(modPath);

function persistedRig(file) {
  const persistence = createQueueFilePersistence(() => file, (m) => logs.push(m));
  const logs = [];
  const t = rig();
  // 把 persistence 注入 rig 的 q 不便（rig 内建 support）——直接重建一个带 persistence 的台架
  const events = [];
  const dispatched = [];
  let running = false;
  const q2 = createBackendQueueSupport({
    isRunning: () => running,
    dispatch: (text) => { dispatched.push(text); },
    onEvent: (ev) => events.push(ev),
    persistence,
    log: (m) => logs.push(m),
  });
  return { q: q2, events, dispatched, setRunning: (v) => { running = v; }, logs, persistence };
}

test("sidecar：入队落盘 → 新 support 懒恢复（list 触发）→ clear/remove 收口", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bq-sidecar-"));
  const file = join(dir, "sess-a.json");

  // 第一段：入队两条 → 文件落盘
  const t1 = persistedRig(file);
  t1.setRunning(true);
  await t1.q.routePrompt("m1", { streamingBehavior: "followUp" });
  await t1.q.routePrompt("m2", { streamingBehavior: "followUp" });
  assert.ok(existsSync(file), "入队后 sidecar 应存在");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.entries.map((e) => e.text), ["m1", "m2"]);

  // 第二段：模拟重启——新 support 同文件 → list 触发懒恢复
  const t2 = persistedRig(file);
  assert.deepEqual((await t2.q.queueManage({ action: "list" })).followUp, ["m1", "m2"], "list 应触发恢复");
  // 恢复后 clear 返回清空前文本 + sidecar 清空落盘
  const cleared = await t2.q.queueManage({ action: "clear" });
  assert.deepEqual(cleared.followUp, ["m1", "m2"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).entries, []);

  // dispose → sidecar 文件删除（会话正常关闭）
  t2.q.dispose();
  assert.ok(!existsSync(file), "dispose 应删除 sidecar");
});

test("sidecar：恢复条目 settle 后自动续轮发出；无文件 = 不恢复不报错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bq-sidecar-"));
  const file = join(dir, "sess-b.json");
  writeFileSync(file, JSON.stringify({ version: 1, entries: [{ text: "old", queuedAt: 1 }] }));

  const t = persistedRig(file);
  t.setRunning(false);
  t.q.scheduleDrain(); // 触发懒恢复 + 立即续轮
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(t.dispatched, ["old"], "恢复条目应被续轮发出");
  assert.deepEqual((await t.q.queueManage({ action: "list" })).followUp, []);

  const t3 = persistedRig(join(dir, "not-exist.json"));
  assert.deepEqual((await t3.q.queueManage({ action: "list" })).followUp, []);
});

test("sidecar：>7 天残留文件在 save 时顺手清理", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bq-sidecar-"));
  const stale = join(dir, "stale-sess.json");
  writeFileSync(stale, JSON.stringify({ version: 1, entries: [] }));
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  const file = join(dir, "fresh.json");
  const t = persistedRig(file);
  t.setRunning(true);
  await t.q.routePrompt("x", { streamingBehavior: "followUp" });
  assert.ok(!existsSync(stale), "过期 sidecar 应被清理");
  assert.ok(existsSync(file));
});

// ---- id 换绑迁移（占位 id → 真实 id；审计 §4.3 claude-code 孤儿问题修复）----
const { migrateQueueSidecar, sidecarFileName } = await import(modPath);

test("migrateQueueSidecar：换绑迁移后内容原样可恢复；目标已存在覆盖；源缺失/同 id/无 dir no-op", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bq-migrate-"));
  const from = join(dir, "queues", sidecarFileName("claude:new-1"));
  mkdirSync(join(dir, "queues"), { recursive: true });
  writeFileSync(from, JSON.stringify({ version: 1, entries: [{ text: "early", queuedAt: 1 }] }));

  const logs = [];
  migrateQueueSidecar(dir, "claude:new-1", "claude:sess_real", (m) => logs.push(m));
  const to = join(dir, "queues", sidecarFileName("claude:sess_real"));
  assert.ok(!existsSync(from), "旧 id 文件应消失");
  assert.ok(existsSync(to), "新 id 文件应就位");
  // 迁移产物可被持久化层原样恢复（version/entries 不动）
  const restored = createQueueFilePersistence(() => to).load();
  assert.deepEqual(restored.map((e) => e.text), ["early"]);
  assert.ok(logs.some((m) => m.includes("claude:new-1")), "迁移应有日志");

  // 目标已存在：覆盖（Windows rename 不覆盖已有目标 → 预删路径）
  writeFileSync(from, JSON.stringify({ version: 1, entries: [{ text: "fresh", queuedAt: 2 }] }));
  migrateQueueSidecar(dir, "claude:new-1", "claude:sess_real");
  assert.deepEqual(JSON.parse(readFileSync(to, "utf8")).entries[0].text, "fresh", "目标已存在应被覆盖");

  // no-op 面：源缺失 / from==to / dir 未捕获
  migrateQueueSidecar(dir, "ghost", "x");
  migrateQueueSidecar(dir, "a", "a");
  migrateQueueSidecar(undefined, "a", "b");
  assert.ok(!existsSync(join(dir, "queues", "x.json")));
});
