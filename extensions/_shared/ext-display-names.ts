/**
 * Extension display-name / self-description entry resolution (self-registered, no central table —
 * 2026-11-15 refactor).
 *
 * Convention: each extension declares its self-description entries in its own index.ts ui.i18n
 * (bundled at install; third-party extensions use the same mechanism):
 *   - "ext.displayName": display name (zh-CN + en; English in en mode, Chinese in zh mode)
 *   - "ext.description": one-line description (en table optional; zh mode falls back to the raw manifest)
 *   - "feat.<featureId>": feature toggle label (same as above)
 * Lookup rule = the current locale's exact table, no cascading: the raw manifest text IS Chinese
 * (zh-CN source), so only the current locale's own table is honored — en-table entries cover en
 * mode; zh mode without an entry naturally falls back to the raw text.
 *
 * registry: /api/extensions/manifest fetched once, caching every extension's ui.i18n (each
 * extension calls primeExtRegistry(apiUrlFn) at register time to inject a basePath-aware fetch
 * primitive; not-ready / absent falls back to fallback).
 * Scenarios that have only an id without a manifest object (AI Helper grouping, dialog 🤖 button,
 * etc.) go through here.
 */

/** Current UI locale (localStorage pi-locale, same source as host useI18n; defaults to en). */
export function currentUiLocale(): "zh-CN" | "zh-TW" | "en" {
  try {
    const v = window.localStorage.getItem("pi-locale");
    if (v === "zh-CN" || v === "zh-TW" || v === "en") return v;
  } catch { /* use the default when storage is unavailable */ }
  return "en";
}

type UiI18n = Record<string, Record<string, string>> | null | undefined;
type ExtManifestEntry = { id: string; name?: string; ui?: { i18n?: UiI18n } | null };

// ---- registry (manifest ui.i18n cache; all data comes from each extension's own declarations, no central table) ----
let registry: Record<string, ExtManifestEntry> | null = null;
let registryPrimed = false;
let registryApiUrl: ((p: string) => string) | null = null;
const listeners = new Set<() => void>();

/** Inject the fetch primitive and prime the manifest cache (called once per extension at register; idempotent). */
export function primeExtRegistry(apiUrlFn?: (p: string) => string): void {
  if (apiUrlFn) registryApiUrl = apiUrlFn;
  if (registryPrimed || typeof window === "undefined") return;
  const urlFn = registryApiUrl;
  if (!urlFn) return; // fetch primitive not injected → consumers fall back to fallback
  registryPrimed = true;
  fetch(urlFn("/api/extensions/manifest"))
    .then((r) => r.json())
    .then((d) => {
      const map: Record<string, ExtManifestEntry> = {};
      for (const e of d?.extensions ?? []) if (e?.id) map[e.id] = e;
      registry = map;
      for (const l of [...listeners]) { try { l(); } catch { /* ignore */ } }
    })
    .catch(() => { registryPrimed = false; /* failure allows retry */ });
}

/** registry ready/change subscription (for consumer re-renders); returns a disposer. */
export function onExtRegistryReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Registry entry for one id (ui.i18n included); undefined until the manifest fetch lands.
 *  Lets consumers read soul/description/exact-table sources without keeping their own manifest copy. */
export function manifestEntry(id: string | undefined): ExtManifestEntry | undefined {
  return (id && registry?.[id]) || undefined;
}

