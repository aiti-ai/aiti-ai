// Service worker for pi-web.
//
// Scope-aware: when the app is served under a sub-path (Next.js basePath),
// this worker is registered at e.g. /dev/sw.js and its scope is /dev/.
// All URL paths below are derived from self.registration.scope so the same
// worker works for both root and sub-path deployments.

const CACHE_PREFIX = "pi-web";
const CACHE_VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const STATIC_CACHE = `${CACHE_PREFIX}-static-${CACHE_VERSION}`;

// self.registration.scope is a full URL (e.g. "https://host/dev/"). Derive
// the pathname form (e.g. "/dev/") for pathname comparisons and the scope-
// relative absolute paths for cache keys. Root deployments get "/". Scope is
// read lazily (per event) so the worker stays correct even if it is moved or
// re-registered under a different prefix without a cache reset.
function getScopePath() {
  return new URL(self.registration.scope).pathname.replace(/\/+$/, "") + "/";
}

function getOfflineUrl() {
  return `${getScopePath()}offline.html`;
}

function getPrecacheUrls() {
  const scopePath = getScopePath();
  return [
    getOfflineUrl(),
    `${scopePath}manifest.webmanifest`,
    `${scopePath}icons/icon-192.png`,
    `${scopePath}icons/icon-512.png`,
    `${scopePath}icons/apple-touch-icon.png`,
  ];
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(getPrecacheUrls()))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(`${CACHE_PREFIX}-`) && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Session data and live agent traffic must always come from the local server.
  const scopePath = getScopePath();
  if (url.pathname.startsWith(`${scopePath}api/`) || url.pathname === `${scopePath}sw.js`) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const fallback = await caches.match(getOfflineUrl());
        return fallback ?? Response.error();
      }),
    );
    return;
  }

  const isStaticAsset =
    url.pathname.startsWith(`${getScopePath()}_next/static/`) ||
    getPrecacheUrls().includes(url.pathname);

  if (isStaticAsset) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Ignore malformed or missing push payloads.
  }
  const { title, body, url, tag } = payload;
  if (typeof title !== "string" || !title || typeof body !== "string" || !body) return;

  // Always surface a system notification. iOS revokes the push subscription
  // when a service worker handles a push without showing a notification, so
  // suppressing the notification while a window is visible poisons the
  // subscription in the background-delivery case. Notifications sharing a tag
  // replace each other instead of stacking, so a visible window merely sees
  // the completion notification re-appear.
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url: typeof url === "string" && url ? url : "/" },
      ...(typeof tag === "string" && tag ? { tag, renotify: true } : {}),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const requestedUrl = typeof event.notification.data?.url === "string"
    ? event.notification.data.url
    : getScopePath();
  let targetUrl = new URL(getScopePath(), self.location.origin);
  try {
    const candidate = new URL(requestedUrl, self.location.origin);
    if (candidate.origin === self.location.origin) targetUrl = candidate;
  } catch {
    // Keep the root URL when notification data is malformed.
  }

  event.waitUntil(focusOrOpenWindow(targetUrl));
});

// 归一同源 URL 用于「窗口是否已位于目标地址」判断（忽略结尾斜杠差异）。
function normalizeUrlForMatch(href) {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}${u.hash}`;
  } catch {
    return href;
  }
}

// 点击通知后把用户带到目标会话。规则：
// 1) 已有同源 pi-web 窗口 → 只 focus，绝不整页 navigate（client.navigate 等于地址栏
//    回车，会把正在看别的会话/实例的窗口硬刷新掉，丢失全部状态）。目标会话经
//    postMessage 交给页面走 SPA 内切换（pi-web:open-session 通道，零刷新），
//    URL 由页面自行 router.replace 同步。
// 2) 没有任何同源窗口 → 开新窗口。
async function focusOrOpenWindow(targetUrl) {
  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  // 只考虑同源窗口：跨实例（/dev /win /mac 等不同 host:port）窗口绝不触碰。
  const sameOrigin = windowClients.filter((client) => {
    try {
      return new URL(client.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  // 已精确位于目标地址的窗口优先（其余情况同样只 focus + 广播会话切换，行为一致）。
  const exactClient = sameOrigin.find(
    (client) => normalizeUrlForMatch(client.url) === normalizeUrlForMatch(targetUrl.href),
  );
  const candidates = exactClient
    ? [exactClient, ...sameOrigin.filter((client) => client !== exactClient)]
    : sameOrigin;

  for (const client of candidates) {
    try {
      await client.focus();
      // 不 navigate：把会话切换意图交给页面（SPA 内 router.replace，零刷新）。
      // 页面端监听 navigator.serviceWorker message 后转发 pi-web:open-session。
      client.postMessage({
        type: "pi-web:open-session",
        url: targetUrl.href,
        sessionId: targetUrl.searchParams.get("session"),
      });
      return;
    } catch {
      // The window may have closed between matchAll and focus; try the next one.
    }
  }

  await self.clients.openWindow(targetUrl.href);
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}
