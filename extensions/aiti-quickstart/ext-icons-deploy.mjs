/**
 * 扩展图标部署侧（Node only）：把 `_shared/icons/<name>.svg` 拷进扩展部署目录 `icons/`。
 *
 * 契约（2026-09 拍板）：扩展注册只写文件名 `icon: "icons/<name>.svg"`（扩展内部文件），
 * 宿主加载扩展时（pi-web lib/ext/loader.ts embedUiSvgIcons）读文件动态生成内嵌 {svg}——
 * 源码里不静态写 path，也没有 token 替换；图标库只有一处：`_shared/icons/*.svg`。
 *
 * deploy.mjs 在拷贝循环后调用：
 *   for (const t of targets) copyIcons(resolve(t, "icons"), ["mic", "history"], { log });
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ICONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "icons");

export function copyIcons(destDir, names, { log } = {}) {
  mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    const file = name.endsWith(".svg") ? name : name + ".svg";
    copyFileSync(resolve(ICONS_DIR, file), resolve(destDir, file));
    log?.(`[deploy] 图标 ${file} → ${destDir}`);
  }
}
