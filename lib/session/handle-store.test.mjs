import { test } from "node:test";
import assert from "node:assert/strict";

// handle-store 依赖 globalThis.__sessionHandles 进程全局——测试须先清场，
// 结束后清理，避免污染其它测试文件。
const g = globalThis;
function resetStore() {
  g.__sessionHandles = undefined;
}

function stub(id, { running = false, alive = true, source = "test" } = {}) {
  const h = {
    id,
    source,
    capabilities: {},
    cwd: "",
    running,
    alive: () => alive,
    isRunning: () => h.running,
    subscribe: () => () => {},
    dispose: async () => {},
  };
  return h;
}

// 动态导入：让 store 在本次测试进程中以干净状态初始化
async function load() {
  resetStore();
  return import("./handle-store.ts");
}

test("getRunningHandleIds 覆盖占位 uuid（Map key）与 handle.id（复合 id）", async () => {
  const { putHandle, putHandleAt, getRunningHandleIds } = await load();
  try {
    // 模拟 zcode 历史会话复活：openExternalSession putHandle(handle)（key=复合 id），
    // resolvePlaceholderSession 再 putHandleAt(占位 uuid)。侧栏行 id = 占位 uuid。
    const h = stub("zcode:sess_abc", { running: true });
    putHandle(h);
    putHandleAt("b74cd851-cad2-446c-be77-7c1bcf5b1241", h);

    const ids = getRunningHandleIds();
    assert.ok(ids.includes("b74cd851-cad2-446c-be77-7c1bcf5b1241"), "占位 uuid 必须进运行集（侧栏行 id 匹配）");
    assert.ok(ids.includes("zcode:sess_abc"), "handle.id（复合 id）也必须进运行集");
  } finally {
    resetStore();
  }
});

test("getRunningHandleIds 过滤 attach 的文件路径 key（/ 开头）", async () => {
  const { putHandle, putHandleAt, getRunningHandleIds } = await load();
  try {
    const h = stub("aaaa-1111-2222-3333", { running: true });
    putHandle(h); // key = handle.id（uuid）
    putHandleAt("/home/pi/.pi/agent/sessions/xxx_aaaa-1111-2222-3333.jsonl", h); // 兼容复用键

    const ids = getRunningHandleIds();
    assert.ok(ids.includes("aaaa-1111-2222-3333"));
    assert.ok(!ids.some((id) => id.startsWith("/")), "文件路径 key 是内部复用，不得暴露给 running 集");
  } finally {
    resetStore();
  }
});

test("getRunningHandleIds 只含运行中的存活 handle；非运行不出现", async () => {
  const { putHandle, getRunningHandleIds } = await load();
  try {
    putHandle(stub("idle-sess", { running: false }));
    putHandle(stub("running-sess", { running: true }));
    const ids = getRunningHandleIds();
    assert.ok(ids.includes("running-sess"));
    assert.ok(!ids.includes("idle-sess"));
  } finally {
    resetStore();
  }
});

test("notifyHandleRunningChange 仅在运行集变化时广播合并后完整集", async () => {
  const { putHandle, notifyHandleRunningChange, subscribeRunningHandles } = await load();
  try {
    let count = 0;
    let last = null;
    const unsub = subscribeRunningHandles((ids) => { count++; last = ids; });

    const h = stub("sess-1", { running: false });
    putHandle(h);
    // 首帧广播初始快照（空集），此后空集未变化不重复广播
    notifyHandleRunningChange();
    assert.equal(count, 1);
    assert.deepEqual(last, []);
    notifyHandleRunningChange();
    assert.equal(count, 1, "运行集未变化（空→空）不应重复广播");

    // 运行集变化（handle 进入 running）→ 广播合并后的完整集
    h.running = true;
    notifyHandleRunningChange();
    assert.equal(count, 2);
    assert.deepEqual([...last].sort(), ["sess-1"]);

    unsub();
  } finally {
    resetStore();
  }
});

// ── disposeAllHandles：在途 handle 延迟销毁（2026-09-07 reload 杀轮次事故）──

/** 带事件广播的 stub：subscribe 收集 listener，emit 手动触发。 */
function eventStub(id, { running = false, alive = true } = {}) {
  const listeners = new Set();
  const h = {
    id,
    source: "test",
    capabilities: {},
    cwd: "",
    running,
    disposed: false,
    alive: () => h.aliveFlag,
    aliveFlag: alive,
    isRunning: () => h.running,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    dispose: async () => { h.disposed = true; },
    emit: (type) => { for (const fn of [...listeners]) fn({ type }); },
  };
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("disposeAllHandles：空闲 handle 立即销毁，在途 handle 连同别名键保留", async () => {
  const { putHandle, putHandleAt, listHandleIds, getHandle, disposeAllHandles } = await load();
  try {
    const idle = eventStub("ext:idle");
    const busy = eventStub("ext:busy", { running: true });
    putHandle(idle);
    putHandle(busy);
    putHandleAt("placeholder-uuid-busy", busy); // 别名双注册

    const count = await disposeAllHandles();
    assert.equal(count, 3, "返回值 = 处理前全部 key 数");
    assert.equal(idle.disposed, true, "空闲 handle 立即 dispose");
    assert.equal(busy.disposed, false, "在途 handle 不得被 reload 杀掉");
    assert.ok(listHandleIds().includes("ext:busy"), "在途 handle 的复合 id 键保留");
    assert.ok(listHandleIds().includes("placeholder-uuid-busy"), "在途 handle 的占位 uuid 别名键保留");
    assert.equal(getHandle("ext:idle"), undefined, "空闲 handle 已出库");
  } finally {
    resetStore();
  }
});

test("disposeAllHandles：在途 handle settle 后自动 dispose + 出库（含别名键）", async () => {
  const { putHandle, putHandleAt, listHandleIds, getHandle, disposeAllHandles } = await load();
  try {
    const busy = eventStub("ext:busy", { running: true });
    putHandle(busy);
    putHandleAt("placeholder-uuid-busy", busy);
    await disposeAllHandles();

    busy.running = false;
    busy.emit("agent_settled");
    await sleep(1200); // 复核延迟 1s

    assert.equal(busy.disposed, true, "settle 后延迟 dispose");
    assert.equal(getHandle("ext:busy"), undefined, "复合 id 键出库");
    assert.equal(getHandle("placeholder-uuid-busy"), undefined, "别名键一并出库");
    assert.equal(listHandleIds().length, 0);
  } finally {
    resetStore();
  }
});

test("disposeAllHandles：settle 复核窗口内重新 running → 不出库继续跑", async () => {
  const { putHandle, getHandle, disposeAllHandles } = await load();
  try {
    const busy = eventStub("ext:busy", { running: true });
    putHandle(busy);
    await disposeAllHandles();

    // agent_end 后排队续轮立刻 agent_start：复核时仍在运行
    busy.emit("agent_end");
    await sleep(50);
    busy.running = true;
    busy.emit("agent_start");
    await sleep(1200);

    assert.equal(busy.disposed, false, "复核窗口内重新运行 → 不得销毁");
    assert.ok(getHandle("ext:busy"), "handle 仍在库内");
  } finally {
    resetStore();
  }
});
