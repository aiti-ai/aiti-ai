import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { createWebSessionToken } = await jiti.import("./web-auth.ts");
const { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } = await import("./auth-throttle.ts");

before(() => { process.env.PI_WEB_PASSWORD = "secret"; });
beforeEach(() => { recordAuthSuccess(); });
after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Host: "localhost", ...headers },
  });
}

test("redirects page navigation to the login page and preserves its query", async () => {
  const response = await proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login?next=%2F%3Fsession%3Dabc");
});

test("accepts a signed session for pages", async () => {
  const token = createWebSessionToken("secret");
  const response = await proxy(request("/", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("keeps Basic Auth compatibility for APIs but not pages", async () => {
  const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
  assert.equal((await proxy(request("/api/sessions", { Authorization: authorization }))).status, 200);
  assert.equal((await proxy(request("/", { Authorization: authorization }))).status, 307);
  assert.equal((await proxy(request("/api/sessions"))).status, 401);
});

test("leaves the login endpoint reachable without a session", async () => {
  assert.equal((await proxy(request("/login"))).status, 200);
  assert.equal((await proxy(request("/api/web-auth"))).status, 200);
});

function basic(password) {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

test("a wrong Basic password blocks further attempts, even with the right password", async () => {
  assert.equal((await proxy(request("/api/sessions", { Authorization: basic("guess") }))).status, 401);
  assert.ok(getAuthRetryAfterMs() > 0);

  for (const path of ["/api/sessions", "/api/web-auth"]) {
    const response = await proxy(request(path, { Authorization: basic("secret") }));
    assert.equal(response.status, 429, path);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("GET /api/web-auth cannot be used to check Basic passwords without the throttle", async () => {
  assert.equal((await proxy(request("/api/web-auth", { Authorization: basic("guess") }))).status, 200);
  assert.ok(getAuthRetryAfterMs() > 0);
  assert.equal((await proxy(request("/api/web-auth", { Authorization: basic("guess-2") }))).status, 429);
});

test("a signed session keeps working while Basic attempts are blocked", async () => {
  await proxy(request("/api/sessions", { Authorization: basic("guess") }));
  const token = createWebSessionToken("secret");
  const response = await proxy(request("/api/sessions", {
    Authorization: basic("guess"),
    Cookie: `pi_web_session=${token}`,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("only Basic credentials count as password attempts", async () => {
  assert.equal((await proxy(request("/api/sessions", { Authorization: "Bearer token" }))).status, 401);
  assert.equal(getAuthRetryAfterMs(), 0);
});

test("a Basic success does not reset earlier failures", async () => {
  recordAuthFailure(Date.now() - 2_000);
  assert.equal(getAuthRetryAfterMs(), 0);
  assert.equal((await proxy(request("/api/sessions", { Authorization: basic("secret") }))).status, 200);

  assert.equal((await proxy(request("/api/sessions", { Authorization: basic("guess") }))).status, 401);
  // The second failure in a row doubles the block instead of starting over.
  assert.ok(getAuthRetryAfterMs() > 1_000);
});
