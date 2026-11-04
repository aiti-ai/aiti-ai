#!/usr/bin/env node
/**
 * aiti-extman · 部署到 ~/.pi/web/extensions/ 和 ~/.pi/web-dev/extensions/
 *
 * 步骤：拷贝 index.ts / installer.ts / shared-deps.ts / client bundle → 两个扩展根；提交部署 git。
 * 用法：node tools/deploy.mjs
 * 生效：POST /api/extensions/reload（或重启 pi-web）；client no-store 刷新页面即新
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { deployCommit } from '../../_shared/deploy-commit.mjs';
import { copyIcons } from '../../_shared/ext-icons-deploy.mjs';

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, '..'); // pi-web-ext/aiti-extman

// 0) 客户端 bundle 构建（client/src/*.tsx → client/aiti-extman-client.mjs）
console.log('[deploy] 构建 JSX client bundle…');
try {
  execSync('node tools/build-client.mjs', { cwd: root, stdio: 'inherit' });
} catch (e) {
  console.error('[deploy] 构建失败，中止部署：', e.message);
  process.exit(1);
}

const targets = [
  resolve(homedir(), '.pi', 'web', 'extensions', 'aiti-extman'),
  resolve(homedir(), '.pi', 'web-dev', 'extensions', 'aiti-extman'),
];

const homepage = 'https://aiti.pw/extensions/aiti-extman.html';

for (const extDir of targets) {
  mkdirSync(resolve(extDir, 'dist'), { recursive: true });
  for (const f of ['index.ts', 'icon.svg', 'installer.ts', 'publisher.ts', 'shared-deps.ts', 'protocol-screen.mjs']) copyFileSync(resolve(root, f), resolve(extDir, f));
  // 协议版本 canonical（_shared/ext-protocol.mjs）→ 部署目录同名拷贝（index.ts 以 ./ext-protocol.mjs 相对导入）
  copyFileSync(resolve(root, '../_shared/ext-protocol.mjs'), resolve(extDir, 'ext-protocol.mjs'));
  // client TS 残留检查器（层 2）：installer.ts 以 ./check-client.mjs 相对导入，需同目录
  copyFileSync(resolve(root, '../_shared/check-client.mjs'), resolve(extDir, 'check-client.mjs'));
  copyFileSync(resolve(root, 'dist/aiti-extman-client.mjs'), resolve(extDir, 'dist/aiti-extman-client.mjs'));
  // yauzl 是运行时依赖（zip 解包）——只拷运行时闭包（yauzl→fd-slicer/buffer-crc32→pend），
  // 不带 node_modules 全量（vite 等构建依赖不进部署目录）。
  copyFileSync(resolve(root, 'package.json'), resolve(extDir, 'package.json'));
  const RUNTIME_NM = ['yauzl', 'fd-slicer', 'buffer-crc32', 'pend'];
  if (existsSync(resolve(root, 'node_modules'))) {
    rmSync(resolve(extDir, 'node_modules'), { recursive: true, force: true });
    mkdirSync(resolve(extDir, 'node_modules'), { recursive: true });
    for (const nm of RUNTIME_NM) {
      const src = resolve(root, 'node_modules', nm);
      if (existsSync(src)) cpSync(src, resolve(extDir, 'node_modules', nm), { recursive: true });
    }
  }
  // 统一线图库图标（sidebarFooter 懒加载静态条目的 meta.icon）
  copyIcons(resolve(extDir, 'icons'), ['wrench'], { log: (m) => console.log('[deploy] ' + m) });
  console.log('[deploy] → ' + extDir);
  // skills/ 帮助点目录（pi skills 标准）
  const skillSrc = resolve(root, 'skills');
  if (existsSync(skillSrc)) {
    const skillDest = resolve(extDir, 'skills');
    mkdirSync(skillDest, { recursive: true });
    cpSync(skillSrc, skillDest, { recursive: true });
  }
}

// 部署状态提交（生产根是 git 仓库；失败不影响部署）
const extRepo = resolve(homedir(), '.pi', 'web', 'extensions');
let srcRev = '';
try { srcRev = execSync('git rev-parse --short HEAD', { cwd: resolve(root, '../..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}

deployCommit({ repo: extRepo, name: 'aiti-extman', paths: ['aiti-extman'], extraMsg: srcRev ? '源 rev ' + srcRev : '', log: (m) => console.log('[deploy] ' + m) });
console.log('[deploy] 完成。reload: POST /api/extensions/reload');

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
