// aiti-float 小屏系统返回接线单测（back-layer.ts，纯逻辑零 DOM）。
// 钉住：小屏+服务 → acquire；断点回大屏/服务下线/panelGone/dispose → release；
// 断点变化重估；服务后上线 catch-up；dismiss 经句柄 close 回调触发；重复 panelReady 幂等。
// Run: node --experimental-strip-types --test pi-web-ext/aiti-float/client/src/back-layer.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { createBackLayerManager } from "./back-layer.ts";

/** 伪宿主服务：记录 acquire/release/close 回调。 */
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

function makePorts({ service = null, small = true, dismiss = () => {} } = {}) {
  const listeners = [];
  const ports = {
    service,
    small,
    dismiss,
    onSmallScreenChange(cb) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    setSmall(value) {
      ports.small = value;
      for (const cb of [...listeners]) cb();
    },
    getService: () => ports.service,
    isSmallScreen: () => ports.small,
  };
  return ports;
}

test("registers a back layer per dismissible panel on small screens only", () => {
  const service = makeService();
  const ports = makePorts({ service, small: true });
  const mgr = createBackLayerManager(ports);
  const a = {};
  const b = {};
  mgr.panelReady(a);
  mgr.panelReady(b);
  assert.equal(mgr.size(), 2);
  assert.equal(service.acquired.length, 2);
  // 重复 ready 幂等，不重复 acquire
  mgr.panelReady(a);
  assert.equal(service.acquired.length, 2);
  mgr.dispose();
});

test("does not acquire while desktop, and catches up when entering small screen", () => {
  const service = makeService();
  const ports = makePorts({ service, small: false });
  const mgr = createBackLayerManager(ports);
  const a = {};
  mgr.panelReady(a);
  assert.equal(mgr.size(), 0, "大屏不注册（浏览器返回语义不变）");
  ports.setSmall(true);
  assert.equal(mgr.size(), 1, "进小屏自动补注册");
  ports.setSmall(false);
  assert.equal(mgr.size(), 0, "回大屏自动释放");
  assert.equal(service.released.length, 1);
  mgr.dispose();
});

test("dismissal callback clicks the panel close via the provided port", () => {
  const service = makeService();
  const dismissed = [];
  const ports = makePorts({ service, small: true, dismiss: (panel) => dismissed.push(panel) });
  const mgr = createBackLayerManager(ports);
  const a = {};
  mgr.panelReady(a);
  service.acquired[0].close();
  assert.deepEqual(dismissed, [a]);
  mgr.dispose();
});

test("panelGone releases and forgets; knows() drives the caller's lookup skip", () => {
  const service = makeService();
  const ports = makePorts({ service, small: true });
  const mgr = createBackLayerManager(ports);
  const a = {};
  assert.equal(mgr.knows(a), false);
  mgr.panelReady(a);
  assert.equal(mgr.knows(a), true);
  mgr.panelGone(a);
  assert.equal(mgr.knows(a), false);
  assert.equal(mgr.size(), 0);
  assert.equal(service.released.length, 1);
  mgr.dispose();
});

test("missing service degrades silently and late service still attaches", () => {
  const ports = makePorts({ service: null, small: true });
  const mgr = createBackLayerManager(ports);
  const a = {};
  mgr.panelReady(a);
  assert.equal(mgr.size(), 0, "旧宿主无服务：不注册不抛");
  const service = makeService();
  ports.service = service;
  mgr.syncAll(); // 服务上线（onExtServiceChange 后调用）
  assert.equal(mgr.size(), 1);
  assert.equal(service.acquired.length, 1);
  mgr.dispose();
  assert.equal(service.released.length, 1);
});
