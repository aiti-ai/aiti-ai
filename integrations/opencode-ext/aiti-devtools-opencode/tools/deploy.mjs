#!/usr/bin/env node
/**
 * 部署：dist/aiti-devtools-opencode.js → ~/.config/opencode/plugins/（全局，opencode 自动加载）
 * 幂等；旧文件直接覆盖。验证：opencode 启动日志 / 工具清单出现 aiti_*。
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'dist/aiti-devtools-opencode.js');
const destDir = resolve(homedir(), '.config/opencode/plugins');
const dest = resolve(destDir, 'aiti-devtools-opencode.js');

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
const size = statSync(dest).size;
console.log('[deploy] ' + dest + ' (' + (size / 1024).toFixed(1) + ' KB)');
console.log('[deploy] 桥默认 http://127.0.0.1:8777/aiti（AITI_BRIDGE_URL 覆盖）；重启 opencode 生效');
