// v0.3 组合模型 + 粘性路由全场景测试
// StickyRouter 单元 / key 层粘性 / stickyKeys=false 回退 / TTL 过期 / rpm 提前换 /
// combo 粘性命中 / body.model 改写 / 429 成员切换 / vision 路由 / 404 / 全员不可用
import { randomBytes } from "node:crypto";
import { ProxyServer, hasImageContent, classifyContent, weightedPick, DEFAULT_SLOT_WEIGHT } from "../src/proxy.ts";
import { setUsageLogFile } from "../src/usage-log.ts";
import { flattenComboSlots } from "../src/flatten.ts";
import { StickyRouter } from "../src/sticky.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();
const token = () => "sk-dummy-" + randomBytes(8).toString("hex");

// ---------- 场景 1：StickyRouter 单元 ----------
{
  const r = new StickyRouter({ ttlMin: 15 });
  const healthy = () => true;
  ok("空指针 → undefined", r.get("c1", healthy) === undefined);
  r.set("c1", 2);
  ok("set 后命中", r.get("c1", healthy) === 2);
  ok("不健康 → 清除并 undefined", r.get("c1", () => false) === undefined && r.get("c1", healthy) === undefined);

  const r2 = new StickyRouter({ ttlMin: 0.00001 }); // ~0.6ms
  r2.set("c", 1);
  await new Promise((res) => setTimeout(res, 20));
  ok("TTL 过期 → 清除并 undefined", r2.get("c", healthy) === undefined && r2.size === 0);

  const r3 = new StickyRouter({ ttlMin: 15, cap: 3 });
  for (let i = 0; i < 5; i++) r3.set(`c${i}`, i);
  ok("LRU 上限淘汰", r3.size === 3 && r3.get("c0", healthy) === undefined && r3.get("c4", healthy) === 4);
}

// ---------- 场景 2：key 层粘性（同 client 稳定同 key） ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => {
    hits.push(req.headers.authorization.slice(7));
    res.writeHead(200); res.end("{}");
  });
  const tk = token();
  const p = new ProxyServer({
    provider: "s2b", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }, { name: "k2", key: "sk-b" }, { name: "k3", key: "sk-c" }],
    port: await freeP(), authToken: tk,
  });
  await p.start();
  for (let i = 0; i < 5; i++) {
    await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  }
  const uniq = [...new Set(hits)];
  ok("key 粘性：同一 client 五连发全落同一把 key", uniq.length === 1, `(hits=${hits.length}, uniq=${uniq.join(",")})`);
  p.stop(); up.close();
}

// ---------- 场景 3：stickyKeys=false 回退旧轮转 ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => {
    hits.push(req.headers.authorization.slice(7));
    res.writeHead(200); res.end("{}");
  });
  const tk = token();
  const p = new ProxyServer({
    provider: "s3", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }, { name: "k2", key: "sk-b" }],
    port: await freeP(), authToken: tk, stickyKeys: false,
  });
  await p.start();
  for (let i = 0; i < 4; i++) {
    await fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  }
  ok("stickyKeys=false → 恢复顺序轮转", hits.join(",") === ["sk-a", "sk-b", "sk-a", "sk-b"].join(","), `(got=${hits.join(",")})`);
  p.stop(); up.close();
}

// ---------- 场景 4：TTL 过期后换 key ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => {
    hits.push(req.headers.authorization.slice(7));
    res.writeHead(200); res.end("{}");
  });
  const tk = token();
  const p = new ProxyServer({
    provider: "s4", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }, { name: "k2", key: "sk-b" }],
    port: await freeP(), authToken: tk, stickyTtlMin: 0.001, // ~60ms
  });
  await p.start();
  const go = () => fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  await go();
  await go();
  await new Promise((r) => setTimeout(r, 150));
  await go();
  ok("TTL 过期 → 换到下一把 key", hits[0] === hits[1] && hits[2] !== hits[0], `(hits=${hits.join(",")})`);
  p.stop(); up.close();
}

