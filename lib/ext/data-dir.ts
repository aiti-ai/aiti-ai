/**
 * Extension directory conventions.
 *
 * Code:  ~/.pi/web/extensions/<id>/   (PI_WEB_EXTENSIONS_DIR overrides)
 *        + optional extra roots        (PI_WEB_EXTRA_EXTENSIONS_DIRS, comma-separated)
 *        + dev-only roots              (<pkgDir>/dev-exts, auto when the dir exists)
 *        + bundled baseline            (<pkgDir>/extensions, PI_WEB_BUNDLED_EXTENSIONS_DIR overrides)
 * Data:  ~/.pi/web/data/<id>/         (PI_WEB_DATA_DIR overrides)
 *
 * Dev/prod isolation: when PI_WEB_DEV_DIST=1 (dev server / systemd dev service),
 * the default roots move to ~/.pi/web-dev/{extensions,data} so the dev instance
 * never loads the production extension set nor shares its runtime state.
 * Explicit PI_WEB_EXTENSIONS_DIR / PI_WEB_DATA_DIR always win.
 *
 * Priority when an id exists in several roots: user > extra (listed order) > dev > bundled.
 * Code/data separation keeps updates from clobbering runtime state.
 */
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

/** dev 实例根（PI_WEB_DEV_DIST=1）——与生产扩展隔离，避免共享加载/运行时状态。 */
export function webRoot(): string {
  return process.env.PI_WEB_DEV_DIST === "1"
    ? join(homedir(), ".pi", "web-dev")
    : join(homedir(), ".pi", "web");
}

export function extensionsRoot(): string {
  return process.env.PI_WEB_EXTENSIONS_DIR || join(webRoot(), "extensions");
}

/** pi-web 程序目录（bin/pi-web.js spawn 时显式注入；dev 模式回退 process.cwd()）。 */
export function pkgDir(): string {
  return process.env.PI_WEB_PKG_DIR || process.cwd();
}

/** 内置扩展根（随包发布的基线，兜底层）。 */
export function bundledExtensionsRoot(): string {
  return process.env.PI_WEB_BUNDLED_EXTENSIONS_DIR || join(pkgDir(), "extensions");
}

/**
 * dev 分支约定：仓库根 dev-exts/ 目录自动作为开发扩展根（优先级介于 extra 与 bundled 之间）。
 * 生产安装包（npm files）不含此目录 → 天然只在 dev 分支生效。
 */
export function devExtensionsRoot(): string | null {
  const dir = join(pkgDir(), "dev-exts");
  return existsSync(dir) ? dir : null;
}

/**
 * 额外扩展根（中间层）：PI_WEB_EXTRA_EXTENSIONS_DIRS，用逗号分隔多个路径
 * （如 `/opt/share/ext,/srv/team/ext`，无平台差异）。列出顺序即优先级，越靠前越优先。
 * 空串项忽略；重复路径按 resolve 后去重。已知限制：路径本身含逗号时无法转义。
 */
export function extraExtensionsRoots(): string[] {
  const raw = process.env.PI_WEB_EXTRA_EXTENSIONS_DIRS ?? "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of raw.split(",")) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const resolved = resolve(trimmed);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export function dataRoot(): string {
  return process.env.PI_WEB_DATA_DIR || join(webRoot(), "data");
}

/** Resolve (and create) the data directory for one extension. */
export function extensionDataDir(id: string): string {
  const dir = join(dataRoot(), id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
