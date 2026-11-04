// 粘性 + 挂起：验证粘性是否会反复粘住挂起槽位，导致远超"槽位数xTTFB"的总耗时
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream } from "./util.mjs";
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model){return{name:`${pid}/${kn}`,key,upstream:`http://127.0.0.1:${port}`,model,vision:false,group:"fast",member:`${pid}/${model}`};}

// 粘性(默认) + 全员挂起：同一 client 反复请求
{
  const mkUp = () => makeUpstream((req,res)=>{/* 永不响应 */});
  const ups = await Promise.all([mkUp(), mkUp(), mkUp()]); // 3 槽位
  const tk = token();
  const c = new ProxyServer({
    provider: "stickhang", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(), stickyKeys: true,
    timeouts: { ttfbMs: 500, idleMs: 400, totalMs: 20000 },
    apiKeys: ups.map((u,i)=>slot(`P${i}`,"k"+i,"sk-"+i,u.address().port,"m"+i)),
  });
  await c.start();
  // 同一 client 连发 3 次，每次单独计时
  for (let k=0;k<3;k++){
    const t0=Date.now();
    const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
    console.log(`[粘性+挂起] 第${k+1}次 status=${r.status} dt=${Date.now()-t0}ms`);
  }
  c.stop(); ups.forEach(u=>u.close());
}
