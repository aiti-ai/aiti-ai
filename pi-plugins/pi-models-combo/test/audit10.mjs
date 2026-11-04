// 关键：全员挂起时 attempt 计数 —— 5槽位 maxRetries=5，是否会循环多轮(每轮5槽xTTFB)?
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream } from "./util.mjs";
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model){return{name:`${pid}/${kn}`,key,upstream:`http://127.0.0.1:${port}`,model,vision:false,group:"fast",member:`${pid}/${model}`};}
const mkUp = () => makeUpstream((req,res)=>{});
const ups = await Promise.all([mkUp(),mkUp(),mkUp(),mkUp(),mkUp()]);
const tk = token();
const c = new ProxyServer({
  provider: "hangcnt", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
  authToken: tk, port: await freeP(), stickyKeys: true, maxRetries: 5,
  timeouts: { ttfbMs: 500, idleMs: 400, totalMs: 60000 },
  apiKeys: ups.map((u,i)=>slot(`P${i}`,"k"+i,"sk-"+i,u.address().port,"m"+i)),
});
await c.start();
let n=0;
const orig = c.log.bind(c);
c.log = (m)=>{ if(m.includes("upstream timeout")||m.includes("upstream error")) {n++; console.log("  [log] "+m);} orig(m); };
const t0=Date.now();
const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
const dt=Date.now()-t0;
console.log(`[5槽全员挂起 sticky maxRetries=5] status=${r.status} dt=${dt}ms 上游尝试次数=${n}`);
console.log(`  推算默认TTFB=90s时 ≈ ${(dt/1000/0.5*90/60).toFixed(1)} 分钟`);
c.stop(); ups.forEach(u=>u.close());
