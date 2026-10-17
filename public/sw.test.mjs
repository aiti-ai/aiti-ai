import assert from "node:assert/strict";
import test, { mock } from "node:test";

const listeners = new Map();
globalThis.self = {
  location: {
    href: "https://pi.test/sw.js?v=test",
    origin: "https://pi.test",
  },
  registration: { scope: "https://pi.test/" },
  addEventListener: (type, listener) => listeners.set(type, listener),
  clients: null,
};

await import("./sw.js");

function setScope(scope) {
  self.registration.scope = scope;
}

function dispatchFetchPlain(url, { method = "GET", mode = "no-cors" } = {}) {
  let responded = false;
  let responsePromise = null;
  const request = { url, method, mode };
  listeners.get("fetch")({
    request,
    respondWith: (promise) => {
      responded = true;
      responsePromise = promise;
    },
  });
  return { responded, responsePromise };
}

async function installFetchHarness() {
  const cacheStore = new Map();
  globalThis.caches = {
    match: async (request) => cacheStore.get(String(request)),
    open: async () => ({
      addAll: async () => {},
      put: async (request, response) => { cacheStore.set(String(request), response); },
    }),
    keys: async () => [],
    delete: async () => true,
  };
  globalThis.fetch = async () => new Response("ok", { status: 200 });
}

function dispatchNotificationClick(data) {
  let pending;
  let closed = false;
  listeners.get("notificationclick")({
    notification: {
      data,
      close: () => { closed = true; },
    },
    waitUntil: (promise) => { pending = promise; },
  });
  return { pending, wasClosed: () => closed };
}


function dispatchPush(payload, clients, { existing = [] } = {}) {
  let pending;
  const shown = [];
  const closed = [];
  self.clients = {
    matchAll: async () => clients,
    openWindow: async () => assert.fail("push must not open windows"),
  };
  self.registration = {
    // Keep the scope: later tests (upstream offline/timeout suite) read
    // self.registration.scope through the SW's getScopePath().
    scope: self.registration?.scope,
    showNotification: async (title, options) => { shown.push({ title, options }); },
    getNotifications: async () => existing.map((n, i) => ({
      tag: n.tag,
      timestamp: n.timestamp,
      close: () => { closed.push(n.tag ?? `#${i}`); },
    })),
  };
  listeners.get("push")({
    data: { json: () => payload },
    waitUntil: (promise) => { pending = promise; },
  });
  return { pending, shown, closed };
}

test("root scope: API and sw.js requests bypass the cache", async () => {
  setScope("https://pi.test/");
  await installFetchHarness();

  assert.equal(dispatchFetchPlain("https://pi.test/api/sessions").responded, false);
  assert.equal(dispatchFetchPlain("https://pi.test/api/agent/s1/events").responded, false);
  assert.equal(dispatchFetchPlain("https://pi.test/sw.js?v=test").responded, false);
});

test("root scope: static assets are served cache-first", async () => {
  setScope("https://pi.test/");
  await installFetchHarness();

  const staticHit = dispatchFetchPlain("https://pi.test/_next/static/chunks/app.js");
  assert.equal(staticHit.responded, true);
  await staticHit.responsePromise;
  assert.equal(dispatchFetchPlain("https://pi.test/icons/icon-192.png").responded, true);
  // 融合上游语义：manifest 是运行时配置，绕过 SW（不响应、不缓存）
  assert.equal(dispatchFetchPlain("https://pi.test/manifest.webmanifest").responded, false);
});

test("root scope: navigations fall back to the offline page", async () => {
  setScope("https://pi.test/");
  await installFetchHarness();

  const nav = dispatchFetchPlain("https://pi.test/?session=abc", { mode: "navigate" });
  assert.equal(nav.responded, true);
  await nav.responsePromise;
});

test("sub-path scope (/dev): API requests under the scope bypass the cache", async () => {
  setScope("https://pi.test/dev/");
  await installFetchHarness();

  assert.equal(dispatchFetchPlain("https://pi.test/dev/api/sessions").responded, false);
  assert.equal(dispatchFetchPlain("https://pi.test/dev/api/sessions/s1/context?leafId=x").responded, false);
  assert.equal(dispatchFetchPlain("https://pi.test/dev/sw.js?v=test").responded, false);
  // Requests outside the scope are left alone, including root-level APIs.
  assert.equal(dispatchFetchPlain("https://pi.test/api/sessions").responded, false);
  assert.equal(dispatchFetchPlain("https://pi.test/_next/static/chunks/app.js").responded, false);
});

