/**
 * aiti-event-bus · client busId 实例比对单测（2026-11-04「session-manager 运行状态不更新」修复）
 *
 * 背景：服务端扩展 reload 后，旧 SSE 连接的帧 sink 随旧总线实例丢弃（帧全停），但每连接
 * 心跳 setInterval 闭包仍存活（心跳照发）→ 消费方（session-manager/SessionSidebar）健康
 * 时钟恒判健康 → 兜底轮询永不触发 → 列表运行状态冻结，只能手动刷新。修复两层：
 *   - 服务端：新实例 startup 统一关闭 globalThis 登记的旧实例残留流（断流 → 客户端
 *     EventSource 自动重连自愈）；hello/heartbeat 帧携带 BUS_ID；
 *   - 客户端：noteBusId 比对——id 变化即主动重建连接（rebuildConnection），不等下一次
 *     订阅变化经 STALE 发现。
 *
 * 本文件钉死客户端比对契约：记录 / 触发重建 / 旧服务端兼容 / 迟到事件不重复重建。
 * Run: node --test bus-id.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

// ---- 浏览器环境桩（import 模块之前就位；与 stale-rebuild.test.mjs 同款）----

class FakeEventSource {
  static created = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.listeners = {};
    FakeEventSource.created.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  close() { this.readyState = 2; this.closedByTest = true; }
  /** 测试驱动：模拟服务端 hello 帧（可带 busId） */
  emitHello(conn, busId) {
    this.readyState = 1;
    const payload = { conn };
    if (busId !== undefined) payload.busId = busId;
    for (const fn of this.listeners.hello ?? []) fn({ data: JSON.stringify(payload) });
  }
  /** 测试驱动：模拟服务端 heartbeat 帧（可带 busId） */
  emitHeartbeat(busId) {
    const payload = busId !== undefined ? { busId } : {};
    for (const fn of this.listeners.heartbeat ?? []) fn({ data: JSON.stringify(payload) });
  }
}

let subscribeQueue = [];

function jsonRes(status, body) {
  return { ok: status < 400, status, json: async () => body };
}

globalThis.window = { addEventListener() {}, dispatchEvent() {} };
globalThis.EventSource = FakeEventSource;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("/subscribe")) {
    const respond = subscribeQueue.shift();
    if (!respond) return jsonRes(500, { ok: false, error: "no scripted response" });
    return respond(opts ? JSON.parse(opts.body) : null);
  }
  if (String(url).includes("/heartbeat")) return jsonRes(200, { ok: true });
  return jsonRes(404, { ok: false, error: "unexpected fetch " + url });
};

const drain = () => new Promise((r) => setTimeout(r, 0));

async function freshClient() {
  const mod = await import(`./dist/aiti-event-bus-client.mjs?case=${Date.now()}-${Math.random()}`);
  mod.default({ apiUrl: (p) => p });
  return mod;
}

/** 建立一条完成订阅的连接（hello busId=A，POST 200），返回模块与首连接 */
async function connectedClient(busIdA = "bus_A") {
  FakeEventSource.created = [];
  subscribeQueue = [() => jsonRes(200, { ok: true, count: 1 })];
  const mod = await freshClient();
  mod.subscribeTopics(() => {}, ["t1"]);
  FakeEventSource.created[0].emitHello("conn-1", busIdA);
  await drain();
  assert.equal(FakeEventSource.created.length, 1, "前置：单连接已建立");
  return mod;
}

const currentEs = () => FakeEventSource.created[FakeEventSource.created.length - 1];

test("hello 首帧带 busId：只记录，不触发重建", async () => {
  await connectedClient("bus_A");
  assert.equal(FakeEventSource.created.length, 1, "首帧不重建");
  assert.ok(!currentEs().closedByTest, "连接保持");
});

