// maxTokens 改写单测：协议字段名分派 / store 与 models.json 双源 / 静默透传边界
//
// 用真实代理走一次端到端：构造假上游，配置 PMC_MODELS_JSON / PMC_MODELS_STORE 指临时文件，
// 触发 sendBody 改写路径，断言上游收到的 body.maxTokens 等于预期。
//
// 覆盖矩阵：
//   1) openai-completions + compat.maxTokensField = "max_tokens" → 改写 max_tokens
//   2) openai-completions + compat.maxTokensField = "max_completion_tokens" → 改写 max_completion_tokens
//   3) anthropic-messages → 改写顶层 max_tokens
//   4) google-generative-ai → 改写 generationConfig.maxOutputTokens
//   5) 缺上游 maxTokens → 静默透传
//   6) 请求 maxTokens ≤ 上限 → 不动
//   7) 缺字段 / 非数字 → 透传不补
//   8) combo 模式 + entry.member 解析 source provider → 命中该 provider 的 compat
//   9) PMC_NO_MAXTOKENS_REWRITE=1 → 全部不写
//
// mock 策略：process.env.PMC_MODELS_JSON / PMC_MODELS_STORE 指向临时文件，
// proxy #storePath() / #modelsJsonPath() 直接读这里（不污染真实 ~/.pi/agent）。

import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();
const authToken = "sk-dummy-" + randomBytes(8).toString("hex");

/** 临时配置目录 + 写两个 JSON：models.json（用户显式） + models-store.json（pi store 兜底） */
function setupCfg(spec) {
  const dir = mkdtempSync(join(tmpdir(), "pmc-mt-"));
  const mj = {};
  for (const [pid, pcfg] of Object.entries(spec.providers || {})) mj[pid] = pcfg;
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: mj }, null, 2));
  writeFileSync(join(dir, "models-store.json"), JSON.stringify(spec.store || {}, null, 2));
  process.env.PMC_MODELS_JSON = join(dir, "models.json");
  process.env.PMC_MODELS_STORE = join(dir, "models-store.json");
  return {
    dir,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/** 跑一个请求：构造 body → 走代理 → 拿上游收到 body → JSON.parse 返回 */
async function runOnce({ provider = "test", upstream, api, apiKeys, body }) {
  const port = await freeP();
  const p = new ProxyServer({
    provider,
    upstream,
    apiKeys,
    port,
    authToken,
    api,
    maxRetries: 1,
  });
  await p.start();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", authorization: "Bearer " + authToken },
    });
    const j = await r.json();
    return { status: r.status, json: j };
  } finally {
    p.stop();
  }
}

