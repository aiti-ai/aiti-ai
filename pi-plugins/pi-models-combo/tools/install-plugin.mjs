#!/usr/bin/env node
/**
 * 把本包作为「内置 pi 插件」安装到 <agentDir>/pi-plugins/pi-models-combo/，
 * 供 pi-web 的 lib/pi-plugins.ts 扫描并经 additionalExtensionPaths 随会话加载。
 * 副本来源 = 本仓 src/（构建产物即 TS 源，jiti 直接加载）。
 *
 * 用法：node tools/install-plugin.mjs [agentDir]   （缺省 ~/.pi/agent）
 */
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const agentDir = process.argv[2] || path.join(homedir(), ".pi", "agent");
const srcDir = path.resolve(import.meta.dirname, "..", "src");
const dst = path.join(agentDir, "pi-plugins", "pi-models-combo");
mkdirSync(dst, { recursive: true });
cpSync(srcDir, dst, { recursive: true });
const version = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")).version;
console.log(`[pi-models-combo] 内置插件已安装 → ${dst} (v${version})`);