test("heartbeat busId 变化（服务端 reload）：主动重建连接，新连接同 id 不再触发", async () => {
  await connectedClient("bus_A");
  // 服务端 reload → 旧实例心跳闭包仍发旧流（这里直接模拟：同一连接上报新 id，
  // 真实路径是新实例 startup 关流 → 自动重连 → 新 hello 带新 id，重建语义一致）
  currentEs().emitHeartbeat("bus_B");
  await drain();
  assert.equal(FakeEventSource.created.length, 2, "busId 变化 → 重建（新 EventSource）");
  assert.ok(FakeEventSource.created[0].closedByTest, "旧连接已关闭");
  // 新连接 hello（busId=bus_B）→ 已对齐 → 不再重建
  subscribeQueue.push(() => jsonRes(200, { ok: true, count: 1 }));
  currentEs().emitHello("conn-2", "bus_B");
  await drain();
  assert.equal(FakeEventSource.created.length, 2, "同 id 稳态不再重建");
  // 稳态心跳也不再触发
  currentEs().emitHeartbeat("bus_B");
  await drain();
  assert.equal(FakeEventSource.created.length, 2, "稳态心跳零重建");
});

test("旧服务端兼容：heartbeat 无 busId → 忽略，行为同旧版", async () => {
  await connectedClient("bus_A");
  currentEs().emitHeartbeat(undefined);
  currentEs().emitHeartbeat(null);
  currentEs().emitHeartbeat(123);
  await drain();
  assert.equal(FakeEventSource.created.length, 1, "无有效 busId 的帧不触发重建");
  assert.ok(!currentEs().closedByTest, "连接保持");
});

test("迟到事件（来自已被换下的旧连接）：只对齐记录，不重复重建", async () => {
  await connectedClient("bus_A");
  const oldEs = currentEs();
  // 正常路径先重建一次：busId → bus_B
  oldEs.emitHeartbeat("bus_B");
  await drain();
  assert.equal(FakeEventSource.created.length, 2);
  // 旧连接的迟到事件再报一个不同 id（现实中不会发生，防御性）：不驱动重建
  oldEs.emitHeartbeat("bus_C");
  await drain();
  assert.equal(FakeEventSource.created.length, 2, "非当前连接的事件不触发重建");
});

test("subscribe POST 瞬时失败：退避重试直至生效（不等下一轮 hello）", async () => {
  FakeEventSource.created = [];
  // 首次声明成功（busId=A），随后收缩声明失败一次、重试成功
  subscribeQueue = [
    () => jsonRes(200, { ok: true, count: 1 }),   // 首次（bus_A）
    () => jsonRes(500, { ok: false, error: "blip" }), // 收缩声明瞬时失败
    () => jsonRes(200, { ok: true, count: 0 }),   // 重试成功
  ];
  const mod = await freshClient();
  const rSub = mod.subscribeTopics(() => {}, ["running"]);
  const off = rSub.off;
  FakeEventSource.created[0].emitHello("conn-1", "bus_A");
  await drain();
  assert.equal(FakeEventSource.created.length, 1);
  // 退订 → 收缩 POST 失败 → 退避重试成功
  off();
  await drain();
  await new Promise((r) => setTimeout(r, 2500)); // 首次退避 2s
  await drain();
  assert.equal(FakeEventSource.created.length, 1, "重试不换连接（原连接白名单恢复）");
});

test("subscribe 失败重试不因连接重建而悬挂：新连接 hello 后白名单重发", async () => {
  FakeEventSource.created = [];
  subscribeQueue = [
    () => jsonRes(404, { ok: false, code: "STALE_CONN", error: "unknown conn" }),
    () => jsonRes(200, { ok: true, count: 1 }),
  ];
  const mod = await freshClient();
  mod.subscribeTopics(() => {}, ["running"]);
  FakeEventSource.created[0].emitHello("conn-1", "bus_A"); // STALE → 重建
  await drain();
  FakeEventSource.created[1].emitHello("conn-2", "bus_A"); // 新连接 hello → 重发 → 200
  await drain();
  assert.ok(FakeEventSource.created[0].closedByTest, "旧连接已关");
  assert.ok(!FakeEventSource.created[1].closedByTest, "新连接存活");
});
