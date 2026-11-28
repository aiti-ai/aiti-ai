/**
 * endpoints.test.mjs —— 地址协商解析（纯函数）
 * 用法：node test/endpoints.test.mjs
 */
import assert from "node:assert/strict";
import { resolveEndpoints, normalizeBridgeUrl, hasBridgePathSignature, sameOrigin } from "../src/endpoints.ts";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("✗ " + msg); } };

// ---- 空 bridgeUrl → 同源 ----
{
  const e = resolveEndpoints({ serverUrl: "http://localhost:5173" });
  ok(e.kind === "same-origin", "空 → same-origin");
  ok(e.bridgeBase === "http://localhost:5173/aiti", "bridgeBase = origin/aiti");
  ok(e.launcherUrl === "http://localhost:5173/aiti/aiti-launcher.js", "launcherUrl");
  ok(e.mcpUrl === "http://localhost:5173/aiti/mcp", "mcpUrl（一遍 /mcp）");
  ok(e.cockpitUrl === "http://localhost:5173/aiti/cockpit.html", "cockpitUrl");
  ok(e.aiUrl === e.cockpitUrl, "无 aiUrl → 同源 cockpit");
}

// ---- 剥后缀协商 ----
{
  const cases = [
    ["http://localhost:5173/aiti", "http://localhost:5173/aiti"],
    ["http://localhost:5173/aiti/", "http://localhost:5173/aiti"],
    ["http://localhost:5173/aiti/bridge", "http://localhost:5173/aiti"],
    ["http://localhost:5173/aiti/bridge/", "http://localhost:5173/aiti"],
    ["http://localhost:5173/aiti/mcp", "http://localhost:5173/aiti"],
    ["http://localhost:5173/aiti/mcp/mcp", "http://localhost:5173/aiti"],
    ["http://127.0.0.1:8777/aiti/mcp/mcp", "http://127.0.0.1:8777/aiti"],
    ["http://127.0.0.1:8777", "http://127.0.0.1:8777/aiti"],
  ];
  for (const [input, wantBase] of cases) {
    const e = resolveEndpoints({ bridgeUrl: input, serverUrl: "http://localhost:5173" });
    ok(e.bridgeBase === wantBase, `协商 ${input} → ${wantBase}（得 ${e.bridgeBase}）`);
  }
  // 同 host → same-origin；外部 → external-bridge
  ok(resolveEndpoints({ bridgeUrl: "http://localhost:5173/aiti", serverUrl: "http://localhost:5173" }).kind === "same-origin", "同 host → same-origin");
  ok(resolveEndpoints({ bridgeUrl: "http://127.0.0.1:8777/aiti/mcp/mcp", serverUrl: "http://localhost:5173" }).kind === "external-bridge", "外部 → external-bridge");
  ok(resolveEndpoints({ bridgeUrl: "http://localhost:5174", serverUrl: "http://localhost:5173" }).kind === "external-bridge", "同 host 不同端口 → external-bridge");
}

// ---- 多余路径：保留 origin + 提示 ----
{
  const e = resolveEndpoints({ bridgeUrl: "http://10.0.0.5:8777/foo", serverUrl: "http://localhost:5173" });
  ok(e.origin === "http://10.0.0.5:8777", "多余路径 → 保留 origin");
  ok(e.notes.some((n) => n.includes("/foo")), "提示忽略 /foo");
  ok(e.bridgeBase === "http://10.0.0.5:8777/aiti", "bridgeBase 仍派生");
}

// ---- 裸外部地址未识别提示 ----
{
  const e = resolveEndpoints({ bridgeUrl: "http://10.0.0.5:8777", serverUrl: "http://localhost:5173" });
  ok(e.kind === "external-bridge", "裸外部 → external-bridge");
  ok(e.notes.some((n) => n.includes("aiUrl")), "提示可用 aiUrl 指定 agent");
}

// ---- aiUrl ----
{
  const e = resolveEndpoints({ aiUrl: "http://aiti-agent.local:3000/", serverUrl: "http://localhost:5173" });
  ok(e.aiUrl === "http://aiti-agent.local:3000", "aiUrl 去尾斜杠");
  ok(e.kind === "same-origin", "桥仍同源");
  ok(e.mcpUrl === "http://localhost:5173/aiti/mcp", "mcp 同源（一遍）");
}

// ---- 自定义前缀 ----
{
  const e = resolveEndpoints({ bridgeUrl: "http://localhost:5173/dbg/mcp/mcp", serverUrl: "http://localhost:5173", prefix: "/dbg" });
  ok(e.bridgeBase === "http://localhost:5173/dbg", "自定义前缀剥 /mcp/mcp → /dbg");
  ok(e.launcherUrl === "http://localhost:5173/dbg/aiti-launcher.js", "launcher 自定义前缀");
}

// ---- normalizeBridgeUrl / hasBridgePathSignature / sameOrigin ----
{
  ok(hasBridgePathSignature("http://x:1/aiti/bridge"), "signature /aiti");
  ok(hasBridgePathSignature("http://x:1/mcp/mcp"), "signature /mcp");
  ok(!hasBridgePathSignature("http://x:1"), "裸地址无 signature");
  ok(sameOrigin("http://a:1/x", "http://a:1"), "sameOrigin true");
  ok(!sameOrigin("http://a:2", "http://a:1"), "sameOrigin false");
  const r = normalizeBridgeUrl("http://h:1/aiti/bridge/agent/tools/call", "/aiti");
  ok(r.origin === "http://h:1", "深路径剥到 origin");
}

console.log(`\nendpoints: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
