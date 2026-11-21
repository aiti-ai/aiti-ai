// Ark Agent/Coding plan endpoint diagnostics: plan endpoints expose no /models, and each of the three
// key families (pay-as-you-go / coding / agent plan) is rejected by the others.
// Covers: no model -> probe ark-code-latest instead of listing; 401 / 404 / InvalidSubscription each
// produce an actionable message.
import { createRequire } from "module";
import { makeUpstream, Tester } from "../../../pi-plugins/pi-models-combo/test/util.mjs";

const require = createRequire(import.meta.url);
const wz = require("../core.cjs");
const { ok, finish } = Tester();

const jsonReply = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// -- 1) agent plan + pay-as-you-go key: no model -> probe ark-code-latest -> 401 hint about the dedicated key --
{
  const seen = [];
  const up = await makeUpstream((req, res) => {
    seen.push(req.method + " " + req.url);
    if (req.url.endsWith("/models")) { res.writeHead(404); res.end(); return; }
    jsonReply(res, 401, { error: { code: "AuthenticationError", message: "The API key or AK/SK in the request is missing or invalid. Request id: x", type: "Unauthorized" } });
  });
  const base = `http://127.0.0.1:${up.address().port}/api/plan/v3`;
  const r = await wz.testConnection({ baseUrl: base, api: "openai-completions", apiKey: "ark-payasyougo" }, { timeoutMs: 8000 });
  ok("① pass=false（401）", r.pass === false && r.status === 401, `status=${r.status}`);
  ok("① 探针模型 = ark-code-latest", r.model === "ark-code-latest", `model=${r.model}`);
  ok("① 未拉 /models（直接打 chat）", seen.length === 1 && seen[0].includes("/chat/completions"), `seen=${JSON.stringify(seen)}`);
  ok("① detail 指向「专属 API Key」", String(r.detail).includes("专属 API Key"), `detail=${r.detail}`);
  up.close();
}

// -- 2) plan endpoints have no /models: discover explains it instead of suggesting a wrong base path --
{
  const up = await makeUpstream((req, res) => { res.writeHead(404); res.end(); });
  const base = `http://127.0.0.1:${up.address().port}/api/plan/v3`;
  const d = await wz.discoverModels({ baseUrl: base, api: "openai-completions", apiKey: "ark-x" }, { timeoutMs: 8000 });
  ok("② discover ok=false", d.ok === false);
  ok("② error 说明套餐端点无列表", String(d.error).includes("不提供 /models"), `error=${d.error}`);
  ok("② error 给出 ark-code-latest", String(d.error).includes("ark-code-latest"));
  up.close();
}

// -- 3) model not in the plan whitelist (404 UnsupportedModel) -> blame the model, not the URL --
{
  const up = await makeUpstream((req, res) => {
    jsonReply(res, 404, { error: { code: "UnsupportedModel", message: "The requested model does not support the agent plan feature.", param: "", type: "" } });
  });
  const base = `http://127.0.0.1:${up.address().port}/api/plan/v3`;
  const r = await wz.testConnection({ baseUrl: base, api: "openai-completions", apiKey: "ark-plan", model: "doubao-seed-1-6-250615" }, { timeoutMs: 8000 });
  ok("③ pass=false", r.pass === false);
  ok("③ detail 指向套餐支持清单", String(r.detail).includes("不在该套餐支持清单"), `detail=${r.detail}`);
  up.close();
}

// -- 4) coding plan not subscribed (400 InvalidSubscription) -> hint to subscribe or use the pay-as-you-go base --
{
  const up = await makeUpstream((req, res) => {
    jsonReply(res, 400, { error: { code: "InvalidSubscription", message: "Your account (1000) does not have a valid CodingPlan subscription, or your subscription has expired.", type: "Bad Request" } });
  });
  const base = `http://127.0.0.1:${up.address().port}/api/coding/v3`;
  const r = await wz.testConnection({ baseUrl: base, api: "openai-completions", apiKey: "ark-x", model: "ark-code-latest" }, { timeoutMs: 8000 });
  ok("④ detail 说明无套餐订阅", String(r.detail).includes("套餐订阅") && String(r.detail).includes("InvalidSubscription"), `detail=${r.detail}`);
  up.close();
}

// -- 5) regression: a regular endpoint still gets the "wrong path?" wording on /models 404 --
{
  const up = await makeUpstream((req, res) => { res.writeHead(404); res.end(); });
  const base = `http://127.0.0.1:${up.address().port}/v1`;
  const r = await wz.testConnection({ baseUrl: base, api: "openai-completions", apiKey: "sk-x" }, { timeoutMs: 8000 });
  ok("⑤ 普通端点 404 话术不变", String(r.detail).includes("可能漏了 /v1 或 /v2"), `detail=${r.detail}`);
  up.close();
}

finish("wizard ark-plan-endpoint · 套餐端点诊断");
