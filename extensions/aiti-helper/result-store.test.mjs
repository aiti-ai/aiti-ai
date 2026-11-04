/**
 * aiti-helper · result-store 结果状态机单测（方案 docs/aiti-helper-result-event-bus-plan.md §3.4）
 *
 * 覆盖：begin/settled/failed 语义、snapshot 四态、turn、listActive、run 边界 + 宽限（零产出终态）、
 * endSession 保留已结算、dispose 清理。全用例用假计时器，无真实等待。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-helper/result-store.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const modPath = new URL("./result-store.ts", import.meta.url).pathname;
const { createResultStore, DEFAULT_SETTLE_GRACE_MS } = await import(modPath);

/** 假计时器：记录挂起回调，fireAll 手动触发（清掉的不会触发）。 */
function makeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    fireAll: () => { const all = [...timers.values()]; timers.clear(); for (const t of all) t.fn(); },
    pending: () => timers.size,
    delays: () => [...timers.values()].map((t) => t.ms),
  };
}

const origin = (turn = 1) => ({ message: "做事", helperId: "h1", turn, startedAt: 1 });

test("begin → snapshot=running；markSettled → snapshot=ok（文本/historyId/turn）", () => {
  const clock = makeClock();
  const store = createResultStore({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  store.begin("s1", origin(3));
  assert.deepEqual(store.snapshot("s1"), { ok: false, code: "running", turn: 3 });
  store.markSettled("s1", "结果文本", "h_1");
  assert.deepEqual(store.snapshot("s1"), { ok: true, text: "结果文本", historyId: "h_1", turn: 3, settled: true });
});

test("markFailed → snapshot=no_result（错误文案 + turn）；listActive 不再列出", () => {
  const clock = makeClock();
  const store = createResultStore({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  store.begin("s1", origin());
  assert.equal(store.listActive().length, 1);
  store.markFailed("s1", "模型报错");
  assert.deepEqual(store.snapshot("s1"), { ok: false, code: "no_result", error: "模型报错", turn: 1 });
  assert.equal(store.listActive().length, 0);
});

test("未知会话 snapshot=not_found", () => {
  const store = createResultStore();
  const s = store.snapshot("nope");
  assert.equal(s.ok, false);
  assert.equal(s.code, "not_found");
});

test("begin 覆盖同 sid → turn/message 更新，settled 复位", () => {
  const clock = makeClock();
  const store = createResultStore({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  store.begin("s1", origin(1));
  store.markSettled("s1", "第一轮", "h_1");
  store.begin("s1", { ...origin(2), message: "追问" });
  assert.equal(store.get("s1").origin.turn, 2);
  assert.equal(store.get("s1").settled, false);
  assert.deepEqual(store.snapshot("s1"), { ok: false, code: "running", turn: 2 });
});

test("宽限：raw agent_settled 后仍未结算 → onGraceExpire + 标失败（默认 3s）", () => {
  const clock = makeClock();
  const expired = [];
  const store = createResultStore({
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onGraceExpire: (sid, entry) => expired.push([sid, entry.failedError]),
  });
  store.begin("s1", origin(2));
  store.onAgentStart("s1");
  store.onAgentSettled("s1");                 // run 结束但仍未结算
  assert.deepEqual(clock.delays(), [DEFAULT_SETTLE_GRACE_MS]);
  clock.fireAll();
  assert.equal(expired.length, 1);
  assert.equal(expired[0][0], "s1");
  assert.deepEqual(store.snapshot("s1"), { ok: false, code: "no_result", error: expired[0][1], turn: 2 });
  assert.equal(store.isPendingHelperTurn("s1"), false);
});

test("宽限：宿主 onAgentSettled（正常路径）先到 → 计时器被清、无 onGraceExpire", () => {
  const clock = makeClock();
  let expired = 0;
  const store = createResultStore({
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onGraceExpire: () => expired++,
  });
  store.begin("s1", origin());
  store.onAgentStart("s1");
  store.markSettled("s1", "ok", "h_9");       // 宿主 dispatchAgentSettled（先于 raw 事件监听器）
  store.onAgentSettled("s1");                 // raw 帧：已结算 → 不应起计时
  assert.equal(clock.pending(), 0);
  clock.fireAll();
  assert.equal(expired, 0);
  assert.deepEqual(store.snapshot("s1"), { ok: true, text: "ok", historyId: "h_9", turn: 1, settled: true });
});

test("宽限：新一轮 run 已起跑（followup 边界）不判零产出", () => {
  const clock = makeClock();
  let expired = 0;
  const store = createResultStore({
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onGraceExpire: () => expired++,
  });
  store.begin("s1", origin());
  store.onAgentSettled("s1");                  // 起计时
  store.onAgentStart("s1");                    // 新一轮起跑 → 清计时
  assert.equal(clock.pending(), 0);
  clock.fireAll();
  assert.equal(expired, 0);
  assert.deepEqual(store.snapshot("s1"), { ok: false, code: "running", turn: 1 });
});

test("endSession：已结算条目保留（快照仍可用），未结算条目清除", () => {
  const clock = makeClock();
  const store = createResultStore({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  store.begin("done", origin());
  store.markSettled("done", "x", "h_x");
  store.begin("running", origin());
  assert.ok(store.endSession("done"));
  assert.equal(store.endSession("running"), undefined);
  assert.deepEqual(store.snapshot("done"), { ok: true, text: "x", historyId: "h_x", turn: 1, settled: true });
  assert.equal(store.snapshot("running").code, "not_found");
});

test("dispose：清计时器与账本", () => {
  const clock = makeClock();
  const store = createResultStore({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  store.begin("s1", origin());
  store.onAgentSettled("s1");
  assert.equal(clock.pending(), 1);
  store.dispose();
  assert.equal(clock.pending(), 0);
  assert.equal(store.size(), 0);
});

test("markSettled/markFailed 对未知会话 no-op（不抛）", () => {
  const store = createResultStore();
  assert.equal(store.markSettled("nope", "x", "h"), undefined);
  assert.equal(store.markFailed("nope", "x"), undefined);
});