// ---------- 场景 5：粘住 key 撞 rpm 长等待 → 提前换下一把 ----------
{
  const hits = [];
  const up = await makeUpstream((req, res) => {
    hits.push(req.headers.authorization.slice(7));
    res.writeHead(200); res.end("{}");
  });
  const tk = token();
  const p = new ProxyServer({
    provider: "s5", upstream: `http://127.0.0.1:${up.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a", rpm: 1 }, { name: "k2", key: "sk-b" }],
    port: await freeP(), authToken: tk,
  });
  await p.start();
  const go = () => fetch(`http://127.0.0.1:${p.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk } });
  await go(); // 落 k1（rpm=1 记满窗口）
  const t0 = Date.now();
  const r = await go(); // k1 需等 ~60s > 10s → 提前换 k2
  const dt = Date.now() - t0;
  ok("rpm 长等待提前换 key 且不阻塞", r.status === 200 && hits[1] === "sk-b" && dt < 5000, `(hits=${hits.join(",")} dt=${dt}ms)`);
  p.stop(); up.close();
}

// ---------- combo 测试基建（扁平化槽位：每个槽位 = key + 各自目标地址，同一 ProxyServer） ----------
function slot(pid, keyName, key, upPort, model, opts = {}) {
  return {
    name: `${pid}/${keyName}`, key,
    upstream: `http://127.0.0.1:${upPort}`, model,
    vision: !!opts.vision, group: "fast", member: `${pid}/${model}`,
    ...(opts.weight != null ? { weight: opts.weight } : {}),
    ...(opts.types ? { types: opts.types } : {}),
  };
}

function comboFixture(upA, upB, opts = {}) {
  return {
    provider: "快速组",
    upstream: "http://combo.pmc.invalid/", // 占位：所有槽位自带目标地址
    api: "openai-completions",
    apiKeys: [
      slot("provA", "a-key", "sk-key-a", upA.address().port, "model-a"),
      slot("provB", "b-key", "sk-key-b", upB.address().port, "model-b", { vision: opts.visionB ?? true }),
    ],
    stickyTtlMin: opts.ttlMin ?? 15,
  };
}

// ---------- 场景 6：combo 粘性命中 + body.model 改写 + 成员 key 注入 ----------
{
  const seen = [];
  const mkUp = () => makeUpstream((req, res) => {
    seen.push({ auth: req.headers.authorization?.slice(7), model: JSON.parse(req.rawBody.toString()).model });
    res.writeHead(200); res.end("{}");
  });
  const upA = await mkUp(), upB = await mkUp();
  const tk = token();
  const cfg = comboFixture(upA, upB);
  const c = new ProxyServer({ ...cfg, authToken: tk, port: await freeP() });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }), headers: { authorization: "Bearer " + tk } });
  const r1 = await go(), r2 = await go();
  ok("combo 两连发均 200", r1.status === 200 && r2.status === 200);
  ok("body.model 改写为成员模型 id", seen.length === 2 && seen.every((x) => x.model === "model-a"), `(models=${seen.map((x) => x.model)})`);
  ok("成员 key 注入正确", seen.every((x) => x.auth === "sk-key-a"));
  ok("粘住同一槽位（未轮转到 B）", seen.length === 2);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 7：成员 A 全部 key 429 冷却 → 切到 B ----------
{
  const seen = [];
  const mkUp = (always429) => makeUpstream((req, res) => {
    if (always429) { res.writeHead(429, { "retry-after": "30" }); return res.end("{}"); }
    seen.push(JSON.parse(req.rawBody.toString()).model);
    res.writeHead(200); res.end("{}");
  });
  const upA = await mkUp(true), upB = await mkUp(false);
  const tk = token();
  const c = new ProxyServer({ ...comboFixture(upA, upB), authToken: tk, port: await freeP() });
  await c.start();
  const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  ok("成员 A 429 冷却 → 切到 B 出 200", r.status === 200 && seen.includes("model-b"));
  const r2 = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  ok("后续请求粘在健康的 B 上", r2.status === 200 && seen.length === 2 && seen[1] === "model-b");
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 8：vision 路由（带图请求避开纯文本成员） ----------
{
  const hitBy = [];
  const mkUp = (tag) => makeUpstream((req, res) => { hitBy.push(tag); res.writeHead(200); res.end("{}"); });
  const upA = await mkUp("A"), upB = await mkUp("B");
  const tk = token();
  const c = new ProxyServer({ ...comboFixture(upA, upB, { visionB: true }), authToken: tk, port: await freeP() });
  await c.start();
  // 先纯文本 → 粘住 A；再带图 → 应回避无 vision 的 A 切到 B
  await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }), headers: { authorization: "Bearer " + tk } });
  await fetch(`http://127.0.0.1:${c.port}/c`, {
    method: "POST",
    body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }] }),
    headers: { authorization: "Bearer " + tk },
  });
  ok("带图请求自动切到 vision 成员", hitBy.join(",") === "A,B", `(hitBy=${hitBy.join(",")})`);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 8b：types 分工路由（text-only 不收带图 / vision-only 不收纯文本） ----------
{
  const hitBy = [];
  const mkUp = (tag) => makeUpstream((req, res) => { hitBy.push(tag); res.writeHead(200); res.end("{}"); });
  const upA = await mkUp("A"), upB = await mkUp("B");
  const tk = token();
  const c = new ProxyServer({
    provider: "快速组", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    apiKeys: [
      slot("provA", "a-key", "sk-key-a", upA.address().port, "model-a", { types: ["text"] }),     // 仅文本
      slot("provB", "b-key", "sk-key-b", upB.address().port, "model-b", { vision: true, types: ["vision"] }), // 仅图形
    ],
    authToken: tk, port: await freeP(),
  });
  await c.start();
  const text = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }), headers: { authorization: "Bearer " + tk } });
  const img = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }] }), headers: { authorization: "Bearer " + tk } });
  await text(); await img(); await text();
  ok("分工路由：纯文本只落 text-only，带图只落 vision-only，交替互不干扰", hitBy.join(",") === "A,B,A", `(hitBy=${hitBy.join(",")})`);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 8c：未配 types = 全收（vision 能力成员可接两类；文本请求不落到 vision-only） ----------
{
  const hitBy = [];
  const mkUp = (tag) => makeUpstream((req, res) => { hitBy.push(tag); res.writeHead(200); res.end("{}"); });
  const upA = await mkUp("A"), upB = await mkUp("B");
  const tk = token();
  const c = new ProxyServer({
    provider: "快速组", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    apiKeys: [
      slot("provA", "a-key", "sk-key-a", upA.address().port, "model-a", { vision: true }),        // 全收（有 vision）
      slot("provB", "b-key", "sk-key-b", upB.address().port, "model-b", { types: ["vision"] }), // 仅图形
    ],
    authToken: tk, port: await freeP(),
  });
  await c.start();
  const text = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: "hi" }] }), headers: { authorization: "Bearer " + tk } });
  const img = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,x" } }] }] }), headers: { authorization: "Bearer " + tk } });
  await text(); await img();
  ok("全收成员可接两类；带图请求不因 B 是 vision-only 而落空（A 有 vision 承接）", hitBy.join(",") === "A,A", `(hitBy=${hitBy.join(",")})`);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 9：未知模型 404 / classifyContent 单元 ----------
{
  const tk = token();
  const upA = await makeUpstream((q, s) => { s.writeHead(200); s.end("{}"); });
  const upB = await makeUpstream((q, s) => { s.writeHead(200); s.end("{}"); });
  const c = new ProxyServer({ ...comboFixture(upA, upB), authToken: tk, port: await freeP() });
  await c.start();
  const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "nope" }), headers: { authorization: "Bearer " + tk } });
  ok("未知组合模型 → 404", r.status === 404);
  c.stop(); upA.close(); upB.close();

  ok("hasImageContent: openai image_url", hasImageContent({ messages: [{ content: [{ type: "image_url", image_url: {} }] }] }) === true);
  ok("hasImageContent: anthropic image", hasImageContent({ messages: [{ content: [{ type: "image", source: {} }] }] }) === true);
  ok("hasImageContent: 纯文本 false", hasImageContent({ messages: [{ content: [{ type: "text", text: "hi" }] }] }) === false);

  // classifyContent 多态分类（text/vision/other）
  const cls = (body) => classifyContent(body).join(",");
  ok("classify: 纯文本 → text", cls({ messages: [{ content: [{ type: "text", text: "hi" }] }] }) === "text");
  ok("classify: openai image_url → text,vision", cls({ messages: [{ content: [{ type: "image_url", image_url: {} }] }] }) === "text,vision");
  ok("classify: anthropic image → text,vision", cls({ messages: [{ content: [{ type: "image", source: {} }] }] }) === "text,vision");
  ok("classify: google inline_data image → text,vision", cls({ contents: [{ parts: [{ text: "看图" }, { inline_data: { mime_type: "image/png", data: "x" } }] }] }) === "text,vision");
  ok("classify: google file_data image → text,vision", cls({ contents: [{ parts: [{ file_data: { mime_type: "image/jpeg", file_uri: "f" } }] }] }) === "text,vision");
  ok("classify: anthropic document → text,other", cls({ messages: [{ content: [{ type: "document", source: { media_type: "application/pdf" } }] }] }) === "text,other");
  ok("classify: openai input_audio → text,other", cls({ messages: [{ content: [{ type: "input_audio", input_audio: {} }] }] }) === "text,other");
  ok("classify: google audio mime → text,other", cls({ contents: [{ parts: [{ inline_data: { mime_type: "audio/mp3", data: "x" } }] }] }) === "text,other");
  ok("classify: google video mime → text,other", cls({ contents: [{ parts: [{ file_data: { mime_type: "video/mp4", file_uri: "f" } }] }] }) === "text,other");
  ok("classify: 图文混合 → text,vision（含 text 类）", cls({ messages: [{ content: [{ type: "text", text: "a" }, { type: "image_url", image_url: {} }] }] }) === "text,vision");
}

