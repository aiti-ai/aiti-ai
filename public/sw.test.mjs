import assert from "node:assert/strict";
import test from "node:test";

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

function dispatchFetch(url, { method = "GET", mode = "no-cors" } = {}) {
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

test("root scope: API and sw.js requests bypass the cache", async () => {
  setScope("https://pi.test/");
  await installFetchHarness();

  assert.equal(dispatchFetch("https://pi.test/api/sessions").responded, false);
  assert.equal(dispatchFetch("https://pi.test/api/agent/s1/events").responded, false);
  assert.equal(dispatchFetch("https://pi.test/sw.js?v=test").responded, false);
});

test("root scope: static assets are served cache-first", async () => {
  setScope("https://pi.test/");
  await installFetchHarness();

  const staticHit = dispatchFetch("https://pi.test/_next/static/chunks/app.js");
  assert.equal(staticHit.responded, true);
  await staticHit.responsePromise;
  assert.equal(dispatchFetch("https://pi.test/icons/icon-192.png").responded, true);
  assert.equal(dispatchFetch("https://pi.test/manifest.webmanifest").responded, true);
});

test("root scope: navigations fall back to the offline page", async () => {
  setScope("https://pi.test/");
  await installFetchHarness();

  const nav = dispatchFetch("https://pi.test/?session=abc", { mode: "navigate" });
  assert.equal(nav.responded, true);
  await nav.responsePromise;
});

test("sub-path scope (/dev): API requests under the scope bypass the cache", async () => {
  setScope("https://pi.test/dev/");
  await installFetchHarness();

  assert.equal(dispatchFetch("https://pi.test/dev/api/sessions").responded, false);
  assert.equal(dispatchFetch("https://pi.test/dev/api/sessions/s1/context?leafId=x").responded, false);
  assert.equal(dispatchFetch("https://pi.test/dev/sw.js?v=test").responded, false);
  // Requests outside the scope are left alone, including root-level APIs.
  assert.equal(dispatchFetch("https://pi.test/api/sessions").responded, false);
  assert.equal(dispatchFetch("https://pi.test/_next/static/chunks/app.js").responded, false);
});

test("sub-path scope (/dev): static assets under the scope are served cache-first", async () => {
  setScope("https://pi.test/dev/");
  await installFetchHarness();

  const staticHit = dispatchFetch("https://pi.test/dev/_next/static/chunks/app.js");
  assert.equal(staticHit.responded, true);
  await staticHit.responsePromise;
  assert.equal(dispatchFetch("https://pi.test/dev/icons/icon-192.png").responded, true);
  assert.equal(dispatchFetch("https://pi.test/dev/manifest.webmanifest").responded, true);
  assert.equal(dispatchFetch("https://pi.test/dev/offline.html").responded, true);
});

test("sub-path scope (/dev): navigations fall back to the scoped offline page", async () => {
  setScope("https://pi.test/dev/");
  await installFetchHarness();

  const nav = dispatchFetch("https://pi.test/dev/?session=abc", { mode: "navigate" });
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
  };
  self.clients = {
    matchAll: async () => [focusedClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.equal(event.wasClosed(), true);
  assert.deepEqual(calls, ["focus"]);
});

test("notification click navigates an existing client to the session", async () => {
  setScope("https://pi.test/");
  const calls = [];
  const navigatedClient = {
    focus: async () => { calls.push("focus"); },
  };
  const existingClient = {
    url: "https://pi.test/?session=other-session",
    navigate: async (url) => {
      calls.push(["navigate", url]);
      return navigatedClient;
    },
    focus: async () => assert.fail("the navigated client should be focused"),
  };
  self.clients = {
    matchAll: async () => [existingClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.deepEqual(calls, [
    ["navigate", "https://pi.test/?session=session-1"],
    "focus",
  ]);
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
