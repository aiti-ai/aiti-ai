import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";
const { ok, finish } = Tester();
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model){return{name:`${pid}/${kn}`,key,upstream:`http://127.0.0.1:${port}`,model,vision:false,group:"fast",member:`${pid}/${model}`};}

// 挂起成员(TTFB超时) + 正常成员：应降级到正常成员
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
