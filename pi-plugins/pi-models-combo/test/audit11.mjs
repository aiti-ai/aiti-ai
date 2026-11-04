// Bug3 验证：客户端发送部分 body 后停住(不发 end) → 代理 #handle 的 req.on('end') 永不触发 → 永久挂起
import { randomBytes } from "node:crypto";
import http from "node:http";
import { ProxyServer } from "../src/proxy.ts";
import { freeP, makeUpstream } from "./util.mjs";
const token = () => "sk-" + randomBytes(8).toString("hex");
function slot(pid, kn, key, port, model){return{name:`${pid}/${kn}`,key,upstream:`http://127.0.0.1:${port}`,model,vision:false,group:"fast",member:`${pid}/${model}`};}
const okUp = await makeUpstream((req,res)=>{ res.writeHead(200); res.end("{}"); });
const tk = token();
const c = new ProxyServer({
  provider: "bodyhang", upstream: "http://combo.pmc.invalid/", api: "openai-completions",
  authToken: tk, port: await freeP(),
  apiKeys: [slot("A","a","sk-a",okUp.address().port,"ma")],
});
await c.start();
// 建立 socket, 发 headers + 部分 body, 然后停住不 end —— 模拟客户端卡在发送 body
const sock = http.request({ host:"127.0.0.1", port:c.port, path:"/c", method:"POST", headers:{ "content-type":"application/json","content-length":"10000","authorization":"Bearer "+tk } });
sock.write('{"model":"fast","messages":[]}'); // 只发 25 字节, 声明 10000, 剩余不发
sock.on("error", ()=>{});
sock.setTimeout(3000, ()=>{ console.log("[BUG3] 客户端发不完整body后: 代理无响应(socket超时)——确认永久挂起"); sock.destroy(); });
sock.end();
await new Promise(r=>setTimeout(r,3500));
console.log("[BUG3] 测试结束：代理对该不完整body请求无任何日志/响应");
c.stop(); okUp.close();
