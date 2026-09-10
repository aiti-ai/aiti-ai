import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { installConnGuard } = await jiti.import("./conn-guard.ts");

// 防抱死守护行为测试：fetch 观测登记、starve/unstarve 广播时机、恢复延迟。
// 浏览器环境桩 + 可手动推进的时钟（Date.now / setTimeout 全部换成本地可控版本）。
// 注：installConnGuard 模块级 installed 只生效一次 → 全部场景共用同一环境。
function makeEnv({ fetchImpl }) {
  const listeners = new Map();
  const timers = [];
  let clock = Date.now();
  const window = {
    __connGuardInstalled: false,
    fetch: fetchImpl,
    dispatchEvent: (ev) => {
      for (const fn of listeners.get(ev.type) || []) fn(ev);
      return true;
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
  };
  const origSetTimeout = globalThis.setTimeout;
  const origCustomEvent = globalThis.CustomEvent;
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    static now() { return clock; }
  };
  globalThis.setTimeout = (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; };
  globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } };
  const env = {
    window,
    /** 推进虚拟时钟 ms 并手动执行到期的 conn-guard 定时器（模拟事件循环） */
    advance(ms) {
      clock += ms;
      const run = timers.splice(0);
      for (const t of run) t.fn();
    },
    pendingTimerCount: () => timers.length,
    cleanup() {
      globalThis.Date = RealDate;
      globalThis.setTimeout = origSetTimeout;
      globalThis.CustomEvent = origCustomEvent;
      delete globalThis.window;
      delete globalThis.location;
    },
  };
  globalThis.window = window;
  globalThis.location = { origin: "http://x" };
  return env;
}

function hangPromise() {
  const p = { then(onF) { p.resolve = onF; return p; }, catch() { return p; } };
  return p;
}

test("conn-guard: 安装幂等 + starve/unstarve 广播时机 + 恢复延迟 + 饥饿未解不放行", async () => {
  const env = makeEnv({ fetchImpl: () => hangPromise() });
  try {
    installConnGuard();
    assert.equal(env.window.__connGuardInstalled, true, "安装后应打标记");
    installConnGuard(); // 幂等：二次安装不重复包装（无异常即通过）

    const starveEvents = [];
    env.window.addEventListener("piwe-conn-starve", (e) => starveEvents.push(e.detail?.starved));

    // ── 场景 1：单请求挂起 → 超阈值 starve；settle → 延迟 unstarve ──
    const a = env.window.fetch("/api/a", {});
    assert.deepEqual(starveEvents, [], "未到阈值不广播（timer 尚未到点）");

    env.advance(9_000); // 推进时钟越过 STARVE_THRESHOLD_MS，随后触发到点 timer
    assert.deepEqual(starveEvents, [true], "超阈值应广播 starve=true");

    a.resolve({ ok: true }); // fetch settle → 安排延迟恢复
    assert.equal(env.pendingTimerCount(), 1, "settle 后应安排延迟恢复 timer");
    assert.deepEqual(starveEvents, [true], "延迟窗口内不广播 unstarve");

    env.advance(6_000); // 跨过 UNSTARVE_REBUILD_DELAY_MS
    assert.deepEqual(starveEvents, [true, false], "延迟到期应广播 unstarve=false");

    // ── 场景 2：两个挂起请求，其一完成仍有超龄 → 不放行 ──
    const b = env.window.fetch("/api/b", {});
    const c = env.window.fetch("/api/c", {});
    env.advance(9_000); // b、c 的 timer 到点（时钟已越过阈值）→ starve（距上次广播超 MIN_STARVE_GAP，可再次广播）
    assert.equal(starveEvents.at(-1), true, "重新饥饿应再次广播");

    b.resolve({ ok: true }); // b 完成，但 c 仍超龄 → 不得安排恢复
    assert.equal(env.pendingTimerCount(), 0, "仍有超龄请求时不应安排恢复");
    assert.equal(starveEvents.includes(false), true ? starveEvents.filter((v) => v === false).length === 1 : false, "unstarve 只应有一次（场景 1 的）");

    c.resolve({ ok: true }); // c 也完成 → 现在可以安排恢复了
    assert.equal(env.pendingTimerCount(), 1, "全部 settle 后应安排恢复");
    env.advance(6_000);
    assert.equal(starveEvents.at(-1), false, "恢复广播送达");
  } finally {
    env.cleanup();
  }
});
