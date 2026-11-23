/**
 * aiti-extman · pi-web extension manager
 *
 * Extension management moved out of pi-web's built-in UI into an extension (the business logic
 * lives here; core only keeps the mount points and the contract):
 *   - Status: GET /api/extensions/aiti-extman/status (full registry state, including disabled and
 *     failed entries)
 *   - Online registry: GET /api/extensions/aiti-extman/registry (proxies aiti.pw/extensions.json,
 *     short TTL)
 *   - Operations: POST /api/extensions/aiti-extman/ops
 *       { action: "install", source: "git:…|npm:…|/path", id?, docsUrl?, publisherHint?, trust? }
 *         · VSCode-style trust gate: the publisher is resolved before installing (npm registry /
 *           GitHub owner / package.json); when untrusted the call returns needsTrust without
 *           installing, the UI asks for confirmation and retries with trust:true; trusted
 *           publishers install immediately.
 *       { action: "remove", id } · { action: "enable"|"disable", id } · { action: "reload" }
 *       { action: "set-feature", id, featureId, enabled }   ← feature management (per-toggle
 *                                                             enable/disable of declared features)
 *       { action: "trust"|"untrust", name, url?, source? }  ← publisher trust management
 *       { action: "reconcile-deps", source? }               ← manual shared-dependency reconcile
 *     Install/uninstall runs through this extension's installer (file-level, no code execution);
 *     enable/disable/reload calls the in-process registry directly.
 *     Shared dependencies: after install/uninstall the runtime dependencies declared by every
 *     extension are reconciled into <webRoot>/node_modules (jiti resolves upward and finds them;
 *     see shared-deps.ts). deploy.mjs can also POST this op after copying files to align them
 *     (_shared/reconcile-deps.mjs).
 *     Feature management: extensions declare features in their entry (capability toggles, e.g.
 *     aiti-devtools' aiti_* tools) and users enable/disable them one by one here — core filters
 *     the injected agent-session tools accordingly (no reload needed, effective immediately).
 *   - Trusted publishers: GET /api/extensions/aiti-extman/publishers (management UI)
 *
 * UI (client bundle):
 *   - toolbar 🧩 button → dialogs management panel (list / detail / add panel / online registry)
 *   - after a change, ctx.reloadExtensions() refreshes the host manifest and client bundles
 *     (optional, for older hosts)
 *
 * Source installation keeps the semantics of pi's base plugin installer:
 * git:<url>[#branch] / git@… / GitHub links / npm:@scope/pkg[@version] / local directory paths.
 *
 * Usage: deploy to ~/.pi/web/extensions/aiti-extman/ (tools/deploy.mjs), then reload.
 */
import { installExtension, removeExtension, installFromZipBuffer, extractZipToTemp, writePublisher, parseInstallSource, runNpm, readInstallMeta, gitUpdateInfo, type InstallMeta } from "./installer.js";
import { reconcile, depsState, extDepStates, collectDeps, extensionsRootPath } from "./shared-deps.js";
import {
  resolvePublisherForSource,
  publisherFromZipBuffer,
  publisherFromPackageJson,
  isTrusted,
  addTrusted,
  removeTrusted,
  listTrusted,
  type Publisher,
} from "./publisher.js";
import { rmSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import { EXT_PROTOCOL_VERSION, EXT_PROTOCOL_MIN_MAJOR, extProtocolInfo } from "./ext-protocol.mjs";
import { screenAndMigrateOnInstall } from "./protocol-screen.mjs";
import { extPinyin } from "./pinyin-index.mjs"; // 独立文件名即版本：.mjs 经宿主走原生 ESM（缓存不可清），改内容不换名不会重新加载
import { semverGt, isSemver, mergeUpdateSources, type UpdateEntry, type UpdateState } from "./updates-merge.js";

// Pure merge/state-machine helpers live in updates-merge.ts so they can be unit-tested
// without loading this entry (npm/git side effects stay here).
export { semverGt, isSemver, mergeUpdateSources };
export type { UpdateEntry, UpdateState };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/** In-process extension registry (the globalThis.__piWebExt singleton set up by instrumentation). */
function registry(): any {
  return (globalThis as any).__piWebExt;
}

/** Full status: new hosts expose statusPayload directly; older hosts are assembled from the base API. */
function statusPayload(): any {
  const reg = registry();
  if (reg && typeof reg.statusPayload === "function") return reg.statusPayload();
  const exts = reg?.status?.() ?? {};
  for (const id of Object.keys(exts)) exts[id].enabled = reg?.isEnabled?.(id) ?? true;
  return {
    loaded: reg?.isLoaded?.() ?? false,
    extensionsRoot: reg?.extensionsRoot?.() ?? "",
    extraExtensionsRoots: reg?.extraExtensionsRoots?.() ?? [],
    devExtensionsRoot: null,
    bundledExtensionsRoot: reg?.bundledExtensionsRoot?.() ?? "",
    dataRoot: reg?.dataRoot?.() ?? "",
    extensions: exts,
  };
}

/** Attach publisher info to each local entry (reads the extension's package.json, no code execution). */
function withPublishers(payload: any): any {
  const extensions = payload?.extensions;
  if (!extensions) return payload;
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    if (e && typeof e.dir === "string" && e.dir) {
      try {
        e.publisher = publisherFromPackageJson(e.dir);
      } catch {
        e.publisher = undefined;
      }
      // Per-locale metadata fallback: the host's readPackageInfo already parses these maps, but a
      // running host process keeps the code it booted with — reading the file here lets localized
      // descriptions/taglines go live on an extension reload instead of a full process restart.
      attachPackageI18n(e, e.dir);
    }
  }
  return payload;
}

/** Attach package.json displayNameI18n / descriptionI18n / soulI18n locale maps to entry.packageInfo (host value wins). */
function attachPackageI18n(entry: any, dir: string): void {
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  } catch {
    return;
  }
  const pick = (v: unknown): Record<string, string> | undefined => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const out: Record<string, string> = {};
    for (const [locale, text] of Object.entries(v as Record<string, unknown>)) {
      if (typeof text === "string" && text.trim()) out[locale] = text.trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const displayNameI18n = pick(parsed.displayNameI18n);
  const descriptionI18n = pick(parsed.descriptionI18n);
  const soulI18n = pick(parsed.soulI18n);
  if (!displayNameI18n && !descriptionI18n && !soulI18n) return;
  entry.packageInfo = {
    ...(entry.packageInfo || {}),
    ...(displayNameI18n && !entry.packageInfo?.displayNameI18n ? { displayNameI18n } : {}),
    ...(descriptionI18n && !entry.packageInfo?.descriptionI18n ? { descriptionI18n } : {}),
    ...(soulI18n && !entry.packageInfo?.soulI18n ? { soulI18n } : {}),
  };
}

/** Read an extension directory's protocol declaration and compute its compatibility state (shared by install results and status enrichment). */
function protocolOfDir(dir: string | undefined, opts?: { current?: string; minMajor?: number }): any {
  let declared: unknown;
  try {
    declared = dir ? JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).aitiExtProtocol : undefined;
  } catch {
    declared = undefined;
  }
  return extProtocolInfo(declared, opts ?? {});
}

/**
 * Attach the protocol declaration and compatibility state to every entry (docs/pi-web-ext-protocol.md).
 * The current version prefers the host-provided `payload.protocol` (current/minMajor); older hosts fall back to local constants.
 * Declarations come from the deployed package.json (no code execution); `needsUpgrade` surfaces the 🤖 AI upgrade entry in the UI.
 */
function withProtocol(payload: any): any {
  const extensions = payload?.extensions;
  if (!extensions) return payload;
  const host = payload?.protocol && typeof payload.protocol === "object" ? payload.protocol : null;
  const opts = {
    current: typeof host?.current === "string" ? host.current : EXT_PROTOCOL_VERSION,
    minMajor: Number.isInteger(host?.minMajor) ? host.minMajor : EXT_PROTOCOL_MIN_MAJOR,
  };
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    if (!e || typeof e !== "object") continue;
    e.protocol = { ...protocolOfDir(typeof e.dir === "string" ? e.dir : undefined, opts), source: host ? "host" : "local" };
  }
  return payload;
}