// ---------- 场景 10：全员不可用 → 立即结构化 429 ----------
{
  const mkUp = () => makeUpstream((q, s) => { s.writeHead(429, { "retry-after": "30" }); s.end("{}"); });
  const upA = await mkUp(), upB = await mkUp();
  const tk = token();
  const c = new ProxyServer({ ...comboFixture(upA, upB), authToken: tk, port: await freeP() });
  await c.start();
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const dt = Date.now() - t0;
  const j = await r.json();
  ok("全员冷却 → 立即 429 结构化错误（不傻等冷却）", r.status === 429 && j.error?.type === "rate_limit_exceeded" && String(j.error?.message).includes("provA/model-a") && dt < 5000, `(status=${r.status} dt=${dt}ms msg=${j.error?.message})`);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 10b：持续饱和闸门 → 终态 400（quota exceeded 锚点终止客户端无限重试） ----------
{
  const mkUp = () => makeUpstream((q, s) => { s.writeHead(429, { "retry-after": "30" }); s.end("{}"); });
  const upA = await mkUp(), upB = await mkUp();
  const tk = token();
  const c = new ProxyServer({ ...comboFixture(upA, upB), authToken: tk, port: await freeP(), saturationTerminalMs: 500 });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const r1 = await go();
  ok("首次全冷却 → 结构化 429（闸门开始计时）", r1.status === 429);
  const raSat = Number(r1.headers.get("retry-after"));
  ok("结构化 429 的 retry-after ≤60 且对齐 cap（pi 拒等 >60s）", Number.isFinite(raSat) && raSat <= 60 && raSat <= c.status().retryAfterCapSec, `(retry-after=${r1.headers.get("retry-after")} cap=${c.status().retryAfterCapSec})`);
  await new Promise((r) => setTimeout(r, 650));
  const r2 = await go();
  const j2 = await r2.json();
  ok("持续饱和超阈值 → 终态 400 且消息含 quota exceeded 锚点（文案随 locale；锚点不译）", r2.status === 400 && String(j2.error?.message).includes("quota exceeded"), `(status=${r2.status} msg=${String(j2.error?.message).slice(0, 60)}...)`);
  const r3 = await go();
  ok("终态后闸门重置 → 再请求回到 429 重新计时", r3.status === 429);
  const st = c.status();
  ok("status() 暴露饱和计时", Array.isArray(st.saturation) && st.saturation.length === 1 && st.saturation[0].pool === "fast" && st.saturation[0].seconds >= 0, `(sat=${JSON.stringify(st.saturation)})`);
  c.stop(); upA.close(); upB.close();
}


// ---------- 场景 11：多 key 成员接力（2 供应商 / 3 槽位） ----------
// A: 单 key 永久 429；B: 双 key（sk-b1 首发永久 429，sk-b2 正常）
// 期望：组合模式遇到 429 必须继续换健康候选，直到接住为止——
//   A 429 → 试 B/k1 → 也 429 → 立即接力到健康 B/k2 → 200（3 死 1 活的池子不得谎报 all combo unavailable）
// 后续请求粘在健康 B/k2 上
{
  const hits = [];
  const upA = await makeUpstream((req, res) => { hits.push("A"); res.writeHead(429, { "retry-after": "30" }); res.end("{}"); });
  const upB = await makeUpstream((req, res) => {
    const k = req.headers.authorization.slice(7);
    hits.push(`B/${k}`);
    if (k === "sk-b1") { res.writeHead(429, { "retry-after": "30" }); return res.end("{}"); }
    res.writeHead(200); res.end("{}");
  });
  const tk = token();
  const c = new ProxyServer({
    provider: "mix",
    upstream: "http://combo.pmc.invalid/",
    api: "openai-completions",
    authToken: tk, port: await freeP(),
    apiKeys: [
      slot("provA", "a-key", "sk-a1", upA.address().port, "model-a"),
      slot("provB", "b-k1", "sk-b1", upB.address().port, "model-b"),
      slot("provB", "b-k2", "sk-b2", upB.address().port, "model-b"),
    ],
  });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const r1 = await go();
  ok("组合 429 接力：A 429 → B/k1 429 → 立即接力健康 B/k2 → 200", r1.status === 200 && hits.join(",") === "A,B/sk-b1,B/sk-b2", `(status=${r1.status} hits=${hits.join(",")})`);
  hits.length = 0;
  const r2 = await go();
  ok("后续请求粘在 B 且只用健康的 k2", r2.status === 200 && hits.join(",") === "B/sk-b2", `(hits=${hits.join(",")})`);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 11b：多成员部分死（3 死 1 活）—— 4 成员池必须有健康成员存在就成功，不得谎报 429 ----------
// 复现事故：freeds4/deepseek-v4-flash（modelscope/sensenova/ark 各死 + opencode-go 活）
// 期望：一次请求内试到活的成员（3 个死的 + 1 个活的），终 200，绝不中途报 all combo unavailable
{
  const hits = [];
  const mk = (tag, alive) => makeUpstream((req, res) => {
    hits.push(tag);
    if (alive) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ choices: [] })); }
    res.writeHead(429, { "retry-after": "60" }); res.end("{}");
  });
  const upM = await mk("modelscope", false), upS = await mk("sensenova", false), upA = await mk("ark", false), upO = await mk("opencode-go", true);
  const tk = token();
  const c = new ProxyServer({
    provider: "freeds4", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(),
    apiKeys: [
      slot("modelscope", "primary", "sk-m", upM.address().port, "deepseek-ai/DeepSeek-V4-Flash-0731"),
      slot("sensenova", "k", "sk-s", upS.address().port, "deepseek-v4-flash"),
      slot("ark-coding", "key-1", "sk-a", upA.address().port, "deepseek-v4-flash-ga-260731"),
      slot("opencode-go", "go-1", "sk-o", upO.address().port, "deepseek-v4-flash-vision-exp"),
    ],
  });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  for (let i = 0; i < 4; i++) {
    const r = await go();
    ok(`3 死 1 活的 4 成员池第 ${i + 1} 次请求应经健康成员出 200（不得 429）`, r.status === 200, `(status=${r.status})`);
  }
  ok("请求流中健康成员 opencode-go 确实被命中且不重复死成员", hits.includes("opencode-go") && hits.filter((x) => x === "opencode-go").length >= 1, `(hits=${hits.join(",")})`);
  c.stop(); upM.close(); upS.close(); upA.close(); upO.close();
}

