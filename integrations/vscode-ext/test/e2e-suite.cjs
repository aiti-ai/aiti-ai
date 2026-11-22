const vscode = require("vscode");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const BRIDGE = "http://127.0.0.1:8777/aiti/bridge/sessions";
const PORT_RANGE = Array.from({ length: 10 }, (_, i) => 8788 + i); // 代理端口分配池
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error(`timeout(${timeoutMs}ms): ${label}${lastErr ? ` — ${lastErr.message}` : ""}`);
}

/** 登记模型下代理端口动态分配——扫描端口池找「已注入」的通道 */
async function findInjectedProxy() {
  for (const port of PORT_RANGE) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 800);
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal, headers: { "sec-fetch-mode": "navigate" } });
      clearTimeout(t);
      const body = await res.text();
      if (body.startsWith("<script") && body.includes("aiti-launcher.js") && body.includes("AITI-PROXY-TEST-PAGE")) {
        return { port, body };
      }
    } catch { /* not listening */ }
  }
  return null;
}

async function run() {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(ws, "测试工作区已打开");
  console.log(`[e2e] workspace: ${ws}`);

  const ext = vscode.extensions.getExtension("aiti-ai.aiti-devtools-vscode");
  assert.ok(ext, "扩展已加载");
  if (!ext.isActive) await ext.activate();

  // ① 启用（autoEnable 已在工作区设置里跑过一次——幂等）
  await vscode.commands.executeCommand("aiti.enableDebug", "http://127.0.0.1:5173");
  await waitUntil(async () => !!(await findInjectedProxy()), 8000, "注入通道就绪");
  const { port, body } = await findInjectedProxy();
  console.log(`[e2e] proxy up :${port}`);

  // ② 注入断言
  assert.ok(body.startsWith("<script"), "launcher 标签在文档最前");
  assert.ok(body.includes('data-bridge-url="http://127.0.0.1:8777/aiti"'), "桥地址指向 8777/aiti");
  assert.ok(body.includes("AITI-PROXY-TEST-PAGE"), "目标页面内容完整");
  console.log("[e2e] injection ok");

  // ③ mcp.json
  const mcpFile = path.join(ws, ".vscode", "mcp.json");
  const mcp = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
  assert.equal(mcp.servers.aiti.type, "stdio");
  assert.ok(mcp.servers.aiti.args[0].endsWith("aiti-mcp-shim.cjs"));
  assert.equal(mcp.servers.aiti.env.AITI_BRIDGE_URL, "http://127.0.0.1:8777/aiti");
  console.log("[e2e] mcp.json ok");

  // ④ 桥复用
  const bridgeRes = await fetch(BRIDGE);
  assert.ok(bridgeRes.ok, "外部桥 8777 可用");
  console.log("[e2e] bridge reused ok");

  // ⑤ 停止（全部通道）
  await vscode.commands.executeCommand("aiti.stopDebug");
  await waitUntil(async () => {
    for (const p of PORT_RANGE) {
      try {
        await fetch(`http://127.0.0.1:${p}/`);
        return false;
      } catch { /* down */ }
    }
    return true;
  }, 8000, "全部代理已关闭");
  const bridgeAfter = await fetch(BRIDGE);
  assert.ok(bridgeAfter.ok, "停止后外部桥 8777 仍健康（不误杀）");
  console.log("[e2e] stop ok, bridge untouched");
}

exports.run = run;