/** The current locale's exact entry table (deliberately non-cascading — see the file header). */
export function ui18nExact(ui18n: UiI18n, locale: string): Record<string, string> {
  if (!ui18n) return {};
  return ui18n[locale] ?? {};
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** Resolve the self-description name via the registry (id-only scenarios: AI Helper grouping,
 *  dialog 🤖 etc.). ext.displayName entry (current locale's exact table) → raw CJK manifest text for
 *  every zh variant (zh-TW included, a Chinese name beats an id) / non-CJK fallback in en mode → id. */
export function extDisplayName(id: string, fallbackName?: string | null): string {
  const locale = currentUiLocale();
  primeExtRegistry();
  const entry = registry?.[id];
  const over = entry ? ui18nExact(entry.ui?.i18n, locale)["ext.displayName"] : undefined;
  if (over) return over;
  const name = fallbackName ?? entry?.name ?? "";
  if (!name) return id;
  return locale.startsWith("zh") ? name : CJK_RE.test(name) ? id : name;
}

/** Synchronous resolution when a full manifest object is available (pure-function scenarios like
 *  App Center buildApps). ext.displayName entry → raw CJK text for every zh variant / non-CJK raw in
 *  en mode → id. */
export function extNameFor(ext: { id: string; name?: string | null; ui?: { i18n?: UiI18n } | null } | undefined | null, locale: string): string {
  if (!ext) return "";
  const over = ui18nExact(ext.ui?.i18n, locale)["ext.displayName"];
  if (over) return over;
  const name = ext.name ?? "";
  if (!name) return ext.id;
  return locale.startsWith("zh") ? name : CJK_RE.test(name) ? ext.id : name;
}

/** Extension description: "ext.description" ui.i18n override → package.json descriptionI18n[locale] → raw manifest. */
export function extDescriptionFor(
  ext: { description?: string | null; descriptionI18n?: Record<string, string> | null; ui?: { i18n?: UiI18n } | null } | undefined | null,
  locale: string,
): string {
  const over = ui18nExact(ext?.ui?.i18n, locale)["ext.description"];
  if (over) return over;
  return localeText(ext?.descriptionI18n, locale) || ext?.description || "";
}

/** Extension tagline (❝ … ❞): "ext.soul" ui.i18n override → package.json soulI18n[locale] → raw soul.
 *  Manifest text stays the single-valued default so docs sync / npm consumers keep reading `soul`. */
export function extSoulFor(
  ext: { soul?: string | null; soulI18n?: Record<string, string> | null; ui?: { i18n?: UiI18n } | null } | undefined | null,
  locale: string,
): string {
  const over = ui18nExact(ext?.ui?.i18n, locale)["ext.soul"];
  if (over) return over;
  return localeText(ext?.soulI18n, locale) || ext?.soul || "";
}

/** Pick the best entry from a package.json locale map: exact locale → same language family → "". */
function localeText(map: Record<string, string> | null | undefined, locale: string): string {
  if (!map || typeof map !== "object") return "";
  const exact = map[locale];
  if (typeof exact === "string" && exact) return exact;
  const short = locale.split("-")[0];
  const family = Object.entries(map).find(([k, v]) => typeof v === "string" && v && k.split("-")[0] === short);
  return family ? family[1] : "";
}

/** Cross-extension item-text resolution ("i18n:<key>" prefix → the declaring extension's manifest
 *  ui.i18n table). Cascading table pick (current locale → language short → zh-CN for zh → en → first
 *  table); non-prefixed text passes through; missing table/key falls back to the bare key. Consumers
 *  prime the registry once at mount (primeExtRegistry(apiUrlFn)); until the cache lands the bare key
 *  is returned. Same protocol as the host translateExtItemText / app-center / extman resolvers. */
export function extItemText(extId: string | undefined, text: string | undefined, locale: string): string {
  if (!text) return "";
  if (!extId || !text.startsWith("i18n:")) return text;
  primeExtRegistry();
  const key = text.slice("i18n:".length);
  const ui18n = registry?.[extId]?.ui?.i18n;
  if (!ui18n) return key;
  const short = locale.split("-")[0];
  const tbl = ui18n[locale] ?? ui18n[short] ?? (short === "zh" ? ui18n["zh-CN"] : undefined) ?? ui18n.en ?? Object.values(ui18n)[0] ?? {};
  return tbl[key] ?? key;
}

/** Feature label: "feat.<id>" entry → "i18n:<key>" prefix (host translateExtItemText cascade) → raw manifest text. */
export function featureLabelFor(ext: { ui?: { i18n?: UiI18n } | null } | undefined | null, f: { id: string; label?: unknown }, locale: string): string {
  const ui18n = ext?.ui?.i18n;
  const over = ui18nExact(ui18n, locale)["feat." + f.id];
  if (over) return over;
  const raw = f.label != null ? String(f.label) : String(f.id);
  if (raw.startsWith("i18n:")) {
    const key = raw.slice("i18n:".length);
    const tbl = ui18n?.[locale] ?? ui18n?.[locale.split("-")[0]] ?? ui18n?.en ?? Object.values(ui18n ?? {})[0];
    return tbl?.[key] ?? key;
  }
  return raw;
}

/** Feature description: "feat.<id>.desc" override; falls back to the manifest original. */
export function featureDescriptionFor(ext: { ui?: { i18n?: UiI18n } | null } | undefined | null, f: { id: string; description?: unknown }, locale: string): string {
  const over = ui18nExact(ext?.ui?.i18n, locale)["feat." + f.id + ".desc"];
  if (over) return over;
  return f.description != null ? String(f.description) : "";
}
