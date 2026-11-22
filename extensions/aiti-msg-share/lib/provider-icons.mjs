/**
 * provider-icons — curated per-target glyphs for the share picker (pure data, no DOM).
 *
 * The content-share catalog carries no icon/favicon metadata (checked against
 * @aiti-ai/content-share 0.1.17: catalog entries have id/name/kinds/category/
 * source/auth/note/status only, and providers have no icon field), so the old
 * `icon: p?.icon` was always null. Rather than fetching third-party favicons
 * (privacy + offline), resolve a stable local glyph:
 *
 *   1. provider.icon when a future catalog version supplies one (string or { emoji })
 *   2. ordered keyword rules over the target id (ids are domain-ish: "imgur.com",
 *      "0x0.st (URL shortener)", "aliyun-oss", "gitee-gist", …)
 *   3. null → the client keeps its category/status glyph
 *
 * Order matters: specific families first, generic "shortener"/"file" last.
 */

/** Curated glyphs keyed by exact target id (the few curated aiti entries). */
const EXACT = {
  "aliyun-oss": "☁️",
  "gitee-gist": "🟠",
  "local-link": "🔗",
  custom: "⚙️",
};

/** Ordered keyword rules over the lower-cased target id. */
const RULES = [
  [/(^|[^a-z])github|(^|[^a-z])gist|gitlab|git\.io|gitee|codeberg|sourcehut/, "💻"],
  [/catbox|litterbox/, "🐱"],
  [/shortener|short\.?url|\bshort\b/, "✂️"],
  [/imgur|imgbb|freeimage|gyazo|chevereto|postimag|epvpimg|\bimage\b|\bimg\b|\bpic\b|photo|lsky/, "🖼️"],
  [/paste|haste|dpaste|ghostbin|privatebin|ix\.io|0x0\.st/, "📋"],
  [/\boss\b|s3|storage|qiniu|tencent|upyun|wasabi|minio|backblaze|\bb2\b|\br2\b|bucket/, "☁️"],
  [/joplin|obsidian|notion|evernote/, "📓"],
  [/telegram|discord|slack|feishu|lark|flomo|\bim\b/, "💬"],
  [/\bmail|smtp|email/, "✉️"],
  [/ipfs|ipns/, "🌐"],
  [/local-link/, "🔗"],
  [/webhook|httpreq|httpbin/, "🔗"],
  [/\bfile\b|gofile|transfer|dropfile|filebin|tmpfiles|uguu|fuwa|fuck\.it|catbox/, "📦"],
];

/**
 * Resolve the glyph for one target.
 * @param {string} providerId target id from the catalog
 * @param {{ icon?: unknown } | null | undefined} provider registry provider (future metadata)
 * @returns {string | null} glyph, or null so the client falls back
 */
export function resolveProviderIcon(providerId, provider) {
  const fromProvider = provider?.icon;
  if (typeof fromProvider === "string" && fromProvider.trim()) return fromProvider.trim();
  if (fromProvider && typeof fromProvider === "object" && typeof fromProvider.emoji === "string") {
    return fromProvider.emoji.trim() || null;
  }
  const id = String(providerId || "").trim();
  if (!id) return null;
  if (EXACT[id]) return EXACT[id];
  const lower = id.toLowerCase();
  for (const [pattern, glyph] of RULES) {
    if (pattern.test(lower)) return glyph;
  }
  return null;
}
