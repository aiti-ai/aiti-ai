/**
 * aiti-event-bus · client STALE_CONN 静默重建单测（统一 SSE 端口方案 §3-D2）
 *
 * 回归锚点：服务端 reload 重建 conns 后旧 conn POST /subscribe 得 404（现带
 * code:"STALE_CONN"）——旧客户端把它 throw 成 unhandled rejection（控制台
 * `[ext] aiti-event-bus (uncaught)/subscribe HTTP 404`）。新契约：
 *   - STALE_CONN → 静默重建连接（关旧 ES、清 conn、新建连），ready 等待者不 reject；
 *     新连接 hello 后重发订阅，成功后 ready resolve；
 *   - 无 code 的 404（路由缺失，如扩展禁用）→ 仍走失败路径（ready reject）；
 *   - STALE_CONN 连续超过上限（3 次）→ 放弃重建，ready reject（防无限循环）。
 *
 * 环境：模块顶层引用 window/location 处均有 typeof 守卫；EventSource/fetch 用桩。
 * node --test 对 unhandled rejection 判失败——本文件全绿即「无 uncaught 泄漏」成立。
 * Run: node --test stale-rebuild.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

// ---- 浏览器环境桩（import 模块之前就位）----

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
  /** 测试驱动：模拟服务端 hello 帧 */
  emitHello(conn) {
    this.readyState = 1;
    for (const fn of this.listeners.hello ?? []) fn({ data: JSON.stringify({ conn }) });
  }
}

let subscribeQueue = []; // POST /subscribe 的响应脚本（逐次弹出；空则 500）

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
  return jsonRes(404, { ok: false, error: "unexpected fetch " + url });
};

const drain = () => new Promise((r) => setTimeout(r, 0));

async function freshClient() {
  // 每用例独立模块实例（broker 是模块级单例）
  const mod = await import(`./dist/aiti-event-bus-client.mjs?case=${Date.now()}-${Math.random()}`);
  const register = mod.default;
  const { subscribeTopics } = mod;
  register({ apiUrl: (p) => p });
  return { register, subscribeTopics };
}

function settle(h) {
  return new Promise((resolve, reject) => h.then(resolve, reject));
}

test("STALE_CONN：静默重建连接，ready 不 reject，新 hello 后重发订阅成功", async () => {
  FakeEventSource.created = [];
  subscribeQueue = [
    (body) => (globalThis.__firstBody = body) && jsonRes(404, { ok: false, code: "STALE_CONN", error: "unknown conn" }),
    (body) => (globalThis.__secondBody = body) && jsonRes(200, { ok: true, count: 1 }),
  ];
  const { subscribeTopics } = await freshClient();
  const ready = settle(subscribeTopics(() => {}, ["t1"]).ready);
  // 首连接 hello → pushSubscription → 404 STALE_CONN → 重建（第二个 ES）
  FakeEventSource.created[0].emitHello("conn-1");
  await drain();
  assert.equal(globalThis.__firstBody.conn, "conn-1", "首次 POST 带首连接 connId");
  assert.equal(FakeEventSource.created.length, 2, "STALE_CONN 后已静默重建（新 EventSource）");
  assert.ok(FakeEventSource.created[0].closedByTest, "旧连接已关闭");
  // 新连接 hello → 重发订阅 → 200 → ready resolve（不 reject = 无 unhandled）
  FakeEventSource.created[1].emitHello("conn-2");
  await drain();
  await Promise.race([ready, drain().then(() => { throw new Error("ready 未 resolve"); })]);
  assert.equal(globalThis.__secondBody.conn, "conn-2", "重建后的 POST 带新 connId");
  assert.deepEqual(globalThis.__secondBody.types, ["t1"], "请求体契约不变（conn+types）");
});

test("无 code 的 404（路由缺失）：走失败路径，ready reject（不重建）", async () => {
  FakeEventSource.created = [];
  subscribeQueue = [() => jsonRes(404, { ok: false, error: "not found" })];
  const { subscribeTopics } = await freshClient();
  const readyP = subscribeTopics(() => {}, ["t1"]).ready;
  const ready = settle(readyP);
  FakeEventSource.created[0].emitHello("conn-1");
  await assert.rejects(ready, /subscribe HTTP 404/, "无 code 404 仍 reject（订阅方按契约降级）");
  assert.equal(FakeEventSource.created.length, 1, "未重建（扩展禁用场景回退是正确终态）");
});

