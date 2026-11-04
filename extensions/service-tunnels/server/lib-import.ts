/**
 * lib-import — 库子模块的健壮动态导入（宿主 exports 解析缓存兼容）。
 *
 * 背景：新增的库子路径（如 "service-tunnels/port-identity"）在「宿主进程的
 * package.json exports 解析缓存为旧视图」时无法解析——Node/jiti 对 package.json
 * 的缓存不随文件变化或扩展 reload 失效（进程重启前一直如此）。旧缓存进程下
 * 静态/动态 import 都会抛 ERR_PACKAGE_PATH_NOT_EXPORTED，炸掉整个扩展加载。
 *
 * 本工具的导入顺序：
 *   1. 正常 specifier（解析缓存新视图/新进程 → 直接成功）；
 *   2. 物理兜底：扩展部署目录内真实安装的 dist 文件（file:// URL 导入，
 *      绕过 exports 解析——deploy 的 npm install 已把文件落盘，存在即可用）。
 * 全部失败返回 null，调用方降级（fail-low）。
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

let cachedLibRoot: string | undefined;

function libRoot(): string | undefined {
  if (cachedLibRoot !== undefined) return cachedLibRoot;
  try {
    const req = createRequire(import.meta.url);
    cachedLibRoot = dirname(req.resolve("service-tunnels/package.json"));
  } catch {
    // resolve 也被旧视图卡住 → 从本模块位置推断：<ext>/server/ → <ext>/node_modules
    try {
      cachedLibRoot = join(dirname(import.meta.url.replace(/^file:\/\//, "")), "..", "node_modules", "service-tunnels");
    } catch {
      cachedLibRoot = undefined;
    }
  }
  return cachedLibRoot;
}

/** 动态导入库子模块（sub 为 exports 子路径名，如 "port-identity"/"i18n"/"ui-shared"）。 */
export async function importLib<T = Record<string, unknown>>(sub: string): Promise<T | null> {
  const attempts: string[] = [`service-tunnels/${sub}`];
  const root = libRoot();
  if (root) attempts.push(pathToFileURL(join(root, "dist", `${sub}.js`)).href);
  for (const spec of attempts) {
    try {
      return (await import(/* @vite-ignore */ spec)) as T;
    } catch { /* 下一个候选 */ }
  }
  return null;
}
