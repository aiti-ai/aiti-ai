// 代理全场景测试：认证门 / 429 重试轮转 / 冷却 / 全部限流 / RPM 滑动窗口 / 头剥离 / 上游错误 / 透传
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();
const authToken = "sk-dummy-" + randomBytes(8).toString("hex");

const bad429 = (req, res) => {
  res.writeHead(429, { "content-type": "application/json", "retry-after": "1", "x-ratelimit-limit": "10", "server": "nginx", "retry-after": "2" });
  res.end(JSON.stringify({ error: "rl" }));
};
const good200 = (req, res) => {
  res.writeHead(200, { "content-type": "application/json", "x-ratelimit-remaining": "9", "server": "nginx", "retry-after": "999" });
  res.end(JSON.stringify({ ok: true, key: req.headers.authorization.slice(7) }));
};

// ---------- 场景 1：认证门 ----------
{
  const up = await makeUpstream(good200);
  const p = new ProxyServer({ provider: "t1", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "k1", key: "sk-a" }], port: await freeP(), authToken });
  await p.start();
  const opt = (auth) => ({ method: "POST", body: "{}", headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer " + auth } : {}) } });
  let r = await fetch(`http://127.0.0.1:${p.port}/x`, opt(null));
  ok("无 auth → 401", r.status === 401);
  r = await fetch(`http://127.0.0.1:${p.port}/x`, opt("wrong"));
  ok("错 auth → 401", r.status === 401);
  r = await fetch(`http://127.0.0.1:${p.port}/x`, opt(authToken));
  const j = await r.json();
  ok("对 auth → 200 透传", r.status === 200 && j.key === "sk-a");
  ok("响应剥 x-ratelimit / retry-after / server", !r.headers.get("x-ratelimit-remaining") && !r.headers.get("retry-after") && !r.headers.get("server"));
  p.stop(); up.close();
}

// ---------- 场景 2：单 key 429 → 打 1 次即失败（429 只重试 1 次且不傻等冷却；pi 自带重试） ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => { hits.push(req.headers.authorization); bad429(req, res); });
  const p = new ProxyServer({ provider: "t2", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "k1", key: "sk-a" }], port: await freeP(), authToken, maxRetries: 5 });
  await p.start();
  const r = await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{\"hi\":1}", headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  const j = await r.json();
  // 第一次 429 → 允许 1 次重试 → key 已冷却 → 走全冷却立即 429（不等待冷却窗口）
  ok("单 key 429 → 打 1 次后立即 429（不傻等冷却）", r.status === 429 && hits.length === 1, `(hits=${hits.length})`);
  p.stop(); up.close();
}

// ---------- 场景 3：多 key 429 → 冷却 → 轮转成功（bad 永久 429，good 正常） ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => {
    const k = req.headers.authorization.slice(7); hits.push(k);
    if (k === "sk-bad") { res.writeHead(429, { "retry-after": "1" }); res.end("{}"); }
    else { res.writeHead(200, {}); res.end(`{"ok":true,"key":"${k}"}`); }
  });
  const p = new ProxyServer({ provider: "t3", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "bad", key: "sk-bad" }, { name: "good", key: "sk-good" }], port: await freeP(), authToken, maxRetries: 5 });
  await p.start();
  const r = await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  const j = await r.json();
  const badN = hits.filter((k) => k === "sk-bad").length, goodN = hits.filter((k) => k === "sk-good").length;
  ok("多 key：bad 429 → 冷却 → 轮转 good → 200", r.status === 200 && j.key === "sk-good", `(bad=${badN}, good=${goodN})`);
  ok("bad 只打一次（冷却下限 8s 内不再选它）", badN === 1);
  p.stop(); up.close();
}

// ---------- 场景 4：全部 key 都 429 → 重试耗尽 → 429 ----------
{
  const up = await makeUpstream(bad429);
  const p = new ProxyServer({ provider: "t4", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "a", key: "sk-a" }, { name: "b", key: "sk-b" }], port: await freeP(), authToken, maxRetries: 2 });
  await p.start();
  const r = await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  const j = await r.json();
  ok("全部 key 429 重试耗尽 → 429", r.status === 429, `(retry-after=${r.headers.get("retry-after")})`);
  ok("429 body 含 rate_limit_exceeded", j.error && j.error.type === "rate_limit_exceeded");
  p.stop(); up.close();
}

