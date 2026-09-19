import assert from "node:assert/strict";
import test from "node:test";

// Tests must be hermetic regardless of the deployment machine's environment:
// the systemd unit exports API_ALLOW_ORIGINS (e.g. "*" for the aiti-devtools
// bridge), which intentionally allows cross-site origins. The origin-gate
// tests below assert the *default* rejection behavior, so neutralize the
// deployment override for the whole file (restored per-test where used).
delete process.env.API_ALLOW_ORIGINS;

async function loadSubject() {
  return import("./request-security.ts");
}


test("allows same-origin and non-browser API requests", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  })), true);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: { host: "localhost:30141" },
  })), true);
});

test("allows LAN same-origin requests when Next.js uses an internal localhost URL", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://192.168.32.7:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), true);
});

test("allows IPv6 and an explicitly configured hostname", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const ipv6 = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "[::1]:30141",
      origin: "http://[::1]:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  const configured = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "pi-web.internal:30141",
      origin: "http://pi-web.internal:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(ipv6), true);
  assert.equal(isApiRequestAllowed(configured, ["pi-web.internal"]), true);
});

test("rejects cross-origin browser API requests", async () => {
  const { isApiRequestAllowed, shouldCheckApiRequestOrigin } = await loadSubject();
  const post = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
  });
  const crossSiteGet = new Request("http://localhost:30141/api/sessions", {
    headers: { host: "localhost:30141", "sec-fetch-site": "cross-site" },
  });
  assert.equal(shouldCheckApiRequestOrigin(post), true);
  assert.equal(isApiRequestAllowed(post), false);
  assert.equal(shouldCheckApiRequestOrigin(crossSiteGet), true);
  assert.equal(isApiRequestAllowed(crossSiteGet), false);
});

test("does not globally trust opaque iframe or alternate loopback origins", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const previewUrl = "http://localhost:30141/api/files/tmp/test.docx?type=preview";
  const opaqueIframe = new Request(previewUrl, {
    headers: {
      host: "localhost:30141",
      origin: "null",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "iframe",
    },
  });
  const alternateLoopback = new Request(previewUrl, {
    headers: {
      host: "localhost:30141",
      origin: "http://127.0.0.1:30141",
      "sec-fetch-site": "cross-site",
    },
  });

  assert.equal(isApiRequestAllowed(opaqueIframe), false);
  assert.equal(isApiRequestAllowed(alternateLoopback), false);
});

test("allows only user-initiated session export document navigations from a PWA", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const navigationHeaders = {
    host: "127.0.0.1:30141",
    "sec-fetch-site": "cross-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "sec-fetch-user": "?1",
  };

  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: navigationHeaders },
  )), true);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions",
    { headers: navigationHeaders },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: { ...navigationHeaders, "sec-fetch-dest": "empty" } },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    {
      headers: {
        ...navigationHeaders,
        "sec-fetch-user": "",
      },
    },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { method: "POST", headers: navigationHeaders },
  )), false);
  assert.equal(isApiRequestAllowed(new Request(
    "http://127.0.0.1:30141/api/sessions/session-id/export?inline=1",
    { headers: { ...navigationHeaders, host: "attacker.example:30141" } },
  )), false);
});

test("allows operator-configured host forwarded via X-Forwarded-Host (nginx deployment)", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://127.0.0.1:3000/api/agent/new", {
    method: "POST",
    headers: {
      host: "web.example.com:8443",
      "x-forwarded-host": "web.example.com:8443",
      "x-forwarded-proto": "https",
      origin: "https://web.example.com:8443",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  // PI_WEB_ALLOWED_HOSTS is operator-trusted; XFH must be trusted too, otherwise
  // every same-origin API call behind nginx (which forwards X-Forwarded-Host)
  // gets rejected while the page itself (host gate only) still loads.
  assert.equal(isApiRequestAllowed(request, ["web.example.com", "backup.example.com"]), true);
});

test("rejects forged X-Forwarded-Host that only matches a configured host, not the Origin", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const forged = new Request("http://127.0.0.1:3000/api/agent/new", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "web.example.com:8443",
      "x-forwarded-proto": "https",
      origin: "https://attacker.example",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestAllowed(forged, ["web.example.com"]), false);
});

