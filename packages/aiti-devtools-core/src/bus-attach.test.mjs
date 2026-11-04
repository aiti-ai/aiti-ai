/**
 * 桥 SSE 总线适配单测（统一 SSE 端口方案 v2 · 桥下行流收编）
 *
 * 契约：createBridge(opts.busPublish) 接线 event-bus publish 出口后——
 *   - POST /bridge/attach-bus：连接注册为「总线型 writer」（无 SSE socket），
 *     ready 帧经 busPublish 投到专属 topic bridge-<instanceId>，帧形状
 *     { type: "bridge-<instanceId>", msg: <桥原消息> }（帧 type = 订阅 topic，与
 *     客户端白名单一致；publish(type,data) 的 data 展开会覆盖同名键，桥消息只能放 msg）；
 *   - 既有推送点（exec/interaction/event…）全部 w.write() → 自动入总线（零改动收编）；
 *   - POST /bridge/bus-heartbeat 刷新 lastSeen（无断连信号的活性保鲜）；
 *   - busPublish 未接线 → attach-bus 501（客户端 fallback 自带 SSE 的信号）；
 *   - sessions 能看到总线型连接（bridge_status 可见性不降级）。
 * Run: node --experimental-strip-types --test bus-attach.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "./bridge.ts";

function tmpDir(tag) {
  return "/tmp/bridge-bus-test-" + tag + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
}

const ATTACH = (body) => new Request("http://x/bridge/attach-bus", { method: "POST", body: JSON.stringify(body) });

test("attach-bus：注册总线型连接，ready 帧入专属 topic（帧形状锁定）", async () => {
  const frames = [];
  const b = createBridge(tmpDir("a"), { name: "t", busPublish: (t, d) => frames.push({ t, f: { type: t, ...d } }) });
  const res = await b.handle(ATTACH({ instanceId: "dev", role: "page", frameId: "host", url: "http://x/", title: "T" }), ["bridge", "attach-bus"], new URLSearchParams());
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.deepEqual(d, { ok: true, topic: "bridge-dev", via: "bus" });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].t, "bridge-dev", "publish 第一参 = topic");
  assert.equal(frames[0].f.type, "bridge-dev", "帧 type = topic（与客户端订阅白名单一致）");
  assert.equal(frames[0].f.msg.type, "ready", "msg = 桥原消息");
  assert.equal(frames[0].f.msg.via, "bus");
});

test("exec 下行经总线：既有推送点零改动收编（w.write → busPublish）", async () => {
  const frames = [];
  const b = createBridge(tmpDir("b"), { name: "t", busPublish: (t, f) => frames.push({ t, type: f && f.msg && f.msg.type }) });
  await b.handle(ATTACH({ instanceId: "dev", role: "page", frameId: "host" }), ["bridge", "attach-bus"], new URLSearchParams());
  await b.callTool("page_exec", { cmd: "Runtime.evaluate", args: { expression: "1" }, pageId: "dev/host" }, async () => ({ ok: true, result: {} }));
  await new Promise((r) => setTimeout(r, 80));
  const types = frames.filter((f) => f.t === "bridge-dev").map((f) => f.type);
  assert.ok(types.includes("ready"), "ready 已入总线");
  assert.ok(types.includes("exec"), "exec 下行已入总线（writer.write 收编生效）");
});

test("bus-heartbeat：刷新活性；unknown conn 404（客户端重新 attach 信号）", async () => {
  const b = createBridge(tmpDir("c"), { name: "t", busPublish: () => {} });
  await b.handle(ATTACH({ instanceId: "dev", role: "page" }), ["bridge", "attach-bus"], new URLSearchParams());
  const ok = await b.handle(new Request("http://x/bridge/bus-heartbeat", { method: "POST", body: JSON.stringify({ instanceId: "dev", role: "page" }) }), ["bridge", "bus-heartbeat"], new URLSearchParams());
  assert.equal(ok.status, 200);
  const miss = await b.handle(new Request("http://x/bridge/bus-heartbeat", { method: "POST", body: JSON.stringify({ instanceId: "ghost", role: "page" }) }), ["bridge", "bus-heartbeat"], new URLSearchParams());
  assert.equal(miss.status, 404, "未注册连接 → 404（客户端据此重新 attach）");
});

test("busPublish 未接线：attach-bus 501（客户端 fallback 自带 SSE 的信号）", async () => {
  const b = createBridge(tmpDir("d"), { name: "t" });
  const res = await b.handle(ATTACH({ instanceId: "dev", role: "page" }), ["bridge", "attach-bus"], new URLSearchParams());
  assert.equal(res.status, 501);
  const d = await res.json();
  assert.equal(d.error, "bus not wired");
});

test("sessions 可见总线型连接（bridge_status 可见性不降级）；同 instanceId 重复 attach 摘旧", async () => {
  const b = createBridge(tmpDir("e"), { name: "t", busPublish: () => {} });
  await b.handle(ATTACH({ instanceId: "dev", role: "page", url: "http://a/", title: "A" }), ["bridge", "attach-bus"], new URLSearchParams());
  await b.handle(ATTACH({ instanceId: "dev", role: "page", url: "http://b/", title: "B" }), ["bridge", "attach-bus"], new URLSearchParams());
  const sess = await b.handle(new Request("http://x/bridge/sessions"), ["bridge", "sessions"], new URLSearchParams());
  const list = await sess.json();
  const dev = list.filter((s) => s.instanceId === "dev");
  assert.equal(dev.length, 1, "同 instanceId 只保留最新连接");
  assert.equal(dev[0].url, "http://b/", "新连接覆盖旧连接");
});
