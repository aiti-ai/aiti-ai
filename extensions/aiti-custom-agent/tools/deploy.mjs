#!/usr/bin/env node
/** 部署 aiti-custom-agent 到 ~/.pi/web{,-dev}/extensions/（默认双写；--prod 仅 prod、--dev 仅 dev；文件集须与部署树一致）。 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";
import { notifyReconcile } from "../../_shared/reconcile-deps.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// 目标：默认双写 web + web-dev；--prod 仅 prod、--dev 仅 dev（向后兼容旧单边用法）
const prod = process.argv.includes("--prod");
const devOnly = process.argv.includes("--dev");
const home = process.env.HOME || process.env.USERPROFILE;
const bases = [
  ...(prod ? [] : [join(home, ".pi", process.env.PI_WEB_DEV_DIR ? `web-${process.env.PI_WEB_DEV_DIR}` : "web-dev", "extensions")]),
  ...(devOnly ? [] : [join(home, ".pi", "web", "extensions")]),
];
for (const base of bases) {
  const dest = join(base, "aiti-custom-agent");
  mkdirSync(dest, { recursive: true });
  for (const f of ["index.ts", "generic-handle.ts", "core.cjs", "package.json"]) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(dest, f));
  }
  // 管理面板 client（零构建原生 h()）
  mkdirSync(join(dest, "dist"), { recursive: true });
  cpSync(join(root, "client", "src", "custom-agent-client.mjs"), join(dest, "dist", "custom-agent-client.mjs"));
  // 工具条图标（线图库 _shared/icons，禁 emoji；清单须覆盖引用全集）
  copyIcons(join(dest, "icons"), ["bot.svg"], { log: (m) => console.log(m) });
  console.log(`[deploy] aiti-custom-agent → ${dest}`);
}

// 共享根依赖对齐（本扩展暂无运行时依赖，通知保持幂等；建议在 reload 之前）
try {
  await notifyReconcile();
} catch (e) {
  console.log("[deploy] notifyReconcile 未执行（" + String((e && e.message) || e) + "）");
}

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
