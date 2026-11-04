#!/usr/bin/env node
/**
 * 部署 aiti-subagents 扩展到 ~/.pi/web/extensions/ 与 ~/.pi/web-dev/extensions/
 *
 * 用法：
 *   node tools/deploy.mjs           # 双目标：生产 + dev
 *   node tools/deploy.mjs --prod    # 仅生产
 *   node tools/deploy.mjs --dev     # 仅 dev 实例
 *
 * 部署后执行 POST /api/extensions/reload 热重载即可生效。
 */
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { deployCommit } from '../../_shared/deploy-commit.mjs';
import { copyIcons } from '../../_shared/ext-icons-deploy.mjs';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { spawnSync } from 'node:child_process';

// 先构建 JSX client（失败即中止；构建产物免 checker——TS 残留在源头不可能，model-check 同例）
{
  const r = spawnSync(process.execPath, [resolve(import.meta.dirname, 'build-client.mjs')], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}


const __dirname = dirname(fileURLToPath(import.meta.url));
const extSrc = resolve(__dirname, '..'); // pi-web-ext/aiti-subagents/

const only = process.argv[2] === '--prod' ? 'prod' : process.argv[2] === '--dev' ? 'dev' : 'both';
const TARGETS = [
  ...(only !== 'dev' ? [{ name: 'prod', extRepo: resolve(homedir(), '.pi', 'web', 'extensions') }] : []),
  ...(only !== 'prod' ? [{ name: 'dev', extRepo: resolve(homedir(), '.pi', 'web-dev', 'extensions') }] : []),
];

// 需要拷贝的文件/目录
const ENTRIES = [
  'index.ts',
  'package.json',
  'upstream-fleet.js', // fork 引擎数据源（扫上游工件 + bridge-registry）
  'subagent-config.js', // 并发配置纯函数层（index.ts api /config 路由 require；漏拷 → 整个扩展 API 404）
  'icon.svg',
  'client',      // 目录（源码）
  'dist',        // 构建产物（manifest client 字段指向 dist/，2026-09-10 dist 迁移）
];

function copyRecursive(src, dest) {
  const stat = existsSync(src);
  if (!stat) return;
  mkdirSync(dest, { recursive: true });
  const items = readdirSync(src);
  for (const item of items) {
    const srcPath = resolve(src, item);
    const destPath = resolve(dest, item);
    const s = existsSync(srcPath);
    if (!s) continue;
    try {
      copyFileSync(srcPath, destPath);
    } catch (e) {
      // 目录递归
      copyRecursive(srcPath, destPath);
    }
  }
}

for (const t of TARGETS) {
  const extDir = resolve(t.extRepo, 'aiti-subagents');
  console.log(`[deploy] → ${t.name}: ${extDir}`);

  mkdirSync(extDir, { recursive: true });

  for (const entry of ENTRIES) {
    const src = resolve(extSrc, entry);
    const dest = resolve(extDir, entry);
    if (!existsSync(src)) {
      console.warn(`  ⚠ 跳过不存在的: ${entry}`);
      continue;
    }
    // 检查是文件还是目录
    const stat = existsSync(src);
    if (!stat) continue;
    try {
      copyFileSync(src, dest);
      console.log(`  ✓ ${entry}`);
    } catch {
      // 是目录
      copyRecursive(src, dest);
      console.log(`  ✓ ${entry}/`);
    }
  }

  console.log(`  → 完成`);
  console.log(`  → 执行 POST /api/extensions/reload 热重载`);
}



// 部署状态 commit（无变更跳过；失败不阻断）——crash-rescue #9：纯 mjs 扩展也可回滚
// 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
for (const t of TARGETS) copyIcons(resolve(t.extRepo, 'aiti-subagents', 'icons'), ['users'], { log: (m2) => console.log(m2) });

deployCommit({ repo: resolve(homedir(), ".pi", "web", "extensions"), name: "aiti-subagents", paths: ["aiti-subagents"], ident: true, log: (m) => console.log("[deploy] " + m) });

console.log('[deploy] 部署完成');

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
