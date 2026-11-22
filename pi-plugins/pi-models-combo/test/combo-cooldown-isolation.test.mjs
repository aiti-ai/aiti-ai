// 槽位级冷却隔离回归：共享同一把 key 的组合槽位，单个成员 429 只冷却它自己。
// 事故背景：冷却原按 key 名（e.name）索引，combo 各槽位共享 `freeflow/primary`
// → 一个成员 429 全池连坐冷却（6 个 req 0 的槽位同时 ⏳28s）。
// 修复：冷却键改为 key名|member|model（普通多 key 无 member/model 退化为 key 名，行为不变）。
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";

const { ok, finish } = Tester();
const token = () => "sk-dummy-" + randomBytes(8).toString("hex");

// ---------- 场景：3 成员共享同名 key，成员 ma 返回 429，其余 200 ----------
{
  const hits = [];
  const up429 = await makeUpstream((req, res) => {
    hits.push("ma");
    res.writeHead(429, { "retry-after": "30" });
    res.end(JSON.stringify({ error: { message: "rate limited" } }));
  });
  const upOk = await makeUpstream((req, res) => {
    hits.push(JSON.parse(req.rawBody.toString()).model);
    res.writeHead(200); res.end("{}");
  });

  // 同 combo.test.mjs 的槽位结构，但三把「key」同名 freeflow/primary（真实 freeflow 场景）
  const slot = (model, port) => ({
    name: "freeflow/primary", key: "sk-same",
    upstream: `http://127.0.0.1:${port}`, model,
    vision: false, group: "free-coder", member: `freeflow/${model}`, weight: 10,
  });
  const tk = token();
  const p = new ProxyServer({
    provider: "free-coding-combo",
    upstream: "http://combo.pmc.invalid/",
    api: "openai-completions",
    apiKeys: [slot("ma", up429.address().port), slot("mb", upOk.address().port), slot("mc", upOk.address().port)],
    stickyKeys: false, // 关粘性：纯轮转视角验证冷却隔离
    port: await freeP(), authToken: tk,
  });
  await p.start();

  const call = () => fetch(`http://127.0.0.1:${p.port}/c`, {
    method: "POST", body: JSON.stringify({ model: "free-coder" }), headers: { authorization: "Bearer " + tk },
  });

  // ① 首个请求：轮到 ma 吃 429 → 组合模式自动换健康成员 → 最终 200
  const r1 = await call();
  ok("① 单成员 429 后自动换健康成员成功", r1.status === 200, `(hits=${hits.join(",")})`);

  // ② 冷却只落在 ma：status() 里 mb/mc 无冷却
  const st = p.status();
  const byMember = Object.fromEntries(st.entries.map((e) => [e.member, e]));
  ok("② 429 成员 ma 进入冷却", (byMember["freeflow/ma"]?.cooldown?.secondsLeft ?? 0) > 0,
    JSON.stringify(byMember["freeflow/ma"]?.cooldown));
  ok("② 健康成员 mb/mc 不被连坐", !byMember["freeflow/mb"]?.cooldown && !byMember["freeflow/mc"]?.cooldown,
    `mb=${JSON.stringify(byMember["freeflow/mb"]?.cooldown)} mc=${JSON.stringify(byMember["freeflow/mc"]?.cooldown)}`);

  // ③ 后续请求不再撞 ma：直接落到健康成员
  hits.length = 0;
  const r2 = await call();
  ok("③ 冷却期内新请求直达健康成员（不碰 ma）", r2.status === 200 && !hits.includes("ma"), `(hits=${hits.join(",")})`);

  // ④ 普通多 key（无 member/model）冷却键退化为 key 名：行为不变
  const upK = await makeUpstream((req, res) => { res.writeHead(429, { "retry-after": "5" }); res.end("{}"); });
  const tk2 = token();
  const p2 = new ProxyServer({
    provider: "dual", upstream: `http://127.0.0.1:${upK.address().port}`,
    apiKeys: [{ name: "k1", key: "sk-a" }, { name: "k2", key: "sk-b" }],
    max429Retries: 0, port: await freeP(), authToken: tk2,
  });
  await p2.start();
  await fetch(`http://127.0.0.1:${p2.port}/c`, { method: "POST", body: "{}", headers: { authorization: "Bearer " + tk2 } }).catch(() => {});
  const st2 = p2.status();
  const coolingKeys = st2.entries.filter((e) => e.cooldown).map((e) => e.name);
  ok("④ 普通多 key：429 的 key 冷却（key 级语义不变）", coolingKeys.includes("k1"), `cooling=${coolingKeys.join(",")}`);

  p.stop(); p2.stop();
  up429.close(); upOk.close(); upK.close();
}

finish();
