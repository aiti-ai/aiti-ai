/**
 * bridge-url.test.mjs —— 桥地址协商（normalizeBridgeBase）回归测试
 *
 * 背景：pi-web 注入的 AITI_BRIDGE_URL 是 shim 的「扩展路径签名」形态（不带 /mcp），
 * 本扩展必须归一为 `<extBase>/mcp` 才能直达桥路由（否则 register/sse 404）。
 *
 * 用法：node packages/aiti-devtools-pi/test/bridge-url.test.mjs
 */
import { normalizeBridgeBase, PI_WEB_EXT_PATH_SIG } from "../src/bridge-url.ts";

let pass = 0, fail = 0;
const eq = (actual, expected, msg) => {
  if (actual === expected) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.error("  ✗ " + msg + "\n      期望=" + expected + "\n      实际=" + actual); }
};

console.log("bridge-url.test.mjs");

// 签名常量与 shim 同值（跨模块契约）
eq(PI_WEB_EXT_PATH_SIG, "/api/extensions/aiti-devtools", "签名常量与 aiti-mcp-shim 的 EXT_PATH_SIG 同值");

// dev 注入原形（agent-spawn-env）→ 补 /mcp
eq(
  normalizeBridgeBase("http://127.0.0.1:3001/dev/api/extensions/aiti-devtools"),
  "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp",
  "dev 注入原形 → 补 /mcp",
);
// 已带 /mcp → 幂等
eq(
  normalizeBridgeBase("http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp"),
  "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp",
  "已带 /mcp → 幂等不变",
);
// 完整 MCP 端点（/mcp/mcp）→ 归一为桥 base
eq(
  normalizeBridgeBase("http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp/mcp"),
  "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp",
  "完整端点 /mcp/mcp → 归一",
);
// prod（无 basePath）
eq(
  normalizeBridgeBase("http://127.0.0.1:3002/api/extensions/aiti-devtools"),
  "http://127.0.0.1:3002/api/extensions/aiti-devtools/mcp",
  "prod 无 basePath → 补 /mcp",
);
// 带 basePath（155 /win）
eq(
  normalizeBridgeBase("https://pi.example.com:8443/win/api/extensions/aiti-devtools"),
  "https://pi.example.com:8443/win/api/extensions/aiti-devtools/mcp",
  "带 basePath（/win）→ 补 /mcp",
);
// 独立桥形态不受影响
eq(normalizeBridgeBase("http://127.0.0.1:8777/aiti"), "http://127.0.0.1:8777/aiti", "独立桥 …/aiti → 原样");
eq(normalizeBridgeBase("http://127.0.0.1:8777"), "http://127.0.0.1:8777", "裸 origin → 原样");
// 非法 URL 原样（不 throw）
eq(normalizeBridgeBase("not-a-url"), "not-a-url", "非法 URL → 原样不炸");
// 尾部斜杠由调用方剥（resolveBridgeUrl 先 replace）；此处带斜杠也应得稳定结果
eq(
  normalizeBridgeBase("http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp/"),
  "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp",
  "尾部斜杠 → 归一稳定",
);
// 签名后带额外路径（例如误给完整 register 端点）→ 仍归一为桥 base
eq(
  normalizeBridgeBase("http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp/bridge/agent/register"),
  "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp",
  "签名后带子路径 → 归一为桥 base",
);

console.log("────────────────────────────");
console.log("bridge-url.test.mjs 结果：" + pass + " 通过 / " + fail + " 失败");
process.exit(fail === 0 ? 0 : 1);