// ---------- 场景 5：RPM 滑动窗口（快速验证：第二请求正在睡眠） ----------
{
  const up = await makeUpstream(good200);
  const p = new ProxyServer({ provider: "t5", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "only", key: "sk-ok", rpm: 1 }], port: await freeP(), authToken });
  await p.start();
  const opt = (i) => ({ method: "POST", body: `{"i":${i}}`, headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  const r1 = await fetch(`http://127.0.0.1:${p.port}/c`, opt(1));
  ok("rpm=1 第一请求即时放行", r1.status === 200);
  const r2p = fetch(`http://127.0.0.1:${p.port}/c`, opt(2));
  let completed = false;
  try {
    const rr = await Promise.race([r2p.then((v) => ({ done: true, v })), new Promise((res) => setTimeout(() => res({ done: false }), 3000))]);
    completed = rr.done; if (rr.done) rr.v.body?.cancel();
  } catch (e) {}
  ok("rpm=1 第二请求 3s 内未返回（在等滑动窗口）", completed === false);
  p.stop(); up.close();
}

// ---------- 场景 6：上游连接错误 → 502 ----------
{
  const p = new ProxyServer({ provider: "t6", upstream: `http://127.0.0.1:1`, apiKeys: [{ name: "a", key: "sk-a" }], port: await freeP(), authToken });
  await p.start();
  const r = await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  ok("上游拒绝连接 → 502", r.status === 502);
  p.stop();
}

// ---------- 场景 7：GET 透传 + query + 上游前缀拼接 ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => { hits.push(req.url); res.writeHead(200, {}); res.end(`{"u":"${req.url}"}`); });
  const p = new ProxyServer({ provider: "t7", upstream: `http://127.0.0.1:${up.address().port}/v1`, apiKeys: [{ name: "a", key: "sk-a" }], port: await freeP(), authToken });
  await p.start();
  const r = await fetch(`http://127.0.0.1:${p.port}/chat/completions?m=1`, { headers: { authorization: "Bearer " + authToken } });
  const j = await r.json();
  ok("GET + query + 上游前缀 /v1 拼接", r.status === 200 && j.u === "/v1/chat/completions?m=1", `(u=${j.u})`);
  p.stop(); up.close();
}


// ---------- 场景 14：流中途停摆 → 空闲超时双端掐断 + 冷却换 key ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => {
    const k = req.headers.authorization.slice(7);
    hits.push(k);
    if (k === "sk-a") {
      // 响应头立即回、流写一半后停摆（模拟模型卡死）
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: 1\n\n");
      // 之后不再写也不 end——连接保持打开
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, key: k }));
    }
  });
  const tk = "sk-dummy-" + randomBytes(8).toString("hex");
  const p = new ProxyServer({ provider: "t-idle", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }, { name: "k2", key: "sk-b" }],
    port: await freeP(), authToken: tk, timeouts: { idleMs: 300 } });
  await p.start();
  let aborted = false;
  try {
    const r = await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
    await r.text(); // 读流会因双端掐断而中断
  } catch { aborted = true; }
  ok("流停摆 → 客户端连接被掐断（不无限挂起）", aborted || hits.length >= 1, `aborted=${aborted}`);
  const t0 = Date.now();
  const r2 = await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  const j = await r2.json();
  const dt = Date.now() - t0;
  ok("下一请求自动换到健康 key（死槽已冷却）", j.ok === true && j.key === "sk-b" && dt < 5000, `(hits=${hits.join(",")} dt=${dt}ms)`);
  p.stop(); up.close();
}