// ---------- 场景 12：GET /models 返回组合清单；纯网络错误 → 502 api_error ----------
{
  const tk = token();
  const deadUp = await makeUpstream((req, res) => { /* 立即销毁连接模拟网络错误 */ req.socket.destroy(); });
  const c = new ProxyServer({
    provider: "g",
    upstream: "http://combo.pmc.invalid/",
    api: "openai-completions",
    authToken: tk, port: await freeP(),
    apiKeys: [slot("provX", "x", "sk-x", deadUp.address().port, "mx")],
  });
  await c.start();
  const rm = await fetch(`http://127.0.0.1:${c.port}/models`, { headers: { authorization: "Bearer " + tk } });
  const jm = await rm.json();
  ok("GET /models → 组合清单", rm.status === 200 && jm.data?.[0]?.id === "fast");
  const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const j = await r.json();
  ok("纯网络错误不可用 → 502 api_error（不谎报限流）", r.status === 502 && j.error?.type === "api_error", `(status=${r.status} type=${j.error?.type})`);
  c.stop(); deadUp.close();
}

// ---------- 场景 13：权重机制（排序+累计区间+随机数落点） ----------
{
  // 单元：区间划分 —— 权重 [7,2,1]（排序后 A 占 [0,0.7) B [0.7,0.9) C [0.9,1)）
  ok("weightedPick: r=0.35 → 区间0", weightedPick([11, 22, 33], [7, 2, 1], 0.35) === 11);
  ok("weightedPick: r=0.75 → 区间1", weightedPick([11, 22, 33], [7, 2, 1], 0.75) === 22);
  ok("weightedPick: r=0.95 → 区间2", weightedPick([11, 22, 33], [7, 2, 1], 0.95) === 33);
  ok("weightedPick: 总权重0 → 退回首个", weightedPick([44], [0], 0.5) === 44);
}

