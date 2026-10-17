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

// Offline assets only — the manifest is runtime configuration (PI_WEB_APP_NAME)
// and must not be precached or served stale (see the fetch handler's bypass).
function getPrecacheUrls() {
  const scopePath = getScopePath();
  return [
    getOfflineUrl(),
    `${scopePath}icons/icon-192.png`,
    `${scopePath}icons/icon-512.png`,
    `${scopePath}icons/apple-touch-icon.png`,
  ];
}

// A reachable port backed by a dead upstream accepts the connection and then
// never answers: fetch() neither resolves nor rejects, so the navigation hangs
// forever instead of falling back to offline.html. Bound every network wait.
const NAVIGATION_TIMEOUT_MS = 8000;
const ASSET_TIMEOUT_MS = 8000;

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

  // The manifest is runtime configuration. Bypass even entries left in an old
  // cache, including requests with a query string or navigation mode.
  if (url.pathname === `${scopePath}manifest.webmanifest`) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS).catch(async () => {
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
    event.respondWith(cacheFirst(request, event));
  }
});

// Session-completion notification cap: at most SESSION_NOTIFICATION_LIMIT on screen at a time;
// when exceeded, a new notification replaces the oldest one.
// Mirrors the same-named constant/algorithm in lib/browser-notifications.ts (same cleanup as the
// in-page notification path).
const SESSION_NOTIFICATION_TAG_PREFIX = "pi-session-complete";
const SESSION_NOTIFICATION_LIMIT = 3;

// Whether a tag belongs to the session-completion notification pool (the base name itself,
// or base:<sessionId>).
function isSessionNotificationTag(tag) {
  return typeof tag === "string"
    && (tag === SESSION_NOTIFICATION_TAG_PREFIX || tag.startsWith(`${SESSION_NOTIFICATION_TAG_PREFIX}:`));
}

// Compute which older session-completion notifications to close before showing incomingTag so
// the count stays within limit afterwards.
// - incomingTag already open (a repeat notification for the same session is replaced by the
//   browser rather than added) → compact back down to limit;
// - incomingTag not open (adds a new one) → keep at most limit - 1 older notifications;
// - Close oldest first (missing timestamp counts as oldest; stable sort preserves input order).
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

// Show after closing overflow session-completion notifications (best-effort: never block
// showing if enumeration is unavailable or fails).
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

// Push events may arrive concurrently (several sessions finishing at once) — display serially
// so cleanup decisions don't race each other.
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

// Normalize a same-origin URL for "is the window already at the target address" checks
// (ignores trailing-slash differences).
function normalizeUrlForMatch(href) {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}${u.hash}`;
  } catch {
    return href;
  }
}

// Bring the user to the target session after a notification click. Rules:
// 1) An existing same-origin pi-web window → focus it only, never do a full navigation
//    (client.navigate is the equivalent of hitting Enter in the address bar: it hard-refreshes
//    a window that is viewing another session/instance and loses all its state). The target
//    session is handed to the page via postMessage for in-SPA switching (pi-web:open-session
//    channel, zero reload); the page syncs the URL itself via router.replace.
// 2) No same-origin window at all → open a new window.
async function focusOrOpenWindow(targetUrl) {
  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  // Only consider same-origin windows: never touch windows of other instances
  // (/dev, /win, /mac, etc. — different host:port).
  const sameOrigin = windowClients.filter((client) => {
    try {
      return new URL(client.url).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  // Prefer a window already exactly at the target address (other cases behave the same:
  // focus + broadcast session switch).
  const exactClient = sameOrigin.find(
    (client) => normalizeUrlForMatch(client.url) === normalizeUrlForMatch(targetUrl.href),
  );
  const candidates = exactClient
    ? [exactClient, ...sameOrigin.filter((client) => client !== exactClient)]
    : sameOrigin;

  for (const client of candidates) {
    try {
      await client.focus();
      // No navigation: hand the session-switch intent to the page (in-SPA router.replace,
      // zero reload). The page listens for navigator.serviceWorker messages and forwards
      // pi-web:open-session.
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

/**
 * Fetch with a ceiling on the wait for the response headers (time to first
 * byte). The timer is cleared as soon as they arrive, so a response that
 * streams a long body — Next.js streams SSR output — is never cut off
 * mid-stream.
 */
async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(request, event) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetchWithTimeout(request, ASSET_TIMEOUT_MS);
  if (response.ok && response.type === "basic") {
    // Deliberately NOT awaited before returning the response.
    //
    // The SW script URL is versioned (?v=<app version>), so every upgrade
    // starts a fresh cache: the first load after an upgrade misses on every
    // chunk and writes them all at once. Awaiting each write here held every
    // response behind Cache Storage I/O, which stalled navigations past
    // NAVIGATION_TIMEOUT_MS — the browser showed the offline page while the
    // local server was perfectly healthy. waitUntil keeps this worker alive
    // until the write finishes without blocking the response.
    const copy = response.clone();
    event.waitUntil(
      caches
        .open(STATIC_CACHE)
        .then((cache) => cache.put(request, copy))
        .catch(() => {
          // A failed write only costs one network re-fetch next time.
        }),
    );
  }
  return response;
}
