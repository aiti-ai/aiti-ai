#!/usr/bin/env node
/**
 * cc-connect bridge WS 端到端测试——模拟 cc-connect Web UI Chat 注册 + 发消息
 *
 * 验证：bridge WS 注册（adapter registered）→ 消息进 cc-connect → cc-connect spawn 连接器
 *       → ACP session/new（pi-web 真会话）→ 回复经 bridge 回流。
 *
 * 前置：cc-connect 用含 [bridge] insecure 的临时 config 跑着（见下方「临时 config 生成」），
 * pi-web 的 ACP server 须监听（POST /api/extensions/aiti-channels/reload 或重启 pi-web）。
 *
 * 用法：node tests/bridge-ws-e2e.mjs [wsUrl] [project] [content]
 *   wsUrl 缺省 = ws://127.0.0.1:9810/bridge/ws?token=
 *   project 缺省 = acpchat
 *
 * 临时 config 生成（在 pi-web 面板或直接写）：
 *   data_dir = "/tmp/cc-acptest-data"
 *   [[projects]]
 *     name = "acpchat"
 *     [projects.agent]
 *       type = "acp"                    # cc-connect 原生 type=acp（不改它的文件）
 *       [projects.agent.options]
 *         work_dir = "/home/pi/workspace/atest"
 *         command = "node"              # ⚠ cc-connect 旧版二进制读 command（非 cmd）；config-gen 已用 command
 *         args = ["<扩展>/bin/aiti-acp-connector.mjs", "--socket", "<dataDir>/acp/default.sock"]
 *         display_name = "AITI Agent"
 *     [[projects.platforms]]           # cc-connect 要求 project 至少一个 platform（既有约束）
 *       type = "telegram"
 *       [projects.platforms.options]
 *         token = "123456789:AAExx..."  # 假 token：platform 创建不 fatal，仅 telegram 连不上 retry（不影响 bridge 触发 agent）
 *   [management]
 *   enabled = true
 *   port = 9821
 *   [bridge]
 *   enabled = true
 *   port = 9810
 *   insecure = true                     # 本地测试免 token
 *   path = "/bridge/ws"
 *
 * 启动：setsid cc-connect -config /tmp/cc-acptest.toml &
 *
 * 注意：cc-connect engine 对 acp agent 的回复聚合存在已知问题——session spawned 后
 * 可能卡住不发 session/prompt，或 EventText content 空导致 bridge reply 为 "(空响应)"。
 * 这是 cc-connect engine 内部逻辑（message→Prompt→fullResponse 路径），非 ACP server 实现
 * 问题（直接 socket 测 tests/acp-socket-smoke.mjs 全绿）。本脚本用于验证 bridge 注册 +
 * 消息派发链路，reply content 完整性见 §10.7 待办。
 */
const url = process.argv[2] || "ws://127.0.0.1:9810/bridge/ws?token=";
const project = process.argv[3] || "acpchat";
const content = process.argv[4] || "只回四个字：bridge通";
const ws = new WebSocket(url);
let buf = "", done = false, pingTimer = null;

ws.onopen = () => {
  console.error("[bridge] connected, registering");
  ws.send(JSON.stringify({ type: "register", platform: "web", capabilities: ["text","card","buttons","typing","update_message"], metadata: { version: "1.0.0", description: "e2e-smoke" } }));
};
ws.onmessage = (e) => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.type === "ping" || m.type === "ping_request") { ws.send(JSON.stringify({ type: "pong", ts: Date.now() })); return; }
  if (m.type === "register_ack") {
    console.error(`[bridge] register_ack ok=${m.ok}${m.error ? " err=" + m.error : ""}`);
    if (m.ok) {
      pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch {} }, 5000);
      ws.send(JSON.stringify({ type: "message", msg_id: `web-${Date.now()}`, session_key: `web:e2e:${Date.now()%1000}`, user_id: "web-admin", user_name: "Web", content, reply_ctx: `web:e2e:1`, project }));
      console.error("[bridge] message sent, waiting reply...");
    }
    return;
  }
  if (m.type === "reply_stream") { buf += m.delta || ""; if (m.done) { console.log(`[bridge] 完整回复(stream): ${buf}`); finish(); } return; }
  if (m.type === "reply") { console.log(`[bridge] reply: ${m.content || "(空)"}`); finish(); return; }
  if (m.type === "error") { console.error("[bridge] error:", m.code, m.message); process.exit(1); }
  if (m.type === "pong") return;
  console.error(`[bridge] · ${m.type}`);
};
ws.onerror = (e) => { console.error("[bridge] ws error:", e.message || "(no msg)"); };
ws.onclose = (e) => { console.error(`[bridge] closed code=${e.code} clean=${e.wasClean}`); if (pingTimer) clearInterval(pingTimer); if (!done) process.exit(1); };
function finish() { done = true; if (pingTimer) clearInterval(pingTimer); setTimeout(() => process.exit(0), 500); }
setTimeout(() => { console.error(`[bridge] timeout (partial: ${buf})`); if (pingTimer) clearInterval(pingTimer); process.exit(done ? 0 : 1); }, 120000);