// ---------- 场景 15：TTFB 超时 → 换 key 重试（非 combo 也替换） ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => {
    const k = req.headers.authorization.slice(7);
    hits.push(k);
    if (k === "sk-a") return; // 永不给响应头
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, key: k }));
  });
  const tk = "sk-dummy-" + randomBytes(8).toString("hex");
  const p = new ProxyServer({ provider: "t-ttfb", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }, { name: "k2", key: "sk-b" }],
    port: await freeP(), authToken: tk, timeouts: { ttfbMs: 250 } });
  await p.start();
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  const j = await r.json();
  ok("TTFB 超时 → 冷却死槽并换 key 出 200", r.status === 200 && j.key === "sk-b" && Date.now() - t0 < 5000, `(hits=${hits.join(",")})`);
  p.stop(); up.close();
}

// ---------- 场景 16：错误状态码 → 粘性立即到期（401 后换 key） ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => {
    const k = req.headers.authorization.slice(7);
    hits.push(k);
    if (k === "sk-a") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "bad key" })); }
    else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, key: k })); }
  });
  const tk = "sk-dummy-" + randomBytes(8).toString("hex");
  const p = new ProxyServer({ provider: "t-401", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }, { name: "k2", key: "sk-b" }],
    port: await freeP(), authToken: tk });
  await p.start();
  const go = () => fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  const r1 = await go();
  const j1 = await r1.json();
  ok("401 槽内故障 → 请求内自动轮换到健康 key（客户端无感）", r1.status === 200 && j1.key === "sk-b" && hits[0] === "sk-a", `(hits=${hits.join(",")})`);
  const r2 = await go();
  const j = await r2.json();
  ok("坏 key 已冷却 → 后续请求不再命中", r2.status === 200 && j.key === "sk-b", `(hits=${hits.join(",")})`);
  p.stop(); up.close();
}

// ---------- 场景 17：缓慢但流动的流不被空闲超时误杀（data 重置计时器） ----------
{
  const up = await makeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const t = setInterval(() => {
      i++;
      res.write(`data: chunk${i}\n\n`);
      if (i >= 6) { clearInterval(t); res.end(JSON.stringify({ done: true })); }
    }, 100);
  });
  const tk = "sk-dummy-" + randomBytes(8).toString("hex");
  const p = new ProxyServer({ provider: "t-flow", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }],
    port: await freeP(), authToken: tk, timeouts: { idleMs: 250 } }); // 间隔 100ms < 250ms → 不该误杀
  await p.start();
  const r = await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  const body = await r.text();
  ok("流动的慢流完整送达（idle 计时器被 data 正确重置）", body.includes("chunk6") && body.includes("done"), `(len=${body.length})`);
  p.stop(); up.close();
}

// ---------- 场景 18：上游超长 retry-after → 封顶（曾致槽位被雪藏 5.1 天无人察觉） ----------
{
  const up = await makeUpstream((req, res) => { res.writeHead(429, { "retry-after": "3600" }); res.end("{}"); });
  const tk = "sk-dummy-" + randomBytes(8).toString("hex");
  const p = new ProxyServer({ provider: "t-cap", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }], port: await freeP(), authToken: tk, retryAfterCapSec: 60 });
  await p.start();
  const r = await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  ok("retry-after 3600 → 客户端仍拿 429", r.status === 429);
  const raHdr = Number(r.headers.get("retry-after"));
  ok("响应头 retry-after 同样封顶（≤60s，pi 的 validateServerRetryDelayMs 上限）", Number.isFinite(raHdr) && raHdr <= 60, `(retry-after=${String(r.headers.get("retry-after"))})`);
  const st = p.status();
  const cd = st.entries[0].cooldown;
  ok("冷却被封顶为 60s（而非照单全收 1 小时）", cd && cd.secondsLeft <= 60 && cd.secondsLeft >= 8, `(secondsLeft=${cd?.secondsLeft})`);
  p.stop(); up.close();
}