test("rejects X-Forwarded-Host that is not operator-configured", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const untrusted = new Request("http://127.0.0.1:3000/api/agent/new", {
    method: "POST",
    headers: {
      host: "127.0.0.1:3000",
      "x-forwarded-host": "evil.example:443",
      "x-forwarded-proto": "https",
      origin: "https://evil.example",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(untrusted, ["web.example.com"]), false);
});

test("rejects an origin that does not match the external request host", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "192.168.32.7:30141",
      origin: "http://attacker.example",
      "sec-fetch-site": "same-site",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects DNS rebinding even when browser headers say same-origin", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("http://localhost:30141/api/skills/install", {
    method: "POST",
    headers: {
      host: "attacker.example:30141",
      origin: "http://attacker.example:30141",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);
});

test("rejects missing, malformed, and unconfigured Host headers", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test")), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "localhost@attacker.example:30141" },
  })), false);
  assert.equal(isApiRequestAllowed(new Request("http://localhost:30141/api/test", {
    headers: { host: "pi-web.internal:30141" },
  })), false);
});

test("recognizes JSON request content types", async () => {
  const { hasJsonContentType } = await loadSubject();
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/json; charset=utf-8" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "application/problem+json" },
  })), true);
  assert.equal(hasJsonContentType(new Request("http://localhost", {
    headers: { "content-type": "text/plain" },
  })), false);
});

test("API_ALLOW_ORIGINS explicitly allow-lists cross-site origins", async (t) => {
  const { isApiRequestAllowed } = await loadSubject();
  // Configured for the aiti-devtools bridge (injected pages on service
  // vhosts call the bridge API cross-origin). Explicit operator config
  // overrides the cross-site rejection — see b574439.
  const previous = process.env.API_ALLOW_ORIGINS;
  t.after(() => {
    if (previous === undefined) delete process.env.API_ALLOW_ORIGINS;
    else process.env.API_ALLOW_ORIGINS = previous;
  });

  const crossSite = (origin) => new Request("http://localhost:30141/api/agent/bridge", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin,
      "sec-fetch-site": "cross-site",
    },
  });

  // Exact/prefix scheme://host matching — the configured origin passes,
  // anything else still rejected.
  process.env.API_ALLOW_ORIGINS = "https://8084-pi-web.example.com:8443";
  assert.equal(
    isApiRequestAllowed(crossSite("https://8084-pi-web.example.com:8443")),
    true,
  );
  assert.equal(
    isApiRequestAllowed(crossSite("https://attacker.example")),
    false,
  );

  // Wildcard allows every origin (deployment choice, fully open bridge).
  process.env.API_ALLOW_ORIGINS = "*";
  assert.equal(
    isApiRequestAllowed(crossSite("https://attacker.example")),
    true,
  );

  // Non-matching entries change nothing.
  process.env.API_ALLOW_ORIGINS = "https://other.example.com";
  assert.equal(
    isApiRequestAllowed(crossSite("https://attacker.example")),
    false,
  );
});
test("allows a proxy that reports the scheme out-of-band and rewrites Origin", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  // Azure Dev Tunnels normalizes Host and Origin onto the backend authority
  // but keeps the external scheme in x-forwarded-proto.
  const request = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), true);
});

test("still rejects a foreign origin when a proxy is in front", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const foreignHost = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://attacker.example",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });
  const foreignPort = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30199",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });
  const alternateLoopback = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://127.0.0.1:30141",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });
  const opaque = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "null",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-site",
    },
  });

  assert.equal(isApiRequestAllowed(foreignHost), false);
  assert.equal(isApiRequestAllowed(foreignPort), false);
  assert.equal(isApiRequestAllowed(alternateLoopback), false);
  assert.equal(isApiRequestAllowed(opaque), false);
});

test("does not relax the scheme without same-origin proxy evidence", async () => {
  const { isApiRequestAllowed } = await loadSubject();
  const request = new Request("https://localhost:30141/api/test", {
    method: "POST",
    headers: {
      host: "localhost:30141",
      origin: "http://localhost:30141",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(isApiRequestAllowed(request), false);

  request.headers.set("x-forwarded-proto", "https");
  request.headers.set("sec-fetch-site", "same-site");
  assert.equal(isApiRequestAllowed(request), false);
});
