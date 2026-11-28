#!/usr/bin/env node
/**
 * aiti-acp-connector —— cc-connect (type=acp) spawn 的薄连接器（几 KB，无状态）
 *
 * 一端：ACP ndjson over stdio（cc-connect ⇄ 本进程，cc-connect 是成熟 ACP client）
 * 另一端：同一字节流 ⇄ aiti-channels ACP server（Unix socket，pi-web 进程内常驻）
 *
 * 纯字节双向转发，不解析协议——协议演进零维护。agent（pi-web 会话）全部归 aiti 管：
 * pi-web 停机 → socket 连不上 → 连接器短重试后退出 → cc-connect 报错，无孤儿 pi 进程。
 *
 * 时序安全：cc-connect spawn 后立刻写 initialize 首帧，而 socket 可能未就绪
 * （连接器有 30s 重试窗）——连通前的 stdin 字节全量缓冲，connect 后按序补发。
 *
 * 用法：node aiti-acp-connector.mjs --socket <path>   （或 env AITI_ACP_SOCKET）
 * 诊断只写 stderr。
 */
import net from "node:net";
import process from "node:process";

const args = process.argv.slice(2);
let socketPath = process.env.AITI_ACP_SOCKET || "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--socket" && args[i + 1]) { socketPath = args[i + 1]; i++; }
}
if (!socketPath) {
  console.error("[aiti-acp-connector] 缺 --socket <path>");
  process.exit(2);
}

let sock = null;        // 就绪的 socket（stdin 字节只往这里写）
let closing = false;
let pending = [];       // 连通前缓冲的 stdin 字节
let pendingBytes = 0;

function teardown() {
  if (closing) return;
  closing = true;
  try { sock?.destroy(); } catch {}
  process.exit(0);
}

// socket → stdout（下行：session/update / prompt 结果）
function downstream(s) {
  s.on("data", (chunk) => {
    if (!process.stdout.destroyed) process.stdout.write(chunk);
  });
  s.on("end", () => {
    if (!process.stdout.destroyed) process.stdout.end();
  });
  s.on("error", (e) => {
    console.error(`[aiti-acp-connector] socket error: ${e.message}`);
    teardown();
  });
}

function connect(attempt = 0) {
  const MAX_ATTEMPTS = 60; // 500ms × 60 = 30s：覆盖 pi-web 重启窗口，超时放弃退出
  const s = net.connect(socketPath);
  s.setNoDelay(true);

  s.on("connect", () => {
    if (attempt > 0) console.error(`[aiti-acp-connector] 已连上（第 ${attempt + 1} 次尝试）`);
    sock = s;
    downstream(s);
    if (pendingBytes > 0) {
      const buffered = Buffer.concat(pending);
      pending = []; pendingBytes = 0;
      s.write(buffered);
      console.error(`[aiti-acp-connector] 补发连通前缓冲的 ${buffered.length} 字节`);
    }
  });

  s.on("error", (e) => {
    s.destroy();
    if (closing) return;
    if (attempt + 1 >= MAX_ATTEMPTS) {
      console.error(`[aiti-acp-connector] 连不上 ${socketPath}（重试 ${MAX_ATTEMPTS} 次放弃）: ${e.message}`);
      process.exit(1);
    }
    if (attempt === 0) console.error(`[aiti-acp-connector] ${socketPath} 未就绪，500ms 后重试…`);
    setTimeout(() => connect(attempt + 1), 500);
  });
}

// stdin → socket（上行：initialize / session/new / prompt …；未连通先缓冲）
process.stdin.on("data", (chunk) => {
  if (sock && !sock.destroyed) { sock.write(chunk); return; }
  pending.push(Buffer.from(chunk));
  pendingBytes += chunk.length;
});
process.stdin.on("error", teardown);
process.stdout.on("error", teardown);
process.stdin.on("end", () => { /* cc-connect 关 stdin = 关会话；等 socket 端 end 收尾 */ });
process.on("SIGTERM", teardown);
process.on("SIGINT", teardown);

connect();