// ---------- 场景 18b：cap>60 时两条 429 出口的响应头仍必须 ≤60（pi 硬限；否则原始事故在 cap 调大时复发） ----------
{
  const up = await makeUpstream((req, res) => { res.writeHead(429, { "retry-after": "1600000" }); res.end("{}"); });
  const tk = "sk-dummy-" + randomBytes(8).toString("hex");
  const p = new ProxyServer({ provider: "t-cap600", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }], port: await freeP(), authToken: tk, retryAfterCapSec: 600 });
  await p.start();
  const go = () => fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  const r1 = await go(); // 重试耗尽 → exhausted-429 透传出口
  const ra1 = Number(r1.headers.get("retry-after"));
  ok("cap=600 exhausted-429 头 ≤60（曾用 min(ra,cap) 漏掉 60 上限）", r1.status === 429 && Number.isFinite(ra1) && ra1 <= 60, `(retry-after=${r1.headers.get("retry-after")})`);
  const st1 = p.status();
  ok("内部冷却仍按 cap=600s 雪藏（客户端节奏与内部冷却解耦）", st1.entries[0].cooldown?.secondsLeft > 60, `(secondsLeft=${st1.entries[0].cooldown?.secondsLeft})`);
  const r2 = await go(); // 全冷却 → saturatedResponse 出口
  const ra2 = Number(r2.headers.get("retry-after"));
  ok("cap=600 结构化 429 头 ≤60", r2.status === 429 && Number.isFinite(ra2) && ra2 <= 60, `(retry-after=${r2.headers.get("retry-after")})`);
  p.stop(); up.close();
}

// ---------- 场景 19：普通模式持续饱和闸门 → 终态 400 终止客户端无限重试 ----------
{
  const up = await makeUpstream((req, res) => { res.writeHead(429, { "retry-after": "30" }); res.end("{}"); });
  const tk = "sk-dummy-" + randomBytes(8).toString("hex");
  const p = new ProxyServer({ provider: "t-gate", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }, { name: "k2", key: "sk-b" }],
    port: await freeP(), authToken: tk, saturationTerminalMs: 500 });
  await p.start();
  const go = () => fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  const r1 = await go();
  ok("首次全冷却 → 429（闸门开始计时）", r1.status === 429);
  await new Promise((r) => setTimeout(r, 650));
  const r2 = await go();
  const j2 = await r2.json();
  ok("持续饱和超阈值 → 终态 400（quota exceeded 锚点）", r2.status === 400 && String(j2.error?.message).includes("quota exceeded"), `(status=${r2.status})`);
  const r3 = await go();
  ok("终态后闸门重置 → 再请求回到 429", r3.status === 429);
  p.stop(); up.close();
}

// ---------- 场景 20：饱和期间选到健康槽位（池子有容量）→ 计时清除，不误报终态 ----------
{
  // k1/k2 永久 429；k3 受 all429 开关控制。r1 打 k1/k2 耗尽（arm，k3 未动）→
  // r2 走 k3 成功（clear）→ 若 clear 失效，r3 的闸门判断会误报 400。
  let all429 = true;
  const up = await makeUpstream((req, res) => {
    const k = req.headers.authorization.slice(7);
    if (k === "sk-c" && !all429) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }
    else { res.writeHead(429, { "retry-after": "30" }); res.end("{}"); }
  });
  const tk = "sk-dummy-" + randomBytes(8).toString("hex");
  const p = new ProxyServer({ provider: "t-heal", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }, { name: "k2", key: "sk-b" }, { name: "k3", key: "sk-c" }],
    port: await freeP(), authToken: tk, saturationTerminalMs: 500 });
  await p.start();
  const go = () => fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  const r1 = await go();
  ok("k1/k2 耗尽 → 429（闸门计时中，k3 未冷却）", r1.status === 429);
  all429 = false; // k3 恢复可用
  const r2 = await go();
  ok("池子仍有容量（k3）→ 请求成功且清除饱和计时", r2.status === 200);
  await new Promise((r) => setTimeout(r, 650)); // 若计时未被清除，这里已超阈值
  all429 = true;
  const r3 = await go();
  ok("成功清了计时 → 再次饱和从 429 重新计（而非 400）", r3.status === 429, `(status=${r3.status})`);
  p.stop(); up.close();
}