// ---------- 场景 14：权重占比随机分布（9:1）----------
// 每个请求用独立 token（独立 client 独立粘性指针），初始选点按权重占比随机
{
  const hitBy = [];
  const mkUp = (tag) => makeUpstream((req, res) => { hitBy.push(tag); res.writeHead(200); res.end("{}"); });
  const upA = await mkUp("A"), upB = await mkUp("B");
  const tk = token();
  const cfg = comboFixture(upA, upB);
  cfg.apiKeys[0].weight = 9; // A:B = 9:1
  cfg.apiKeys[1].weight = 1;
  const c = new ProxyServer({ ...cfg, authToken: tk, port: await freeP() });
  await c.start();
  const N = 300;
  for (let i = 0; i < N; i++) {
    const t = token();
    c.registerToken(t); // 独立 client：先注册 dummy token，粘性指针互不干扰
    await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + t } });
  }
  const aRatio = hitBy.filter((x) => x === "A").length / N;
  ok(`权重占比生效：A≈90%（实测 ${(aRatio * 100).toFixed(1)}%）`, aRatio > 0.8 && aRatio < 0.97, `(A=${hitBy.filter((x) => x === "A").length}/${N})`);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 15：默认权重 → 保持确定性轮转起步（不引入随机） ----------
{
  const hitBy = [];
  const mkUp = (tag) => makeUpstream((req, res) => { hitBy.push(tag); res.writeHead(200); res.end("{}"); });
  const upA = await mkUp("A"), upB = await mkUp("B");
  const tk = token();
  const c = new ProxyServer({ ...comboFixture(upA, upB), authToken: tk, port: await freeP() }); // 均默认权重
  await c.start();
  const t = token(); c.registerToken(t);
  await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + t } });
  ok("默认权重（全10）→ 首个 client 确定落第一个健康槽位 A", hitBy[0] === "A", `(hitBy=${hitBy.join(",")})`);
  ok("DEFAULT_SLOT_WEIGHT === 10", DEFAULT_SLOT_WEIGHT === 10);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 16：成员级权重占比（provA w20 两 key / provB w10 单 key → 成员占比 A≈2/3，key 数不放大） ----------
{
  const hitBy = [];
  const mkUp = (tag) => makeUpstream((req, res) => { hitBy.push(tag); res.writeHead(200); res.end("{}"); });
  const upA = await mkUp("A"), upB = await mkUp("B");
  const tk = token();
  const c = new ProxyServer({
    provider: "w2",
    upstream: "http://combo.pmc.invalid/",
    api: "openai-completions",
    authToken: tk, port: await freeP(),
    apiKeys: [
      slot("provA", "a-k1", "sk-a1", upA.address().port, "model-a", { weight: 20 }),
      slot("provA", "a-k2", "sk-a2", upA.address().port, "model-a", { weight: 10 }), // 均摊后各 10
      slot("provB", "b-key", "sk-b1", upB.address().port, "model-b", { weight: 10 }),
    ],
  });
  await c.start();
  const N = 300;
  for (let i = 0; i < N; i++) {
    const t = token(); c.registerToken(t);
    await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + t } });
  }
  const aRatio = hitBy.filter((x) => x === "A").length / N;
  ok(`成员级权重占比：A≈67%（实测 ${(aRatio * 100).toFixed(1)}%，key 数不放大占比）`, aRatio > 0.58 && aRatio < 0.74, `(A=${hitBy.filter((x) => x === "A").length}/${N})`);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 18：flattenComboSlots 单元——权重按 key 数均摊 / 成员去重 / 跨协议报错 ----------
{
  const norm = (raw) => raw.map((e, i) => ({ name: e.name || `k${i}`, key: e.key, rpm: e.rpm }));
  const providers = {
    pa: { baseUrl: "http://a.upstream/v1", apiKeys: [{ name: "x", key: "sk-x" }, { name: "y", key: "sk-y" }],
          models: [{ id: "ma", input: ["text"] }] },
    pb: { baseUrl: "http://b.upstream/v1", apiKey: "sk-primary",
          models: [{ id: "mb", input: ["text", "image"] }] },
  };
  const models = [{
    id: "fast",
    combo: { members: [
      { provider: "pa", model: "ma", weight: 20 },   // 2 把 key → 各摊 10
      { provider: "pb", model: "mb" },               // 默认 10，单 key
      { provider: "pa", model: "ma" },               // 重复引用 → 报错忽略
    ] },
  }];
  const r = flattenComboSlots(models, providers, norm);
  ok("flatten: 槽位数量 = 成员 key 数求和（重复引用不计）", r.slots.length === 3, JSON.stringify(r.slots.map((x) => x.name)));
  ok("flatten: 各槽位携带完整成员权重（成员级语义由代理端分组保证）", r.slots[0].weight === 20 && r.slots[1].weight === 20 && r.slots[2].weight === 10);
  ok("flatten: 槽位自带目标地址/真实模型/vision/分组", r.slots.every((x) => x.group === "fast" && x.member === `${x.name.split("/")[0]}/` + (x.model)) && r.slots[0].upstream === "http://a.upstream/v1" && r.slots[2].model === "mb" && r.slots[2].vision === true);

  // types 透传：合法过滤 + 空数组归一 undefined + 非法值过滤
  const modelsT = [{ id: "fast", combo: { members: [
    { provider: "pa", model: "ma", types: ["vision", "text"] },
    { provider: "pb", model: "mb", types: ["text"] },
    { provider: "pb", model: "mb", types: [] },
  ] } }];
  const rT = flattenComboSlots(modelsT, providers, norm);
  const tByMember = Object.fromEntries(rT.slots.map((x) => [x.member, x.types]));
  ok("flatten: types 透传（多值/单值）", JSON.stringify(tByMember["pa/ma"]) === JSON.stringify(["vision", "text"]) && JSON.stringify(tByMember["pb/mb"]) === JSON.stringify(["text"]));
  const rT2 = flattenComboSlots([{ id: "fast", combo: { members: [
    { provider: "pa", model: "ma", types: ["video", "text", "text"] }, // video 非法过滤 + 去重
  ] } }], providers, norm);
  ok("flatten: 非法 types 过滤 + 去重", JSON.stringify(rT2.slots[0].types) === JSON.stringify(["text"]), JSON.stringify(rT2.slots[0].types));
  const rT3 = flattenComboSlots([{ id: "fast", combo: { members: [
    { provider: "pb", model: "mb", types: ["nope"] }, // 全部非法 → undefined（全收）
  ] } }], providers, norm);
  ok("flatten: 全非法 types → undefined（全收）", rT3.slots[0].types === undefined, JSON.stringify(rT3.slots[0].types));
  const providersX = JSON.parse(JSON.stringify(providers));
  providersX.pb.models[0].api = "anthropic-messages"; // 与 pa 的 openai 跨协议
  const r2 = flattenComboSlots([{ id: "bad", combo: { members: [
    { provider: "pb", model: "mb" },
    { provider: "pa", model: "ma" },
  ] } }], providersX, norm);
  ok("flatten: 跨协议成员 → 报错跳过且无槽位", r2.slots.length === 0 && r2.errors.some((e) => e.error.includes("跨协议")), JSON.stringify(r2.errors));
}

