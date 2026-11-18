/**
 * 宿主内 E2E（@vscode/test-electron）：起独立 VS Code 实例加载本扩展，
 * 真实执行 aiti.enableDebug / aiti.stopDebug 并断言全链路效果。
 * 运行：node test/e2e.mjs（DISPLAY 有可用 X；--disable-extensions 隔离其他扩展）
 */
import { runTests } from "@vscode/test-electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// e2e-workspace/.vscode/mcp.json 是本机配置（.vscode/ 已 gitignore，不入库）——clone 后
// 不存在。fixture 自愈：缺文件时生成参数化模板（${workspaceFolder} 由 VS Code 解析，
// 指向仓内可再生构建产物 dist/bridge/aiti-mcp-shim.cjs；跑前先 npm run build）。
const wsMcpDir = path.join(root, "test", "e2e-workspace", ".vscode");
const wsMcp = path.join(wsMcpDir, "mcp.json");
if (!fs.existsSync(wsMcp)) {
  fs.mkdirSync(wsMcpDir, { recursive: true });
  fs.writeFileSync(wsMcp, JSON.stringify({
    servers: {
      aiti: {
        type: "stdio",
        command: "node",
        args: ["${workspaceFolder}/../../dist/bridge/aiti-mcp-shim.cjs"],
        env: { AITI_BRIDGE_URL: "http://127.0.0.1:8777/aiti" },
      },
    },
  }, null, 2) + "\n");
  console.log("[e2e] generated fixture: test/e2e-workspace/.vscode/mcp.json");
}

runTests({
  // 本机已装 VS Code（snap wrapper 自带环境），免下载
  vscodeExecutablePath: "/snap/bin/code",
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, "test", "e2e-suite.cjs"),
  launchArgs: [
    path.join(root, "test", "e2e-workspace"),
    "--disable-extensions", // 隔离 juehang/copilot 等，只加载我们的扩展
    "--disable-workspace-trust",
    "--disable-gpu",
  ],
})
  .then(() => {
    console.log("E2E PASSED");
    process.exit(0);
  })
  .catch((e) => {
    console.error("E2E FAILED:", e?.message || e);
    process.exit(1);
  });