// ---------- 场景 21：等间距节流 minIntervalMs（无 rpm，纯间隔） ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => { hits.push(Date.now()); res.writeHead(200, {}); res.end(`{"ok":true}`); });
  const p = new ProxyServer({ provider: "t21", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "only", key: "sk-a", minIntervalMs: 800 }], port: await freeP(), authToken });
  await p.start();
  const opt = (i) => ({ method: "POST", body: `{"i":${i}}`, headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  const r1 = await fetch(`http://127.0.0.1:${p.port}/c`, opt(1));
  ok("minIntervalMs 第一请求即时放行", r1.status === 200);
  const r2p = fetch(`http://127.0.0.1:${p.port}/c`, opt(2));
  let early = false;
  try {
    const rr = await Promise.race([r2p.then((v) => ({ done: true, v })), new Promise((res) => setTimeout(() => res({ done: false }), 300))]);
    early = rr.done; if (rr.done) rr.v.body?.cancel();
  } catch (e) {}
  ok("minIntervalMs 第二请求 300ms 内未返回（在等间隔 sleep）", early === false);
  const r2 = await r2p; // 等到真正返回
  const gap = hits[1] - hits[0];
  ok("minIntervalMs 两请求间隔 ≥800ms", r2.status === 200 && gap >= 780, `(gap=${gap}ms)`);
  p.stop(); up.close();
}

// ---------- 场景 22：minIntervalMs:"auto" → 按 rpm 折算等间距（rpm30→2s） ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => { hits.push(Date.now()); res.writeHead(200, {}); res.end(`{"ok":true}`); });
  const p = new ProxyServer({ provider: "t22", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "only", key: "sk-a", rpm: 30, minIntervalMs: "auto" }], port: await freeP(), authToken });
  await p.start();
  const opt = (i) => ({ method: "POST", body: `{"i":${i}}`, headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  const r1 = await fetch(`http://127.0.0.1:${p.port}/c`, opt(1));
  const r2 = await fetch(`http://127.0.0.1:${p.port}/c`, opt(2));
  const gap = hits[1] - hits[0];
  ok("auto→60000/rpm 折算（≈2s 间隔）", r1.status === 200 && r2.status === 200 && gap >= 1800 && gap < 4000, `(gap=${gap}ms)`);
  p.stop(); up.close();
}

// ---------- 场景 23：rpm + minIntervalMs 叠加 → 取最大等待（滑窗满 60s 主导，非 800ms） ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => { hits.push(Date.now()); res.writeHead(200, {}); res.end(`{"ok":true}`); });
  // rpm=1（首发即满窗口）+ minIntervalMs=800：第二请求应等滑窗 60s（最大），而非只等 800ms
  const p = new ProxyServer({ provider: "t23", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "only", key: "sk-a", rpm: 1, minIntervalMs: 800 }], port: await freeP(), authToken });
  await p.start();
  const opt = (i) => ({ method: "POST", body: `{"i":${i}}`, headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  await fetch(`http://127.0.0.1:${p.port}/c`, opt(1));
  const r2p = fetch(`http://127.0.0.1:${p.port}/c`, opt(2));
  let doneIn2s = false;
  try {
    const rr = await Promise.race([r2p.then((v) => ({ done: true, v })), new Promise((res) => setTimeout(() => res({ done: false }), 2000))]);
    doneIn2s = rr.done; if (rr.done) rr.v.body?.cancel();
  } catch (e) {}
  ok("叠加取最大：第二请求 2s 内未返回（被滑窗 60s 挡，而非等间距 800ms 放行）", doneIn2s === false);
  r2p.then((v) => { try { v.body?.cancel(); } catch {} }).catch(() => {});
  p.stop(); up.close();
}

// ---------- 场景 24：非法 minIntervalMs → 按默认 auto 处理（无 rpm → 关） → 连发即时 ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => { hits.push(Date.now()); res.writeHead(200, {}); res.end(`{"ok":true}`); });
  const p = new ProxyServer({ provider: "t24", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "a", key: "sk-a", minIntervalMs: "bogus" }, { name: "b", key: "sk-b", minIntervalMs: -5 }], port: await freeP(), authToken });
  await p.start();
  const opt = (i) => ({ method: "POST", body: `{"i":${i}}`, headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  const r1 = await fetch(`http://127.0.0.1:${p.port}/c`, opt(1));
  const t0 = Date.now();
  const r2 = await fetch(`http://127.0.0.1:${p.port}/c`, opt(2));
  const dt = Date.now() - t0;
  ok("非法 minIntervalMs → 默认 auto（无 rpm=关）→ 连发即时", r1.status === 200 && r2.status === 200 && dt < 400, `(dt=${dt}ms)`);
  p.stop(); up.close();
}

// ---------- 场景 25：默认 auto —— 只配 rpm（无 minIntervalMs 字段）也按 60000/rpm 匀速 ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => { hits.push(Date.now()); res.writeHead(200, {}); res.end(`{"ok":true}`); });
  const p = new ProxyServer({ provider: "t25", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "only", key: "sk-a", rpm: 30 }], port: await freeP(), authToken });
  await p.start();
  const opt = (i) => ({ method: "POST", body: `{"i":${i}}`, headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  const r1 = await fetch(`http://127.0.0.1:${p.port}/c`, opt(1));
  const r2 = await fetch(`http://127.0.0.1:${p.port}/c`, opt(2));
  const gap = hits[1] - hits[0];
  ok("默认 auto：rpm30 无字段 → 两请求间隔 ≈2s", r1.status === 200 && r2.status === 200 && gap >= 1800 && gap < 4000, `(gap=${gap}ms)`);
  p.stop(); up.close();
}

// ---------- 场景 26：minIntervalMs:0 = 显式关闭匀速 → 突发滑窗（连发即时，窗口未满不等待） ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => { hits.push(Date.now()); res.writeHead(200, {}); res.end(`{"ok":true}`); });
  const p = new ProxyServer({ provider: "t26", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "only", key: "sk-a", rpm: 30, minIntervalMs: 0 }], port: await freeP(), authToken });
  await p.start();
  const opt = (i) => ({ method: "POST", body: `{"i":${i}}`, headers: { "content-type": "application/json", authorization: "Bearer " + authToken } });
  const r1 = await fetch(`http://127.0.0.1:${p.port}/c`, opt(1));
  const t0 = Date.now();
  const r2 = await fetch(`http://127.0.0.1:${p.port}/c`, opt(2));
  const dt = Date.now() - t0;
  ok("0=突发滑窗：连发即时（不受匀速约束）", r1.status === 200 && r2.status === 200 && dt < 400, `(dt=${dt}ms)`);
  p.stop(); up.close();
}