/** Slot context class: global = can fire without a session context; context = requires a specific context. */
const SLOT_CONTEXT: Record<string, { context: "global" | "context"; where: string }> = {
  toolbar: { context: "global", where: "顶部工具条" },
  sidebar: { context: "global", where: "左侧栏" },
  sidebarFooter: { context: "global", where: "侧栏底部" },
  sessionTopbar: { context: "global", where: "顶部工具条" },
  dialogs: { context: "global", where: "弹窗（由扩展自身入口触发）" },
  banners: { context: "global", where: "页面顶部横幅（常驻）" },
  pages: { context: "global", where: "主区域页面面板（常驻）" },
  sessionRowActions: { context: "context", where: "左侧会话列表·会话行操作按钮" },
  chatInputTop: { context: "context", where: "聊天输入框上方" },
  commands: { context: "global", where: "命令目录（无 UI 渲染点；应用中心动作卡 + 输入命令提示消费）" },
  fileViewer: { context: "context", where: "文件查看/编辑接管（按文件匹配）" },
  pathPicker: { context: "global", where: "目录选择器能力（顶栏打开文件夹等消费）" },
};

/** Attach slot-item details (label/title/context/position) to entries — read from the declared ui. */
function withSlotDetails(payload: any): any {
  const reg = registry();
  const extensions = payload?.extensions;
  if (!reg || !extensions) return payload;
  // Dependency-injection P1: the core.registry service wins (read-only ui view); the legacy registry.byId
  // call stays as the dualtrack fallback while older production cores are still around
  const coreReg = reg?.services?.get?.("core.registry") ?? null;
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    const ui = coreReg && typeof coreReg.ui === "function" ? coreReg.ui(id)
      : typeof reg.byId === "function" ? reg.byId(id)?.ext?.ui : null;
    if (!e || !ui || typeof ui !== "object") continue;
    const detail: Record<string, Array<{ id: string; label?: string; title?: string; context: string; where: string }>> = {};
    for (const [slot, items] of Object.entries(ui)) {
      if (!Array.isArray(items) || items.length === 0) continue;
      const ctx = SLOT_CONTEXT[slot] ?? { context: "context", where: slot };
      detail[slot] = items
        .filter((it) => it !== null && typeof it === "object" && typeof (it as { id?: unknown }).id === "string")
        .map((it) => {
          const item = it as { id: string; label?: unknown; title?: unknown };
          return {
            id: item.id,
            ...(typeof item.label === "string" && item.label ? { label: item.label } : {}),
            ...(typeof item.title === "string" && item.title ? { title: item.title } : {}),
            context: ctx.context,
            where: ctx.where,
          };
        });
      if (detail[slot].length === 0) delete detail[slot];
    }
    if (Object.keys(detail).length > 0) e.slotsDetail = detail;
  }
  return payload;
}

/**
 * Add dependency edges for disabled entries: pi-web core does not load disabled extensions (their status
 * entry carries no ui/declaration info),
 * yet the reverse "depended on by" view needs the edges those disabled dependents declare (demo-lazy→demo).
 * Best-effort extraction from the index.ts source
 * of the five declarations (clientDependsOn plus the four dependency/capability fields; single-line arrays;
 * anchored to line starts so comments do not match);
 * failures stay silent (informational field, never blocks).
 */
function withDisabledDeps(payload: any): any {
  const extensions = payload?.extensions;
  if (!extensions || typeof extensions !== "object") return payload;
  const FIELDS = ["clientDependsOn", "dependsOn", "optionalDependsOn", "provides", "takeover"] as const;
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    if (!e || e.loaded !== false || typeof e.dir !== "string") continue;
    try {
      const src = readFileSync(resolve(e.dir, "index.ts"), "utf8");
      for (const field of FIELDS) {
        if (e[field]) continue;
        const m = src.match(new RegExp("^\\s*" + field + "\\s*:\\s*\\[([^\\]]*)\\]", "m"));
        if (!m) continue;
        const ids = [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]).filter((s: string) => s.length > 0);
        if (ids.length > 0) e[field] = ids;
      }
    } catch {}
  }
  return payload;
}
/**
 * Extension markdown description (DESC.md contract): attach descriptionMd to each local entry.
 * Locale fallback chain: DESC.<locale>.md → DESC.<lang>.md → DESC.md → package.json descriptionMd.
 * Static file read only (no code execution); truncate beyond 48KB to keep status responses bounded.
 * The client renderer supports the agreed variables ({{aiti-url}}/{{ext-id}}/…, see client/src/md-desc.tsx).
 */
const DESC_MD_MAX = 48 * 1024;
/** Locale candidates in priority order (exact → same language family); "" means the neutral file. */
function descLocaleCandidates(locale?: string | null): string[] {
  const out: string[] = [];
  const exact = (locale || "").trim();
  if (exact) {
    out.push(exact);
    const short = exact.split("-")[0];
    if (short && short !== exact) out.push(short);
  }
  return out;
}
function readDescMd(dir?: string, locale?: string | null): string | undefined {
  if (!dir) return undefined;
  for (const loc of descLocaleCandidates(locale)) {
    try {
      const p = resolve(dir, `DESC.${loc}.md`);
      if (!existsSync(p)) continue;
      const s = readFileSync(p, "utf8");
      if (s.trim()) return s.length > DESC_MD_MAX ? s.slice(0, DESC_MD_MAX) + "\n\n<!-- (DESC.md 超 48KB 已截断) -->" : s;
    } catch { /* try next candidate */ }
  }
  try {
    const p = resolve(dir, "DESC.md");
    if (existsSync(p)) {
      const s = readFileSync(p, "utf8");
      if (s.trim()) return s.length > DESC_MD_MAX ? s.slice(0, DESC_MD_MAX) + "\n\n<!-- (DESC.md 超 48KB 已截断) -->" : s;
    }
  } catch {}
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as { descriptionMd?: unknown };
    if (typeof parsed.descriptionMd === "string" && parsed.descriptionMd.trim()) {
      const s = parsed.descriptionMd;
      return s.length > DESC_MD_MAX ? s.slice(0, DESC_MD_MAX) + "\n\n<!-- (descriptionMd 超 48KB 已截断) -->" : s;
    }
  } catch {}
  return undefined;
}
function withDescription(payload: any, locale?: string | null): any {
  const extensions = payload?.extensions;
  if (!extensions || typeof extensions !== "object") return payload;
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    if (e && typeof e.dir === "string" && e.dir) e.descriptionMd = readDescMd(e.dir, locale);
  }
  return payload;
}

/** Shared-dependency view: payload.sharedDeps (roots / union / last reconcile result) plus a per-dependency local/shared/missing mark for user-root extensions. */
function withSharedDeps(payload: any): any {
  try {
    payload.sharedDeps = depsState();
    const root = extensionsRootPath();
    const { byExt } = collectDeps(root);
    const extensions = payload?.extensions;
    if (extensions && typeof extensions === "object") {
      for (const id of Object.keys(extensions)) {
        const e = extensions[id];
        const mine = byExt[id];
        if (!e || typeof e.dir !== "string" || !mine) continue;
        e.npmDepStates = extDepStates(e.dir, Object.keys(mine));
      }
    }
  } catch {} // 纯信息增强，任何异常不阻塞 status
  return payload;
}

/** Pinyin enrichment: extensions whose name contains Chinese get a pinyin field ("full spelling + initials", see pinyin-helper.mjs). */
function withPinyin(payload: any): any {
  const extensions = payload?.extensions;
  if (!extensions || typeof extensions !== "object") return payload;
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    if (!e || typeof e !== "object") continue;
    const fromName = typeof e.name === "string" ? extPinyin(e.name) : "";
    // zh pinyin source = the ui.i18n zh-CN self-description entry ext.displayName (no central table; raw manifest text is the fallback via fromName)
    const zh = e.ui?.i18n?.["zh-CN"]?.["ext.displayName"];
    const fromDisplay = typeof zh === "string" && zh && zh !== e.name ? extPinyin(zh) : "";
    e.pinyin = fromName === fromDisplay ? fromName : [fromName, fromDisplay].filter(Boolean).join(" ");
  }
  return payload;
}

/** Full status (publishers + protocol + slot-item details + markdown description + shared-dependency view + pinyin index). */
function enrichedStatus(locale?: string | null): any {
  return withProtocol(withSharedDeps(withDescription(withDisabledDeps(withPublishers(withSlotDetails(withPinyin(statusPayload())))), locale)));
}

/** Check whether the publisher needs trust (VSCode style): untrusted → returns a needsTrust response without installing. */
function needsTrustResponse(publisher: Publisher, extra: Record<string, unknown> = {}) {
  return json({
    ok: false,
    needsTrust: true,
    trusted: false,
    publisher,
    ...extra,
  });
}

