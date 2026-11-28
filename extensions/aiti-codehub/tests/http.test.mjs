import test from "node:test";
import assert from "node:assert/strict";
import { createHttp, ForgeHttpError, intHeader, parseLinkNext, sanitizeErrorText } from "../server/http.ts";

function mockFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { impl, calls };
}

const jsonRes = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("builds relative URLs, query params and JSON bodies", async () => {
  const { impl, calls } = mockFetch(() => jsonRes({ ok: true }));
  const http = createHttp("https://api.example.com/v1", { fetchImpl: impl, headers: { "x-test": "1" } });
  const res = await http.req("/items", { method: "POST", query: { a: 1, b: undefined, c: "x" }, body: { x: 1 } });
  assert.equal(res.status, 200);
  assert.equal(calls[0].url, "https://api.example.com/v1/items?a=1&c=x");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-test"], "1");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.body, '{"x":1}');
});

test("rejects absolute URLs outside the provider origin", async () => {
  const { impl } = mockFetch(() => jsonRes({}));
  const http = createHttp("https://api.example.com", { fetchImpl: impl });
  await assert.rejects(() => http.req("https://evil.example/x"), (e) => e instanceof ForgeHttpError && e.code === "bad_request");
  const ok = await http.req("https://api.example.com/x");
  assert.equal(ok.status, 200);
});

test("maps status codes and sanitizes error text", async () => {
  const cases = [
    [401, "auth", { errorMessage: "bad token oat-abcdefgh12345678" }],
    [403, "forbidden", { message: "no access" }],
    [404, "not_found", { error: "missing" }],
    [429, "rate_limited", { message: "slow down" }],
    [500, "server", { message: "boom" }],
  ];
  for (const [status, code, body] of cases) {
    const { impl } = mockFetch(() => jsonRes(body, status));
    const http = createHttp("https://api.example.com", { fetchImpl: impl });
    await assert.rejects(() => http.req("/x"), (e) => {
      assert.ok(e instanceof ForgeHttpError);
      assert.equal(e.code, code);
      assert.equal(e.status, status);
      assert.ok(!String(e.message).includes("oat-abcdefgh12345678"));
      return true;
    });
  }
});

test("rate-limit retryAt from headers", async () => {
  const reset = Math.floor(Date.now() / 1000) + 60;
  const { impl } = mockFetch(() => jsonRes({ message: "limit" }, 403, { "x-ratelimit-reset": String(reset) }));
  const http = createHttp("https://api.example.com", { fetchImpl: impl });
  await assert.rejects(() => http.req("/x"), (e) => {
    assert.equal(e.code, "forbidden");
    assert.ok(e.retryAt && e.retryAt > Date.now());
    return true;
  });
});

test("network errors are wrapped", async () => {
  const http = createHttp("https://api.example.com", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(() => http.req("/x"), (e) => e.code === "network" && /ECONNREFUSED/.test(e.message));
});

test("sanitizeErrorText removes known token shapes", () => {
  const s = sanitizeErrorText("token oat-abcDEF1234567890 ghp_abcdefghijklmnop access_token=secret123 Authorization: Bearer xyz");
  assert.ok(!s.includes("oat-abcDEF1234567890"));
  assert.ok(!s.includes("ghp_abcdefghijklmnop"));
  assert.ok(!s.includes("secret123"));
  assert.ok(!s.includes("Bearer xyz"));
});

test("pagination helpers", () => {
  const link = '<https://api.example.com/items?page=2>; rel="next", <https://api.example.com/items?page=9>; rel="last"';
  assert.equal(parseLinkNext(link), "https://api.example.com/items?page=2");
  assert.equal(parseLinkNext(null), null);
  const h = new Headers({ "x-total": "42", "x-total-pages": "3" });
  assert.equal(intHeader(h, "x-total"), 42);
  assert.equal(intHeader(h, "x-total-pages"), 3);
  assert.equal(intHeader(h, "missing"), undefined);
});
