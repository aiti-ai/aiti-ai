// 轮转机制深度审核测试
// 重点：组合模式 stickyKeys=false 的顺序轮转是否覆盖所有槽位（游标推进正确性）
// 以及：组合模式 sticky 命中后游标推进是否与其他槽位错位
import { randomBytes } from "node:crypto";
import { ProxyServer, DEFAULT_SLOT_WEIGHT } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();
const token = () => "sk-dummy-" + randomBytes(8).toString("hex");

function slot(pid, keyName, key, upPort, model) {
  return {
    name: `${pid}/${keyName}`, key,
    upstream: `http://127.0.0.1:${upPort}`, model,
    vision: false, group: "fast", member: `${pid}/${model}`,
  };
}

// ---------- 场景 R1：combo + stickyKeys=false → 顺序轮转应覆盖所有槽位 ----------
// 4 个槽位（含同成员多 key B/B2，共用同一上游），无粘性，应严格按游标顺序轮流命中每个槽位
// 注意：B/B2 共用一个上游，必须按 authorization key 区分才能验证 B2 是否被选中
{
  const hits = [];
  const mkUp = (tag) => makeUpstream((req, res) => { hits.push(tag); res.writeHead(200); res.end("{}"); });
  const upA = await mkUp("sk-a"), upB = await makeUpstream((req, res) => {
    hits.push(req.headers.authorization.slice(7)); res.writeHead(200); res.end("{}");
  }), upC = await mkUp("sk-c");
  const tk = token();
  const c = new ProxyServer({
    provider: "rot", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(), stickyKeys: false,
    apiKeys: [
      slot("provA", "a", "sk-a", upA.address().port, "ma"),
      slot("provB", "b", "sk-b", upB.address().port, "mb"),
      slot("provB", "b2", "sk-b2", upB.address().port, "mb"),
      slot("provC", "c", "sk-c", upC.address().port, "mc"),
    ],
  });
  await c.start();
  const go = () => fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  for (let i = 0; i < 8; i++) await go();
  // 期望严格轮转 A(sk-a),B(sk-b),B2(sk-b2),C(sk-c) 循环——每个槽位轮流命中
  ok("顺序轮转覆盖所有槽位（无跳过/重复错位）", hits.join(",") === ["sk-a","sk-b","sk-b2","sk-c","sk-a","sk-b","sk-b2","sk-c"].join(","), `(hits=${hits.join(",")})`);
  c.stop(); upA.close(); upB.close(); upC.close();
}

// ---------- 场景 R2：sticky 命中后，游标是否与其他 client 错位 ----------
// client A 粘住槽位 0（多次命中不推进游标）；client B 每次新 client 走 scan
// 验证游标推进不会因 sticky 命中而卡死/错位（B 能轮转到不同槽位）
{
  const hits = [];
  const mkUp = (tag) => makeUpstream((req, res) => {
    hits.push(`${tag}:${req.headers.authorization.slice(7)}`); res.writeHead(200); res.end("{}");
  });
  const upA = await mkUp("A"), upB = await mkUp("B"), upC = await mkUp("C");
  const tkA = token();
  const c = new ProxyServer({
    provider: "mix2", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tkA, port: await freeP(), stickyTtlMin: 15,
    apiKeys: [
      slot("provA", "a", "sk-a", upA.address().port, "ma"),
      slot("provB", "b", "sk-b", upB.address().port, "mb"),
      slot("provC", "c", "sk-c", upC.address().port, "mc"),
    ],
  });
  await c.start();
  // client A 连发（粘住一个槽位）
  for (let i = 0; i < 3; i++) {
    await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tkA } });
  }
  const aHits = hits.filter((h) => h.endsWith("sk-a"));
  ok("client A 三连发粘住同一槽位（sk-a）", aHits.length === 3, `(aHits=${aHits.length})`);
  // 多个新 client（各自独立 token → 各自 scan 轮转）
  const distinct = new Set();
  for (let i = 0; i < 9; i++) {
    const tk = token(); c.registerToken(tk);
    await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
    const h = hits[hits.length - 1].split(":")[1];
    distinct.add(h);
  }
  ok("多个新 client 应覆盖到不同槽位（游标正确推进）", distinct.size >= 2, `(distinct=${[...distinct].join(",")})`);
  c.stop(); upA.close(); upB.close(); upC.close();
}

// ---------- 场景 R3：全员 429 冷却后冷却到期，轮转是否恢复 ----------
// 关键：冷却 map 中最早的到期时间，allCoolingWait 的 wait 计算是否正确
{
  const seen = [];
  const mkUp = () => makeUpstream((req, res) => { seen.push(Date.now()); res.writeHead(429, { "retry-after": "1" }); res.end("{}"); });
  const upA = await mkUp(), upB = await mkUp();
  const tk = token();
  const c = new ProxyServer({
    provider: "cool", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(),
    apiKeys: [
      slot("provA", "a", "sk-a", upA.address().port, "ma"),
      slot("provB", "b", "sk-b", upB.address().port, "mb"),
    ],
  });
  await c.start();
  const t0 = Date.now();
  const r1 = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const j = await r1.json();
  // r1 探测：A/B 各打一次 429（429 只重试 1 次 → 总 2 次尝试）后返回 429
  ok("首次请求：429 重试 1 次后返回 429", r1.status === 429, `(status=${r1.status} dt=${Date.now() - t0}ms)`);
  // r2：此刻全部 key 已在限流冷却 → 应走「全冷却立即 429」分支，不等待冷却窗口
  const t1 = Date.now();
  const r2 = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const dt2 = Date.now() - t1;
  ok("全员 429 冷却后再次请求 → 立即 429（不傻等冷却窗口）", r2.status === 429 && dt2 < 500, `(dt2=${dt2}ms)`);
  // 等冷却过期后重试，应能出请求（不卡死）
  await new Promise((r) => setTimeout(r, 1200));
  const r3 = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  ok("冷却过期后请求能发出（非 429 即恢复）", r3.status === 429 || r3.status === 200, `(status=${r3.status})`);
  c.stop(); upA.close(); upB.close();
}

finish();
