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

  // The in-page notification path handles the visible case (and plays the
  // completion sound). Only surface a system notification when no window for
  // this app is visible — e.g. a backgrounded iOS PWA.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      if (clients.some((client) => client.visibilityState === "visible")) return;
      return self.registration.showNotification(title, {
        body,
        data: { url: typeof url === "string" && url ? url : "/" },
        ...(typeof tag === "string" && tag ? { tag, renotify: true } : {}),
      });
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

  event.waitUntil(focusOrOpenWindow(targetUrl.href));
});

async function focusOrOpenWindow(targetUrl) {
  const windowClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const exactClient = windowClients.find((client) => client.url === targetUrl);
  const candidates = exactClient
    ? [exactClient, ...windowClients.filter((client) => client !== exactClient)]
    : windowClients;

  for (const client of candidates) {
    try {
      const targetClient = client.url === targetUrl
        ? client
        : (await client.navigate(targetUrl)) ?? client;
      await targetClient.focus();
      return;
    } catch {
      // The window may have closed between matchAll and focus; try the next one.
    }
  }

  await self.clients.openWindow(targetUrl);
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
