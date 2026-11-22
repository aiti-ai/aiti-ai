#!/usr/bin/env node
/**
 * esbuild 打包：src/index.ts → dist/aiti-devtools-opencode.js（单文件 ESM 插件）
 * external：@opencode-ai/plugin（opencode 宿主运行时提供，从 plugins 目录旁 node_modules 解析）
 */
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(root, 'dist'), { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node', // 插件跑在 opencode 宿主（bun/node）：core 用 node: 内建（DSH 同款）
  target: 'es2023',
  outfile: resolve(root, 'dist/aiti-devtools-opencode.js'),
  external: ['@opencode-ai/plugin'],
  sourcemap: false,
  logLevel: 'info',
});
console.log('[build] dist/aiti-devtools-opencode.js done');