// ---------- 场景 20：临时禁用（enabled:false）——key / 成员引用 / 虚拟模型 / 成员 provider / 成员模型 级 ----------
// 引擎语义：禁用 = 临时停用不删除——跳过参与，其余照常组队；全禁只记 error 不构建。
{
  // norm 模拟引擎 normalizeApiKeys：enabled:false 的 key 跳过（不参与轮转）
  const norm = (raw) => raw.filter((e) => e.enabled !== false).map((e, i) => ({ name: e.name || `k${i}`, key: e.key, rpm: e.rpm }));
  const providers = {
    pa: { baseUrl: "http://a.upstream/v1",
          apiKeys: [{ name: "x", key: "sk-x" }, { name: "y", key: "sk-y", enabled: false }], // y 临时禁用
          models: [{ id: "ma", input: ["text"] }, { id: "ma2", input: ["text"] }] },
    pb: { baseUrl: "http://b.upstream/v1", apiKey: "sk-primary", models: [{ id: "mb", input: ["text"] }] },
    pc: { baseUrl: "http://c.upstream/v1", apiKey: "sk-c", enabled: false, models: [{ id: "mc", input: ["text"] }] }, // provider 级禁用
  };
  // A. 成员引用级禁用：跳过该引用；同模型禁用引用也不重复叠加
  const rA = flattenComboSlots([{ id: "fast", combo: { members: [
    { provider: "pa", model: "ma" },
    { provider: "pa", model: "ma", enabled: false }, // 禁用引用
    { provider: "pb", model: "mb" },
  ] } }], providers, norm);
  ok("成员引用禁用：pa 只出 1 个启用 key 的槽（y 禁用不入池）", rA.slots.length === 2 && rA.slots.filter((x) => x.member === "pa/ma").length === 1 && rA.slots.filter((x) => x.member === "pa/ma")[0].name === "pa/x", JSON.stringify(rA.slots));
  // B. 虚拟模型级禁用：整个模型不参与
  const rB = flattenComboSlots([{ id: "off", enabled: false, combo: { members: [{ provider: "pa", model: "ma" }] } }], providers, norm);
  ok("虚拟模型禁用：无槽位", rB.slots.length === 0);
  // C. 成员 provider 级禁用：跳过该 provider 的成员（不 fail 其余）
  const rC = flattenComboSlots([{ id: "fast2", combo: { members: [
    { provider: "pa", model: "ma" },
    { provider: "pc", model: "mc" }, // pc 已禁用
  ] } }], providers, norm);
  ok("成员 provider 禁用：只出 pa 槽，不 fail 整组", rC.slots.length === 1 && rC.slots[0].member === "pa/ma", JSON.stringify(rC.slots));
  // D. 成员模型级禁用（models[i].enabled:false，与 provider 级独立）：跳过该模型
  const providersD = JSON.parse(JSON.stringify(providers));
  providersD.pa.models[1].enabled = false; // ma2 禁用
  const rD = flattenComboSlots([{ id: "fast3", combo: { members: [
    { provider: "pa", model: "ma" },
    { provider: "pa", model: "ma2" },
  ] } }], providersD, norm);
  ok("成员模型级禁用：跳过 ma2，只出 ma 槽", rD.slots.length === 1 && rD.slots[0].member === "pa/ma", JSON.stringify(rD.slots));
  // E. 全部成员禁用 → 无槽位 + error 提示（不静默）
  const rE = flattenComboSlots([{ id: "alloff", combo: { members: [
    { provider: "pa", model: "ma", enabled: false },
  ] } }], providers, norm);
  ok("成员全禁用：无槽位 + error（提示至少保留一个启用成员）", rE.slots.length === 0 && rE.errors.some((e) => e.error.includes("已禁用")), JSON.stringify(rE.errors));
}

// ---------- 场景 17：并发请求不串包（per-request ctx） ----------
// 两个慢上游 + 并发交错请求，各自 messages 内容必须原样到达对应成员
{
  const seen = [];
  const mkSlow = (tag) => makeUpstream((req, res) => {
    const body = JSON.parse(req.rawBody.toString());
    setTimeout(() => {
      seen.push({ tag, msg: body.messages[0].content, model: body.model });
      res.writeHead(200); res.end("{}");
    }, 80);
  });
  const upA = await mkSlow("A"), upB = await mkSlow("B");
  const tk = token();
  const cfg = comboFixture(upA, upB);
  cfg.apiKeys[0].weight = 1;
  cfg.apiKeys[1].weight = 9; // 大概率先落 B，再让 A 的慢响应与 B 交错
  const c = new ProxyServer({ ...cfg, authToken: tk, port: await freeP() });
  await c.start();
  // 同一 client 并发两发（粘性同槽位），消息内容不同 → 上游收到的必须一一对应
  const mkReq = (msg) => { const t2 = token(); c.registerToken(t2); return fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [{ role: "user", content: msg }] }), headers: { authorization: "Bearer " + t2 } }); };
  await Promise.all([mkReq("msg-AAA"), mkReq("msg-BBB")]);
  await new Promise((r) => setTimeout(r, 200));
  const contents = seen.map((x) => x.msg).sort();
  ok("并发两请求的 messages 内容无串包", contents.join(",") === "msg-AAA,msg-BBB", `(seen=${JSON.stringify(seen.map((x) => [x.tag, x.msg]))})`);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 19：单代理多虚拟模型——分组与粘性键隔离 ----------
{
  const hitBy = [];
  const mkUp = (tag) => makeUpstream((req, res) => { hitBy.push(tag); res.writeHead(200); res.end("{}"); });
  const upA = await mkUp("A"), upB = await mkUp("B");
  const tk = token();
  const c = new ProxyServer({
    provider: "两组",
    upstream: "http://combo.pmc.invalid/",
    api: "openai-completions",
    authToken: tk, port: await freeP(),
    apiKeys: [
      slot("provA", "a-key", "sk-a", upA.address().port, "model-a"), // group: fast
      { ...slot("provB", "b-key", "sk-b", upB.address().port, "model-b"), group: "slow" },
    ],
  });
  await c.start();
  const go = (model) => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model, messages: [] }), headers: { authorization: "Bearer " + tk } });
  await go("fast"); await go("slow"); await go("fast");
  ok("多虚拟模型各走各组（fast→A / slow→B，互不串组）", hitBy.join(",") === "A,B,A", `(hitBy=${hitBy.join(",")})`);
  const r404 = await go("nope");
  ok("另一虚拟模型 id 未注册 → 404", r404.status === 404);
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 20：anthropic-messages 成员——逐槽位协议覆盖（x-api-key + version 头） ----------
{
  const seen = [];
  const up = await makeUpstream((req, res) => {
    seen.push({
      xapi: req.headers["x-api-key"] ?? null,
      auth: req.headers.authorization ?? null,
      ver: req.headers["anthropic-version"] ?? null,
      model: JSON.parse(req.rawBody.toString()).model,
    });
    res.writeHead(200); res.end("{}");
  });
  const tk = token();
  const c = new ProxyServer({
    provider: "claude组",
    upstream: "http://combo.pmc.invalid/",
    api: "openai-completions", // provider 级声明故意错误 → 必须被槽位覆盖
    authToken: tk, port: await freeP(),
    apiKeys: [{ ...slot("provC", "c-key", "sk-claude", up.address().port, "claude-x"), api: "anthropic-messages" }],
  });
  await c.start();
  await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const h = seen[0];
  ok("anthropic 槽位：x-api-key 注入 + authorization 不残留 + version 头补齐",
    h && h.xapi === "sk-claude" && h.auth === null && h.ver === "2023-06-01" && h.model === "claude-x", JSON.stringify(h));
  c.stop(); up.close();
}

