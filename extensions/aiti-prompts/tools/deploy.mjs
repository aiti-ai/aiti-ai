#!/usr/bin/env node
/**
 * aiti-prompts · 部署到 ~/.pi/web/extensions/ 和 ~/.pi/web-dev/extensions/（pi-web 双实例扩展目录）
 *
 * 步骤：
 *   0) 构建 JSX client bundle（client/src/*.tsx → client/aiti-prompts-client.mjs）
 *   1) 拷贝服务端源码（index/store）→ 两个扩展目录
 *   2) 拷贝 client bundle → 两个扩展目录 client/
 *   3) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）（失败不影响部署）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 *
 * 前置：pi-web core 需含扩展发送通道 ctx.sendChatMessage + chatInputTop inputValue 透传
 *       （components/ExtSlots.tsx + ChatInput.tsx，见 docs/aiti-prompts-extension-plan.md §6）
 */
import { copyFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-prompts
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-prompts"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-prompts"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

// 0) 客户端 bundle 构建（client/src/*.tsx → client/aiti-prompts-client.mjs）
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

for (const extDir of targets) {
  // 1) 服务端源码
  mkdirSync(extDir, { recursive: true });
  for (const f of ["package.json", "index.ts", "icon.svg", "store.ts"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] 源码 → " + resolve(extDir, f));
  }

  // 2) client bundle
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-prompts-client.mjs"), resolve(clientDir, "aiti-prompts-client.mjs"));
  console.log("[deploy] client → " + resolve(clientDir, "aiti-prompts-client.mjs"));
  // skills/ 帮助点目录（pi skills 标准）
  const skillSrc = resolve(root, "skills");
  if (existsSync(skillSrc)) {
    const skillDest = resolve(extDir, "skills");
    mkdirSync(skillDest, { recursive: true });
    cpSync(skillSrc, skillDest, { recursive: true });
    console.log("[deploy] skills → " + skillDest);
  }
}

// 3) 部署 commit（扩展 git 仓库；无变更跳过，失败不影响部署）

// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["bookmark", "import"], { log: (m2) => console.log(m2) });

deployCommit({ repo: extRepo, name: "aiti-prompts", paths: ["aiti-prompts"], ident: true, log: (m) => console.log("[deploy] " + m) });

console.log("[deploy] 完成。生效：POST /api/extensions/reload（或重启 pi-web）；client 刷新页面即新");

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
