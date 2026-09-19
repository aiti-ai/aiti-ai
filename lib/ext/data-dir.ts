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

/** Dev instance root (PI_WEB_DEV_DIST=1) — isolated from production extensions, avoiding shared loading/runtime state. */
export function webRoot(): string {
  return process.env.PI_WEB_DEV_DIST === "1"
    ? join(homedir(), ".pi", "web-dev")
    : join(homedir(), ".pi", "web");
}

export function extensionsRoot(): string {
  return process.env.PI_WEB_EXTENSIONS_DIR || join(webRoot(), "extensions");
}

/** App program directory (explicitly injected when spawning bin/pi-web.js; falls back to process.cwd() in dev mode). */
export function pkgDir(): string {
  return process.env.PI_WEB_PKG_DIR || process.cwd();
}

/** Bundled extensions root (baseline shipped with the package, fallback tier). */
export function bundledExtensionsRoot(): string {
  return process.env.PI_WEB_BUNDLED_EXTENSIONS_DIR || join(pkgDir(), "extensions");
}

/**
 * Dev-branch convention: the repo root's dev-exts/ directory automatically acts as
 * a development extensions root (priority between extra and bundled).
 * Production installs (npm files) don't contain this directory → naturally only
 * effective on the dev branch.
 */
export function devExtensionsRoot(): string | null {
  const dir = join(pkgDir(), "dev-exts");
  return existsSync(dir) ? dir : null;
}

/**
 * Extra extension roots (middle tier): PI_WEB_EXTRA_EXTENSIONS_DIRS, comma-separated
 * paths (e.g. `/opt/share/ext,/srv/team/ext`, no platform differences). Listing order
 * is priority — earlier = higher priority. Empty entries ignored; duplicate paths
 * deduplicated after resolve. Known limitation: paths containing commas cannot be escaped.
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

/**
 * jiti transpile cache directory (host-level, not owned by any extension): default
 * <webRoot()>/.cache/jiti — persistent (survives restarts), key = file path hash with
 * a trailing source hash check; hits when content is unchanged. Dev/prod are
 * naturally isolated by their respective webRoots. The hidden .cache name matches the
 * backup excludes' .cache wildcard exclusion. env override is for test
 * isolation/migration only. The whole directory can be rm -rf'd and is rebuilt on
 * next access (cache contract).
 */
export function jitiCacheDir(): string {
  return process.env.PI_WEB_JITI_CACHE_DIR || join(webRoot(), ".cache", "jiti");
}

/** Resolve (and create) the data directory for one extension. */
export function extensionDataDir(id: string): string {
  const dir = join(dataRoot(), id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
