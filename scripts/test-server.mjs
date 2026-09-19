// Test / demo upstream service for the service-vhost proxy (proxy.ts):
//   node scripts/test-server.mjs    → http://127.0.0.1:8903 hello-svc
// Then enroll it from the Services dialog (Expose → proxy) and reach it at
// <port>.example.com (or <port>-pi-web.<domain> for pi-web itself).
// Exits on SIGINT; port overridable: PORT=9000 node scripts/test-server.mjs

import http from "node:http";

const server = http.createServer((req, res) => {
  const info = {
    path: req.url,
    method: req.method,
    headers: req.headers,
    timestamp: new Date().toISOString()
  };
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'hello-svc', ...info }, null, 2));
});

server.listen(8903, '127.0.0.1', () => {
  console.log('Test server running on http://127.0.0.1:8903');
});