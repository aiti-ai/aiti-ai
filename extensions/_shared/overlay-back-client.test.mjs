// _shared/overlay-back-client unit tests (the extension-side back-to-close wiring thin wrapper).
// Coverage: small-screen gate / dynamic breakpoint re-evaluation / missing-or-throwing service
// degradation / acquire exception tolerance / release idempotence.
// Run: node --experimental-strip-types --test pi-web-ext/_shared/overlay-back-client.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { dismissOnBack, OVERLAY_BACK_MOBILE_QUERY } from "./overlay-back-client.ts";

/** Controllable matchMedia stub: matches can be flipped and dispatches change. */
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
    assert.equal(svc.acquired.length, 0, "desktop must not register");
    media.set(true);
    assert.equal(svc.acquired.length, 1, "entering the small screen auto-registers");
    media.set(false);
    assert.equal(svc.released.length, 1, "returning to desktop auto-releases");
    media.set(true);
    assert.equal(svc.acquired.length, 2, "re-entering the small screen registers again");
    release();
    assert.equal(svc.released.length, 2);
    release();
    assert.equal(svc.released.length, 2, "release is idempotent");
    assert.equal(media.listenerCount(), 0, "release unregisters the matchMedia listener");
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
    media.set(false); // trigger one re-evaluation (the service has arrived)
    media.set(true);
    assert.equal(svc.acquired.length, 1, "late-arriving service: registered on re-evaluation");
    release();
    assert.equal(svc.released.length, 1);
  });
});

test("mobile query matches the host/float breakpoint", () => {
  assert.equal(OVERLAY_BACK_MOBILE_QUERY, "(max-width: 640px)");
});
