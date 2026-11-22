// 流中途挂起：上游返回200并开始SSE流，但中途停摆(无字节)
// 验证 abortStream 的 idle 超时 + 是否给客户端结构化错误(还是裸 destroy)
import { randomBytes } from "node:crypto";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream } from "./util.mjs";
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model){return{name:`${pid}/${kn}`,key,upstream:`http://127.0.0.1:${port}`,model,vision:false,group:"fast",member:`${pid}/${model}`};}

// 上游发 200 + 一点点数据后停摆(模拟 SSE 中途挂起)
{
  const hangUp = await makeUpstream((req,res)=>{
    res.writeHead(200, {"content-type":"text/event-stream"});
    res.write("data: {}\n\n"); // 发一个块让代理进入流模式
    // 之后永不写数据，也不结束 —— 模拟流停摆
  });
  const tk = token();
  const c = new ProxyServer({
    provider: "streamhang", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
    authToken: tk, port: await freeP(), stickyKeys: false,
    timeouts: { ttfbMs: 2000, idleMs: 700, totalMs: 5000 },
    apiKeys: [slot("A","a","sk-a",hangUp.address().port,"ma")],
  });
  await c.start();
  const t0=Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${c.port}/c`, { method: "POST", body: JSON.stringify({ model: "fast", messages: [], stream:true }), headers: { authorization: "Bearer " + tk } });
    const dt=Date.now()-t0;
    console.log(`[流中途挂起] status=${r.status} dt=${dt}ms (fetch到头部即返回)`);
    // 读取流，看 idle 超时后代理怎么掐
    const reader = r.body.getReader();
    let chunks=[];
    try {
      while(true){ const {done,value}=await reader.read(); if(done) break; chunks.push(value.length); }
    } catch(e){ console.log(`  读取中断: ${e.message}`); }
    console.log(`  收到数据块大小: ${chunks}，总dt=${Date.now()-t0}ms`);
  } catch(e) { console.log(`[流中途挂起] fetch error: ${e.message} dt=${Date.now()-t0}ms`); }
  c.stop(); hangUp.close();
}
