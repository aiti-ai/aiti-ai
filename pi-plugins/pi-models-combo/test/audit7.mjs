// 精确：真实 retry-after(30s) 下 4 槽位全部 429 的响应延迟
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream } from "./util.mjs";
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model){return{name:`${pid}/${kn}`,key,upstream:`http://127.0.0.1:${port}`,model,vision:false,group:"fast",member:`${pid}/${model}`};}
const mkUp = () => makeUpstream((req,res)=>{ res.writeHead(429,{"retry-after":"30"}); res.end("{}"); });
const ups = await Promise.all([mkUp(),mkUp(),mkUp(),mkUp()]); // 4 槽位
const tk = token();
const c = new ProxyServer({
  provider: "all429", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
  authToken: tk, port: await freeP(),
  apiKeys: ups.map((u,i)=>slot(`P${i}`,"k"+i,"sk-"+i,u.address().port,"m"+i)),
});
await c.start();
const t0=Date.now();
const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [] }), headers: { authorization: "Bearer " + tk } });
const dt=Date.now()-t0;
const j = await r.json().catch(()=>({}));
console.log(`[4槽位全部429 retry-after=30s] status=${r.status} dt=${dt}ms msg=${j.error?.message}`);
// 关键：期望"立即"返回 429（all-cooldown 分支），实际因退避累积？
console.log(`  → ${dt>2000 ? "异常慢：退避累积导致非立即返回" : "正常立即返回"}`);
c.stop(); ups.forEach(u=>u.close());
