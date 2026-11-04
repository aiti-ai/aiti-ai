import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream, Tester } from "./util.mjs";
const { ok, finish } = Tester();
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model){return{name:`${pid}/${kn}`,key,upstream:`http://127.0.0.1:${port}`,model,vision:false,group:"fast",member:`${pid}/${model}`};}

// A: retry-after 30s(长冷却) / B: retry-after 1s(短冷却)
for (const [tag, ra, expectQuick] of [["长冷却30s", "30", true], ["短冷却1s", "1", false]]) {
  const hits=[];
  const mkUp=(n)=>makeUpstream((req,res)=>{hits.push(n); res.writeHead(429,{"retry-after":ra}); res.end("{}");});
  const upA=await mkUp("A"), upB=await mkUp("B");
  const tk=token();
  const c=new ProxyServer({provider:`p-${tag}`,upstream:"http://combo.pmc.invalid/",api:"openai-completions",authToken:tk,port:await freeP(),
    apiKeys:[slot("A","a","sk-a",upA.address().port,"ma"),slot("B","b","sk-b",upB.address().port,"mb")]});
  await c.start();
  const t0=Date.now();
  const r=await fetch(`http://127.0.0.1:${c.port}/c`,{method:"POST",body:JSON.stringify({model:"fast",messages:[]}),headers:{authorization:"Bearer "+tk}});
  const dt=Date.now()-t0;
  console.log(`[${tag}] status=${r.status} dt=${dt}ms hits=${hits.join(",")} attempts=${hits.length}`);
  if(expectQuick) ok("长冷却应快速返回(<=2s)", dt<2000, `dt=${dt}`);
  else console.log(`  → 短冷却实测 dt=${dt}ms (非"立即"，符合预期但要分析影响)`);
  c.stop(); upA.close(); upB.close();
}
finish();
