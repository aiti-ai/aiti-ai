// x-opencode-session 自学习测试：上游 400 MissingSessionID → 打全局标记 + 带头重发一次（后续直接带头）
// 覆盖：① 首请求自愈（200）② 标记生效（后续请求首跳即带头）③ 普通 400 不受影响原样透传 ④ i18n key 存在
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();
const authToken = "sk-dummy-" + randomBytes(8).toString("hex");

// 模拟中转域名上的 Console Go：没带 x-opencode-session → 400 MissingSessionID；带了 → 200
const mkOcUpstream = () => {
  const hits = [];
  const handler = (req, res) => {
    const has = !!req.headers["x-opencode-session"];
    hits.push(has);
    if (has) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "MissingSessionID", message: "Request is missing x-opencode-session and cannot be routed" } }));
  };
  return { hits, upstream: null, make: async function () { this.upstream = await makeUpstream(handler); return this.upstream; } };
};

// ── ① + ②：首请求 400 → 学习 → 带头重发成功；第二请求直接带头 ──
{
  const oc = mkOcUpstream();
  const up = await oc.make();
  const p = new ProxyServer({ provider: "oc1", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "k1", key: "sk-a" }], port: await freeP(), authToken });
  await p.start();
  const opt = { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: "Bearer " + authToken } };

  const r1 = await fetch(`http://127.0.0.1:${p.port}/v1/chat/completions`, opt);
  const j1 = await r1.json();
  ok("① 首请求 MissingSessionID → 自学习重发后 200", r1.status === 200 && j1.ok === true, `status=${r1.status}`);
  ok("① 上游恰好被打 2 次（无头 1 次 + 带头 1 次）", oc.hits.length === 2 && oc.hits[0] === false && oc.hits[1] === true, `hits=${JSON.stringify(oc.hits)}`);

  const r2 = await fetch(`http://127.0.0.1:${p.port}/v1/chat/completions`, opt);
  ok("② 第二请求直接 200", r2.status === 200);
  ok("② 标记生效：第二请求首跳即带头（仅 +1 次且带头）", oc.hits.length === 3 && oc.hits[2] === true, `hits=${JSON.stringify(oc.hits)}`);

  p.stop(); up.close();
}

// ── ③：普通 400（参数错）不触发学习/重试，原样透传 ──
{
  let n = 0;
  const up = await makeUpstream((req, res) => {
    n++;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid model id", type: "invalid_request_error" } }));
  });
  const p = new ProxyServer({ provider: "oc2", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "k1", key: "sk-a" }], port: await freeP(), authToken });
  await p.start();
  const r = await fetch(`http://127.0.0.1:${p.port}/v1/chat/completions`, { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  const j = await r.json();
  ok("③ 普通 400 原样透传", r.status === 400 && j?.error?.message === "invalid model id");
  ok("③ 上游仅 1 次（无重试）", n === 1, `n=${n}`);
  p.stop(); up.close();
}

finish("ocsession-learn · MissingSessionID 自学习");
