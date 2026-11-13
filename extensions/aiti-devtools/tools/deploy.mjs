#!/usr/bin/env node
/**
 * 部署 aiti-devtools 扩展到 ~/.pi/web/extensions/（生产）与 ~/.pi/web-dev/extensions/（dev 实例，PI_WEB_DEV_DIST=1）
 *
 * 步骤：
 *   1) 构建浏览器注入产物（packages/aiti-devtools-inject/tools/build.mjs → inject/dist）
 *   2) 拷贝扩展源码（index.ts + bridge.ts + inject.ts）到扩展目录
 *   3) 拷贝 assets（aiti-launcher.js + bridge-client.js + cdp-core.js + host-protocol.js）+ client（AI 窗口）
 *   4) 提交部署状态到扩展 git 仓库（~/.pi/web/extensions/）：一次部署 = 一个 commit，
 *      直接手改会被 git status 暴露，可 diff/回滚；commit message 带源仓库 rev 追溯链路
 *
 * 用法：node tools/deploy.mjs          # 双目标：生产 ~/.pi/web + dev ~/.pi/web-dev
 *       node tools/deploy.mjs --prod   # 仅生产
 *       node tools/deploy.mjs --dev    # 仅 dev 实例
 * 说明：pi-web 的 /api/extensions/reload 可热加载扩展；assets 拷贝后刷新页面即可
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { deployCommit } from '../../_shared/deploy-commit.mjs';
import { copyIcons } from '../../_shared/ext-icons-deploy.mjs';
import { notifyReconcile } from '../../_shared/reconcile-deps.mjs';

// 容忍拷贝：发布仓（aiti-ai）的 packages/aiti-devtools-core 镜像不含 pair 三件
// （pair.ts / pair-client.js / pair.html）——npm/docker 形态缺源时降级跳过（pair 手机页不可用），
// 不让整个 aiti-devtools 扩展部署失败；本仓（pi-work）core/src 有源，行为不变。
const copyIfPresent = (src, dst, note) => {
  if (existsSync(src)) { copyFileSync(src, dst); return; }
  console.log('[deploy] ⚠ 源缺失，跳过 ' + note + '（发布仓 core 镜像不含 pair 三件 → pair 功能降级）');
};

// client TS 残留检查（.mjs 里是合法 JS 语法检查不报、运行时必炸；FAIL 即部署失败）
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, '..', '..', '..'); // 仓库根（pi-work）
const injectRoot = resolve(root, 'packages/aiti-devtools-inject');
const injectDist = resolve(injectRoot, 'dist');
const coreSrc = resolve(root, 'packages/aiti-devtools-core/src');
const extSrc = resolve(root, 'pi-web-ext/aiti-devtools');
// 部署目标：dev 实例（PI_WEB_DEV_DIST=1，扩展根 ~/.pi/web-dev）与生产（~/.pi/web）
const only = process.argv[2] === '--prod' ? 'prod' : process.argv[2] === '--dev' ? 'dev' : 'both';
const TARGETS = [
  ...(only !== 'dev' ? [{ name: 'prod', extRepo: resolve(homedir(), '.pi', 'web', 'extensions'), commit: true }] : []),
  ...(only !== 'prod' ? [{ name: 'dev', extRepo: resolve(homedir(), '.pi', 'web-dev', 'extensions'), commit: false }] : []),
];

// 1) 构建浏览器注入产物（aiti-launcher.js + bridge-client.js + cdp-core.js）
console.log('[deploy] 构建注入产物（' + injectRoot + '）…');
execSync('node ' + resolve(injectRoot, 'tools/build.mjs'), { cwd: injectRoot, stdio: 'inherit' });

for (const t of TARGETS) {
  const extDir = resolve(t.extRepo, 'aiti-devtools');
  // 2) 拷贝扩展源码（bridge.ts 是薄适配层；桥核心来自 core，拷为 bridge-core.ts 同目录相对导入——不依赖宿主装 aiti-devtools-core）
  mkdirSync(extDir, { recursive: true });
  for (const f of ['index.ts', 'bridge.ts', 'inject.ts', 'icon.svg', 'package.json']) {
    copyFileSync(resolve(extSrc, f), resolve(extDir, f));
  }
  copyFileSync(resolve(coreSrc, 'bridge.ts'), resolve(extDir, 'bridge-core.ts'));
  copyIfPresent(resolve(coreSrc, 'pair.ts'), resolve(extDir, 'pair.ts'), 'pair.ts'); // pair 设备互连模块（bridge-core.ts 相对导入）
  copyFileSync(resolve(extSrc, 'server', 'pair-fed.ts'), resolve(extDir, 'pair-fed.ts')); // 跨桥联邦代理（index.ts 相对导入）
  // jiti 转译缓存对内容变化不失效（实测坑：deploy 后 reload/restart 仍跑旧转译产物）——服务端源码有变时清之
  const jitiCache = resolve(process.env.PI_WEB_DEV_WEBROOT || resolve(homedir(), '.pi', 'web-dev'), '.cache', 'jiti');
  try { rmSync(jitiCache, { recursive: true, force: true }); console.log('[deploy] jiti 缓存已清（' + jitiCache + '）'); } catch {}
  const jitiCacheProd = resolve(process.env.PI_WEB_WEBROOT || resolve(homedir(), '.pi', 'web'), '.cache', 'jiti');
  try { rmSync(jitiCacheProd, { recursive: true, force: true }); console.log('[deploy] jiti 缓存已清（' + jitiCacheProd + '）'); } catch {}
  // 图标文件拷贝（icon: "icons/<name>.svg" → 宿主加载时内嵌；库在 _shared/icons/）
  copyIcons(resolve(extDir, 'icons'), ["wrench"], { log: (m) => console.log('[deploy] ' + m) });

  // 3) 拷贝 assets（注入产物 + host-protocol）+ client（AI 窗）
  // 产物统一 dist/（零构建手写源在 client/src/，git 跟踪）
  const distDir = resolve(extDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  copyFileSync(resolve(extSrc, 'client', 'src', 'aiti-client.mjs'), resolve(distDir, 'aiti-client.mjs'));

  mkdirSync(resolve(extDir, 'assets'), { recursive: true });
  copyFileSync(resolve(injectDist, 'aiti-launcher.js'), resolve(extDir, 'assets', 'aiti-launcher.js'));
  copyFileSync(resolve(injectDist, 'bridge-client.js'), resolve(extDir, 'assets', 'bridge-client.js'));
  copyFileSync(resolve(injectDist, 'cdp-core.js'), resolve(extDir, 'assets', 'cdp-core.js'));
  copyFileSync(resolve(coreSrc, 'host-protocol.js'), resolve(extDir, 'assets', 'host-protocol.js'));
  copyIfPresent(resolve(coreSrc, 'pair-client.js'), resolve(extDir, 'assets', 'pair-client.js'), 'assets/pair-client.js'); // pair 公共库（widget）
  copyIfPresent(resolve(coreSrc, 'pair.html'), resolve(extDir, 'assets', 'pair.html'), 'assets/pair.html'); // pair 手机独立页
  console.log('[deploy] ' + t.name + ' → ' + extDir + '（源码/bridge-core/client/assets）');
}
console.log('[deploy] 完成。pi-web 热重载：POST /api/extensions/reload（dev basePath /dev 前缀）；或重启 pi-web');

// 4) 提交部署状态到扩展 git 仓库（仅生产 ~/.pi/web/extensions；web-dev 非仓库不提交）
//    无变更跳过（不算失败）；失败带 git stderr 首行（不阻断部署）
function commitDeploy() {
  const t = TARGETS.find((x) => x.commit);
  if (!t) return;
  let srcRev = '';
  try {
    srcRev = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch (e) {}
  deployCommit({ repo: t.extRepo, name: 'aiti-devtools', paths: ['aiti-devtools'],
    extraMsg: srcRev ? '源 rev ' + srcRev : '', log: (m) => console.log('[deploy] ' + m) });
}

commitDeploy();

// ── 双实例热重载（basePath 双 env 按机器设值）——允许失败：服务未启动/共享模块缺失仅提示，不影响 deploy 退出码 ──
try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── 共享依赖 reconcile 通知（@aiti-ai/aiti-bridge 等运行时依赖装进 <webRoot>/node_modules；shim 安装态路径来源）──
await notifyReconcile();

// ── dev-pack（方案 §3.2：源码+构建工具+AGENTS.md 直达部署目录，AI 可现场直改）——允许失败，不影响 deploy 退出码 ──
try {
  const { packDevPack } = await import("../../_shared/dev-pack.mjs");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
