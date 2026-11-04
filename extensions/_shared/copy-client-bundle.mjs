/**
 * copy-client-bundle — 扩展 client 构建产物部署 helper（含代码分块）。
 *
 * 背景（docs/aiti-ext-lazy-loading-plan.md 陷阱④；backend-queue G1 同源）：
 * 多数扩展 deploy 脚本按「单一 client/<ext>-client.mjs」清单拷贝——bundle 一旦
 * 产生代码分块（vite 动态 import() / React.lazy → 独立 hash chunk），分块文件
 * 不会被拷贝，运行时 import() 404（静默，只有 console 可见）。
 *
 * 用法（deploy.mjs 内替换单文件 copyFileSync）：
 *   import { copyClientBuild } from "../../_shared/copy-client-bundle.mjs";
 *   copyClientBuild(root, extDir, "aiti-xxx-client.mjs");
 *
 * 行为：
 *  1. 拷主 bundle（<main>.mjs）+ client/ 下全部 .mjs/.js 构建产物（src/ 不拷）；
 *  2. 清理目标目录中源目录已不存在的 .js（陈旧 hash 分块防累积）；
 *  3. 幂等，可重复调用。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export function copyClientBuild(root, extDir, mainBundle) {
  const srcClient = resolve(root, "client");
  const dstClient = resolve(extDir, "client");
  if (!existsSync(srcClient)) return;
  mkdirSync(dstClient, { recursive: true });
  const srcFiles = readdirSync(srcClient).filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
  const main = resolve(srcClient, mainBundle);
  if (existsSync(main)) copyFileSync(main, resolve(dstClient, mainBundle));
  for (const f of srcFiles) {
    if (f === mainBundle) continue;
    copyFileSync(resolve(srcClient, f), resolve(dstClient, f));
  }
  // 清理目标目录陈旧分块（源目录已不含旧 hash 名）
  for (const f of readdirSync(dstClient)) {
    if (f.endsWith(".js") && !srcFiles.includes(f)) {
      try { unlinkSync(resolve(dstClient, f)); } catch { /* noop */ }
    }
  }
}
