// usage-log 测试：extractUsageFromBody 三种 api 形态 + 代理写 key-request 日志
import fs, { readFileSync, readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyServer } from "../src/proxy.ts";
import { extractUsageFromBody, setUsageLogFile, appendRawRecord, sweepCompressOldMonths } from "../src/usage-log.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();

// ---------- extractUsageFromBody：openai-completions（SSE 尾帧带 usage） ----------
{
  const sse = [
    'data: {"id":"c1","choices":[{"delta":{"content":"Hi"}}]}',
    "",
    'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":800},"completion_tokens_details":{"reasoning_tokens":10}}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const u = extractUsageFromBody(sse);
  ok("openai SSE usage 解析", u && u.input === 200 && u.output === 50 && u.cacheRead === 800 && u.reasoning === 10, JSON.stringify(u));
}

// ---------- extractUsageFromBody：anthropic-messages（message_start + message_delta） ----------
{
  const sse = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":500,"output_tokens":1,"cache_read_input_tokens":300,"cache_creation_input_tokens":20}}}',
    "",
    "event: content_block_delta",
    'data: {"type":"content_block_delta","delta":{"text":"x"}}',
    "",
    'data: {"type":"message_delta","usage":{"output_tokens":77}}',
    "",
  ].join("\n");
  const u = extractUsageFromBody(sse);
  ok("anthropic SSE usage 解析（delta 覆盖 output）", u && u.input === 500 && u.output === 77 && u.cacheRead === 300 && u.cacheWrite === 20, JSON.stringify(u));
}

// ---------- extractUsageFromBody：google-generative-ai ----------
{
  const sse = [
    'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}],"usageMetadata":{"promptTokenCount":400,"candidatesTokenCount":30,"thoughtsTokenCount":15,"cachedContentTokenCount":100,"totalTokenCount":445}}',
    "",
  ].join("\n");
  const u = extractUsageFromBody(sse);
  ok("google SSE usage 解析", u && u.input === 300 && u.output === 45 && u.cacheRead === 100 && u.reasoning === 15, JSON.stringify(u));
}

// ---------- extractUsageFromBody：非流式 JSON 体 ----------
{
  const u = extractUsageFromBody(JSON.stringify({ id: "x", usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  ok("非流式 JSON usage 解析", u && u.input === 10 && u.output === 5, JSON.stringify(u));
}

// ---------- 解析失败 → null ----------
ok("垃圾输入 → null", extractUsageFromBody("not json at all") === null);

// ---------- 代理端到端：成功请求写一条日志（含 model + usage），429 也写 ----------
{
  process.env.PMC_USAGE_FILE = join(mkdtempSync(join(tmpdir(), "pmc-usage-")), "key-requests.jsonl");
  setUsageLogFile(process.env.PMC_USAGE_FILE);
  const authToken = "sk-dummy-test";
  // 上游按模式响应：ok→200 SSE（openai usage 帧）；fail→429
  let mode = "ok";
  const up = await makeUpstream((req, res) => {
    if (mode === "ok") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7}}\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"error":"rl"}');
    }
  });
  const p = new ProxyServer({
    provider: "tlog",
    upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }],
    port: await freeP(),
    authToken,
    maxRetries: 5,
  });
  await p.start();
  const call = () => fetch(`http://127.0.0.1:${p.port}/v1/chat`, {
    method: "POST",
    body: JSON.stringify({ model: "test-model", messages: [] }),
    headers: { "content-type": "application/json", authorization: "Bearer " + authToken },
  });
  await (await call()).text();      // 请求 1：成功 → 写成功日志
  mode = "fail";
  await (await call()).text();      // 请求 2：429 → 写 429 日志（不重试到成功）
  await new Promise((res) => setTimeout(res, 150)); // tee end 异步落盘
  p.stop(); up.close();

  const lines = readFileSync(process.env.PMC_USAGE_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok("每次尝试各写一条：一次成功 + 一次 429", lines.length === 2, `lines=${lines.length}`);
  const okRec = lines.find((l) => l.status === 200);
  ok("成功记录含 model/key/usage",
    okRec && okRec.model === "test-model" && okRec.key === "k1" &&
    okRec.input === 100 && okRec.output === 7 && okRec.provider === "tlog" && typeof okRec.ts === "number",
    JSON.stringify(okRec));
  const rls = lines.filter((l) => l.status === 429);
  ok("429 记录归到 key 且无 usage 字段", rls.length === 1 && rls.every((r) => r.key === "k1" && !("input" in r)), JSON.stringify(rls));
  rmSync(process.env.PMC_USAGE_FILE, { force: true });
  delete process.env.PMC_USAGE_FILE;
}