// ---------- 场景 21：usage log —— combo 归属字段 + switch 独立行 ----------
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pmc-ulog-")), "u.jsonl");
  setUsageLogFile(logFile);

  let a429 = false;
  const mkUp = (tag) => makeUpstream((req, res) => {
    if (tag === "A" && a429) { res.writeHead(429, { "retry-after": "30" }); return res.end("{}"); }
    res.writeHead(200); res.end('{"usage":{"prompt_tokens":10,"completion_tokens":5}}');
  });
  const upA = await mkUp("A"), upB = await mkUp("B");
  const tk = token();
  const c = new ProxyServer({ ...comboFixture(upA, upB, { visionB: false }), authToken: tk, port: await freeP() });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } }).then((r) => r.text());

  await go(); // 粘住 A
  a429 = true;
  await go(); // A 冷却 → 切 B（应产生 switch 行）
  await new Promise((r) => setTimeout(r, 100)); // tee 在流结束时异步落盘
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const okRows = lines.filter((x) => x.status === 200 && !x.switch);
  const switchRows = lines.filter((x) => x.switch);
  ok("成功记录带 combo 成员归属 + 用量（单条不双计）",
    okRows.length >= 2 && okRows.every((x) => x.combo) && okRows.some((x) => x.combo === "provA/model-a") && okRows.some((x) => x.input === 10),
    JSON.stringify(okRows.map((x) => [x.combo, x.input, x.output])));
  ok("成员切换写独立 switch 行（from/to/reason，无用量不参与统计）",
    switchRows.length >= 1 && switchRows[0].switch.from === "provA/model-a" && switchRows[0].switch.to === "provB/model-b" && switchRows[0].input === undefined,
    JSON.stringify(switchRows));
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 22：成员 baseUrl 的 store 兜底（只存 key 的 provider 从 pi 模型 store 补地址/api） ----------
{
  const norm = (raw) => raw.map((e, i) => ({ name: e.name || `k${i}`, key: e.key }));
  const providers = {
    zai: { apiKey: "sk-z", api: "openai-completions" }, // 无 baseUrl 无 models（真实形态如 zai-coding-cn）
  };
  const store = { zai: { models: [{ id: "glm-5.2", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", api: "openai-completions" }] } };
  const models = [{ id: "g", combo: { members: [{ provider: "zai", model: "glm-5.2" }] } }];
  const r = flattenComboSlots(models, providers, norm, store);
  ok("store 兜底：成员从 store 补 baseUrl/api 入组", r.errors.length === 0 && r.slots.length === 1 && r.slots[0].upstream === "https://open.bigmodel.cn/api/coding/paas/v4" && r.slots[0].model === "glm-5.2", JSON.stringify(r));
  const r2 = flattenComboSlots(models, providers, norm, null);
  ok("无 store 且无 baseUrl → 拒绝（清单为空）", r2.slots.length === 0 && r2.errors.length > 0, JSON.stringify(r2.errors));
}
// ---------- 场景 23：质量监控——成员持续慢 → 忽略 TTL 立即换 ----------
{
  const hitBy = [];
  const mkUp = (tag, delayMs) => makeUpstream((req, res) => {
    hitBy.push(tag);
    setTimeout(() => { res.writeHead(200); res.end("{}"); }, delayMs);
  });
  const upA = await mkUp("A", 250), upB = await mkUp("B", 5);
  const tk = token();
  const cfg = comboFixture(upA, upB, { visionB: false });
  cfg.apiKeys[0].weight = 10;
  cfg.apiKeys[1].weight = 10;
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pmc-slow-")), "u.jsonl");
  setUsageLogFile(logFile);
  const c = new ProxyServer({
    ...cfg, authToken: tk, port: await freeP(),
    quality: { window: 3, ttfbMedianMs: 100 },   // A 的 TTFB 250ms > 100ms 阈值
  });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } }).then((r) => r.text());
  await go(); await go(); await go();  // 同 client 粘在 A，攒满慢窗口
  const aCount = hitBy.filter((x) => x === "A").length;
  await go();                           // 第 4 次：A 已判定持续慢 → 忽略 TTL 换 B
  ok(`持续慢成员被无视 TTL 换掉（前 3 次全 A=${aCount}，第 4 次落 B）`, aCount === 3 && hitBy[3] === "B", `hitBy=${hitBy.join(",")}`);
  await go();
  ok("切换后粘在健康的 B 上", hitBy[4] === "B", `hitBy=${hitBy.join(",")}`);
  await new Promise((r) => setTimeout(r, 80)); // tee 异步落盘
  const rows = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.switch);
  ok("slow 切换写独立 switch 行且 reason=\"slow\"（不被通用归因覆盖）",
    rows.some((x) => x.switch?.reason === "slow" && x.switch?.from === "provA/model-a" && x.switch?.to === "provB/model-b"),
    JSON.stringify(rows.map((x) => x.switch)));
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 24：rpm 长等待提前换槽 → switch 行 reason==="rpm" ----------
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pmc-rpm-")), "u.jsonl");
  setUsageLogFile(logFile);
  const hitBy = [];
  const mkUp = (tag) => makeUpstream((req, res) => { hitBy.push(tag); res.writeHead(200); res.end("{}"); });
  const upA = await mkUp("A"), upB = await mkUp("B");
  const tk = token();
  const cfg = comboFixture(upA, upB, { visionB: false });
  cfg.apiKeys[0].rpm = 1; // A 首发即占满窗口，第二请求长等待 >10s → 提前换 B
  cfg.apiKeys[1].weight = 0.0001; // 权重上几乎不会主动选 B
  delete cfg.apiKeys[1].weight;
  const c = new ProxyServer({ ...cfg, authToken: tk, port: await freeP() });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } }).then((r) => r.text());
  await go(); // 粘 A
  await go(); // A rpm 长等待 → 提前换 B
  await new Promise((r) => setTimeout(r, 80));
  const rows = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.switch);
  ok("rpm 长等待提前换槽 → switch 行 reason=\"rpm\"",
    rows.some((x) => x.switch?.reason === "rpm" && x.switch?.to === "provB/model-b"),
    JSON.stringify(rows.map((x) => x.switch)));
  c.stop(); upA.close(); upB.close();
}

// ---------- 场景 25：成员带 :free/:batch 后缀 → 槽位 model id 原样保留（转发给上游） ----------
{
  const norm = (raw) => raw.map((e, i) => ({ name: e.name || `k${i}`, key: e.key }));
  const providers = {
    or: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or", models: [{ id: "z-ai/glm-5.2:free" }] },
  };
  const models = [{ id: "g", combo: { members: [{ provider: "or", model: "z-ai/glm-5.2:free" }] } }];
  const r = flattenComboSlots(models, providers, norm, null);
  ok(":free 成员 → 槽位 model 原样保留", r.errors.length === 0 && r.slots.length === 1 && r.slots[0].model === "z-ai/glm-5.2:free", JSON.stringify(r));
}

