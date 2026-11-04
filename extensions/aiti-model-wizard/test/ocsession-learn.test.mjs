// x-opencode-session 自学习单测：上游 400 MissingSessionID → 学习 host（全局标记）+ 带头重发一次
// 覆盖：testConnection 经 httpPostJson 自愈 / 学习后后续请求首跳即带头 / 普通 400 不重试原样透传
import { createRequire } from "module";
import { makeUpstream, Tester } from "../../../pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const wz = require("../core.cjs");
const { ok, finish } = Tester();

// 模拟中转域名上的 Console Go：没带 x-opencode-session → 400 MissingSessionID；带了 → 200
const mkOcUpstream = () => {
  const hits = [];
  const serverP = makeUpstream((req, res) => {
    const has = !!req.headers["x-opencode-session"];
    hits.push(has);
    if (has) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] })); return; }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "MissingSessionID", message: "Request is missing x-opencode-session and cannot be routed" } }));
  });
  return { hits, serverP };
};

// ── ① testConnection：首测 400 → 自学习带头重发 → pass ──
{
  const oc = mkOcUpstream();
  const up = await oc.serverP;
  const base = `http://127.0.0.1:${up.address().port}`;
  const r = await wz.testConnection({ baseUrl: base, api: "openai-completions", apiKey: "sk-x", model: "test-model" }, { timeoutMs: 8000 });
  ok("① 首测自学习后 pass（200）", r.pass === true && r.status === 200, `status=${r.status} pass=${r.pass}`);
  ok("① 上游恰好 2 次（无头→带头）", oc.hits.length === 2 && oc.hits[0] === false && oc.hits[1] === true, `hits=${JSON.stringify(oc.hits)}`);

  // ── ② 学习标记全局生效：同 host 再测首跳即带头（仅 +1 次且带头）──
  const r2 = await wz.testConnection({ baseUrl: base, api: "openai-completions", apiKey: "sk-x", model: "test-model" }, { timeoutMs: 8000 });
  ok("② 复测直接 pass", r2.pass === true);
  ok("② 标记生效：仅 +1 次且带头", oc.hits.length === 3 && oc.hits[2] === true, `hits=${JSON.stringify(oc.hits)}`);
  up.close();
}

// ── ③ 普通 400 不重试、原样透传 ──
{
  let n = 0;
  const up = await makeUpstream((req, res) => {
    n++;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid model id", type: "invalid_request_error" } }));
  });
  const base = `http://127.0.0.1:${up.address().port}`;
  const r = await wz.testConnection({ baseUrl: base, api: "openai-completions", apiKey: "sk-x", model: "test-model" }, { timeoutMs: 8000 });
  ok("③ 普通 400 原样透传（detail 带上游 message）", r.pass === false && r.status === 400 && String(r.detail).includes("invalid model id"), `detail=${r.detail}`);
  ok("③ 上游仅 1 次（无重试）", n === 1, `n=${n}`);
  up.close();
}

finish("wizard ocsession-learn · MissingSessionID 自学习");