// ---------- 多 token 门禁：每会话独立 token，日志带 client 关联字段 ----------
{
  process.env.PMC_USAGE_FILE = join(mkdtempSync(join(tmpdir(), "pmc-multi-")), "key-requests.jsonl");
  setUsageLogFile(process.env.PMC_USAGE_FILE); // 模块级绑定已被上一用例占用，显式重绑
  const up = await makeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const p = new ProxyServer({
    provider: "tmulti",
    upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }],
    port: await freeP(),
    authToken: "sk-dummy-sessionA-aaaaaaaaaaaa",
  });
  await p.start();
  p.registerToken("sk-dummy-sessionB-bbbbbbbbbbbb");
  const call = (tok) => fetch(`http://127.0.0.1:${p.port}/x`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tok } }).then((r) => r.status);
  ok("token A → 200", (await call("sk-dummy-sessionA-aaaaaaaaaaaa")) === 200);
  ok("token B（后注册）→ 200", (await call("sk-dummy-sessionB-bbbbbbbbbbbb")) === 200);
  ok("未注册 token → 401", (await call("sk-dummy-intruder")) === 401);
  await new Promise((res) => setTimeout(res, 120));
  p.stop(); up.close();

  const lines = readFileSync(process.env.PMC_USAGE_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const clients = lines.filter((l) => l.status === 200).map((l) => l.client);
  ok("成功记录带截断 client 字段", clients.length === 2 &&
    clients[0] === "sessionA-aaa" && clients[1] === "sessionB-bbb", JSON.stringify(clients));
  rmSync(process.env.PMC_USAGE_FILE, { force: true });
  delete process.env.PMC_USAGE_FILE;
}


// ---------- 按月轮转：记录落自身月份文件，旧月 gzip 压缩 ----------
{
  const dir = mkdtempSync(join(tmpdir(), "pmc-rot-"));
  setUsageLogFile(join(dir, "key-requests.jsonl"), {
    monthly: true,
    now: () => new Date("2026-09-15T10:00:00Z"), // 注入时钟
  });
  appendRawRecord({ ts: Date.parse("2026-07-03T00:00:00Z"), type: "client", client: "jul" });
  appendRawRecord({ ts: Date.parse("2026-08-20T00:00:00Z"), type: "client", client: "aug" });
  appendRawRecord({ ts: Date.parse("2026-09-15T00:00:00Z"), type: "client", client: "sep" });

  sweepCompressOldMonths(dir, "2026-09"); // 显式触发当日压缩扫描

  const names = readdirSync(dir).sort();
  ok("三个月各一个文件（旧月被扫描压缩）",
    JSON.stringify(names) === JSON.stringify(["key-requests-2026-07.jsonl.gz", "key-requests-2026-08.jsonl.gz", "key-requests-2026-09.jsonl"]),
    JSON.stringify(names));
  const { gunzipSync } = await import("node:zlib");
  const jul = JSON.parse(gunzipSync(fs.readFileSync(join(dir, "key-requests-2026-07.jsonl.gz"))).toString().trim());
  ok("压缩内容完好", jul.client === "jul");
  const sepLines = fs.readFileSync(join(dir, "key-requests-2026-09.jsonl"), "utf8").trim().split("\n").length;
  ok("当前月未压缩可追加", sepLines === 1);
}

finish();

