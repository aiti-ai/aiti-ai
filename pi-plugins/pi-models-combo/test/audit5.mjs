// 关键：用默认超时(或不配)测「全员挂起」，计算总耗时 = 是否就是"卡几十分钟"的原因
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream } from "./util.mjs";
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model){return{name:`${pid}/${kn}`,key,upstream:`http://127.0.0.1:${port}`,model,vision:false,group:"fast",member:`${pid}/${model}`};}

// 用较短 TTFB 模拟，验证"全员挂起"的失败路径耗时 = 槽位数 x TTFB x 重试轮数
{
  const mkUp = () => makeUpstream((req,res)=>{/* 永不响应 */});
  const ups = await Promise.all([mkUp(), mkUp(), mkUp(), mkUp(), mkUp()]); // 5 槽位(模拟 freeglm)
  const tk = token();
  const c = new ProxyServer({
    provider: "allhang", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(),
    timeouts: { ttfbMs: 600, idleMs: 500, totalMs: 15000 }, // TTFB 0.6s 加速模拟
    apiKeys: ups.map((u,i)=>slot(`P${i}`,"k"+i,"sk-"+i,u.address().port,"m"+i)),
  });
  await c.start();
  const t0=Date.now();
  const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
  const dt=Date.now()-t0;
  const j = await r.json().catch(()=>({}));
  console.log(`[5槽位全员挂起 TTFB=0.6s] status=${r.status} dt=${dt}ms`);
  console.log(`  按比例推算默认TTFB=90s时 ≈ ${(dt/1000/0.6*90/60).toFixed(1)} 分钟`);
  c.stop(); ups.forEach(u=>u.close());
}