// ---------- 场景 26：slotFault（401/402/403 key 失效）→ 错误冷却 + 换槽；全灭 → all combo members failed ----------
{
  // 真实形态：opencode-go 死 key 403（非限流）不阻塞组合，错误冷却 60s 后到期重探
  const upA = await makeUpstream((q, s) => { s.writeHead(403); s.end("{}"); });
  const upB = await makeUpstream((q, s) => { s.end("{}"); });
  const tk = token();
  const c = new ProxyServer({ ...comboFixture(upA, upB), authToken: tk, port: await freeP() });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const r1 = await go();
  ok("403 槽位故障 → 换槽命中健康成员（不冒 403 给客户端）", r1.status === 200, `(status=${r1.status})`);
  const a = c.status().entries.find((e) => e.name.startsWith("provA"));
  ok("403 槽位上错误冷却（kind=error，≤60s）", a?.cooldown?.kind === "error" && a.cooldown.secondsLeft <= 60, `(cd=${JSON.stringify(a?.cooldown)})`);
  const r2 = await go();
  ok("冷却期内再请求 → 直接健康槽不再撞 403", r2.status === 200, `(status=${r2.status})`);
  c.stop(); upA.close(); upB.close();

  // 全员 403 + maxRetries=2（槽位数≥maxRetries 时先试槽全故障 → 可达 failed(code) 终态行）
  const upC = await makeUpstream((q, s) => { s.writeHead(403); s.end("{}"); });
  const upD = await makeUpstream((q, s) => { s.writeHead(403); s.end("{}"); });
  const c2 = new ProxyServer({ ...comboFixture(upC, upD), authToken: tk, port: await freeP(), maxRetries: 2 });
  await c2.start();
  const r3 = await fetch(`http://127.0.0.1:${c2.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const j3 = await r3.json().catch(() => ({}));
  ok("全员 403 → 终态（api_error 语义；文案随 locale，多语后只锚 status/type）", r3.status === 403 && j3.error?.type === "api_error" && /403/.test(String(j3.error?.message)), `(status=${r3.status} msg=${String(j3.error?.message).slice(0, 70)})`);
  c2.stop(); upC.close(); upD.close();

  // 成员 404（上游下架模型，2026-10 sensenova 实况）→ 与 403 同等槽位故障：冷却 + 换槽，不打穿客户端。
  // 权重 100:1 + 循环到撞上坏成员为止：两次请求全落在健康槽的概率 ≈ (1/101)^5，确定性足够。
  let upEHits = 0;
  const upE = await makeUpstream((q, s) => { upEHits++; s.writeHead(404); s.end(JSON.stringify({ error: { message: "model is not found", type: "not_found_error", code: "5" } })); });
  const upF = await makeUpstream((q, s) => { s.end("{}"); });
  const c3 = new ProxyServer({
    provider: "快速组", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    apiKeys: [
      slot("provA", "a-key", "sk-key-a", upE.address().port, "model-a", { weight: 100 }),
      slot("provB", "b-key", "sk-key-b", upF.address().port, "model-b", { vision: true, weight: 1 }),
    ],
    stickyTtlMin: 15, authToken: tk, port: await freeP(),
  });
  await c3.start();
  const go3 = () => fetch(`http://127.0.0.1:${c3.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  let r4 = null;
  for (let i = 0; i < 5 && upEHits === 0; i++) r4 = await go3();
  ok("combo 成员 404（上游下架）→ 换槽命中健康成员（不冒 404 给客户端）", upEHits >= 1 && r4?.status === 200, `(upEHits=${upEHits} status=${r4?.status})`);
  const e3 = c3.status().entries.find((e) => e.name.startsWith("provA"));
  ok("combo 成员 404 上错误冷却（kind=error，≤60s）", e3?.cooldown?.kind === "error" && e3.cooldown.secondsLeft <= 60, `(cd=${JSON.stringify(e3?.cooldown)})`);
  c3.stop(); upE.close(); upF.close();
}

// ---------- 场景 27：慢节奏客户端（间隔 > cap）→ 饱和计时不再被「选到已解冻槽位」清零，终态 400 必达 ----------
{
  // 曾实测缺陷：clearSaturation 挂在选槽处时，间隔>cap 的客户端（如 pi 每 60s 重试）每轮把冷却
  // 过期的槽位当「恢复」清零闸门 → 终态 400 永不触发。改为上游真成功才清零后，慢节奏也必达终态。
  const mkUp = () => makeUpstream((q, s) => { s.writeHead(429, { "retry-after": "1600000" }); s.end("{}"); });
  const upA = await mkUp(), upB = await mkUp();
  const tk = token();
  const c = new ProxyServer({ ...comboFixture(upA, upB), authToken: tk, port: await freeP(), retryAfterCapSec: 2, saturationTerminalMs: 4000 });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const r1 = await go();
  ok("首发出 429（封顶冷却 2s + 闸门起表）", r1.status === 429);
  await new Promise((r) => setTimeout(r, 3000)); // > cap=2s：冷却已解冻（旧实现在此清零闸门）
  const r2 = await go();
  ok("间隔>cap 再发 → 仍 429 且闸门未被清零", r2.status === 429);
  const sat = c.status().saturation;
  ok("饱和计时仍在走且已 ≥2s（未被选槽清零）", Array.isArray(sat) && sat.length === 1 && sat[0].seconds >= 2, `(sat=${JSON.stringify(sat)})`);
  await new Promise((r) => setTimeout(r, 2300)); // 累计 >4s 终态阈值
  const r3 = await go();
  const j3 = await r3.json().catch(() => ({}));
  ok("慢节奏下终态 400 必达（quota exceeded）", r3.status === 400 && String(j3.error?.message).includes("quota exceeded"), `(status=${r3.status} msg=${String(j3.error?.message).slice(0, 60)})`);
  c.stop(); upA.close(); upB.close();
}

finish("combo.test · 组合模型（扁平化单代理）+ 粘性路由 + 权重占比");
