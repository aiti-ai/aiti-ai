/**
 * aiti-attach-agent — 帧协议单测（D6）：NDJSON 帧分发 / 请求-应答关联 / 桥转发回包。
 *
 * attach 协议（socket NDJSON）：{id,type:"response",success,data|error} 关联 pending；
 * 无 id 的 type 帧透传为事件（agent_settled/agent_end 复位 running；model_select 更新模型）；
 * {type:"aiti_bridge_req"} 反向转发到进程内桥（无桥时回 error 帧）。
 * 直驱私有 onLine + 假 socket（不入网），不测 connect()/注册表（fs/网络面）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-attach-agent/attach-frame.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { AttachSessionHandle } = await import("./index.ts");

/** 假 socket + 事件捕获（不 connect；aliveFlag 手动置位模拟已连）。 */
function makeHandle() {
  const h = new AttachSessionHandle("attach-test", "/tmp/nonexistent.sock", "/tmp");
  const socketWrites = [];
  h.socket = { write: (s) => { socketWrites.push(s); return true; }, destroyed: false };
  h.aliveFlag = true;
  const events = [];
  h.subscribe((e) => events.push(e));
  const onLine = (obj) => h.onLine(typeof obj === "string" ? obj : JSON.stringify(obj));
  return { h, events, socketWrites, onLine };
}

test("请求-应答关联：request → response 帧按 id resolve", async () => {
  const { h, socketWrites, onLine } = makeHandle();
  const p = h.request({ type: "get_state" });
  assert.ok(socketWrites.length === 1, "request 应写一帧");
  const sent = JSON.parse(socketWrites[0]);
  assert.equal(sent.type, "get_state");
  assert.ok(sent.id, "帧带请求 id");
  onLine({ id: sent.id, type: "response", success: true, data: { model: { id: "m1", provider: "pi" } } });
  const state = await p;
  assert.deepEqual(state, { model: { id: "m1", provider: "pi" } });
});

test("请求-应答关联：success:false → reject（错误透传）", async () => {
  const { h, socketWrites, onLine } = makeHandle();
  const p = h.request({ type: "compact" }).catch((e) => e);
  const sent = JSON.parse(socketWrites[0]);
  onLine({ id: sent.id, type: "response", success: false, error: "not supported" });
  const err = await p;
  assert.match(String(err.message), /not supported/);
});

test("事件帧透传：agent_settled 复位 running；model_select 更新模型", () => {
  const { h, events, onLine } = makeHandle();
  h.running = true;
  onLine({ type: "agent_settled", stopReason: "end_turn" });
  assert.equal(h.isRunning(), false);
  onLine({ type: "model_select", model: { id: "glm-5.3", provider: "pi" } });
  assert.deepEqual(h.getModel(), { id: "glm-5.3", provider: "pi" });
  assert.ok(events.some((e) => e.type === "agent_settled"));
  assert.ok(events.some((e) => e.type === "model_select"));
});

test("连接播种：get_state.isStreaming=true → running 置位（运行中打开会话不误判空闲）", async () => {
  // 根因（2026-09-14 实测）：fork 子代理/外部 worker 长工具执行中，pi-web 新建 attach
  // handle 只播种 model，running 靠后续 agent_start/end 事件维护——连接后到下个
  // agent_start 之前恒 false，同一会话【左侧桥 watcher 亮、右侧消息窗显示空闲】。
  const { h, socketWrites, onLine } = makeHandle();
  const p = h.refreshModelSnapshot();
  assert.ok(socketWrites.length === 1, "connect 播种应发 get_state");
  const sent = JSON.parse(socketWrites[0]);
  assert.equal(sent.type, "get_state");
  onLine({ id: sent.id, type: "response", success: true, data: { model: { id: "m2", provider: "pi" }, isStreaming: true } });
  await p;
  assert.equal(h.isRunning(), true);
  assert.deepEqual(h.getModel(), { id: "m2", provider: "pi" });
});

