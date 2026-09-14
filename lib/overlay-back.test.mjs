// 小屏系统返回关闭浮层的退栈器单测（lib/overlay-back.ts）。
//
// 用伪 window/history 完整模拟「pushState 同 URL 条目 + 异步 back 遍历 + popstate」：
//   - 开→系统返回：关层、退出浮层条目；
//   - 关→自身清理：不残留空条目（微任务回退）；关旧开新同 commit 竞态取消回退；
//   - LIFO 连开连回、空槽跳过、前进归一化、Next `__NA` state 保留。
// 隔离：模块级栈状态 → jiti moduleCache:false 每用例独立实例。
// Run: node --experimental-strip-types --test lib/overlay-back.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });

/**
 * 伪浏览器历史：entries/index 模型 + back()/forward() 入队（异步遍历），flush() 时派发 popstate。
 * pushState 不做 Next 补丁（模块自身展开 history.state，可验证 `__NA` 保留）。
 */
function makeWindow() {
  const listeners = { popstate: [] };
  const entries = [{ state: { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["base"] } }];
  let index = 0;
  const queue = [];
  const history = {
    get state() {
      return entries[index]?.state ?? null;
    },
    get length() {
      return entries.length;
    },
    pushState(state) {
      entries.splice(index + 1);
      entries.push({ state });
      index += 1;
    },
    replaceState(state) {
      entries[index] = { state };
    },
    back() {
      queue.push(-1);
    },
    forward() {
      queue.push(1);
    },
  };
  const win = {
    history,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
  };
  /** 执行排队的遍历并派发 popstate；popstate 处理器里再触发的 back 会被同轮消化。 */
  function flush() {
    while (queue.length) {
      const step = queue.shift();
      index = Math.max(0, Math.min(entries.length - 1, index + step));
      const event = { state: entries[index]?.state ?? null };
      for (const fn of [...listeners.popstate]) fn(event);
    }
  }
  return { win, history, entries, flush, index: () => index, queue };
}

async function freshLib(win) {
  globalThis.window = win;
  return jiti.import("./overlay-back.ts");
}

test("acquire pushes a same-URL entry preserving Next router state", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  lib.acquireOverlayBack(() => closes.push("a"));
  assert.equal(h.entries.length, 2);
  const state = h.entries[1].state;
  assert.equal(state.__NA, true, "Next 的 __NA 必须保留，否则 popstate 会触发整页 reload");
  assert.deepEqual(state.__PRIVATE_NEXTJS_INTERNALS_TREE, ["base"]);
  assert.equal(typeof state.__piWebOverlayBack, "number");
  assert.equal(lib.overlayBackDepth(), 1);
});

test("system back closes the top layer and leaves the overlay entry", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  lib.acquireOverlayBack(() => closes.push("a"));
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["a"]);
  assert.equal(lib.overlayBackDepth(), 0);
  assert.equal(h.index(), 0, "回到浮层下面的主页面条目");
});

test("UI close releases the layer and cleans its history slot (no leftover entry)", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  const handle = lib.acquireOverlayBack(() => closes.push("a"));
  handle.release();
  await Promise.resolve(); // release 的自身回退在微任务里排队
  h.flush();
  assert.deepEqual(closes, [], "自身清理回退不得再调 close");
  assert.equal(h.index(), 0);
  // 再开一个：复用空槽（replaceState）而不是继续堆积历史条目
  const handle2 = lib.acquireOverlayBack(() => closes.push("b"));
  assert.equal(h.entries.length, 2);
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b"]);
  handle2.release();
});

test("stacked overlays close in LIFO order", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  lib.acquireOverlayBack(() => closes.push("a"));
  lib.acquireOverlayBack(() => closes.push("b"));
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b"]);
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b", "a"]);
  assert.equal(h.index(), 0);
});

test("vacant slots left by UI closes are skipped in a single back gesture", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  const a = lib.acquireOverlayBack(() => closes.push("a"));
  lib.acquireOverlayBack(() => closes.push("b"));
  a.release(); // 当前条目是 b，a 的条目变空槽（不触发回退）
  h.history.back(); // 关 b 后落到 a 的空槽 → 自动再跳过
  h.flush();
  assert.deepEqual(closes, ["b"], "空槽不得触发已释放层的 close");
  assert.equal(h.index(), 0, "一次返回直达主页面条目");
});

test("close-then-open in the same tick: new layer reuses the slot and keeps its back entry", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  const a = lib.acquireOverlayBack(() => closes.push("a"));
  a.release(); // 微任务里回退
  const b = lib.acquireOverlayBack(() => closes.push("b")); // 复用 a 的空槽
  await Promise.resolve();
  h.flush();
  assert.equal(h.entries.length, 2, "复用空槽，不新增历史条目");
  assert.deepEqual(closes, [], "自身回退被取消，不得误关新层");
  h.history.back();
  h.flush();
  assert.deepEqual(closes, ["b"], "返回应关掉新层");
  b.release();
});

test("forward navigation into a stale overlay entry normalizes state without closing", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const closes = [];
  const handle = lib.acquireOverlayBack(() => closes.push("a"));
  handle.release();
  await Promise.resolve();
  h.flush(); // 回退到主页面条目
  h.history.forward(); // 前进到已失效的浮层条目
  h.flush();
  assert.deepEqual(closes, [], "前进不得关闭任何层");
  assert.equal(h.entries[1].state.__piWebOverlayBack, null, "失效标记被抹掉");
  assert.equal(h.entries[1].state.__NA, true, "Next state 仍保留");
});

test("release is idempotent", async () => {
  const h = makeWindow();
  const lib = await freshLib(h.win);
  const handle = lib.acquireOverlayBack(() => {});
  handle.release();
  handle.release();
  await Promise.resolve();
  h.flush();
  assert.equal(h.queue.length, 0);
  assert.equal(h.index(), 0);
});
