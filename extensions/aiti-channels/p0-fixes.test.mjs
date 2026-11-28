/**
 * aiti-channels · P0 fix unit tests (pure functions only).
 *
 * Pins (plan v3 §8.6):
 *   1. deriveAdminUrl matrix: explicit adminOrigin wins; same-port subdomain
 *      swap; IP/localhost/IPv6/garbage → "" (never a fabricated domain);
 *      trailing-slash normalization on adminOrigin; token passthrough.
 *   2. buildDeepLink: ?session= attach / replace / drop (empty id); existing
 *      query preserved; non-URL input returned as-is.
 *
 * Run: node --test extensions/aiti-channels/p0-fixes.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { deriveAdminUrl } = await import("./lib/admin-url.ts");
const { buildDeepLink } = await import("./lib/deep-link.ts");

test("deriveAdminUrl: explicit adminOrigin wins over derivation", () => {
  const cfg = { management: { token: "tok" } };
  assert.equal(deriveAdminUrl(cfg, "https://pi.example.com:57442", "https://admin.example.com:9/"), "https://admin.example.com:9/?token=tok");
  assert.equal(deriveAdminUrl(cfg, null, "https://admin.example.com"), "https://admin.example.com/?token=tok");
});

test("deriveAdminUrl: same-port subdomain swap carries scheme+port+token", () => {
  const cfg = { management: { token: "abc" } };
  // neutral doc domain (portal.example.com → cc.portal.example.com) — keep the
  // input/expected pair self-consistent, independent of any real deployment host
  assert.equal(deriveAdminUrl(cfg, "https://portal.example.com:57442"), "https://cc.portal.example.com:57442/?token=abc");
  assert.equal(deriveAdminUrl({ management: { token: "" } }, "http://portal.example.com"), "http://cc.portal.example.com/");
});

test("deriveAdminUrl: loopback/IP/IPv6/garbage → empty (no fabricated domain)", () => {
  assert.equal(deriveAdminUrl({ management: { token: "t" } }, "http://127.0.0.1:30142"), "");
  assert.equal(deriveAdminUrl({ management: { token: "t" } }, "https://localhost:57442"), "");
  assert.equal(deriveAdminUrl({ management: { token: "t" } }, "https://192.0.2.48:57442"), "");
  assert.equal(deriveAdminUrl({ management: { token: "t" } }, "https://[::1]:57442"), "");
  assert.equal(deriveAdminUrl({ management: { token: "t" } }, "not a url"), "");
  assert.equal(deriveAdminUrl({ management: { token: "t" } }, null), "");
});

test("buildDeepLink: session attach/replace/drop + query preservation", () => {
  const base = "https://pi.example.com:57442/dev/";
  assert.equal(buildDeepLink(base, "s-123"), "https://pi.example.com:57442/dev/?session=s-123");
  assert.equal(buildDeepLink(base + "?foo=bar", "s-1"), "https://pi.example.com:57442/dev/?foo=bar&session=s-1");
  assert.equal(buildDeepLink(base + "?session=old", "s-2"), "https://pi.example.com:57442/dev/?session=s-2");
  assert.equal(buildDeepLink(base + "?session=old", ""), "https://pi.example.com:57442/dev/");
  assert.equal(buildDeepLink("not a url", "s"), "not a url");
});