/** Normalize the publisher sent back by the UI (validates fields; invalid input returns null so the server resolves it again). */
function normalizePublisher(p: unknown): Publisher | null {
  if (!p || typeof p !== "object") return null;
  const o = p as { name?: unknown; url?: unknown; source?: unknown; fingerprint?: unknown };
  if (typeof o.fingerprint !== "string" || !o.fingerprint.trim()) return null;
  return {
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : null,
    url: typeof o.url === "string" && o.url.trim() ? o.url.trim() : undefined,
    source: typeof o.source === "string" && o.source.trim() ? o.source.trim() : "unknown",
    fingerprint: o.fingerprint.trim(),
  };
}

// ── Update checks: aiti.pw registry × npm × git (dual source) ──
// npm: installed package.json version × `npm view <name> version --json` (machine npm
//   config + registry, the same source the update button installs from) → semver gt.
// registry: `version` of each entry in https://aiti.pw/extensions.json (docs catalog).
// git: installed through git → local HEAD × `git ls-remote origin <tracked ref>`.
// Both sources are compared independently; the newest wins and its origin is reported.
// Timing: panel open / manual refresh only (no polling); short server cache, force=1 bypass.
const NPM_PKG_NAME_RE = /^(@[A-Za-z0-9-._]+\/)?[A-Za-z0-9-._]+$/;
const UPDATES_TTL_MS = 5 * 60_000;
const UPDATES_CONCURRENCY = 8;
const UPDATES_TIMEOUT_MS = 12_000;
let updatesCache: { at: number; data: any } | null = null;
let registryUpdatesCache: { at: number; data: any } | null = null;

// ── Persistent update cache (cacheDir, safe to delete) ──
// Without it every process restart starts from "no data": the panel would have to wait
// for the full check before it can show a single ↑ badge. With it the last verdict is
// returned immediately (marked stale when old or when installed versions moved) and the
// client refreshes in the background — the install button always uses a fresh check.
const UPDATES_DISK_FILE = "updates-cache";
let updatesCacheDir: string | null = null;

function diskCachePath(): string | null {
  // Dev and prod share PI_WEB_DATA_DIR on this machine, so the instance's port is part of
  // the file name: otherwise each instance would invalidate the other's verdict on every
  // visit (different deployed trees → installed-version mismatch).
  const instanceTag = process.env.PORT ? `-${process.env.PORT}` : "";
  return updatesCacheDir ? join(updatesCacheDir, `updates-cache${instanceTag}.json`) : null;
}

function readDiskCache(): { at: number; data: any } | null {
  const file = diskCachePath();
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion?: unknown; checkedAt?: unknown; data?: any };
    if (parsed?.schemaVersion !== 1 || !parsed.data || typeof parsed.data.updates !== "object") return null;
    const at = Date.parse(String(parsed.checkedAt));
    return { at: Number.isFinite(at) ? at : 0, data: parsed.data };
  } catch {
    return null;
  }
}

function writeDiskCache(data: any): void {
  const file = diskCachePath();
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, checkedAt: data.checkedAt, data }));
    renameSync(tmp, file);
  } catch {
    // Best effort: a missing cache only means the next check starts cold.
  }
}