test("sub-path scope (/dev): static assets under the scope are served cache-first", async () => {
  setScope("https://pi.test/dev/");
  await installFetchHarness();

  const staticHit = dispatchFetchPlain("https://pi.test/dev/_next/static/chunks/app.js");
  assert.equal(staticHit.responded, true);
  await staticHit.responsePromise;
  assert.equal(dispatchFetchPlain("https://pi.test/dev/icons/icon-192.png").responded, true);
  assert.equal(dispatchFetchPlain("https://pi.test/dev/manifest.webmanifest").responded, false);
  assert.equal(dispatchFetchPlain("https://pi.test/dev/offline.html").responded, true);
});

test("sub-path scope (/dev): navigations fall back to the scoped offline page", async () => {
  setScope("https://pi.test/dev/");
  await installFetchHarness();

  const nav = dispatchFetchPlain("https://pi.test/dev/?session=abc", { mode: "navigate" });
  assert.equal(nav.responded, true);
  await nav.responsePromise;
});

test("notification click focuses an existing client at the session URL", async () => {
  setScope("https://pi.test/");
  const calls = [];
  const focusedClient = {
    url: "https://pi.test/?session=session-1",
    focus: async () => { calls.push("focus"); },
    navigate: async () => assert.fail("exact client should not navigate"),
    postMessage: (message) => { calls.push(["postMessage", message]); },
  };
  self.clients = {
    matchAll: async () => [focusedClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.equal(event.wasClosed(), true);
  assert.deepEqual(calls, [
    "focus",
    ["postMessage", { type: "pi-web:open-session", url: "https://pi.test/?session=session-1", sessionId: "session-1" }],
  ]);
});

test("notification click focuses (never navigates) an existing client on another session", async () => {
  setScope("https://pi.test/");
  const calls = [];
  const existingClient = {
    url: "https://pi.test/?session=other-session",
    navigate: async () => assert.fail("must not navigate an open client (would full-reload the page)"),
    focus: async () => { calls.push("focus"); },
    postMessage: (message) => { calls.push(["postMessage", message]); },
  };
  self.clients = {
    matchAll: async () => [existingClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.deepEqual(calls, [
    "focus",
    ["postMessage", { type: "pi-web:open-session", url: "https://pi.test/?session=session-1", sessionId: "session-1" }],
  ]);
});

test("notification click ignores cross-origin windows and opens a fresh one", async () => {
  setScope("https://pi.test/");
  const opened = [];
  const foreignClient = {
    url: "https://other-host.example/?session=session-1",
    navigate: async () => assert.fail("cross-origin window must never be navigated"),
    focus: async () => assert.fail("cross-origin window must not be focused"),
    postMessage: async () => assert.fail("cross-origin window must not be messaged"),
  };
  self.clients = {
    matchAll: async () => [foreignClient],
    openWindow: async (url) => { opened.push(url); },
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.deepEqual(opened, ["https://pi.test/?session=session-1"]);
});

test("notification click opens a window and rejects cross-origin targets", async () => {
  setScope("https://pi.test/");
  const opened = [];
  self.clients = {
    matchAll: async () => [],
    openWindow: async (url) => { opened.push(url); },
  };

  const event = dispatchNotificationClick({ url: "https://example.com/redirect" });
  await event.pending;

  assert.deepEqual(opened, ["https://pi.test/"]);
});

test("notification click under a sub-path scope defaults to the scoped root", async () => {
  setScope("https://pi.test/dev/");
  const opened = [];
  self.clients = {
    matchAll: async () => [],
    openWindow: async (url) => { opened.push(url); },
  };

  const event = dispatchNotificationClick({ url: "https://example.com/redirect" });
  await event.pending;

  assert.deepEqual(opened, ["https://pi.test/dev/"]);
});

test("push always shows a notification, even when a window is visible", async () => {
  const event = dispatchPush(
    {
      title: "Session complete",
      body: "Task finished.",
      url: "/?session=session-1",
      tag: "pi-session-complete:session-1",
    },
    [
      { url: "https://pi.test/?session=other", visibilityState: "hidden" },
      { url: "https://pi.test/?session=session-1", visibilityState: "visible" },
    ],
  );
  await event.pending;

  // iOS revokes the push subscription when a push is handled without a
  // notification, so the notification must never be suppressed.
  assert.deepEqual(event.shown, [{
    title: "Session complete",
    options: {
      body: "Task finished.",
      data: { url: "/?session=session-1" },
      tag: "pi-session-complete:session-1",
      // #701: repeated completion notifications with the same tag need renotify to surface again
      renotify: true,
    },
  }]);
});

test("push ignores malformed payloads", async () => {
  const event = dispatchPush(
    { title: "", body: 42 },
    [],
  );
  await event.pending;

  assert.deepEqual(event.shown, []);
});

test("push caps session-complete notifications at three by closing the oldest", async () => {
  const event = dispatchPush(
    { title: "Session complete", body: "Task finished.", url: "/?session=new", tag: "pi-session-complete:new" },
    [],
    {
      existing: [
        { tag: "pi-session-complete", timestamp: 0 },
        { tag: "pi-session-complete:old-1", timestamp: 1 },
        { tag: "pi-session-complete:old-2", timestamp: 2 },
        { tag: "pi-extension-ui:ask-1", timestamp: 3 },
        { tag: "pi-session-complete:old-3", timestamp: 3 },
        { tag: "pi-session-complete:old-4", timestamp: 4 },
      ],
    },
  );
  await event.pending;

  // 5 existing completion-class notifications (including the session-less
  // fallback base name) + 1 new → only 2 old notifications remain, the oldest
  // 3 are closed; extension input prompts are neither counted nor closed.
  assert.deepEqual(event.closed, [
    "pi-session-complete",
    "pi-session-complete:old-1",
    "pi-session-complete:old-2",
  ]);
  assert.equal(event.shown.length, 1);
});

test("push replaces its own tag instead of counting it as a new notification", async () => {
  const event = dispatchPush(
    { title: "Session complete", body: "Task finished.", url: "/?session=a", tag: "pi-session-complete:a" },
    [],
    {
      existing: [
        { tag: "pi-session-complete:a", timestamp: 1 },
        { tag: "pi-session-complete:b", timestamp: 2 },
        { tag: "pi-session-complete:c", timestamp: 3 },
      ],
    },
  );
  await event.pending;

  // Same-tag replacement adds no new entry: the 3 existing ones stay within the cap, nothing to close.
  assert.deepEqual(event.closed, []);
  assert.equal(event.shown.length, 1);
});

test("service worker session-notification limit mirrors lib/browser-notifications.ts", async () => {
  const { readFile } = await import("node:fs/promises");
  // 从源文本正则提取常量而非 import 执行：上游重构后 browser-notifications.ts 的模块链上有
  // 无后缀相对 import（lib/extension-ui-queue），node strip-types 解析不了；镜像检查只需要常量字面量。
  const [libSource, source] = await Promise.all([
    readFile(new URL("../lib/browser-notifications.ts", import.meta.url), "utf8"),
    readFile(new URL("./sw.js", import.meta.url), "utf8"),
  ]);
  const prefix = libSource.match(/SESSION_NOTIFICATION_TAG_PREFIX = "([^"]+)"/)?.[1];
  const limit = libSource.match(/SESSION_NOTIFICATION_LIMIT = (\d+)/)?.[1];
  assert.ok(prefix, "lib must declare SESSION_NOTIFICATION_TAG_PREFIX");
  assert.ok(limit, "lib must declare SESSION_NOTIFICATION_LIMIT");
  assert.match(source, new RegExp(`const SESSION_NOTIFICATION_TAG_PREFIX = "${prefix}"`));
  assert.match(source, new RegExp(`const SESSION_NOTIFICATION_LIMIT = ${limit}\\b`));
});

// A reachable port backed by a dead upstream answers nothing at all, so these
// tests drive fetch() with a stub that only settles once the worker aborts it.

// 本地 basePath 测试可能把 scope 留在 /dev/ —— 上游套件假定 root scope。
// 顶层 setScope 在模块加载时就执行（太早，本地测试执行时又会改掉），
// 因此封装成 helper，由本区块首个测试在执行时恢复。
function restoreRootScope() {
  setScope("https://pi.test/");
}

function installOfflineStub() {
  const offline = new Response("<!doctype html><title>Pi Web is offline</title>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
  globalThis.caches = {
    match: async (request) => ((typeof request === "string" ? request : request.url).endsWith("/offline.html")
      ? offline
      : undefined),
    open: async () => ({ put: async () => {} }),
  };
}

function dispatchFetch(url, { mode = "cors", method = "GET" } = {}) {
  let pending;
  const background = [];
  const request = new Request(url, { method });
  Object.defineProperty(request, "mode", { value: mode });
  listeners.get("fetch")({
    request,
    respondWith: (promise) => { pending = promise; },
    waitUntil: (promise) => { background.push(promise); },
  });
  return { pending, background };
}

test("install precaches offline assets but not the runtime manifest", async () => {
  restoreRootScope();
  let pending;
  let precached;
  let skipped = false;
  globalThis.caches = {
    open: async () => ({ addAll: async (urls) => { precached = urls; } }),
  };
  self.skipWaiting = async () => { skipped = true; };
  listeners.get("install")({ waitUntil: (promise) => { pending = promise; } });
  await pending;

  assert.deepEqual(precached, [
    "/offline.html",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/apple-touch-icon.png",
  ]);
  assert.equal(skipped, true);
});

test("manifest requests bypass the worker even with query strings and old cached entries", async () => {
  const stale = new Response('{"name":"Old Pi"}');
  let cacheReads = 0;
  globalThis.caches = {
    match: async () => { cacheReads++; return stale.clone(); },
    open: async () => assert.fail("manifest must not be cached"),
  };
  const networkRequests = [];
  globalThis.fetch = async (request) => {
    networkRequests.push(request.url);
    return new Response('{"name":"New Pi"}');
  };

  for (const path of ["/manifest.webmanifest", "/manifest.webmanifest?v=old"]) {
    for (const mode of ["cors", "navigate"]) {
      const url = `https://pi.test${path}`;
      const { pending, background } = dispatchFetch(url, { mode });
      assert.equal(pending, undefined, "no respondWith: leave the request to the browser");
      assert.deepEqual(background, []);
      // Model the browser's normal network fallback when respondWith is absent.
      const response = await fetch(new Request(url));
      assert.deepEqual(await response.json(), { name: "New Pi" });
    }
  }
  assert.equal(cacheReads, 0, "old cached manifests must never be read");
  assert.equal(networkRequests.length, 4);
});

/** fetch() that never settles until the signal it was handed is aborted. */
function installHungNetwork() {
  let aborted = false;
  globalThis.fetch = (_request, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  return () => aborted;
}

/**
 * Let a handler's await chain reach its fetch (and schedule its timer) before
 * the fake clock is ticked. setImmediate is not faked, unlike setTimeout.
 */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("a stalled navigation falls back to offline.html", async () => {
  installOfflineStub();
  const wasAborted = installHungNetwork();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { pending } = dispatchFetch("https://pi.test/", { mode: "navigate" });
    await flushMicrotasks();
    mock.timers.tick(8000);
    const response = await pending;

    assert.equal(wasAborted(), true, "a hung upstream must be aborted, not awaited forever");
    assert.match(await response.text(), /Pi Web is offline/);
  } finally {
    mock.timers.reset();
  }
});

test("a stalled static asset request is bounded as well", async () => {
  installOfflineStub();
  const wasAborted = installHungNetwork();

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { pending } = dispatchFetch("https://pi.test/_next/static/chunks/app.js");
    // cacheFirst awaits the cache lookup before it reaches the network.
    await flushMicrotasks();
    mock.timers.tick(8000);

    assert.equal(wasAborted(), true);
    await assert.rejects(pending, /abort/i);
  } finally {
    mock.timers.reset();
  }
});

test("a cache miss responds before the cache write finishes", async () => {
  let releaseWrite;
  let writeStarted = false;
  globalThis.caches = {
    match: async () => undefined,
    open: async () => ({
      put: () => {
        writeStarted = true;
        return new Promise((resolve) => { releaseWrite = resolve; });
      },
    }),
  };
  // fetch() to a same-origin URL yields type "basic"; a constructed Response
  // defaults to "default", which cacheFirst deliberately skips.
  globalThis.fetch = async () => {
    const response = new Response("chunk", {
      status: 200,
      headers: { "Content-Type": "text/javascript" },
    });
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };

  const { pending, background } = dispatchFetch("https://pi.test/_next/static/chunks/app.js");
  const response = await pending;

  // The regression this guards: the SW script URL is versioned, so a version
  // bump leaves the cache cold and every chunk misses at once. Awaiting each
  // write held the responses behind Cache Storage I/O, which pushed
  // navigations past the offline-fallback budget even though the server was
  // healthy. The response must never wait for the write.
  assert.equal(await response.text(), "chunk");

  await flushMicrotasks();
  assert.equal(writeStarted, true, "the write must still happen");
  assert.equal(background.length, 1, "the write must be kept alive with waitUntil");

  releaseWrite();
  await background[0];
});

test("a response that arrives in time is not cut off mid-stream", async () => {
  installOfflineStub();
  let signal;
  globalThis.fetch = async (_request, init) => {
    signal = init.signal;
    return new Response("<!doctype html><title>Pi Web</title>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { pending } = dispatchFetch("https://pi.test/", { mode: "navigate" });
    const response = await pending;
    // The budget only covers time to first byte: a long-lived body keeps
    // streaming past it (Next.js streams its SSR payload).
    mock.timers.tick(60000);

    assert.equal(signal.aborted, false);
    assert.match(await response.text(), /<title>Pi Web<\/title>/);
  } finally {
    mock.timers.reset();
  }
});