test("连接播种：get_state.isStreaming=false → 不置 running（空闲不误亮）", async () => {
  const { h, socketWrites, onLine } = makeHandle();
  const p = h.refreshModelSnapshot();
  const sent = JSON.parse(socketWrites[0]);
  onLine({ id: sent.id, type: "response", success: true, data: { isStreaming: false } });
  await p;
  assert.equal(h.isRunning(), false);
});

test("迟到/已取消响应 → 静默丢弃（不误派发为事件）", () => {
  const { h, events, onLine } = makeHandle();
  onLine({ id: "ghost-1", type: "response", success: true, data: {} });
  assert.deepEqual(events, [], "无 pending 的 response 帧不得进事件流");
});

test("aiti_bridge_req 反向转发：无进程内桥 → 结构化失败回包（success:true + data.ok:false）", async () => {
  const { h, socketWrites, onLine } = makeHandle();
  onLine({ id: "br-1", type: "aiti_bridge_req", tool: "aiti_inbox", args: {} });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(socketWrites.length >= 1, "应回包");
  const reply = JSON.parse(socketWrites.at(-1));
  assert.equal(reply.id, "br-1");
  assert.equal(reply.type, "response");
  assert.equal(reply.success, true, "传输层恒 success（错误结构化进 data）");
  assert.equal(reply.data?.ok, false);
  assert.match(String(reply.data?.error), /no in-process aiti bridge/);
});

test("queueManage(list)：get_state 排队文本透传（followUp 回显修复，2026-10-10）", async () => {
  const { h, socketWrites, onLine } = makeHandle();
  const p = h.queueManage({ action: "list" });
  const sent = JSON.parse(socketWrites.at(-1));
  assert.equal(sent.type, "get_state", "list 走 get_state（桥镜像数据源）");
  onLine({
    id: sent.id, type: "response", success: true,
    data: { steering: ["先做 A"], followUp: ["排队回显验证", "第二条"] },
  });
  assert.deepEqual(await p, { steering: ["先做 A"], followUp: ["排队回显验证", "第二条"] });
});

test("queueManage(list)：缺字段/畸形载荷 → 空数组兜底（不炸 adapter get_state）", async () => {
  const { h, socketWrites, onLine } = makeHandle();
  const p = h.queueManage({ action: "list" });
  const sent = JSON.parse(socketWrites.at(-1));
  onLine({ id: sent.id, type: "response", success: true, data: { steering: "not-an-array", pendingMessageCount: 1 } });
  assert.deepEqual(await p, { steering: [], followUp: [] });
});

test("queueManage 变更动作 → fail-loud（桥协议无队列写口，不得静默 no-op）", async () => {
  const { h } = makeHandle();
  await assert.rejects(() => h.queueManage({ action: "clear" }), /queue list only/);
  await assert.rejects(() => h.queueManage({ action: "recall", kind: "followUp", index: 0 }), /queue list only/);
});

test("queueManage(list)：请求失败（TUI 卡死/桥抖动）→ 空数组兜底（不连坐 get_state）", async () => {
  const { h, socketWrites } = makeHandle();
  const p = h.queueManage({ action: "list" });
  const sent = JSON.parse(socketWrites.at(-1));
  // 模拟桥 15s 超时回绝（attach 请求失败 = reject）
  onLineReject(h, sent.id);
  assert.deepEqual(await p, { steering: [], followUp: [] });
});

/** 让 handle 对指定 id 的 pending 请求回绝（走 markDead 同款 reject 路径）。 */
function onLineReject(h, reqId) {
  // 直接往 pending 表灌 reject：等价于「bridge did not respond」超时路径
  const pending = h.pending?.get?.(reqId);
  if (pending) { h.pending.delete(reqId); pending.reject(new Error("[attach] bridge did not respond")); return; }
  // 退路：销毁 socket 触发 markDead 批量回绝
  h.markDead("test-timeout");
}
