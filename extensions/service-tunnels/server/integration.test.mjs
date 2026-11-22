import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeExposeConfig } from "./integration.ts";

test("sanitizeExposeConfig masks library-declared password params", () => {
  const cfg = {
    mode: "both",
    auth: "portal",
    tunnelParams: { token: "ngrok-token-1234" },
    providerParams: { oidc: { clientSecret: "oidc-secret-5678" } },
  };
  const out = sanitizeExposeConfig(cfg);
  assert.equal(out.mode, "both");
  assert.equal(out.auth, "portal");
  // ParamSpec type:"password" keys (ngrok.token / oauth2-proxy oidc.clientSecret)
  assert.match(out.tunnelParams.token, /^••••/);
  assert.match(out.providerParams.oidc.clientSecret, /^••••/);
  assert.equal(out.tunnelParams.token.slice(-4), "1234");
});

test("sanitizeExposeConfig masks user.password and ngrokAuthtoken (env-expose path)", () => {
  const cfg = {
    user: { name: "admin", password: "pw-secret-99" },
    ngrokAuthtoken: "2abcDEF123",
  };
  const out = sanitizeExposeConfig(cfg);
  assert.equal(out.user.name, "admin");
  assert.match(out.user.password, /^••••/);
  assert.match(out.ngrokAuthtoken, /^••••/);
  assert.equal(out.ngrokAuthtoken.slice(-4), "F123");
});

test("sanitizeExposeConfig leaves non-secret keys verbatim", () => {
  const cfg = {
    mode: "proxy",
    tunnel: "cloudflared",
    protocol: "http",
    allowToolDownload: true,
    allowHost: ["web.example.com"],
    tunnelParams: { server: "frp.example.com:7000", domain: "app.example.com", remotePort: 7000 },
  };
  const out = sanitizeExposeConfig(cfg);
  assert.deepEqual(out, cfg);
});

test("sanitizeExposeConfig null passthrough and no mutation of the source", () => {
  assert.equal(sanitizeExposeConfig(null), null);
  const cfg = { user: { password: "secret" } };
  const out = sanitizeExposeConfig(cfg);
  assert.equal(cfg.user.password, "secret", "source object must not be mutated");
  assert.match(out.user.password, /^••••/);
});

test("sanitizeExposeConfig masks short and non-string secret values", () => {
  const out = sanitizeExposeConfig({ user: { password: "ab" }, tunnelParams: { token: 12345 } });
  assert.equal(out.user.password, "••••");
  assert.equal(out.tunnelParams.token, "••••");
});