// ─── 1) openai-completions + maxTokensField=max_tokens ───
{
  const got = [];
  const up = await makeUpstream((req, res) => {
    got.push(JSON.parse(req.rawBody.toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = setupCfg({
    providers: {
      "oa-max": {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${up.address().port}`,
        apiKey: "sk-a",
        models: [{ id: "m-old", maxTokens: 8000, compat: { maxTokensField: "max_tokens" } }],
      },
    },
  });
  const r = await runOnce({
    provider: "oa-max",
    upstream: `http://127.0.0.1:${up.address().port}`,
    api: "openai-completions",
    apiKeys: [{ name: "k1", key: "sk-a" }],
    body: { model: "m-old", max_tokens: 32000, messages: [{ role: "user", content: "hi" }] },
  });
  ok("1.openai/max_tokens 改写：32000 → 8000", r.status === 200 && got[0]?.max_tokens === 8000, `(got=${got[0]?.max_tokens})`);
  ok("1.openai/max_tokens 改写不动 model", got[0]?.model === "m-old");
  cfg.cleanup(); up.close();
}

// ─── 2) openai-completions + maxTokensField=max_completion_tokens ───
{
  const got = [];
  const up = await makeUpstream((req, res) => {
    got.push(JSON.parse(req.rawBody.toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = setupCfg({
    providers: {
      "oa-mct": {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${up.address().port}`,
        apiKey: "sk-a",
        models: [{ id: "gpt-x", maxTokens: 16384, compat: { maxTokensField: "max_completion_tokens" } }],
      },
    },
  });
  const r = await runOnce({
    provider: "oa-mct",
    upstream: `http://127.0.0.1:${up.address().port}`,
    api: "openai-completions",
    apiKeys: [{ name: "k1", key: "sk-a" }],
    body: { model: "gpt-x", max_completion_tokens: 64000, messages: [{ role: "user", content: "hi" }] },
  });
  ok("2.openai/max_completion_tokens 改写：64000 → 16384", r.status === 200 && got[0]?.max_completion_tokens === 16384, `(got=${got[0]?.max_completion_tokens})`);
  ok("2.openai/max_completion_tokens 改写不动 max_tokens（不在该字段）", got[0]?.max_tokens === undefined);
  cfg.cleanup(); up.close();
}

// ─── 3) anthropic-messages 顶层 max_tokens ───
{
  const got = [];
  const up = await makeUpstream((req, res) => {
    got.push(JSON.parse(req.rawBody.toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = setupCfg({
    providers: {
      "ant": {
        api: "anthropic-messages",
        baseUrl: `http://127.0.0.1:${up.address().port}`,
        apiKey: "sk-ant",
        models: [{ id: "claude-sonnet", maxTokens: 8192 }],
      },
    },
  });
  const r = await runOnce({
    provider: "ant",
    upstream: `http://127.0.0.1:${up.address().port}`,
    api: "anthropic-messages",
    apiKeys: [{ name: "k1", key: "sk-ant" }],
    body: { model: "claude-sonnet", max_tokens: 64000, messages: [{ role: "user", content: "hi" }] },
  });
  ok("3.anthropic 顶层 max_tokens 改写：64000 → 8192", r.status === 200 && got[0]?.max_tokens === 8192, `(got=${got[0]?.max_tokens})`);
  cfg.cleanup(); up.close();
}

// ─── 4) google-generative-ai generationConfig.maxOutputTokens 嵌套 ───
{
  const got = [];
  const up = await makeUpstream((req, res) => {
    got.push(JSON.parse(req.rawBody.toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = setupCfg({
    providers: {
      "gg": {
        api: "google-generative-ai",
        baseUrl: `http://127.0.0.1:${up.address().port}`,
        apiKey: "sk-g",
        models: [{ id: "gem-flash", maxTokens: 8192 }],
      },
    },
  });
  const r = await runOnce({
    provider: "gg",
    upstream: `http://127.0.0.1:${up.address().port}`,
    api: "google-generative-ai",
    apiKeys: [{ name: "k1", key: "sk-g" }],
    body: { model: "gem-flash", contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 64000, temperature: 0.5 } },
  });
  ok("4.google generationConfig.maxOutputTokens 改写：64000 → 8192", r.status === 200 && got[0]?.generationConfig?.maxOutputTokens === 8192, `(got=${got[0]?.generationConfig?.maxOutputTokens})`);
  ok("4.google generationConfig 其它字段（temperature）不动", got[0]?.generationConfig?.temperature === 0.5);
  cfg.cleanup(); up.close();
}

// ─── 5) 缺上游 maxTokens → 静默透传 ───
{
  const got = [];
  const up = await makeUpstream((req, res) => {
    got.push(JSON.parse(req.rawBody.toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = setupCfg({
    providers: {
      "unk": {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${up.address().port}`,
        apiKey: "sk-u",
        models: [], // 显式 models 为空；store 也没有
      },
    },
  });
  const r = await runOnce({
    provider: "unk",
    upstream: `http://127.0.0.1:${up.address().port}`,
    api: "openai-completions",
    apiKeys: [{ name: "k1", key: "sk-u" }],
    body: { model: "mystery", max_tokens: 64000, messages: [{ role: "user", content: "hi" }] },
  });
  ok("5.缺上游 maxTokens → 静默透传", r.status === 200 && got[0]?.max_tokens === 64000, `(got=${got[0]?.max_tokens})`);
  cfg.cleanup(); up.close();
}

// ─── 6) 请求 maxTokens ≤ 上限 → 不动 ───
{
  const got = [];
  const up = await makeUpstream((req, res) => {
    got.push(JSON.parse(req.rawBody.toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = setupCfg({
    providers: {
      "small": {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${up.address().port}`,
        apiKey: "sk-s",
        models: [{ id: "tiny", maxTokens: 32000, compat: { maxTokensField: "max_tokens" } }],
      },
    },
  });
  const r = await runOnce({
    provider: "small",
    upstream: `http://127.0.0.1:${up.address().port}`,
    api: "openai-completions",
    apiKeys: [{ name: "k1", key: "sk-s" }],
    body: { model: "tiny", max_tokens: 4000, messages: [{ role: "user", content: "hi" }] },
  });
  ok("6.请求 ≤ 上限 → 不动（4000 保留）", r.status === 200 && got[0]?.max_tokens === 4000, `(got=${got[0]?.max_tokens})`);
  cfg.cleanup(); up.close();
}

// ─── 7) 缺字段 / 非数字 → 透传（不补默认值）───
{
  const got = [];
  const up = await makeUpstream((req, res) => {
    got.push(JSON.parse(req.rawBody.toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = setupCfg({
    providers: {
      "nb": {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${up.address().port}`,
        apiKey: "sk-n",
        models: [{ id: "x", maxTokens: 8000, compat: { maxTokensField: "max_tokens" } }],
      },
    },
  });
  const r = await runOnce({
    provider: "nb",
    upstream: `http://127.0.0.1:${up.address().port}`,
    api: "openai-completions",
    apiKeys: [{ name: "k1", key: "sk-n" }],
    body: { model: "x", messages: [{ role: "user", content: "hi" }] }, // 缺 max_tokens
  });
  ok("7.缺 max_tokens 字段 → 透传不补", r.status === 200 && got[0]?.max_tokens === undefined);
  cfg.cleanup(); up.close();
}

// ─── 8) combo 模式端到端：entry.member 拆出 source provider ───
//  关键点：combo 成员的 entry.member = "src-p1/real-m1"，代理要从 src-p1 provider 的
//  models 找 maxTokens，而不是 combo 顶层 provider。
{
  const got = [];
  const up = await makeUpstream((req, res) => {
    got.push(JSON.parse(req.rawBody.toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = setupCfg({
    providers: {
      "src-p1": {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${up.address().port}`,
        apiKey: "sk-src",
        models: [{ id: "real-m1", maxTokens: 5000, compat: { maxTokensField: "max_tokens" } }],
      },
    },
  });
  // 构造 combo 槽位：apiKeys 里带 group/member/model/api → #isCombo=true
  const port = await freeP();
  const p = new ProxyServer({
    provider: "combo-top",
    upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [
      { name: "slot-1", key: "sk-c", group: "virt-1", member: "src-p1/real-m1", model: "real-m1", api: "openai-completions" },
    ],
    port,
    authToken,
    api: "openai-completions",
  });
  await p.start();
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ model: "virt-1", max_tokens: 99999, messages: [{ role: "user", content: "hi" }] }),
    headers: { "content-type": "application/json", authorization: "Bearer " + authToken },
  });
  const j = await r.json();
  ok("8.combo 端到端：body.model 改写为真实模型 real-m1", r.status === 200 && got[0]?.model === "real-m1", `(got=${got[0]?.model})`);
  ok("8.combo 端到端：max_tokens 99999 → 5000（命中 src-p1 的 maxTokens）", r.status === 200 && got[0]?.max_tokens === 5000, `(got=${got[0]?.max_tokens})`);
  p.stop(); cfg.cleanup(); up.close();
}

// ─── 9) PMC_NO_MAXTOKENS_REWRITE=1 → 全部不写 ───
{
  const got = [];
  const up = await makeUpstream((req, res) => {
    got.push(JSON.parse(req.rawBody.toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = setupCfg({
    providers: {
      "no": {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${up.address().port}`,
        apiKey: "sk-n",
        models: [{ id: "y", maxTokens: 8000, compat: { maxTokensField: "max_tokens" } }],
      },
    },
  });
  process.env.PMC_NO_MAXTOKENS_REWRITE = "1";
  const r = await runOnce({
    provider: "no",
    upstream: `http://127.0.0.1:${up.address().port}`,
    api: "openai-completions",
    apiKeys: [{ name: "k1", key: "sk-n" }],
    body: { model: "y", max_tokens: 99999, messages: [{ role: "user", content: "hi" }] },
  });
  ok("9.PMC_NO_MAXTOKENS_REWRITE=1 → 不改写", r.status === 200 && got[0]?.max_tokens === 99999, `(got=${got[0]?.max_tokens})`);
  delete process.env.PMC_NO_MAXTOKENS_REWRITE;
  cfg.cleanup(); up.close();
}

// ─── 10) 兜底：openai-completions 协议但 store 给了 maxTokensField（无显式 models）───
{
  const got = [];
  const up = await makeUpstream((req, res) => {
    got.push(JSON.parse(req.rawBody.toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const cfg = setupCfg({
    providers: {
      "fromstore": {
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${up.address().port}`,
        apiKey: "sk-fs",
        models: [], // 显式空 → 走 store 兜底
      },
    },
    store: {
      fromstore: {
        models: [{
          id: "store-only",
          maxTokens: 4096,
          compat: { maxTokensField: "max_completion_tokens" },
        }],
      },
    },
  });
  const r = await runOnce({
    provider: "fromstore",
    upstream: `http://127.0.0.1:${up.address().port}`,
    api: "openai-completions",
    apiKeys: [{ name: "k1", key: "sk-fs" }],
    body: { model: "store-only", max_completion_tokens: 32000, messages: [{ role: "user", content: "hi" }] },
  });
  ok("10.store 兜底 maxTokensField=max_completion_tokens → 改写 32000→4096", r.status === 200 && got[0]?.max_completion_tokens === 4096, `(got=${got[0]?.max_completion_tokens})`);
  cfg.cleanup(); up.close();
}

finish("maxTokens 改写 · 单元");
