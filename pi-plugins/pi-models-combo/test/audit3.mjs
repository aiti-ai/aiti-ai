// 上游挂起(不响应)场景：验证代理能否超时降级，还是无限挂起
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";
const { ok, finish } = Tester();
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model){return{name:`${pid}/${kn}`,key,upstream:`http://127.0.0.1:${port}`,model,vision:false,group:"fast",member:`${pid}/${model}`};}

// 所有成员都挂起(不响应、不销毁连接) —— 模拟卡死上游
{
  const mkUp = () => makeUpstream((req, res) => { /* 永不响应 */ });
  const upA = await mkUp(), upB = await mkUp();
  const tk = token();
  const c = new ProxyServer({
    provider: "hang", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(),
    timeouts: { ttfbMs: 800, idleMs: 600, totalMs: 3000 }, // 短超时加速测试
    apiKeys: [slot("A","a","sk-a",upA.address().port,"ma"), slot("B","b","sk-b",upB.address().port,"mb")],
  });
  await c.start();
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const dt = Date.now() - t0;
  console.log(`[全员挂起] status=${r.status} dt=${dt}ms body=${(await r.text()).slice(0,120)}`);
  ok("全员挂起 → 应在总时长内超时返回(<=4s)", r.status >= 400 && dt < 4000, `dt=${dt} status=${r.status}`);
  c.stop(); upA.close(); upB.close();
}

// 部分挂起(不响应) + 部分正常：验证挂起成员能降级到正常成员
{
  const hits=[];
  const hangUp = await makeUpstream((req,res)=>{/* 永不响应 */});
  const okUp = await makeUpstream((req,res)=>{ hits.push("OK"); res.writeHead(200); res.end("{}"); });
  const tk = token();
  const c = new ProxyServer({
    provider: "part", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(),
    timeouts: { ttfbMs: 800, idleMs: 600, totalMs: 4000 },
    apiKeys: [slot("H","h","sk-h",hangUp.address().port,"mh"), slot("O","o","sk-o",okUp.address().port,"mo")],
  });
  await c.start();
  const t0=Date.now();
  const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const dt=Date.now()-t0;
  console.log(`[挂起+正常] status=${r.status} dt=${dt}ms okHits=${hits.join(",")}`);
  ok("挂起成员 TTFB 超时后应降级到正常成员", r.status===200 && hits.includes("OK"), `dt=${dt} status=${r.status} hits=${hits.join(",")}`);
  c.stop(); hangUp.close(); okUp.close();
}
finish();
