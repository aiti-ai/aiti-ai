/**
 * Extension loader — scans the extensions root and loads each extension entry
 * with jiti (TypeScript transpilation, same mechanism the pi TUI uses).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { createJiti } from "jiti";
import { jitiCacheDir } from "./data-dir.ts";
import type { PiWebExtension } from "./types.ts";

// Host SDK alias: deployed extensions usually ship without node_modules (e.g.
// ~/.pi/web/extensions/*), so the bare specifier @earendil-works/pi-coding-agent is
// provided by the host's node_modules — depend on the host rather than external
// links. Same version and same instance as the app's own dependency (package.json
// dependencies pin 0.85.x).
// When Turbopack compiles the instrumentation hook, import.meta.dirname is
// undefined (a known Next 16 pitfall), while next dev/start always run with the
// project root as cwd — derive the node_modules location from cwd.
const hostSdkDir = resolve(
  import.meta.dirname ? join(import.meta.dirname, "..", "..") : process.cwd(),
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);

const HOST_SDK_ID = "@earendil-works/pi-coding-agent";

// Host SDK module object (lazy singleton native import): injected directly into
// each jiti instance via virtualModules — extensions and the host get a
// structurally identical SDK instance (SDK-internal singletons/global registries
// don't split), no longer relying on the serverExternalPackages coincidence of
// "same URL hits the ESM cache" (a duplicated SDK on disk / changed bundling
// strategy could fork the alias dir into a second instance). In the resolution
// chain virtualModules come before alias: the bare ID hits the direct injection
// exactly; subpaths (.../client) fall back to alias prefix resolution.
// No SDK on the host or native import failure → null → plain alias branch (same
// behavior as before).
let hostSdkModulePromise: Promise<Record<string, unknown> | null> | null = null;

function hostSdkModule(): Promise<Record<string, unknown> | null> | null {
  const entry = join(hostSdkDir, "dist", "index.js");
  if (!existsSync(entry)) return null;
  // webpackIgnore/turbopackIgnore: bundlers statically analyze dynamic
  // import(expressions) as part of the module graph; under Turbopack this fails
  // outright with "expression is too dynamic", so the native import never runs
  // (a pure Node harness can't reproduce it — Next compilation differences).
  // With the magic comments the bundler lets it through and the runtime native
  // import hits the host ESM cache by URL (serverExternalPackages: same URL,
  // same instance).
  hostSdkModulePromise ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(entry).href).catch((e: unknown) => {
    console.error("[ext] host SDK virtualModules injection failed, falling back to alias resolution:", e instanceof Error ? e.message : e);
    hostSdkModulePromise = null;
    return null;
  });
  return hostSdkModulePromise;
}

const ENTRY_NAMES = ["index.ts", "index.mjs", "index.js", "index.cjs"];

export function scanExtensionDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith(".")) // skip hidden dirs (.git etc.)
    .map((name) => join(root, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

/** Find the entry file for one extension directory, or null. */
export function resolveExtensionEntry(dir: string): string | null {
  for (const name of ENTRY_NAMES) {
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  // Single-script layout: one .ts/.js/.mjs file directly in the dir.
  const files = readdirSync(dir).filter((f) => /\.(ts|mjs|js|cjs)$/.test(f) && !f.startsWith("."));
  if (files.length === 1) return join(dir, files[0]);
  return null;
}

/**
 * Parse an extension version into a comparable structure ("1.2.3" / "v1.2.3" /
 * "1.2" / "1.2.3-beta.1"). Only all-numeric segments count as parseable;
 * otherwise return null (treated as unknown in same-id arbitration, falling
 * back to root priority).
 */
export function parseExtVersion(v: unknown): { core: number[]; pre: string } | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^[v=]+/i, "");
  if (!s) return null;
  const dash = s.indexOf("-");
  const corePart = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : "";
  const parts = corePart.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const core: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    core.push(Number(p));
  }
  return { core, pre };
}

/**
 * Version comparison: a>b → 1; a<b → -1; equal or either unparseable → 0
 * (callers fall back to root priority). Numeric segments compared position-wise
 * (missing segments padded with 0); on numeric equality release > prerelease,
 * and two prereleases compare as strings (good enough; full semver prerelease
 * semantics not implemented).
 */
