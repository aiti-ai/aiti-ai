#!/usr/bin/env node
/**
 * 构建 core 公共资产（assets/）：
 *   aiti-launcher.js / bridge-client.js  ← packages/aiti-devtools-inject 构建产物（tools/build.mjs）
 *   cockpit.html                          ← packages/aiti-devtools-pi/src/cockpit.html（pi 扩展组件）
 *   aiwin.js / host-protocol.js           ← core 浏览器模块（自拷贝）
 *
 * 用法：node tools/build-assets.mjs
 * 产物：packages/aiti-devtools-core/assets/（随 npm 包发布；vite/webpack 等载体共用）
 */
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url))); // packages/aiti-devtools-core/tools
const coreRoot = resolve(here, '..');
const repoRoot = resolve(coreRoot, '../..');
const inject = resolve(repoRoot, 'packages/aiti-devtools-inject');
const pi = resolve(repoRoot, 'packages/aiti-devtools-pi'); // cockpit.html 源（pi 扩展组件）
const out = resolve(coreRoot, 'assets');

const files = [
  [resolve(inject, 'dist/aiti-launcher.js'), 'aiti-launcher.js'],
  [resolve(inject, 'dist/bridge-client.js'), 'bridge-client.js'],
  [resolve(inject, 'dist/cdp-core.js'), 'cdp-core.js'],
  [resolve(pi, 'src/cockpit.html'), 'cockpit.html'],
  [resolve(coreRoot, 'src/aiwin.js'), 'aiwin.js'],
  [resolve(coreRoot, 'src/host-protocol.js'), 'host-protocol.js'],
];

mkdirSync(out, { recursive: true });
let bad = 0;
for (const [src, name] of files) {
  if (!existsSync(src)) {
    console.error('✗ 缺失 ' + src + '（aiti-launcher.js/bridge-client.js 需先跑 packages/aiti-devtools-inject 的 node tools/build.mjs）');
    bad++;
    continue;
  }
  copyFileSync(src, resolve(out, name));
  console.log('✓ assets/' + name);
}
if (bad) process.exit(1);
console.log('→ ' + out);
