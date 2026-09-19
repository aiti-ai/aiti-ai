import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const subject = await jiti.import("./dedupe-fetch.ts");
const { dedupeFetch, resetDedupeFetch } = subject;

/** Stub for global fetch: records call count, returns (status, body), or delegates to a custom impl */
function stubFetch(impl) {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(impl(url, init, calls.length));
  };
  globalThis.fetch = fn;
  return calls;
}

test("concurrent same-URL calls share one network round-trip; each gets an independent clone", async () => {
  resetDedupeFetch();
  const calls = stubFetch(() => new Response(JSON.stringify({ home: "/h" }), { status: 200 }));
  const [a, b] = await Promise.all([dedupeFetch("/api/home"), dedupeFetch("/api/home")]);
  assert.equal(calls.length, 1);
  assert.notEqual(a, b, "each caller must get its own Response clone");
  assert.deepEqual(await a.json(), { home: "/h" });
  assert.deepEqual(await b.json(), { home: "/h" });
});

test("successful response is reused within ttlMs without a new request", async () => {
  resetDedupeFetch();
  const calls = stubFetch(() => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
  await dedupeFetch("/x", { ttlMs: 50 }).then((r) => r.json());
  assert.equal(calls.length, 1);
  const again = await dedupeFetch("/x", { ttlMs: 50 });
  assert.equal(calls.length, 1, "TTL window hit → zero network");
  assert.deepEqual(await again.json(), { ok: 1 });
});

test("after ttl expiry a new request is issued", async () => {
  resetDedupeFetch();
  const calls = stubFetch(() => new Response("{}", { status: 200 }));
  await dedupeFetch("/y", { ttlMs: 10 }).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 25));
  await dedupeFetch("/y", { ttlMs: 10 });
  assert.equal(calls.length, 2);
});

test("failed responses are not cached — next call retries", async () => {
  resetDedupeFetch();
  const calls = stubFetch(() => new Response("boom", { status: 500 }));
  await assert.rejects(dedupeFetch("/f").then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }));
  await dedupeFetch("/f");
  assert.equal(calls.length, 2);
});

test("different URLs do not share cache entries", async () => {
  resetDedupeFetch();
  const calls = stubFetch(() => new Response("{}", { status: 200 }));
  await Promise.all([dedupeFetch("/a"), dedupeFetch("/b")]);
  assert.equal(calls.length, 2);
});

test("options are forwarded to fetch on the shared request", async () => {
  resetDedupeFetch();
  let seenInit;
  stubFetch((_url, init) => { seenInit = init; return new Response("{}", { status: 200 }); });
  await dedupeFetch("/opt", { cache: "no-store", headers: { "if-none-match": '"v1"' } });
  assert.equal(seenInit.cache, "no-store");
  assert.equal(seenInit.headers["if-none-match"], '"v1"');
});
