import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { jsonResponse } = await jiti.import("./json-response.ts");

test("does not gzip a large JSON response when the client disables gzip", async () => {
  const response = jsonResponse(
    new Request("http://localhost/test", { headers: { "Accept-Encoding": "gzip;q=0, br" } }),
    { value: "large payload ".repeat(200) },
  );

  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.equal((await response.json()).value, "large payload ".repeat(200));
});

test("does not gzip when the gzip quality value is invalid", async () => {
  const response = jsonResponse(
    new Request("http://localhost/test", { headers: { "Accept-Encoding": "gzip;q=invalid, *;q=1" } }),
    { value: "large payload ".repeat(200) },
  );

  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.equal((await response.json()).value, "large payload ".repeat(200));
});

test("leaves small JSON responses uncompressed", async () => {
  const response = jsonResponse(
    new Request("http://localhost/test", { headers: { "Accept-Encoding": "gzip" } }),
    { ok: true },
  );

  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.deepEqual(await response.json(), { ok: true });
});

test("never gzips, even with a strong gzip preference (Next 16.4.6 strips route-handler Content-Encoding)", async () => {
  const response = jsonResponse(
    new Request("http://localhost/test", { headers: { "Accept-Encoding": "gzip, deflate, br, zstd" } }),
    { value: "large payload ".repeat(200) },
  );

  // Regression guard: a self-gzipped body whose "Content-Encoding" header gets stripped by
  // Next 16.4.6 reaches nginx unlabelled, gets re-compressed at the edge, and browsers then
  // parse the inner gzip bytes as JSON ("Unexpected token ''"). Compression must stay at
  // the edge (nginx), exactly once.
  assert.equal(response.headers.get("Content-Encoding"), null);
  assert.equal((await response.json()).value, "large payload ".repeat(200));
});
