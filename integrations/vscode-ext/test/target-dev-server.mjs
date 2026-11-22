// 靶场 dev server：5173，text/html 页面（无 aiti 注入，等代理注入）
import http from "http";
const html = `<!DOCTYPE html><html><head><title>AITI TARGET</title></head><body><h1 id="btn">AITI-PROXY-TEST-PAGE</h1><script src="/app.js"></script></body></html>`;
http.createServer((req, res) => {
  if (req.url === "/app.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end("console.log('target app')"); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
}).listen(5173, "127.0.0.1", () => console.log("target dev server on 5173"));
