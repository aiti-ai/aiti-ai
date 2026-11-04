#!/usr/bin/env node
/**
 * AI input（aiti-ai-input）· 部署到 ~/.pi/web/extensions/ 和 ~/.pi/web-dev/extensions/
 * （pi-web 双实例扩展目录；照 aiti-prompts deploy）
 *
 * 步骤：
 *   0) 构建 JSX client bundle（client/src/*.tsx → client/aiti-ai-input-client.mjs）
 *   1) 拷贝服务端源码 index.ts → 两个扩展目录
 *   2) 拷贝 client 产物 → 两个扩展目录 client/
 *   3) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）（失败不影响部署）
 *
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 *
 * 前置：pi-web core 需含 chatInputTop slot + registerChatHook preSend（均已存在，
 *       components/ExtSlots.tsx + ChatInput.tsx）；ChatInput textarea 需有
 *       data-chat-input 锚点（一行改动，见 docs/aiti-voice-input-plan.md §9.4）。
 */
import { copyFileSync, mkdirSync, cpSync, existsSync, unlinkSync } from "node:fs";
import { resolve, basename} from "node:path";
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

const root = resolve(import.meta.dirname, ".."); // pi-web-ext/aiti-ai-input

// 0) 客户端 bundle 构建（client/src/*.tsx → client/aiti-ai-input-client.mjs）
console.log("[deploy] 构建 JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] 构建失败，中止部署：", e.message);
  process.exit(1);
}

const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-ai-input"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-ai-input"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

for (const extDir of targets) {
  // 1) 服务端源码
  mkdirSync(extDir, { recursive: true });
  copyFileSync(resolve(root, "index.ts"), resolve(extDir, "index.ts"));
  copyFileSync(resolve(root, "package.json"), resolve(extDir, "package.json"));
  // 引擎层（asr-providers.ts）：index.ts 同目录 import，必须随扩展一起部署
  copyFileSync(resolve(root, "asr-providers.ts"), resolve(extDir, "asr-providers.ts"));
  // 用量统计（state 层持久化；index.ts / 桥 同目录 import）
  copyFileSync(resolve(root, "asr-usage.ts"), resolve(extDir, "asr-usage.ts"));
  // 讯飞真流式桥（进程内 WS 服务；index.ts 同目录 import）
  copyFileSync(resolve(root, "xfyun-bridge.ts"), resolve(extDir, "xfyun-bridge.ts"));
  copyFileSync(resolve(root, "icon.svg"), resolve(extDir, "icon.svg"));
  console.log("[deploy] 源码 → " + resolve(extDir, "index.ts"));

  // 2) client bundle + 全部 hash 分块（薄壳拆分 §4.3：懒 chunk asr-panel/voice-l2/
  //    usage-report/ext-float-dock 随主 bundle 部署；清理陈旧 hash；.map 不部署）
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-ai-input-client.mjs"), resolve(clientDir, "aiti-ai-input-client.mjs"));
  copyFileSync(resolve(root, "client/src/it-terms.js"), resolve(clientDir, "it-terms.js"));
  try {
    const { readdirSync } = await import("node:fs");
    const srcFiles = readdirSync(resolve(root, "dist")).filter((f) => f.endsWith(".js"));
    for (const f of srcFiles) copyFileSync(resolve(root, "dist", f), resolve(clientDir, f));
    for (const f of readdirSync(clientDir)) {
      if (f.endsWith(".js") && !srcFiles.includes(f)) { try { unlinkSync(resolve(clientDir, f)); } catch { /* noop */ } }
    }
    console.log("[deploy] client bundle + chunks（" + (srcFiles.length + 2) + " 文件） → " + clientDir);
  } catch (e) { console.warn("[deploy] client chunks 拷贝失败：", e.message); }

  // 2.5) skills（ai-helper 聚合：skills/index.json + <name>/SKILL.md）
  const skillsDir = resolve(extDir, "skills");
  try {
    cpSync(resolve(root, "skills"), skillsDir, { recursive: true });
    console.log("[deploy] skills → " + skillsDir);
  } catch { /* 无 skills 目录则跳过 */ }

  // 2.6) server（ASR 服务代码随扩展部署——扩展自包含，未知源码路径；除外运行时物）
  const serverDir = resolve(extDir, "server");
  try {
    cpSync(resolve(root, "server"), serverDir, {
      recursive: true,
      filter: (src) => {
        const name = basename(src);
        // 跳过：venv/日志/缓存/pyc——运行时按 dataDir 重建，不入扩展目录
        return !(name === "asr-venv" || name === ".venv" || name === "logs" || name === "__pycache__" || name === "recordings");
      },
    });
    console.log("[deploy] server → " + serverDir);
  } catch (e) { try { console.warn("[deploy] server 拷失败", e); } catch {} }
}

// 3) 部署 commit（扩展 git 仓库；无变更跳过，失败不影响部署）


// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of targets) copyIcons(resolve(t, "icons"), ["mic"], { log: (m2) => console.log(m2) });
deployCommit({ repo: extRepo, name: "aiti-ai-input", paths: ["aiti-ai-input"], ident: true, log: (m) => console.log("[deploy] " + m) });

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
