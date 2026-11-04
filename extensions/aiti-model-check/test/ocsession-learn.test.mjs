// x-opencode-session 自学习单测（探测路径）：上游 400 MissingSessionID → 学习 host + 带头重发一次
// 覆盖：probeOneKey 首测自愈 / 学习后后续探测首跳即带头 / 普通 400 不重试原样归类 badreq
import { createRequire } from "module";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { makeUpstream, Tester } from "../../../pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const mc = require("../core.cjs");
const { ok, finish } = Tester();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "moc-"));
const cfg = { modelsPath: path.join(dir, "models.json"), probe: { timeoutMs: 5000, concurrency: 2, maxTokens: 8, perKey: true } };

const entryFor = (base) => ({ provider: "oc-test", model: "test-model", modelId: "test-model", api: "openai-completions", baseUrl: base, apiKey: "sk-x" });

// 模拟中转域名上的 Console Go：没带 x-opencode-session → 400 MissingSessionID；带了 → 200
{
  const hits = [];
  const up = await makeUpstream((req, res) => {
    const has = !!req.headers["x-opencode-session"];
    hits.push(has);
    if (has) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] })); return; }
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "MissingSessionID", message: "Request is missing x-opencode-session and cannot be routed" } }));
  });
  const base = `http://127.0.0.1:${up.address().port}`;
  const e = entryFor(base);

  // ── ① 首测：400 → 学习 → 带头重发 → ok ──
  const r1 = await mc.probeOneKey(e, cfg);
  ok("① 首测自学习后 ok（200）", r1.ok === true && r1.status === 200, `status=${r1.status} kind=${r1.kind}`);
  ok("① 上游恰好 2 次（无头→带头）", hits.length === 2 && hits[0] === false && hits[1] === true, `hits=${JSON.stringify(hits)}`);

  // ── ② 学习标记全局生效：再测首跳即带头 ──
  const r2 = await mc.probeOneKey(e, cfg);
  ok("② 复测直接 ok", r2.ok === true);
  ok("② 标记生效：仅 +1 次且带头", hits.length === 3 && hits[2] === true, `hits=${JSON.stringify(hits)}`);
  up.close();
}

// ── ③ 普通 400 不重试、归类 badreq（「请求错误」）──
{
  let n = 0;
  const up = await makeUpstream((req, res) => {
    n++;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid model id", type: "invalid_request_error" } }));
  });
  const base = `http://127.0.0.1:${up.address().port}`;
  const r = await mc.probeOneKey(entryFor(base), cfg);
  ok("③ 普通 400 原样归类 badreq", r.ok === false && r.status === 400 && r.kind === "badreq", `kind=${r.kind}`);
  ok("③ 上游仅 1 次（无重试）", n === 1, `n=${n}`);
  up.close();
}

finish("model-check ocsession-learn · MissingSessionID 自学习");