export function compareExtVersions(a: unknown, b: unknown): number {
  const va = parseExtVersion(a);
  const vb = parseExtVersion(b);
  if (!va || !vb) return 0;
  const len = Math.max(va.core.length, vb.core.length);
  for (let i = 0; i < len; i++) {
    const x = va.core[i] ?? 0;
    const y = vb.core[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (va.pre && vb.pre) return va.pre === vb.pre ? 0 : va.pre > vb.pre ? 1 : -1;
  if (va.pre) return -1;
  if (vb.pre) return 1;
  return 0;
}

/** Load one extension directory into a PiWebExtension object (default export). */
export async function loadExtensionFromDir(dir: string): Promise<PiWebExtension | null> {
  const entry = resolveExtensionEntry(dir);
  if (!entry) return null;
  // jiti id = the extension entry file (not the loader itself): bare specifiers
  // resolve from the extension dir — extensions can carry standard node_modules
  // dependencies (npm installs) without relying on the host's node_modules.
  // moduleCache: false so POST /api/extensions/reload picks up code changes.
  // Host SDK: single instance injected via virtualModules (see the hostSdkModule
  // comment); when direct injection is unavailable, fall back to alias dir
  // resolution (not passed at all when the host has no SDK, preserving old behavior).
  const sdk = await hostSdkModule();
  const jiti = createJiti(pathToFileURL(entry).href, {
    interopDefault: true,
    moduleCache: false,
    // jiti transpile cache pinned to a persistent dir (defaults to /tmp/jiti,
    // wiped on reboot): key = file path hash with a tail source-hash checksum —
    // unchanged content hits, so the first start after a reboot skips full
    // retranspilation; dev/prod are naturally isolated by their own webRoot.
    // See docs/pi-web-ext-loader-jiti-fscache-persist-plan.md §1.
    fsCache: jitiCacheDir(),
    ...(sdk
      ? {
          virtualModules: { [HOST_SDK_ID]: sdk },
          alias: { [HOST_SDK_ID]: hostSdkDir }, // subpath prefix fallback (bare ID hits the virtual module)
        }
      : existsSync(hostSdkDir)
        ? { alias: { [HOST_SDK_ID]: hostSdkDir } }
        : {}),
  });
  const mod = (await jiti.import(pathToFileURL(entry).href)) as unknown;
  const ext = (mod as { default?: unknown } | undefined)?.default ?? mod;
  if (!ext || typeof ext !== "object") return null;
  const candidate = ext as Partial<PiWebExtension>;
  if (typeof candidate.id !== "string" || !candidate.id) return null;
  embedUiSvgIcons(dir, candidate);
  return candidate as PiWebExtension;
}

/**
 * Snapshot of the persistent jiti cache dir (for PI_WEB_EXT_TIMING=1
 * observation): flat path → mtimeMs map (jiti cache keys look like
 * <basename>-<hash>.mjs, one flat layer). Hits write nothing, misses overwrite
 * (mtime changes) → diffing before/after snapshots yields the number of files
 * retranspiled during that extension's load.
 */
export function snapshotJitiCache(): Map<string, number> {
  const dir = jitiCacheDir();
  const snap = new Map<string, number>();
  if (!existsSync(dir)) return snap;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".mjs")) continue;
    try {
      snap.set(name, statSync(join(dir, name)).mtimeMs);
    } catch {
      // raced deletion: skip (diff undercounts rather than overcounts)
    }
  }
  return snap;
}

/** Snapshot diff: files in after that are new or changed mtime = retranspiled count (0 = all hits). */
export function countRetranspiled(before: Map<string, number>, after: Map<string, number>): number {
  let n = 0;
  for (const [name, mtime] of after) {
    if (before.get(name) !== mtime) n++;
  }
  return n;
}

/**
 * Inline ui item icon files (2026-09 contract): when icon is a relative path to
 * an .svg file inside the extension (e.g. "icons/mic.svg"), load time reads the
 * file, extracts the inner <svg> markup, and replaces it with an inlined
 * { svg } object — the manifest sent to the frontend already carries the inline
 * svg, so rendering makes zero requests; missing/invalid files keep the original
 * string (the frontend renders via the assets mask fallback). Runs once per
 * extension load/reload (the result is cached on ext.ext.ui and read directly
 * by manifest()).
 */
function embedUiSvgIcons(dir: string, ext: Partial<PiWebExtension>): void {
  const ui = ext.ui as Record<string, unknown> | undefined;
  if (!ui || typeof ui !== "object") return;
  for (const val of Object.values(ui)) {
    if (!Array.isArray(val)) continue;
    for (const item of val) {
      if (!item || typeof item !== "object") continue;
      const icon = (item as { icon?: unknown }).icon;
      if (typeof icon !== "string" || !icon.endsWith(".svg")) continue;
      if (icon.startsWith("/") || icon.includes("..") || icon.includes("://")) continue;
      try {
        const raw = readFileSync(join(dir, icon), "utf8");
        const inner = /<svg[^>]*>([\s\S]*?)<\/svg\s*>/.exec(raw)?.[1]?.trim();
        if (inner) (item as { icon: unknown }).icon = { svg: inner };
      } catch {
        // missing file: keep the string; the frontend's renderExtItemIcon falls
        // back to the assets mask
      }
    }
  }
}
