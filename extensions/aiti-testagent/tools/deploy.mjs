#!/usr/bin/env node
/**
 * aiti-testagent · 部署到 ~/.pi/web/extensions/ 和 ~/.pi/web-dev/extensions/
 *
 * 纯 JS client（无构建）。部署内容：index.ts / lib/ / client/ / icon.svg。
 * 注意：mcp-testagent.cjs 注册在 ~/.config/mcp/mcp.json 指向仓库原路径（不经部署），
 *       MCP 侧改动对下次 MCP client 启动即生效；lib/ 同时被两者 require，一改两生效。
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新。
 */
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// 先构建 JSX client（失败即中止；构建产物免 checker——TS 残留在源头不可能，model-check 同例）
{
  const r = spawnSync(process.execPath, [resolve(import.meta.dirname, "build-client.mjs")], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const root = resolve(import.meta.dirname, "..");
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-testagent"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-testagent"),
];

for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  for (const f of ["package.json", "index.ts", "icon.svg"]) cpSync(resolve(root, f), resolve(dir, f));
  cpSync(resolve(root, "lib"), resolve(dir, "lib"), { recursive: true });
  cpSync(resolve(root, "dist"), resolve(dir, "dist"), { recursive: true });
  cpSync(resolve(root, "attach-tool"), resolve(dir, "attach-tool"), { recursive: true }); // AttachTool.class（attachJava -cp 指向部署目录内）
  // agent jar（打包布局：testagent-1.0.jar 与 mcp-testagent.cjs 同目录 = resolveAgentJar 第一候选）。
  // 源 = 仓库工作区 mvn 产物（shaded 胖包，含 json 依赖；TESTAGENT_JAR 可指定）。
  // 不存在时跳过不阻断——Linux 侧常由环境 jar 兜底；缺失时 attach/startup 会报 jar 不存在。
  try {
    const jarSrc = process.env.TESTAGENT_JAR || resolve(root, "..", "..", "TestAgent", "TestAgent", "target", "testagent-1.0.jar");
    if (existsSync(jarSrc)) {
      cpSync(jarSrc, resolve(dir, "testagent-1.0.jar"));
      console.log("[deploy] agent jar → " + resolve(dir, "testagent-1.0.jar"));
    } else {
      console.log("[deploy] 跳过 agent jar（无构建产物：" + jarSrc + "；可设 TESTAGENT_JAR 指定）");
    }
  } catch (e) {
    console.log("[deploy] agent jar 拷贝失败（不阻断）: " + (e && e.message));
  }
  console.log("[deploy] → " + dir);
}

// 部署状态 commit（无变更跳过；失败不阻断）——crash-rescue #9：纯 mjs 扩展也可回滚
// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["coffee"], { log: (m2) => console.log(m2) });

deployCommit({ repo: resolve(homedir(), ".pi", "web", "extensions"), name: "aiti-testagent", paths: ["aiti-testagent"], ident: true, log: (m) => console.log("[deploy] " + m) });
console.log("[deploy] 完成。生效：POST /api/extensions/reload；MCP 侧（mcp-testagent.cjs）走仓库原路径即时生效");

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack（方案 §3.2：源码+构建工具+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
