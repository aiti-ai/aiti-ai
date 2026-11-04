// _shared/overlay-back-client 单测（扩展端返回关闭接线薄封装）。
// 覆盖：小屏门控 / 断点动态重估 / 服务缺席与抛错降级 / acquire 异常兜底 / release 幂等。
// Run: node --experimental-strip-types --test pi-web-ext/_shared/overlay-back-client.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { dismissOnBack, OVERLAY_BACK_MOBILE_QUERY } from "./overlay-back-client.ts";

/** 可控 matchMedia 桩：matches 可翻转并派发 change。 */
function makeMedia(initial) {
  const listeners = [];
  let matches = initial;
  const mq = {
    get matches() { return matches; },
    addEventListener(type, fn) { if (type === "change") listeners.push(fn); },
    removeEventListener(type, fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  return {
    mq,
    listenerCount: () => listeners.length,
    set(value) {
      matches = value;
      for (const fn of [...listeners]) fn({ matches: value, media: OVERLAY_BACK_MOBILE_QUERY });
    },
  };
}

function withWindow(media, fn) {
  const prev = globalThis.window;
  globalThis.window = { matchMedia: () => media.mq };
  try {
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.window;
    else globalThis.window = prev;
  }
}

function makeService() {
  const acquired = [];
  const released = [];
  return {
    acquired,
    released,
    acquire(close) {
      const handle = { release: () => released.push(close) };
      acquired.push({ close, handle });
      return handle;
    },
  };
}

test("desktop does not register; mobile does; release is idempotent", () => {
  const media = makeMedia(false);
  withWindow(media, () => {
    const svc = makeService();
    const release = dismissOnBack(() => svc, () => {});
    assert.equal(svc.acquired.length, 0, "桌面不得注册");
    media.set(true);
    assert.equal(svc.acquired.length, 1, "进小屏自动补注册");
    media.set(false);
    assert.equal(svc.released.length, 1, "回大屏自动释放");
    media.set(true);
    assert.equal(svc.acquired.length, 2, "再进小屏重新注册");
    release();
    assert.equal(svc.released.length, 2);
    release();
    assert.equal(svc.released.length, 2, "release 幂等");
    assert.equal(media.listenerCount(), 0, "release 反注册 matchMedia 监听");
  });
});

test("passes the close callback through to the host service", () => {
  const media = makeMedia(true);
  withWindow(media, () => {
    const svc = makeService();
    let closed = 0;
    dismissOnBack(() => svc, () => { closed += 1; });
    svc.acquired[0].close();
    assert.equal(closed, 1);
  });
});

test("degrades silently when the service is missing or throws", () => {
  const media = makeMedia(true);
  withWindow(media, () => {
    const releaseNull = dismissOnBack(() => null, () => {});
    const releaseUndefined = dismissOnBack(() => undefined, () => {});
    const releaseThrows = dismissOnBack(() => { throw new Error("boom"); }, () => {});
    const releaseBadAcquire = dismissOnBack(() => ({ acquire: null }), () => {});
    const releaseAcquireThrows = dismissOnBack(() => ({ acquire: () => { throw new Error("boom"); } }), () => {});
    for (const release of [releaseNull, releaseUndefined, releaseThrows, releaseBadAcquire, releaseAcquireThrows]) {
      assert.doesNotThrow(release);
    }
  });
});

test("late service is picked up on a later breakpoint re-evaluation", () => {
  const media = makeMedia(true);
  withWindow(media, () => {
    let svc = null;
    const release = dismissOnBack(() => svc, () => {});
    assert.equal(media.listenerCount(), 1);
    svc = makeService();
    media.set(false); // 触发一次重估（服务已上线）
    media.set(true);
    assert.equal(svc.acquired.length, 1, "服务后上线：重估时补注册");
    release();
    assert.equal(svc.released.length, 1);
  });
});

test("mobile query matches the host/float breakpoint", () => {
  assert.equal(OVERLAY_BACK_MOBILE_QUERY, "(max-width: 640px)");
});
