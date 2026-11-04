#!/usr/bin/env node
/**
 * service-tunnels · 客户端 bundle 构建（esbuild）。
 *
 * 源码：client/src/*.tsx（ServicesDialog / SelfExposeAlert / host-shim / entry）
 * 产物：dist/service-tunnels.mjs（预编译 ESM，宿主 ExtSlots 动态 import；产物统一 dist/，git ignore）
 *
 * react 外部化：esbuild alias react → host-shim（模块级 ctx 委托宿主传入的
 * h/useState/.../apiUrl），产物零 react 引用，宿主单 React 实例。
 *
 * 用法：node tools/build-client.mjs   （bunx esbuild 也可手动等价执行）
 */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const entry = resolve(root, "client/src/entry.ts");
import { mkdirSync } from "node:fs";
mkdirSync(resolve(root, "dist"), { recursive: true });
const outfile = resolve(root, "dist/service-tunnels.mjs");

await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  outfile,
  // react 及其 jsx-runtime → host-shim（模块级 ctx 委托；不打包 react）
  alias: {
    react: resolve(root, "client/src/host-shim.ts"),
    "react/jsx-runtime": resolve(root, "client/src/jsx-runtime.ts"),
  },
  // 共享层单源（方案 §3）：bundle 内联库 src/i18n.ts / src/ui-shared.ts——库代码
  // 里 resolveLang(env = process.env) 在浏览器无 process（宿主不经 Next 打包此
  // bundle），define 替换为空对象（模块级 I18n 实例求值默认语言回退 en）。
  define: {
    "process.env": "{}",
  },
  jsx: "automatic",
  // 产物顶部注释（构建信息）
  banner: { js: `/* service-tunnels client bundle — built by tools/build-client.mjs (${new Date().toISOString()}) */` },
  logLevel: "info",
});

console.log("[build] → " + outfile);
