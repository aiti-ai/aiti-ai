// status() 运行状态快照测试：槽位统计 / 冷却(含种类与剩余秒数) / 组合成员 / 粘性绑定数
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();
const token = () => "sk-" + randomBytes(8).toString("hex");
const jsonUp = (handler) => makeUpstream((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }));
  if (handler) handler();
});

// ---------- 场景 1：普通多 key —— 成功计数 + 最近使用 ----------
{
  const tk = token();
  const up = await jsonUp();
  const c = new ProxyServer({
    provider: "status1", upstream: `http://127.0.0.1:${up.address().port}`, api: "openai-completions",
    authToken: tk, port: await freeP(), apiKeys: [{ name: "key-1", key: "sk-a", rpm: 60, minIntervalMs: 0 }, { name: "key-2", key: "sk-b" }],
  });
  await c.start();
  const r = await fetch(`http://127.0.0.1:${c.port}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [] }), headers: { authorization: "Bearer " + tk } });
  ok("请求 200", r.status === 200);
  const s = c.status();
  ok("status 含 provider/port", s.provider === "status1" && s.port === c.port);
  ok("status 含 2 槽位", Array.isArray(s.entries) && s.entries.length === 2);
  const k1 = s.entries.find((e) => e.name === "key-1");
  const k2 = s.entries.find((e) => e.name === "key-2");
  ok("key-1 记 1 次成功 + lastUsed", k1.stats.ok === 1 && k1.stats.lastUsedAt > 0 && k1.stats.lastStatus === 200, JSON.stringify(k1.stats));
  ok("key-2 未被使用", k2.stats.ok === 0 && k2.stats.lastUsedAt === 0);
  ok("无冷却", k1.cooldown === null);
  ok("key-1 token 流量：↑6↓3↻4（input=10-4 缓存，cacheRead=4）", k1.stats.tin === 6 && k1.stats.tout === 3 && k1.stats.tcr === 4 && k1.stats.tcw === 0, JSON.stringify(k1.stats));
  c.stop(); up.close();
}

// ---------- 场景 2：429 → 冷却（种类 + 剩余秒数）+ 计数 ----------
{
  const tk = token();
  const up = await makeUpstream((req, res) => { res.writeHead(429, { "retry-after": "15" }); res.end("rl"); });
  const c = new ProxyServer({
    provider: "status2", upstream: `http://127.0.0.1:${up.address().port}`, api: "openai-completions",
    authToken: tk, port: await freeP(), max429Retries: 1, apiKeys: [{ name: "k-a", key: "sk-a" }, { name: "k-b", key: "sk-b" }],
  });
  await c.start();
  const r = await fetch(`http://127.0.0.1:${c.port}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [] }), headers: { authorization: "Bearer " + tk } });
  ok("429 透出", r.status === 429);
  const s = c.status();
  const a = s.entries.find((e) => e.name === "k-a");
  const b = s.entries.find((e) => e.name === "k-b");
  ok("k-a 记 429 且冷却中(kind=ratelimit, 秒数>0)", a.stats.err429 >= 1 && a.cooldown?.kind === "ratelimit" && a.cooldown.secondsLeft > 0, JSON.stringify(a.cooldown));
  ok("k-b 也尝试过 429", b.stats.err429 >= 1);
  c.stop(); up.close();
}

// ---------- 场景 2b：超长 retry-after → 面板展示上游原始值 + 内部封顶截断 ----------
{
  const tk = token();
  const up = await makeUpstream((req, res) => { res.writeHead(429, { "retry-after": "3600" }); res.end("rl"); });
  const c = new ProxyServer({
    provider: "status2b", upstream: `http://127.0.0.1:${up.address().port}`, api: "openai-completions",
    authToken: tk, port: await freeP(), max429Retries: 1, apiKeys: [{ name: "k-a", key: "sk-a" }, { name: "k-b", key: "sk-b" }],
  });
  await c.start();
  await fetch(`http://127.0.0.1:${c.port}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const s = c.status();
  const cd = s.entries.find((e) => e.name === "k-a").cooldown;
  ok("超长 retry-after：upstreamSec=3600 + capped + secondsLeft≈60", cd?.kind === "ratelimit" && cd.upstreamSec === 3600 && cd.capped === true && cd.secondsLeft <= 60 && cd.secondsLeft > 55, JSON.stringify(cd));
  c.stop(); up.close();
}

// ---------- 场景 2c：x-ratelimit-reset（unix 秒）→ 提取为上游原始秒数 ----------
{
  const tk = token();
  const resetSec = Math.floor(Date.now() / 1000) + 45;
  const up = await makeUpstream((req, res) => { res.writeHead(429, { "x-ratelimit-reset": String(resetSec) }); res.end("rl"); });
  const c = new ProxyServer({
    provider: "status2c", upstream: `http://127.0.0.1:${up.address().port}`, api: "openai-completions",
    authToken: tk, port: await freeP(), max429Retries: 1, apiKeys: [{ name: "k-a", key: "sk-a" }, { name: "k-b", key: "sk-b" }],
  });
  await c.start();
  await fetch(`http://127.0.0.1:${c.port}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const s = c.status();
  const cd = s.entries.find((e) => e.name === "k-a").cooldown;
  ok("x-ratelimit-reset：upstreamSec∈(0,46]", cd?.kind === "ratelimit" && cd.upstreamSec > 0 && cd.upstreamSec <= 46, JSON.stringify(cd));
  c.stop(); up.close();
}

// ---------- 场景 3：组合槽位 —— isCombo + 成员标识 + 粘性绑定数 ----------
{
  const tk = token();
  const up = await jsonUp();
  const c = new ProxyServer({
    provider: "status3", upstream: `http://127.0.0.1:${up.address().port}`, api: "openai-completions",
    authToken: tk, port: await freeP(),
    apiKeys: [
      { name: "d1", key: "sk-a", model: "deepseek", member: "deepseek/deepseek-chat", group: "fast", weight: 10 },
      { name: "f1", key: "sk-b", model: "flash", member: "google/flash", group: "fast", weight: 30 },
    ],
  });
  await c.start();
  await fetch(`http://127.0.0.1:${c.port}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const s = c.status();
  ok("combo 标记", s.isCombo === true);
  ok("combo 槽位带 member/model", s.entries.every((e) => typeof e.member === "string" && typeof e.model === "string"));
  ok("组合有 1 次成功", s.entries.reduce((a, e) => a + e.stats.ok, 0) === 1);
  ok("组合 token 流量合计 ↑6↓3", s.entries.reduce((a, e) => a + (e.stats.tin ?? 0), 0) === 6 && s.entries.reduce((a, e) => a + (e.stats.tout ?? 0), 0) === 3);
  ok("命中槽位有粘性绑定", s.entries.some((e) => e.stats.ok === 1 && e.pinned === 1), JSON.stringify(s.entries.map((e) => ({ n: e.name, ok: e.stats.ok, pinned: e.pinned }))));
  c.stop(); up.close();
}

// ---------- 场景 4：upstream 含 userinfo 凭据 → status 脱敏，不泄露 ----------
{
  const tk = token();
  const c = new ProxyServer({
    provider: "status4", upstream: "https://user:secretpass@example.com/v1", api: "openai-completions",
    authToken: tk, port: await freeP(), apiKeys: [{ name: "k1", key: "sk-a" }],
  });
  const blob = JSON.stringify(c.status());
  ok("upstream userinfo 已脱敏（无 secretpass / user@）", !blob.includes("secretpass") && !blob.includes("user@"), blob.match(/https:[^"]*/)?.[0]);
}

finish("status() 运行状态快照");
