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

// 完成类通知限流：同屏最多 SESSION_NOTIFICATION_LIMIT 条，超出时新通知替换最旧的。
// 与 lib/browser-notifications.ts 的同名常量/算法保持一致（页面通知链路同款清理）。
const SESSION_NOTIFICATION_TAG_PREFIX = "pi-session-complete";
const SESSION_NOTIFICATION_LIMIT = 3;

// 判定 tag 是否属于完成类通知池（基名本身，或基名:<sessionId>）。
function isSessionNotificationTag(tag) {
  return typeof tag === "string"
    && (tag === SESSION_NOTIFICATION_TAG_PREFIX || tag.startsWith(`${SESSION_NOTIFICATION_TAG_PREFIX}:`));
}

// 计算显示 incomingTag 之前应关闭的旧完成类通知，使显示后不超过 limit 条。
// - incomingTag 已存在（同一会话重复通知会被浏览器替换而非新增）→ 压回 limit；
// - incomingTag 不存在（新增一条）→ 旧通知最多保留 limit - 1 条；
// - 最旧优先关闭（无时间戳视为最旧，稳定排序保持原顺序）。
function sessionNotificationsToClose(existing, incomingTag) {
  const limit = SESSION_NOTIFICATION_LIMIT;
  if (!isSessionNotificationTag(incomingTag)) return [];
  const open = existing
    .filter((n) => isSessionNotificationTag(n.tag))
    .slice()
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const replacesExisting = open.some((n) => n.tag === incomingTag);
  const keep = Math.max(0, replacesExisting ? limit : limit - 1);
  const overflow = open.length - keep;
  return overflow > 0 ? open.slice(0, overflow) : [];
}

// 关闭溢出的完成类通知后展示（best-effort：枚举不可用/失败时不阻塞展示）。
async function showNotificationWithSessionLimit(title, options) {
  const tag = options.tag;
  if (isSessionNotificationTag(tag)) {
    try {
      const open = await self.registration.getNotifications();
      for (const stale of sessionNotificationsToClose(open, tag)) {
        try {
          stale.close();
        } catch (closeError) {
          void closeError;
        }
      }
    } catch (listError) {
      void listError;
    }
  }
  await self.registration.showNotification(title, options);
}

// push 事件可能并发到达（多会话同时完成）——串行展示，避免清理判断相互竞争。
let pushDisplayQueue = Promise.resolve();

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
  // replace each other instead of stacking, and multi-session completions are
  // capped by showNotificationWithSessionLimit (newest replaces the oldest).
  pushDisplayQueue = pushDisplayQueue
    .catch(() => {})
    .then(() => showNotificationWithSessionLimit(title, {
      body,
      data: { url: typeof url === "string" && url ? url : "/" },
      ...(typeof tag === "string" && tag ? { tag, renotify: true } : {}),
    }));
  event.waitUntil(pushDisplayQueue.catch(() => {}));
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
