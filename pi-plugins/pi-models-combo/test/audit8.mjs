// 深挖：粘性命中挂起槽位后，TTFB超时换槽，是否会因粘性反复粘回挂起槽，导致长时间卡顿
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream } from "./util.mjs";
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model){return{name:`${pid}/${kn}`,key,upstream:`http://127.0.0.1:${port}`,model,vision:false,group:"fast",member:`${pid}/${model}`};}

// 2 槽位：A挂起 / B正常。粘性命中A(首个)，TTFB超时后应换B
{
  const hits=[];
  const hangUp = await makeUpstream((req,res)=>{/* 永不响应 */});
  const okUp = await makeUpstream((req,res)=>{ hits.push("OK"); res.writeHead(200); res.end("{}"); });
  const tk = token();
  const c = new ProxyServer({
    provider: "stickyhang2", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(), stickyKeys: true,
    timeouts: { ttfbMs: 500, idleMs: 400, totalMs: 20000 },
    apiKeys: [slot("A","a","sk-a",hangUp.address().port,"ma"), slot("B","b","sk-b",okUp.address().port,"mb")],
  });
  await c.start();
  // 同一 client 反复请求：第一次首槽A挂起→超时换B成功；第二次粘性应已换到B
  for(let k=0;k<3;k++){
    const t0=Date.now();
    const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
    console.log(`[粘性挂起A+正常B] 第${k+1}次 status=${r.status} dt=${Date.now()-t0}ms`);
  }
  console.log(`  OK命中=${hits.join(",")}`);
  c.stop(); hangUp.close(); okUp.close();
}

// 3 槽位：A/B挂起 / C正常。前两次都挂起，第三次降级C
{
  const hits=[];
  const hang1 = await makeUpstream((req,res)=>{});
  const hang2 = await makeUpstream((req,res)=>{});
  const okUp = await makeUpstream((req,res)=>{ hits.push("OK"); res.writeHead(200); res.end("{}"); });
  const tk = token();
  const c = new ProxyServer({
    provider: "multi", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(), stickyKeys: true,
    timeouts: { ttfbMs: 400, idleMs: 300, totalMs: 30000 },
    apiKeys: [slot("A","a","sk-a",hang1.address().port,"ma"), slot("B","b","sk-b",hang2.address().port,"mb"), slot("C","c","sk-c",okUp.address().port,"mc")],
  });
  await c.start();
  const t0=Date.now();
  const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const dt=Date.now()-t0;
  console.log(`[2挂起+1正常] status=${r.status} dt=${dt}ms hits=${hits.join(",")}`);
  console.log(`  → 应降级到C成功(总耗时≈2×TTFB+退避)`);
  c.stop(); hang1.close(); hang2.close(); okUp.close();
}
