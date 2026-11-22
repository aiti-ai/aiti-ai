#!/usr/bin/env node
/**
 * aiti-testagent-native · 部署到 ~/.pi/web/extensions/ 和 ~/.pi/web-dev/extensions/
 *
 * 部署内容：index.ts / dist/（vite client bundle）/ icon.svg / icons/。
 * 生效：POST /api/extensions/reload（deploy 末尾自动双实例 reload，允许失败）。
 * 数据源：testagent-native broker（默认 http://127.0.0.1:8766，env TAN_BROKER_HTTP / TAN_TOKEN）。
 */
import { cpSync, mkdirSync } from "node:fs";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// 先构建 JSX client（失败即中止）
{
  const r = spawnSync(process.execPath, [resolve(import.meta.dirname, "build-client.mjs")], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const root = resolve(import.meta.dirname, "..");
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-testagent-native"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-testagent-native"),
];

for (const dir of targets) {
  mkdirSync(dir, { recursive: true });
  for (const f of ["package.json", "index.ts", "icon.svg"]) cpSync(resolve(root, f), resolve(dir, f));
  cpSync(resolve(root, "dist"), resolve(dir, "dist"), { recursive: true });
  console.log("[deploy] → " + dir);
}

// 图标（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["monitor"], { log: (m2) => console.log(m2) });

deployCommit({ repo: resolve(homedir(), ".pi", "web", "extensions"), name: "aiti-testagent-native", paths: ["aiti-testagent-native"], ident: true, log: (m) => console.log("[deploy] " + m) });
console.log("[deploy] 完成。生效：POST /api/extensions/reload；面板数据源 = testagent-native broker HTTP(8766)");

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败 ──
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