/** True when any recorded installed version no longer matches the deployed one. */
function cacheInstalledMismatch(data: any): boolean {
  try {
    const exts = statusPayload()?.extensions ?? {};
    const known = data && typeof data.updates === "object" && data.updates ? data.updates : {};
    for (const id of Object.keys(exts)) {
      const cur = exts[id];
      if (!cur || typeof cur.dir !== "string" || !cur.dir) continue;
      const cached = known[id];
      const live = typeof cur.version === "string" ? cur.version : null;
      if (!cached || (cached.installed ?? null) !== live) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** Drop both memory caches and the persisted verdict (install / remove / update-all). */
function invalidateUpdatesCache(): void {
  updatesCache = null;
  registryUpdatesCache = null;
  const file = diskCachePath();
  if (!file) return;
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

function isOfflineMode(): boolean {
  return /^(1|true|yes)$/i.test(process.env.PI_OFFLINE ?? "");
}

/**
 * Environment for network check children: drop this server's own variables so a
 * project `.npmrc` cannot expand them into the registry request (same rule as
 * pi-web lib/plugin-updates.ts).
 */
function updateCheckEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "PORT" || key === "NODE_ENV" || key === "PI_WEB_PASSWORD" || key.startsWith("NEXT_")) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}


// npm registry metadata base (falls back to npmjs when `npm config get registry` fails).
// Cached like the update result: one extra spawn per check window, not per package.
const NPM_REGISTRY_TTL_MS = 5 * 60_000;
let npmRegistryCache: { at: number; base: string } | null = null;

async function npmRegistryBase(): Promise<string> {
  if (npmRegistryCache && Date.now() - npmRegistryCache.at < NPM_REGISTRY_TTL_MS) return npmRegistryCache.base;
  let base = "https://registry.npmjs.org";
  try {
    const res = await runNpm(["config", "get", "registry"], undefined, { env: updateCheckEnv(), timeoutMs: 8000 });
    const value = res.stdout.trim();
    if (/^https?:\/\//.test(value)) base = value;
  } catch {
    // Keep the public default; the npm view fallback resolves the real registry anyway.
  }
  npmRegistryCache = { at: Date.now(), base };
  return base;
}

/** Scoped names must be escaped (`@scope/name` → one path segment). */
function npmMetadataPath(pkg: string): string {
  return pkg.startsWith("@") ? pkg.replace("/", "%2f") : encodeURIComponent(pkg);
}

/**
 * Fast path: one registry metadata GET (abbreviated document) per package instead of
 * spawning `npm view`. Returns null when the registry cannot be read without npm's own
 * auth/proxy handling — the caller then falls back to `npm view`.
 */
async function httpLatestVersion(pkg: string): Promise<{ latest?: string; notFound?: boolean } | null> {
  try {
    const base = await npmRegistryBase();
    const res = await fetch(`${base.replace(/\/+$/, "")}/${npmMetadataPath(pkg)}`, {
      headers: {
        accept: "application/vnd.npm.install-v1+json",
        "user-agent": "npm/10 aiti-extman",
      },
      signal: AbortSignal.timeout(UPDATES_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 410) return { notFound: true };
    if (!res.ok) return null; // 401/403/5xx → npm view fallback (auth, proxy, registry quirks)
    const doc = await res.json() as { "dist-tags"?: { latest?: unknown } };
    const latest = doc?.["dist-tags"]?.latest;
    return typeof latest === "string" && latest.trim() ? { latest: latest.trim() } : null;
  } catch {
    return null;
  }
}

/** npm dist-tags.latest (HTTP metadata first, `npm view` fallback; failure/timeout = error, not "no update"). */
async function npmLatestVersion(pkg: string): Promise<{ latest?: string; error?: string; notFound?: boolean }> {
  const fast = await httpLatestVersion(pkg);
  if (fast) return fast;
  try {
    const res = await runNpm(["view", pkg, "version", "--json"], undefined, {
      env: updateCheckEnv(),
      timeoutMs: UPDATES_TIMEOUT_MS,
    });
    const parsed = JSON.parse(res.stdout.trim()) as unknown;
    if (typeof parsed === "string" && parsed.trim()) return { latest: parsed.trim() };
    return { error: "unexpected npm view output" };
  } catch (e) {
    const text = e instanceof Error ? `${e.message}` : String(e);
    // "not published on npm" is a normal state for local/private extensions, not a failure.
    if (/E404|404 Not Found|no such package/i.test(text)) return { notFound: true };
    return { error: text };
  }
}

/**
 * Dual-source update computation. `phase: "registry"` skips npm/git so the panel can
 * render a fast partial verdict first; `phase: "all"` is the authoritative result.
 */
async function computeUpdates(phase: "registry" | "all" = "all"): Promise<any> {
  const offline = isOfflineMode();
  const st = statusPayload();
  const extensions = st?.extensions ?? {};

  let regDoc: any = null;
  let registryError: string | null = null;
  try {
    regDoc = await getRegistryData();
  } catch (e) {
    registryError = e instanceof Error ? e.message : String(e);
  }
  const byId = new Map<string, any>();
  const byNpm = new Map<string, any>();
  for (const item of Array.isArray(regDoc?.extensions) ? regDoc.extensions : []) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.id === "string" && item.id) byId.set(item.id, item);
    if (typeof item.npm === "string" && item.npm.trim()) byNpm.set(item.npm.trim(), item);
  }

  type Local = {
    id: string;
    dir: string;
    pkg: string | null;
    installed: string | null;
    meta: InstallMeta | null;
    registryEntry: any | null;
  };
  const locals: Local[] = [];
  for (const id of Object.keys(extensions)) {
    const e = extensions[id];
    if (!e || typeof e.dir !== "string" || !e.dir) continue;
    let pkg: string | null = null;
    let installed: string | null = null;
    try {
      const pj = JSON.parse(readFileSync(join(e.dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (typeof pj.name === "string" && NPM_PKG_NAME_RE.test(pj.name)) pkg = pj.name;
      if (isSemver(typeof pj.version === "string" ? pj.version : null)) installed = pj.version as string;
    } catch {}
    locals.push({
      id,
      dir: e.dir,
      pkg,
      installed,
      meta: readInstallMeta(e.dir),
      registryEntry: byId.get(id) ?? (pkg ? byNpm.get(pkg) ?? null : null),
    });
  }

  // npm lookups: one query per distinct package name, bounded concurrency.
  const npmResults = new Map<string, { latest?: string; error?: string; notFound?: boolean }>();
  if (phase === "all" && !offline) {
    const targets = new Set<string>();
    for (const l of locals) {
      const p = l.pkg ?? (typeof l.registryEntry?.npm === "string" ? l.registryEntry.npm.trim() : "");
      if (p && NPM_PKG_NAME_RE.test(p)) targets.add(p);
    }
    const names = [...targets];
    let idx = 0;
    const worker = async () => {
      while (idx < names.length) {
        const name = names[idx++];
        npmResults.set(name, await npmLatestVersion(name));
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPDATES_CONCURRENCY, names.length) || 1 }, worker));
  }

  // git lookups: git-installed extensions only (few by nature).
  const gitResults = new Map<string, { head: string; remote: string | null } | null>();
  if (phase === "all" && !offline) {
    const env = updateCheckEnv();
    await Promise.all(locals.map(async (l) => {
      if (l.meta?.kind !== "git" || !l.meta.ref) return;
      gitResults.set(l.id, await gitUpdateInfo(l.dir, { env, timeoutMs: UPDATES_TIMEOUT_MS }));
    }));
  }

  const updates: Record<string, UpdateEntry> = {};
  let npmChecked = 0;
  let npmFailed = 0;
  let npmMissing = 0;
  let gitChecked = 0;
  for (const l of locals) {
    const registryVersion = typeof l.registryEntry?.version === "string" ? l.registryEntry.version : null;
    const registryNpm = typeof l.registryEntry?.npm === "string" && l.registryEntry.npm.trim() ? l.registryEntry.npm.trim() : null;
    const pkgForNpm = l.pkg ?? registryNpm;
    const npmRes = pkgForNpm ? npmResults.get(pkgForNpm) : undefined;
    if (npmRes) {
      npmChecked++;
      if (npmRes.error) npmFailed++;
      if (npmRes.notFound) npmMissing++;
    }
    const git = gitResults.get(l.id) ?? null;
    if (git) gitChecked++;
    const gitSource = l.meta?.kind === "git" && typeof l.meta.ref === "string" && l.meta.ref ? l.meta.ref : null;
    const entry = mergeUpdateSources({
      id: l.id,
      pkg: l.pkg,
      installed: l.installed,
      npmLatest: npmRes?.latest ?? null,
      npmError: npmRes?.notFound ? null : (npmRes?.error ?? null),
      registryVersion,
      registryDocsUrl: typeof l.registryEntry?.docs === "string" ? `https://aiti.pw${l.registryEntry.docs}` : null,
      registryNpm,
      git,
      gitSource,
      offline,
      partial: phase === "registry",
    }) as UpdateEntry;
    if (phase === "registry" && entry.state === "update-available") {
      // Partial verdict: never offer an install source before the npm/git half is known.
      entry.installable = null;
    }
    updates[l.id] = entry;
  }

  return {
    ok: true,
    phase,
    partial: phase === "registry",
    checkedAt: new Date().toISOString(),
    sources: {
      registry: regDoc
        ? { ok: true, count: byId.size }
        : { ok: false, error: registryError },
      npm: phase === "all"
        ? { ok: !offline, checked: npmChecked, failed: npmFailed, missing: npmMissing }
        : { ok: false, pending: true },
      git: phase === "all" ? { ok: !offline, checked: gitChecked } : { ok: false, pending: true },
    },
    updates,
  };
}

// ── Online registry data (aiti-docs build output; browser CORS → proxy + short cache) ──
const DEFAULT_REGISTRY_URL = "https://aiti.pw/extensions.json";
const REGISTRY_TTL_MS = 5 * 60_000;
let registryDocCache: { at: number; doc: any } | null = null;

async function getRegistryData(): Promise<any> {
  if (registryDocCache && Date.now() - registryDocCache.at < REGISTRY_TTL_MS) return registryDocCache.doc;
  const res = await fetch(process.env.PI_WEB_EXT_REGISTRY_URL || DEFAULT_REGISTRY_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  const doc = await res.json() as any;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.extensions)) {
    throw new Error("registry payload has no extensions array");
  }
  registryDocCache = { at: Date.now(), doc };
  return doc;
}

async function fetchRegistry(): Promise<Response> {
  const doc = await getRegistryData();
  return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json; charset=utf-8" } });
}

export default {
  id: "aiti-extman",
  name: "aiti 扩展管理器",
  icon: "icon.svg",
  client: "dist/aiti-extman-client.mjs",

  // AI self-management: the AI can recommend / health-check / install / enable-disable extensions,
  // and even create, modify and publish them
  ai: {
    manage: true,
    intro: "AI 能帮我推荐/体检/安装/启停扩展，乃至直接新建、修改、发布扩展",
    skills: "skills",
  },

  ui: {
    // [lazy-load v2] Panel-only extension: opening a page does not fetch the client bundle (126KB).
    // The sidebarFooter static entry is
    // rendered declaratively by the host (pi-web components/AppShell.tsx sidebarFooterStaticItems); a click
    // goes through meta.onClick → openExtmanPanel, which materializes the panel and opens it.
    // ⚠ Requires the matching host change to be deployed to prod (otherwise prod lacks the Extensions entry).
    clientImmediately: false,
    // Sidebar footer quick-action row (same row as Models / Skills / Plugins) — the extension manager's original entry point.
    sidebarFooter: [{ id: "aiti-extman-open", label: "i18n:ext.shortLabel", title: "i18n:ext.sidebarTitle", icon: "icons/wrench.svg" }],
    dialogs: [{ id: "aiti-extman-panel", label: "aiti-extman extensions panel" }],
    i18n: {
      en: {
        "ext.displayName": "Extension Manager",
        "ext.title": "Extensions",
        "ext.shortLabel": "Extensions",
        "ext.sidebarTitle": "Extensions · enable/disable, install, online registry",
        "ext.reload": "Reload all",
        "ext.refresh": "Refresh",
        "ext.close": "Close",
        "ext.prevExt": "Previous extension",
        "ext.nextExt": "Next extension",
        "ext.list": "Extensions",
        "ext.expand": "Expand",
        "ext.collapse": "Collapse",
        "ext.expandList": "Expand extension list",
        "ext.collapseList": "Collapse extension list",
        "ext.maximize": "Expand to full screen",
        "ext.restore": "Restore window",
        "ext.none": "No extensions",
        "ext.enable": "Enable",
        "ext.disable": "Disable",
        "ext.disabled": "disabled",
        "ext.clientLoaded": "client loaded",
        "ext.prefetched": "prefetched",
        "ext.notLoaded": "not loaded",
        "ext.noClient": "no client",
        "ext.add": "Add extension",
        "ext.searchHint": "Search installed & online…",
        "ext.clearSearch": "Clear",
        "ext.onlineResults": "Online",
        "ext.installFromSource": "Install from source",
        "ext.type": "Type",
        "ext.category": "Category",
        "ext.author": "Author",
        "ext.license": "License",
        "ext.select": "Select an extension",
        "ext.summary": "{total} extensions · {on} on · {off} off",
        "ext.status": "Status",
        "ext.fieldName": "Name",
        "ext.version": "Version",
        "ext.protocol": "Protocol",
        "ext.protocolCurrent": "current",
        "ext.protocolOk": "compatible",
        "ext.protocolStale": "needs upgrade",
        "ext.protocolIncompatible": "incompatible",
        "ext.protocolTooNew": "too new (upgrade host)",
        "ext.protocolMissing": "not declared",
        "ext.protocolInvalid": "invalid",
        "ext.protocolUpgradeAi": "AI upgrade",
        "ext.protocolUpgradeTitle": "Upgrade {id} protocol {from} → {to} via AI",
        "ext.protocolMinorAhead": "host can upgrade",
        "ext.protocolInstallWarn": "installed; protocol {declared} → {current} ({state}) — open detail to AI-upgrade",
        "ext.protocolInstallTooNew": "installed; extension protocol {declared} is newer than host {current} — please upgrade pi-web",
        "ext.slots": "Insertion points",
        "ext.slotSummary": "{slots} slots · {items} items",
        "ext.noSlots": "No UI slots",
        "ext.slotsOpenHint": "click an item to open it",
        "ext.open": "Open",
        "ext.global": "Global",
        "ext.context": "Context",
        "ext.where": "Where",
        "ext.slotContextHint": "Used in {where}",
        "ext.slotOpened": "Opened: {label}",
        "ext.raiseToTop": "Raise to top",
        "ext.slotLocated": "Located at {where}",
        "ext.slotNeedSession": "Needs a session ({where})",
        "ext.slotNoDirect": "No direct trigger ({where}); open it manually there",
        "ext.clientBundle": "Client bundle",
        "ext.clientState": "Client state",
        "ext.dir": "Directory",
        "ext.configDir": "Config dir",
        "ext.sourceUrl": "Source",
        "ext.deps": "Dependencies",
        "ext.clientDeps": "client inject",
        "ext.depsBy": "depended on by",
        "ext.depsByHint": "Extensions whose client bundle declares a dependency on this one (informational: affects client prefetch scheduling, not load correctness). Click to open.",
        "ext.dependentsTitle": "Dependency impact",
        "ext.dependentsBodyDisable": "The following enabled extensions declare a client-inject dependency on {id}. Disabling it may affect their client prefetch and cooperation:",
        "ext.dependentsBodyRemove": "Uninstalling deletes the extension code directory (data directory is kept). The following enabled extensions declare a client-inject dependency on {id} and may be affected:",
        "ext.dependentsConfirmDisable": "Disable anyway",
        "ext.dependentsHardBlocked": "Hard dependency — cannot be disabled while the extensions above are enabled. Disable them first (they declare a hard dependsOn).",
        "ext.dependentsConfirmRemove": "Uninstall anyway",
        "ext.pkgDeps": "npm deps",
        "ext.noDeps": "none",
        "ext.depShared": "shared root",
        "ext.depLocal": "local node_modules",
        "ext.sharedDepsRoot": "Shared deps root",
        "ext.serverCaps": "Server capabilities",
        "ext.provides": "Takes over",
        "ext.services": "Services",
        "ext.features": "Feature management",
        "ext.featuresHint": "Toggle which features of this extension are available. Disabled agent tools are not injected into new sessions; toggling off during a session refuses calls on already-injected tools immediately.",
        "ext.featuresOn": "{on} on",
        "ext.featuresOff": "{off} off",
        "ext.featuresNone": "No manageable features declared",
        "ext.msgFeatureSet": "Feature setting updated.",
        "ext.selfProtected": "manager itself — cannot be disabled/removed",
        "ext.registry": "Online registry",
        "ext.registryHint": "browse & install from aiti.pw",
        "ext.registryEmpty": "Registry is empty",
        "ext.registryFailed": "Failed to load registry",
        "ext.installed": "installed",
        "ext.updatesChecking": "Checking for updates…",
        "ext.updatesPartial": "npm / git check running…",
        "ext.updatesStale": "last check shown, refreshing…",
        "ext.npmUpToDate": "up to date (npm v{version})",
        "ext.updateTo": "update to v{version}",
        "ext.versionCheck": "Version & updates",
        "ext.updateSiteOnly": "site v{version}: npm not released",
        "ext.localAhead": "local ahead",
        "ext.updateCheckFailed": "check failed",
        "ext.updateAll": "Update ({count})",
        "ext.updateAllHint": "Install every available update (npm / git sources)",
        "ext.updateAllConfirm": "Install all {count} available updates? Each extension is replaced in place; the list reloads once at the end.",
        "ext.updatingAll": "Updating all extensions…",
        "ext.msgUpdatedAll": "{count} extension(s) updated.",
        "ext.msgUpdatedSome": "{ok} updated, {failed} failed — see details per extension.",
        "ext.noSource": "no online source",
        "ext.detail": "Details",
        "ext.docs": "Docs",
        "ext.update": "Update",
        "ext.install": "Install",
        "ext.installing": "Installing…",
        "ext.remove": "Remove",
        "ext.publisher": "Publisher",
        "ext.publisherUnknown": "Unknown publisher",
        "ext.trusted": "Trusted",
        "ext.notTrusted": "Not trusted",
        "ext.trustPublisher": "Trust Publisher",
        "ext.untrustPublisher": "Revoke trust",
        "ext.trustDialogTitle": "Trust publisher",
        "ext.trustDialogBody": "This extension is published by a publisher you haven't trusted yet. Only install if you trust this publisher.",
        "ext.trustAndInstall": "Trust Publisher & Install",
        "ext.cancel": "Cancel",
        "ext.copy": "Copy",
        "ext.copied": "Copied",
        "ext.trustedPublishers": "Trusted publishers",
        "ext.trustedEmpty": "No trusted publishers yet",
        "ext.fingerprint": "fingerprint",
        "ext.msgTrusted": "Publisher trusted.",
        "ext.msgUntrusted": "Trust revoked.",
        "ext.fromSource": "Install from source",
        "ext.uploadZip": "Upload zip",
        "ext.chooseZip": "Choose zip…",
        "ext.zipHint": "Pack the extension directory as .zip (entry index.ts at root or one level down; node_modules excluded)",
        "ext.installTo": "Install to",
        "ext.removeConfirm": "Removing deletes the extension code directory (data is kept). Continue?",
        "ext.msgEnabled": "Extension enabled.",
        "ext.msgDisabled": "Extension disabled.",
        "ext.applying": "Applying changes… reloading extensions",
        "ext.msgInstalled": "Extension installed.",
        "ext.msgRemoved": "Extension removed.",
        "ext.msgReloaded": "Extensions reloaded.",
        "ext.back": "Back",
        "ext.view.exts": "Extensions",
        "ext.view.caps": "Capabilities",
        "ext.view.conflicts": "Conflicts",
        "ext.deps.hard": "Dependencies (hard)",
        "ext.deps.optional": "Optional dependencies",
        "ext.capProvide": "Provides (capabilities)",
        "ext.takeoverCaps": "Exclusive takeover",
        "ext.depMissing": "unmet",
        "ext.depInactive": "inactive",
        "ext.depViaPin": "pinned",
        "ext.takeoverEffective": "effective",
        "ext.takeoverShadowed": "superseded",
        "ext.cap.title": "Capability",
        "ext.cap.providers": "Providers",
        "ext.cap.effective": "effective",
        "ext.cap.consumers": "Consumers",
        "ext.cap.none": "No capability declarations or references",
        "ext.cap.pick": "Effective provider",
        "ext.conflict.multiSource": "Same id · multiple sources",
        "ext.conflict.takeover": "Takeover conflicts",
        "ext.conflict.none": "No multi-source or takeover conflicts",
        "ext.conflict.winner": "active",
        "ext.conflict.shadowed": "shadowed",
        "ext.conflict.pick": "Source",
        "ext.pin.auto": "Auto",
        "ext.msgPinned": "Pin updated.",
        "ext.devPriority": "Dev-priority",
        "ext.devPriorityHint": "dev-root candidate wins over version arbitration (for development)",
        "ext.dependentsHardDisable": "The following enabled extensions hard-depend on {id} (directly or via a capability it effectively provides). Disabling it leaves their dependency unmet:",
        "ext.dependentsHardRemove": "Uninstalling deletes the extension code directory (data is kept). The following enabled extensions hard-depend on {id} (directly or via a capability it provides):",
        "ext.statusError": "Status: error",
        "ext.statusDisabled": "Status: disabled",
        "ext.statusNotLoaded": "Status: not loaded",
        "ext.statusRunning": "Status: running",
        "ext.statusNotInstalled": "Status: not installed",
        "ext.dependentDisabledTitle": "{id} (disabled)",
        "ext.featureTypeTextlist": "env vars",
        "ext.featureTypeText": "text",
        "ext.featureDefaultOff": "default off",
        "ext.helperMissing": "aiti-helper is not installed or ready — cannot invoke AI.",
        "ext.protocolUpgradeCtx": "Extension protocol upgrade: {id}",
      },
      "zh-CN": {
        "ext.displayName": "扩展管理器",        "ext.title": "扩展管理",
        "ext.shortLabel": "扩展",
        "ext.sidebarTitle": "扩展管理（启停 / 安装 / 在线注册表）",
        "ext.reload": "全部重载",
        "ext.refresh": "刷新",
        "ext.close": "关闭",
        "ext.prevExt": "上一个扩展",
        "ext.nextExt": "下一个扩展",
        "ext.list": "扩展列表",
        "ext.expand": "展开",
        "ext.collapse": "收起",
        "ext.expandList": "展开扩展列表",
        "ext.collapseList": "收起扩展列表",
        "ext.maximize": "全屏展开",
        "ext.restore": "还原窗口",
        "ext.none": "暂无扩展",
        "ext.enable": "启用",
        "ext.disable": "禁用",
        "ext.disabled": "已禁用",
        "ext.clientLoaded": "client 已加载",
        "ext.prefetched": "已预取（未注册）",
        "ext.notLoaded": "未加载",
        "ext.noClient": "无 client",
        "ext.add": "添加扩展",
        "ext.searchHint": "搜索已安装与在线扩展…",
        "ext.clearSearch": "清空",
        "ext.onlineResults": "在线",
        "ext.installFromSource": "从来源安装",
        "ext.type": "类型",
        "ext.category": "分类",
        "ext.author": "作者",
        "ext.license": "许可",
        "ext.select": "选择左侧扩展查看详情",
        "ext.summary": "{total} 个扩展 · {on} 启用 · {off} 禁用",
        "ext.status": "状态",
        "ext.fieldName": "名称",
        "ext.version": "版本",
        "ext.protocol": "协议",
        "ext.protocolCurrent": "当前",
        "ext.protocolOk": "兼容",
        "ext.protocolStale": "待升级",
        "ext.protocolIncompatible": "不兼容",
        "ext.protocolTooNew": "过新（需升级宿主）",
        "ext.protocolMissing": "未声明",
        "ext.protocolInvalid": "非法",
        "ext.protocolUpgradeAi": "AI 升级",
        "ext.protocolUpgradeTitle": "用 AI 把 {id} 的协议从 {from} 升级到 {to}",
        "ext.protocolMinorAhead": "宿主可升级",
        "ext.protocolInstallWarn": "安装完成；协议 {declared} → 当前 {current}（{state}）——详情页可 🤖 AI 升级",
        "ext.protocolInstallTooNew": "安装完成；扩展协议 {declared} 高于宿主 {current}——请升级 pi-web",
        "ext.slots": "插入点",
        "ext.slotSummary": "{slots} 个插槽 · {items} 项",
        "ext.noSlots": "未声明 UI 插入点",
        "ext.slotsOpenHint": "点击条目可直接打开",
        "ext.open": "打开",
        "ext.global": "全局",
        "ext.context": "需上下文",
        "ext.where": "在哪操作",
        "ext.slotContextHint": "该功能在「{where}」中操作",
        "ext.slotOpened": "已打开：{label}",
        "ext.raiseToTop": "置于顶层",
        "ext.slotLocated": "已定位到「{where}」",
        "ext.slotNeedSession": "该功能需在会话中操作（{where}）",
        "ext.slotNoDirect": "无独立触发入口（{where}），请在对应位置手动操作",
        "ext.clientBundle": "client 包",
        "ext.clientState": "client 状态",
        "ext.dir": "目录",
        "ext.configDir": "配置目录",
        "ext.sourceUrl": "来源地址",
        "ext.deps": "依赖",
        "ext.clientDeps": "client 注入依赖",
        "ext.depsBy": "被依赖",
        "ext.depsByHint": "以下扩展在其 client bundle 里声明依赖本扩展（informational：影响 client 预取调度，不参与加载正确性）。点击可跳转。",
        "ext.dependentsTitle": "依赖影响提示",
        "ext.dependentsBodyDisable": "以下已启用扩展声明 client 注入依赖 {id}。禁用后它们的 client 预取与协作功能可能受影响：",
        "ext.dependentsBodyRemove": "卸载将删除扩展代码目录（数据目录保留）。以下已启用扩展声明 client 注入依赖 {id}，可能受影响：",
        "ext.dependentsConfirmDisable": "仍要禁用",
        "ext.dependentsHardBlocked": "存在硬依赖——上方启用中的扩展 dependsOn 本扩展，不能单独禁用；请先禁用它们（或改声明为 optionalDependsOn）。",
        "ext.dependentsConfirmRemove": "仍要卸载",
        "ext.pkgDeps": "npm 依赖",
        "ext.noDeps": "无",
        "ext.depShared": "共享根",
        "ext.depLocal": "扩展本地",
        "ext.sharedDepsRoot": "共享依赖根",
        "ext.serverCaps": "服务端能力",
        "ext.provides": "接管能力",
        "ext.services": "服务出口",
        "ext.features": "功能管理",
        "ext.featuresHint": "逐项开关本扩展开放的功能：禁用的 agent 工具在新会话中不再注入；会话运行中关闭，已注入工具的调用会立即被拒绝。",
        "ext.featuresOn": "启用 {on}",
        "ext.featuresOff": "禁用 {off}",
        "ext.featuresNone": "未声明可管理功能",
        "ext.msgFeatureSet": "功能设置已更新。",
        "ext.selfProtected": "管理器自身，不可禁用/卸载",
        "ext.registry": "在线扩展注册表",
        "ext.registryHint": "从 aiti.pw 在线浏览并安装",
        "ext.registryEmpty": "注册表为空",
        "ext.registryFailed": "注册表获取失败",
        "ext.installed": "已安装",
        "ext.updatesChecking": "检查更新中…",
        "ext.updatesPartial": "npm / git 检查中…",
        "ext.updatesStale": "显示上次结果，正在刷新…",
        "ext.npmUpToDate": "已是最新（npm v{version}）",
        "ext.updateTo": "可更新到 v{version}",
        "ext.versionCheck": "版本与更新",
        "ext.updateSiteOnly": "站点 v{version}：npm 未发布",
        "ext.localAhead": "本地领先",
        "ext.updateCheckFailed": "检查失败",
        "ext.updateAll": "更新（{count}）",
        "ext.updateAllHint": "安装全部可用更新（npm / git 来源）",
        "ext.updateAllConfirm": "安装全部 {count} 项可用更新？每个扩展将被原地替换，结束后统一重载一次。",
        "ext.updatingAll": "正在更新全部扩展…",
        "ext.msgUpdatedAll": "已更新 {count} 个扩展。",
        "ext.msgUpdatedSome": "更新成功 {ok} 个，失败 {failed} 个——详见各扩展详情。",
        "ext.noSource": "暂无在线安装源",
        "ext.detail": "详情",
        "ext.docs": "文档",
        "ext.update": "更新",
        "ext.install": "安装",
        "ext.installing": "安装中…",
        "ext.remove": "移除",
        "ext.publisher": "发行者",
        "ext.publisherUnknown": "未知发行者",
        "ext.trusted": "已信任",
        "ext.notTrusted": "未信任",
        "ext.trustPublisher": "信任此发行者",
        "ext.untrustPublisher": "撤销信任",
        "ext.trustDialogTitle": "信任发行者",
        "ext.trustDialogBody": "此扩展的发行者尚未被信任。仅在你信任该发行者时继续安装。",
        "ext.trustAndInstall": "信任并安装",
        "ext.cancel": "取消",
        "ext.copy": "复制",
        "ext.copied": "已复制",
        "ext.trustedPublishers": "已信任发行者",
        "ext.trustedEmpty": "暂无已信任的发行者",
        "ext.fingerprint": "指纹",
        "ext.msgTrusted": "发行者已信任。",
        "ext.msgUntrusted": "已撤销信任。",
        "ext.fromSource": "从来源安装",
        "ext.uploadZip": "上传 zip 安装",
        "ext.chooseZip": "选择 zip…",
        "ext.zipHint": "把扩展目录打包成 .zip（入口 index.ts 在根或单层子目录；node_modules 自动剔除）",
        "ext.installTo": "安装位置",
        "ext.removeConfirm": "卸载将删除扩展代码目录（数据目录保留），确定继续？",
        "ext.msgEnabled": "扩展已启用。",
        "ext.msgDisabled": "扩展已禁用。",
        "ext.applying": "正在应用变更…（重载扩展中）",
        "ext.msgInstalled": "扩展已安装。",
        "ext.msgRemoved": "扩展已卸载。",
        "ext.msgReloaded": "扩展已重载。",
        "ext.back": "返回",
        "ext.view.exts": "扩展",
        "ext.view.caps": "能力",
        "ext.view.conflicts": "冲突",
        "ext.deps.hard": "依赖（硬）",
        "ext.deps.optional": "可选依赖",
        "ext.capProvide": "能力提供",
        "ext.takeoverCaps": "独占接管",
        "ext.depMissing": "未满足",
        "ext.depInactive": "未生效",
        "ext.depViaPin": "已 pin",
        "ext.takeoverEffective": "生效中",
        "ext.takeoverShadowed": "被取代",
        "ext.cap.title": "能力",
        "ext.cap.providers": "提供者",
        "ext.cap.effective": "生效",
        "ext.cap.consumers": "消费方",
        "ext.cap.none": "暂无能力声明或引用",
        "ext.cap.pick": "生效提供者",
        "ext.conflict.multiSource": "同 id 多来源",
        "ext.conflict.takeover": "接管冲突",
        "ext.conflict.none": "暂无多来源/接管冲突",
        "ext.conflict.winner": "生效",
        "ext.conflict.shadowed": "被遮蔽",
        "ext.conflict.pick": "来源",
        "ext.pin.auto": "自动",
        "ext.msgPinned": "pin 已更新。",
        "ext.devPriority": "dev 调试优先",
        "ext.devPriorityHint": "开启后 dev 根扩展在同 id 裁决中优先于版本（开发调试用）",
        "ext.dependentsHardDisable": "以下已启用扩展硬依赖 {id}（直接依赖，或依赖它生效提供的能力）。禁用后其依赖声明将未满足：",
        "ext.dependentsHardRemove": "卸载将删除扩展代码目录（数据目录保留）。以下已启用扩展硬依赖 {id}（直接依赖，或经能力解析依赖它）：",
        "ext.statusError": "状态：异常",
        "ext.statusDisabled": "状态：已停用",
        "ext.statusNotLoaded": "状态：未加载",
        "ext.statusRunning": "状态：运行中",
        "ext.statusNotInstalled": "状态：未安装",
        "ext.dependentDisabledTitle": "{id}（已禁用）",
        "ext.featureTypeTextlist": "环境变量",
        "ext.featureTypeText": "文本",
        "ext.featureDefaultOff": "默认关",
        "ext.helperMissing": "aiti-helper 未安装或未就绪，无法唤起 AI。",
        "ext.protocolUpgradeCtx": "扩展协议升级：{id}",
      },
    },
  },

  server: {
    startup(ctx) {
      // Help points are declared in ai.helpers and aggregated by ai-helper — nothing to register here
    },
    async api(req, ctx) {
      const [route] = ctx.path;
      if (ctx.cacheDir && updatesCacheDir !== ctx.cacheDir) updatesCacheDir = ctx.cacheDir;

      // GET status — full state (disabled/failed entries, slot/hook/dependency details + publisher info).
      //   ?locale=<tag> picks DESC.<locale>.md / DESC.<lang>.md before the neutral DESC.md.
      if (route === "status" && ctx.method === "GET") {
        const locale = ctx.searchParams?.get("locale") || null;
        return json(enrichedStatus(locale));
      }

      // GET publishers — trusted publisher list (management UI).
      if (route === "publishers" && ctx.method === "GET") return json({ trusted: listTrusted() });

      // GET registry — proxy for aiti.pw/extensions.json (short TTL).
      if (route === "registry" && ctx.method === "GET") {
        try {
          return await fetchRegistry();
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 502);
        }
      }

      // GET updates — dual-source update check (npm × aiti.pw registry × git).
      //   ?phase=registry → fast partial verdict (npm/git not queried), ?force=1 bypasses cache.
      //   Without force: memory cache → persisted verdict (marked stale when old or when the
      //   deployed versions moved) → full check. A stale reply is shown immediately and the
      //   client refreshes it; the install path always re-checks (update-all never reads here).
      if (route === "updates" && ctx.method === "GET") {
        const params = new URL(req.url ?? "/", "http://localhost").searchParams;
        const force = params.get("force") === "1";
        const phase = params.get("phase") === "registry" ? "registry" as const : "all" as const;
        if (!force) {
          const mem = phase === "registry" ? registryUpdatesCache : updatesCache;
          if (mem && Date.now() - mem.at < UPDATES_TTL_MS) {
            return json({ ...mem.data, cached: true, stale: false });
          }
          const disk = readDiskCache();
          if (disk) {
            const stale = Date.now() - disk.at >= UPDATES_TTL_MS || cacheInstalledMismatch(disk.data);
            return json({ ...disk.data, cached: true, stale });
          }
        }
        try {
          const data = await computeUpdates(phase);
          if (phase === "registry") registryUpdatesCache = { at: Date.now(), data };
          else {
            updatesCache = { at: Date.now(), data };
            writeDiskCache(data);
          }
          return json({ ...data, cached: false, stale: false });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      // POST update-all — install every installable update in one pass, then reload once.
      if (route === "update-all" && ctx.method === "POST") {
        const reg = registry();
        if (!reg) return json({ error: "extension registry unavailable" }, 500);
        try {
          const data = await computeUpdates("all");
          const targets = Object.values(data.updates as Record<string, UpdateEntry>)
            .filter((u) => u.hasUpdate && typeof u.installable === "string" && u.installable);
          if (!targets.length) return json({ ok: true, updated: [], message: "nothing to update" });
          const updated: Array<{ id: string; ok: boolean; from: string | null; to?: string | null; source: string; error?: string }> = [];
          for (const target of targets) {
            try {
              const result = await installExtension(target.installable as string, target.id);
              let to: string | null = null;
              try {
                const pj = JSON.parse(readFileSync(join(result.dir, "package.json"), "utf8")) as { version?: unknown };
                to = typeof pj.version === "string" ? pj.version : null;
              } catch {}
              updated.push({ id: target.id, ok: true, from: target.installed, to, source: target.installable as string });
            } catch (e) {
              updated.push({ id: target.id, ok: false, from: target.installed, source: target.installable as string, error: e instanceof Error ? e.message : String(e) });
            }
          }
          const changed = updated.filter((u) => u.ok).length;
          const deps = changed ? await reconcile("update-all") : null;
          if (changed) await reg.reload();
          invalidateUpdatesCache();
          return json({ ok: true, updated, deps, ...enrichedStatus() });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      // POST install-zip — multipart upload install (file=<zip>, optional id / docsUrl / trust / publisherHint).
      if (route === "install-zip" && ctx.method === "POST") {
        const form = await req.formData().catch(() => null);
        const file = form?.get("file");
        if (!form || !(file instanceof File)) return json({ error: "multipart file required" }, 400);
        if (file.size > 64 * 1024 * 1024) return json({ error: "zip 过大（>64MB）" }, 413);
        const buf = Buffer.from(await file.arrayBuffer());
        const id = typeof form.get("id") === "string" ? String(form.get("id")) : undefined;
        const docsUrl = typeof form.get("docsUrl") === "string" ? String(form.get("docsUrl")) : undefined;
        const trust = form.get("trust") === "1" || form.get("trust") === "true";
        const reg = registry();
        if (!reg) return json({ error: "extension registry unavailable" }, 500);

        // Publisher pre-check (unpack and read package.json): untrusted → needsTrust, nothing installed.
        let publisher: Publisher | null = null;
        let tmp: string | null = null;
        try {
          tmp = await extractZipToTemp(buf);
          publisher = publisherFromZipBuffer(buf, tmp);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 400);
        } finally {
          if (tmp) {
            try {
              rmSync(tmp, { recursive: true, force: true });
            } catch {}
          }
        }
        if (!trust && !isTrusted(publisher)) {
          return needsTrustResponse(publisher, { zipName: file.name });
        }
        if (trust) addTrusted(publisher);

        try {
          const result = await installFromZipBuffer(buf, id, docsUrl);
          try {
            writePublisher(result.dir, publisher);
          } catch {}
          // Shared-dependency reconcile (non-fatal): runtime dependencies declared by a zip source land in the shared root too
          const deps = await reconcile(`install-zip:${result.id}`);
          await reg.reload();
          // Protocol check + install-time screening placeholder (spec §7; currently skipped, no behavior change)
          const protocolCheck = protocolOfDir(result.dir);
          const screening = await screenAndMigrateOnInstall({ id: result.id, dir: result.dir, kind: "zip", fromProtocol: protocolCheck.declared, toProtocol: protocolCheck.current });
          invalidateUpdatesCache(); // Version may have changed after install/overwrite; force a refresh on the next update check
          return json({ ok: true, id: result.id, deps, protocolCheck, screening, ...enrichedStatus() });
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      // POST ops — install / remove / enable / disable / reload / set-feature。
      if (route === "ops" && ctx.method === "POST") {
        let body: {
          action?: string;
          source?: string;
          id?: string;
          docsUrl?: string;
          featureId?: string;
          enabled?: boolean;
          value?: boolean | string;
          /** set-pin：capability | source */
          scope?: string;
          /** set-pin: capability name or extension id */
          key?: string;
          /** set-dev-priority: toggle value */
          trust?: boolean;
          publisherHint?: string;
          fingerprint?: string;
          publisher?: {
            name?: string;
            url?: string;
            source?: string;
            fingerprint: string;
          };
          name?: string;
          url?: string;
        };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ error: "invalid json" }, 400);
        }
        // Self-protection: the manager refuses to disable or uninstall itself (that would remove the only
        // management entry and require editing files by hand to recover).
        if ((body.action === "disable" || body.action === "remove") && body.id === ctx.id) {
          return json({ error: "扩展管理器不允许禁用/卸载自己（否则将失去扩展管理入口）" }, 400);
        }
        const reg = registry();
        if (!reg) return json({ error: "extension registry unavailable" }, 500);

        try {
          // Trust management: trust adds the publisher to the trusted list; untrust removes it.
          if (body.action === "trust" || body.action === "untrust") {
            const name = body.name?.trim();
            const fingerprint = body.fingerprint?.trim();
            const key = name || fingerprint;
            if (!key) return json({ error: "name or fingerprint required" }, 400);
            if (body.action === "trust") {
              addTrusted({ name: name || null, url: body.url, source: body.source || "manual", fingerprint: key });
            } else {
              removeTrusted(key);
            }
            return json({ ok: true, trusted: listTrusted() });
          }

          if (body.action === "install") {
            if (!body.source?.trim()) return json({ error: "source required" }, 400);
            const plan = parseInstallSource(body.source);
            if (!plan) return json({ error: `无法识别的扩展来源：${body.source}` }, 400);
            // VSCode-style trust: resolve the publisher first (npm registry / GitHub owner / package.json).
            // After the UI confirms, it sends the resolved publisher back (so the trust key matches what was
            // displayed); otherwise the server resolves it.
            const publisher =
              (body.publisher && normalizePublisher(body.publisher)) ||
              (await resolvePublisherForSource(plan.kind, plan.ref, body.publisherHint));
            if (body.trust !== true && !isTrusted(publisher)) {
              return needsTrustResponse(publisher, {
                source: body.source,
                docsUrl: body.docsUrl,
                id: body.id?.trim() || plan.id,
              });
            }
            if (body.trust === true) addTrusted(publisher);
            const result = await installExtension(body.source, body.id, body.docsUrl);
            try {
              writePublisher(result.dir, publisher);
            } catch {}
            // Shared-dependency reconcile (non-fatal: failures only surface as warnings, the install is not rolled
            // back); align dependencies first, then reload to load the extension
            const deps = await reconcile(`install:${result.id}`);
            await reg.reload();
            // Protocol check + install-time screening placeholder (spec §7; currently skipped, no behavior change)
            const protocolCheck = protocolOfDir(result.dir);
            const screening = await screenAndMigrateOnInstall({ id: result.id, dir: result.dir, kind: plan.kind, fromProtocol: protocolCheck.declared, toProtocol: protocolCheck.current });
            invalidateUpdatesCache(); // Version may have changed after install/update; force a refresh on the next update check
            return json({ ok: true, id: result.id, deps, protocolCheck, screening, ...enrichedStatus() });
          }
          if (body.action === "remove") {
            if (!body.id?.trim()) return json({ error: "id required" }, 400);
            removeExtension(body.id);
            invalidateUpdatesCache();
            // Pin cleanup (P2): source/capability pins go stale after uninstall — cleared when core exposes the
            // method (older cores skip it; resolution-time soft checks are the safety net)
            try { reg.clearExtPins?.(body.id); } catch {}
            // The dependency union shrank → reconcile lets npm prune packages in the shared root that no extension
            // references anymore (non-fatal)
            const deps = await reconcile(`remove:${body.id}`);
            await reg.reload();
            return json({ ok: true, id: body.id, deps, ...enrichedStatus() });
          }
          if (body.action === "enable" || body.action === "disable") {
            if (!body.id?.trim()) return json({ error: "id required" }, 400);
            reg.setEnabled(body.id, body.action === "enable");
            await reg.reload();
            return json({ ok: true, id: body.id, enabled: reg.isEnabled(body.id), ...enrichedStatus() });
          }
          if (body.action === "reload") {
            await reg.reload();
            return json({ ok: true, ...enrichedStatus() });
          }
          // Dependency & capability model P2: pins (effective capability provider / multi-source ids) and the
          // dev-priority debug switch.
          // Reload after the change so arbitration takes effect (same pattern as enable/disable).
          if (body.action === "set-pin") {
            const scope = body.scope;
            const key = body.key?.trim();
            if ((scope !== "capability" && scope !== "source") || !key) return json({ error: "scope (capability|source) and key required" }, 400);
            if (typeof reg.setPin !== "function") return json({ error: "宿主 core 不支持 pin（需升级 pi-web）" }, 501);
            const value = typeof body.value === "string" && body.value.trim() ? body.value.trim() : null;
            reg.setPin(scope + ":" + key, value);
            await reg.reload();
            return json({ ok: true, scope, key, value, ...enrichedStatus() });
          }
          if (body.action === "set-dev-priority") {
            if (typeof reg.setDevPriority !== "function") return json({ error: "宿主 core 不支持 dev 优先开关（需升级 pi-web）" }, 501);
            reg.setDevPriority(body.value === true);
            await reg.reload();
            return json({ ok: true, devPriority: body.value === true, ...enrichedStatus() });
          }
          // Feature management: enable/disable or set each declared feature (core persists and filters
          // injection; no reload needed).
          if (body.action === "set-feature") {
            if (!body.id?.trim() || !body.featureId?.trim()) return json({ error: "id and featureId required" }, 400);
            const status = enrichedStatus();
            const entry = status.extensions[body.id];
            const feature = entry?.features?.find((f: { id: string; type?: string }) => f.id === body.featureId);
            if (!entry || entry.loaded !== true || !feature) {
              return json({ error: `扩展 ${body.id} 未加载或未声明功能 ${body.featureId}` }, 400);
            }
            // string/textlist feature → write the value (value defaults to an empty string); boolean feature
            // → toggle (enabled defaults to true)
            let value: boolean | string;
            if (feature.type === "string" || feature.type === "textlist") {
              value = (body.value !== undefined && typeof body.value !== "boolean") ? String(body.value) : String(body.value ?? "");
              reg.setFeatureValue(body.id, body.featureId, value);
            } else {
              value = body.enabled !== false;
              reg.setFeatureFlag(body.id, body.featureId, value);
            }
            const fresh = enrichedStatus();
            const fe = fresh.extensions[body.id]?.features?.find((f: any) => f.id === body.featureId);
            return json({ ok: true, id: body.id, featureId: body.featureId, enabled: fe ? fe.enabled !== false : true, value: fe && typeof fe.value === "string" ? fe.value : undefined, ...fresh });
          }
          // Manual shared-dependency reconcile (triggered by deploy.mjs / the AI / the UI; install/remove already
          // trigger it automatically)
          if (body.action === "reconcile-deps") {
            const deps = await reconcile(body.source?.trim() || "manual");
            return json({ ok: deps.ok, deps, ...enrichedStatus() });
          }
          return json({ error: "unknown action (install|remove|enable|disable|reload|set-feature|set-pin|set-dev-priority|reconcile-deps|trust|untrust)" }, 400);
        } catch (e) {
          return json({ error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }

      return null; // 404
    },
  },
};
