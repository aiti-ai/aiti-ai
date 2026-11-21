// Regression: a 400 body compressed by the upstream must not be forwarded as raw gzip bytes.
// The proxy writes a decoded copy with a plain JSON content-type; plain 400s keep their
// original pass-through behaviour, and a mislabelled body must not crash the 400 path.
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();
const authToken = "sk-dummy-" + randomBytes(8).toString("hex");
const post = (port) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST",
  body: "{}",
  headers: { "content-type": "application/json", authorization: "Bearer " + authToken },
});
const gz = (obj) => gzipSync(Buffer.from(JSON.stringify(obj)));

// ── gzip 400 (ark-coding InvalidSubscription): decoded JSON reaches the client ──
{
  let n = 0;
  const up = await makeUpstream((req, res) => {
    n++;
    res.writeHead(400, {
      "content-type": "application/json; charset=utf-8",
      "content-encoding": "gzip",
      vary: "Accept-Encoding",
    });
    res.end(gz({ error: { code: "InvalidSubscription", message: "subscription expired" } }));
  });
  const p = new ProxyServer({
    provider: "gz1", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }], port: await freeP(), authToken,
  });
  await p.start();
  const r = await post(p.port);
  const text = Buffer.from(await r.arrayBuffer()).toString("utf8");
  let j = null;
  try { j = JSON.parse(text); } catch { /* keep null for the assertion */ }
  ok("gzip 400 body is decoded into readable JSON", r.status === 400 && j?.error?.code === "InvalidSubscription", `status=${r.status} text=${text.slice(0, 60)}`);
  ok("client does not see gzip bytes or a stale encoding header", !text.startsWith("\u001f") && r.headers.get("content-encoding") === null);
  ok("upstream hit once (no retry for a plain upstream 400)", n === 1, `n=${n}`);
  p.stop(); up.close();
}

// ── mislabelled gzip: plain body with a gzip header falls back to raw text ──
{
  let n = 0;
  const up = await makeUpstream((req, res) => {
    n++;
    res.writeHead(400, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(JSON.stringify({ error: { message: "invalid model id" } }));
  });
  const p = new ProxyServer({
    provider: "gz2", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }], port: await freeP(), authToken,
  });
  await p.start();
  const r = await post(p.port);
  const text = Buffer.from(await r.arrayBuffer()).toString("utf8");
  let j = null;
  try { j = JSON.parse(text); } catch { /* keep null for the assertion */ }
  ok("mislabelled gzip body keeps plain-text pass-through", r.status === 400 && j?.error?.message === "invalid model id", `status=${r.status} text=${text.slice(0, 60)}`);
  ok("upstream hit once", n === 1, `n=${n}`);
  p.stop(); up.close();
}

// ── MissingSessionID inside a gzip body still triggers header injection/retry ──
{
  const hits = [];
  const up = await makeUpstream((req, res) => {
    const has = !!req.headers["x-opencode-session"];
    hits.push(has);
    if (has) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
    res.writeHead(400, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(gz({ error: { type: "MissingSessionID", message: "missing x-opencode-session" } }));
  });
  const p = new ProxyServer({
    provider: "gz3", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }], port: await freeP(), authToken,
  });
  await p.start();
  const r = await post(p.port);
  ok("gzip MissingSessionID is detected after decoding", r.status === 200, `status=${r.status}`);
  ok("self-learning retry sent the header", hits.length === 2 && hits[0] === false && hits[1] === true, `hits=${JSON.stringify(hits)}`);
  p.stop(); up.close();
}

finish("gzip-error-body · 400 decompression");