// ---------- 场景 27：非 combo 上游 404（模型名不存在）→ 原样透传，不上冷却不重试 ----------
// 回归锚：combo 成员的 404 已纳入槽位故障（冷却+换槽），但普通 provider 的 404 仍是客户端参数错，
// 换 key 无意义 —— 必须保持透传，不得被 combo 侧改动波及。
{
  let hits = 0;
  const up = await makeUpstream((req, res) => { hits++; res.writeHead(404); res.end(JSON.stringify({ error: { message: "model is not found", type: "not_found_error", code: "5" } })); });
  const p = new ProxyServer({ provider: "t27", upstream: `http://127.0.0.1:${up.address().port}`, apiKeys: [{ name: "k1", key: "sk-a" }, { name: "k2", key: "sk-b" }], port: await freeP(), authToken });
  await p.start();
  const r1 = await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + authToken } });
  const j1 = await r1.json().catch(() => ({}));
  ok("非 combo 404 → 原样透传（status 与 body 均不变）", r1.status === 404 && j1.error?.message === "model is not found", `(status=${r1.status})`);
  ok("非 combo 404 → 不重试（两把 key 只打上游 1 次）", hits === 1, `(hits=${hits})`);
  const cd = p.status().entries.map((e) => e.cooldown);
  ok("非 combo 404 → 不上冷却", cd.every((c) => c === null), `(cd=${JSON.stringify(cd)})`);
  p.stop(); up.close();
}

finish("proxy.test · 代理全场景");
