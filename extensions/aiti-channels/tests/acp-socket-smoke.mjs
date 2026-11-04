#!/usr/bin/env node
/**
 * ACP socket 冒烟测试——直连 aiti-channels ACP server（不经 cc-connect/连接器）
 *
 * 验证：initialize → session/new（建 pi-web 真会话）→ session/prompt（流式回流 + stopReason）
 * 全程不依赖 cc-connect / IM 凭证，直接证明 ACP server + 桥接 + pi 会话链路。
 *
 * 用法：node tests/acp-socket-smoke.mjs [socketPath] [cwd]
 *   socketPath 缺省 = ~/.pi/web/data/aiti-channels/acp/default.sock
 *   cwd 缺省 = ~/workspace/atest（须存在）
 *
 * 退出码：0=全绿；1=失败。
 *
 * Windows：socketPath 是命名管（`\\.\pipe\aiti-channels-acp-<hash>-<id>`，acp-status 的
 * socket 字段原样复制）。⚠ git-bash 向 Windows 进程传 `\\.\pipe\...` 会被吞掉一层反斜杠
 * （UNC 设备路径头变 `\.\pipe\`，env/argv 同吃；lessons §3）——本脚本自动修复该形态；
 * 也可传纯名称（`aiti-channels-acp-<hash>-<id>`，脚本自补 `\\.\pipe\` 前缀）。
 */
import net from "node:net";
import path from "node:path";
import os from "node:os";

/** 修复 git-bash 传参吞掉的 UNC 设备路径头：\.\pipe\x → \\.\pipe\x */
function normalizeWinPipe(p) {
  if (/^\\\.\\pipe\\/i.test(p)) return "\\\\.\\pipe\\" + p.slice(8);
  if (!/^\\\\/.test(p) && !p.includes("\\") && !p.includes("/")) return "\\\\.\\pipe\\" + p; // 纯管名
  return p;
}
const SOCK = normalizeWinPipe(process.env.ACP_SOCK || process.argv[2] || "") || path.join(os.homedir(), ".pi", "web", "data", "aiti-channels", "config", "acp", "default.sock");
const cwd = process.argv[3] || path.join(os.homedir(), "workspace", "atest");

const sock = net.connect(SOCK);
let buf = "", nextId = 1;
const pending = new Map();
let sessionId = null;
let textBuf = "";

sock.on("connect", () => console.error(`[smoke] connected: ${SOCK}`));
sock.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { key, resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      const r = msg.result ?? msg.error;
      console.error(`[smoke] ← ${key}: ${JSON.stringify(r).slice(0, 180)}`);
      resolve(r);
    } else if (msg.method === "session/update") {
      const u = msg.params?.update;
      const kind = u?.sessionUpdate;
      if (kind === "agent_message_chunk") {
        const t = u.content?.text || "";
        textBuf += t;
        process.stderr.write(t);
      } else if (kind === "tool_call") {
        console.error(`\n[smoke] · tool_call: ${u.title || ""} [${u.kind || ""}]`);
      } else if (kind === "tool_call_update") {
        console.error(`[smoke] · tool_call_update: status=${u.status}`);
      }
    }
  }
});
sock.on("error", (e) => { console.error("[smoke] socket error:", e.message); process.exit(1); });
sock.on("close", () => { console.error("\n[smoke] socket closed"); });

function rpc(method, params, key) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { key, resolve });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    console.error(`[smoke] → ${method} (id=${id})`);
  });
}

;(async () => {
  const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "smoke", version: "0" } }, "initialize");
  if (!init?.protocolVersion) { console.error("[smoke] FAIL: initialize"); process.exit(1); }

  const nw = await rpc("session/new", { cwd, mcpServers: [] }, "session/new");
  sessionId = nw?.sessionId;
  if (!sessionId) { console.error("[smoke] FAIL: no sessionId"); process.exit(1); }
  console.error(`[smoke] session: acp=${sessionId.slice(0, 8)}`);

  const p = await rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "用一句话说你是谁，不要用任何工具。" }] }, "session/prompt");
  console.error(`\n[smoke] prompt stopReason: ${p?.stopReason}`);
  console.error(`[smoke] 回复全文: ${textBuf}`);

  const ok = p?.stopReason === "end_turn" && textBuf.length > 0;
  console.error(`\n[smoke] ${ok ? "✅ 全绿" : "❌ 失败"}`);
  setTimeout(() => process.exit(ok ? 0 : 1), 300);
})();