test("STALE_CONN 连续超过上限：放弃重建并 reject（防无限循环）", async () => {
  FakeEventSource.created = [];
  const stale = () => jsonRes(404, { ok: false, code: "STALE_CONN", error: "unknown conn" });
  subscribeQueue = [stale, stale, stale, stale, stale]; // 上限 3 次重建，第 4 次 404 放弃
  const { subscribeTopics } = await freshClient();
  const readyP = subscribeTopics(() => {}, ["t1"]).ready;
  // 提前挂 handler：超限 reject 发生在循环内（assert.rejects attach 之前），
  // 裸 reject 会成为 unhandled rejection 被 node --test 抓为失败。
  const readyOutcome = readyP.then(() => "resolved", (e) => String((e && e.message) || e));
  // 每次重建后需手动 hello 驱动下一轮 POST
  for (let round = 0; round < 6; round++) {
    await drain();
    const es = FakeEventSource.created[FakeEventSource.created.length - 1];
    if (es && !es.closedByTest) es.emitHello("conn-r" + round);
  }
  await drain();
  await drain();
  assert.match(await readyOutcome, /STALE_CONN/, "连续 stale 超上限 → reject（不再无限重建）");
  assert.ok(FakeEventSource.created.length <= 5, "重建次数有界");
});

test("重建成功后 readyResolvers 清空：后续 stale 重建不再 reject 已 resolve 的等待者", async () => {
  FakeEventSource.created = [];
  subscribeQueue = [
    () => jsonRes(404, { ok: false, code: "STALE_CONN", error: "x" }),
    () => jsonRes(200, { ok: true, count: 1 }),
    () => jsonRes(404, { ok: false, code: "STALE_CONN", error: "x" }), // 后续 stale（pendingPush 路径）
    () => jsonRes(200, { ok: true, count: 1 }),
  ];
  const { subscribeTopics } = await freshClient();
  const sub = subscribeTopics(() => {}, ["t1"]);
  const ready = settle(sub.ready);
  FakeEventSource.created[0].emitHello("c1");
  await drain();
  FakeEventSource.created[1].emitHello("c2");
  await Promise.race([ready, drain().then(() => { throw new Error("ready 未 resolve"); })]);
  // 二次 stale 走非 forReady 路径（readyResolvers 已空）——不产生 unhandled rejection
  FakeEventSource.created[FakeEventSource.created.length - 1].emitHello("c3");
  await drain(); await drain();
  assert.ok(true, "无 unhandled（node --test 会抓）");
});

test("STALE 窗口内交替 404/200：计数仍累积，超上限后放弃重建（防抖动风暴）", async () => {
  FakeEventSource.created = [];
  const stale = () => jsonRes(404, { ok: false, code: "STALE_CONN", error: "x" });
  const ok = () => jsonRes(200, { ok: true, count: 1 });
  // 每轮「404(重建) → hello → 200(窗口内 <10s，不复位计数)」；订阅者 4 加入触发第 4 次
  // 404 时 staleRebuilds 已达 3 → 超限放弃。旧行为：每次 200 复位 → 永不超限 → 无限重建。
  subscribeQueue = [stale, ok, stale, ok, stale, ok, stale];
  const { subscribeTopics } = await freshClient();
  const ready1Outcome = subscribeTopics(() => {}, ["t1"]).ready
    .then(() => "resolved", (e) => String((e && e.message) || e));
  // 轮 1-2：首连 404 → 重建；新流 hello → 200（窗口内，计数保留 1）
  FakeEventSource.created[0].emitHello("c1");
  await drain();
  assert.equal(FakeEventSource.created.length, 2, "首次 STALE 已重建");
  FakeEventSource.created[1].emitHello("c2");
  await drain();
  assert.equal(await ready1Outcome, "resolved", "订阅者 1 订阅生效");
  // 轮 3-6：订阅者 2/3 加入触发新 POST（desiredTypes 变化）；404 计数累积，200 窗口内不复位
  for (const [t, expectedEs] of [["t2", 3], ["t3", 4]]) {
    subscribeTopics(() => {}, [t]);
    await drain();
    assert.equal(FakeEventSource.created.length, expectedEs, `订阅者加入触发第 ${expectedEs - 1} 次 STALE 重建（窗口内成功未复位计数）`);
    FakeEventSource.created[FakeEventSource.created.length - 1].emitHello("c" + FakeEventSource.created.length);
    await drain();
  }
  // 轮 7：订阅者 4 加入 → 第 4 次 404 → 超限（3 >= 3）→ 放弃重建（不再新建 EventSource）
  const ready4Outcome = subscribeTopics(() => {}, ["t4"]).ready
    .then(() => "resolved", (e) => String((e && e.message) || e));
  await drain();
  await drain();
  assert.equal(FakeEventSource.created.length, 4, "超上限 → 放弃重建（循环收敛）");
  assert.match(await ready4Outcome, /STALE_CONN/, "超限走失败路径（ready reject）");
});
