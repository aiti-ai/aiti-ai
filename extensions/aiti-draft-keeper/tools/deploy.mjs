#!/usr/bin/env node
/**
 * Draft Keeper（aiti-draft-keeper）· 部署到 ~/.pi/web{,-dev}/extensions/
 * 纯 client 免构建：拷贝 index.ts + icon + client/ 即可。
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload；client no-store 刷新页面即新
 */
import { cpSync, mkdirSync } from "node:fs";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, "..");
const targets = [
  resolve(homedir(), ".pi/web/extensions/aiti-draft-keeper"),
  resolve(homedir(), ".pi/web-dev/extensions/aiti-draft-keeper"),
];
for (const dir of targets) {
  mkdirSync(resolve(dir, "dist"), { recursive: true });
  cpSync(resolve(root, "index.ts"), resolve(dir, "index.ts"));
  cpSync(resolve(root, "package.json"), resolve(dir, "package.json"));
  cpSync(resolve(root, "client/src/aiti-draft-keeper-client.mjs"), resolve(dir, "dist/aiti-draft-keeper-client.mjs"));
  cpSync(resolve(root, "client/src/core.mjs"), resolve(dir, "dist/core.mjs"));
  console.log(`[deploy] → ${dir}`);
}

// 部署状态 commit（无变更跳过；失败不阻断）——crash-rescue #9：纯 mjs 扩展也可回滚
deployCommit({ repo: resolve(homedir(), ".pi", "web", "extensions"), name: "aiti-draft-keeper", paths: ["aiti-draft-keeper"], ident: true, log: (m) => console.log("[deploy] " + m) });
console.log("[deploy] 完成。生效：POST /api/extensions/reload 或重启 pi-web");

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
