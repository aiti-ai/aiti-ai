/**
 * action-icons — popover action icon data + provider icon resolver.
 *
 * Pure data + pure functions: no React, no DOM access, no deploy assets, no requests.
 * Same glyph language as the host's line-icon system (lucide 24 viewBox, stroke 2,
 * round caps) and the same node-table pattern as `_shared/dock-icons.ts` — but kept
 * local to this extension so `_shared` deploys don't cascade.
 *
 * Every clickable action button in the popover card renders one icon:
 *   - built-ins map to a fixed name (copy / quote / new-session / file / folder-open /
 *     reveal / url) — see buildCardNode in index.js;
 *   - external topic providers (msg-file-action / msg-popover-top-action /
 *     msg-popover-action / inline-code-action) resolve through resolveActionIcon():
 *     item.icon wins ({svg} inline markup | semantic name | short text/emoji), then
 *     item.type (quote/file/folder/share/reveal/command/url/bookmark/copy/new-session/code),
 *     else no icon. Unknown values degrade to no icon — never a broken button.
 */

/** Node attrs longer than this are treated as invalid icon markup (fallback to type). */
export const ACTION_ICON_SVG_MAX = 8 * 1024;

/** Single SVG child node; attrs use native SVG kebab-case names (verbatim for DOM
 *  setAttribute; React consumers adapt via actionIconReactAttrs). */
// Allowed tags for table entries — guards typos and keeps the DOM builder honest.
const ICON_TAGS = new Set(["path", "rect", "circle", "line", "polyline"]);

const P = (d) => ({ tag: "path", attrs: { d } });

/** Icon node table (lucide line glyphs, hand-copied to stay dependency-free). */
export const ACTION_ICON_NODES = {
  /** Copy: two overlapping rounded rects (lucide copy). */
  copy: [
    { tag: "rect", attrs: { width: 14, height: 14, x: 8, y: 8, rx: 2, ry: 2 } },
    P("M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"),
  ],
  /** Quote-reply: speech bubble with quote marks (lucide message-square-quote). */
  quote: [
    P("M14 14a2 2 0 0 0 2-2V8h-2"),
    P("M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"),
    P("M8 14a2 2 0 0 0 2-2V8H8"),
  ],
  /** Quote into a new session: speech bubble with plus (lucide message-square-plus). */
  "new-session": [
    P("M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"),
    P("M12 8v6"),
    P("M9 11h6"),
  ],
  /** Share (providers usually bring their own {svg}; fallback = lucide share-2). */
  share: [
    { tag: "circle", attrs: { cx: 18, cy: 5, r: 3 } },
    { tag: "circle", attrs: { cx: 6, cy: 12, r: 3 } },
    { tag: "circle", attrs: { cx: 18, cy: 19, r: 3 } },
    { tag: "line", attrs: { x1: 8.59, y1: 13.51, x2: 15.42, y2: 17.49 } },
    { tag: "line", attrs: { x1: 15.41, y1: 6.51, x2: 8.59, y2: 10.49 } },
  ],
  /** Open file: document with text lines (lucide file-text). */
  file: [
    P("M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"),
    P("M14 2v5a1 1 0 0 0 1 1h5"),
    P("M10 9H8"),
    P("M16 13H8"),
    P("M16 17H8"),
  ],
  /** Open folder: open-lid folder (lucide folder-open; directory entries only). */
  "folder-open": [
    P("m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"),
  ],
  /** Reveal / locate: folder with magnifier (lucide folder-search; distinct from open). */
  reveal: [
    P("M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1"),
    P("m21 21-1.9-1.9"),
    { tag: "circle", attrs: { cx: 17, cy: 17, r: 3 } },
  ],
  /** Run command: terminal prompt (lucide terminal; type:"command" fallback). */
  command: [
    P("M12 19h8"),
    P("m4 17 6-6-6-6"),
  ],
  /** Open URL: chain link (lucide link). */
  url: [
    P("M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"),
    P("M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"),
  ],
  /** Bookmark / favorite (providers that star content; spare semantic slot). */
  bookmark: [
    P("m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"),
  ],
  /** Inline code (providers acting on <code> snippets; spare semantic slot). */
  code: [
    P("m16 18 6-6-6-6"),
    P("m8 6-6 6 6 6"),
  ],
};

const hasName = (name) =>
  typeof name === "string" && Object.prototype.hasOwnProperty.call(ACTION_ICON_NODES, name);

/**
 * Resolve the icon for a provider action item.
 * @param {any} item provider action ({ icon?, type? })
 * @param {string} [fallbackType] semantic name used when item.type is absent
 *   (e.g. "command" for inline-code providers)
 * @returns {{kind:"name"|"svg"|"text", value:string}|null} null = no icon, render none
 */
export function resolveActionIcon(item, fallbackType) {
  const it = item || {};
  const icon = it.icon;
  // 1) explicit icon field wins — host inline form {svg}
  if (icon && typeof icon === "object" && typeof icon.svg === "string" && icon.svg.trim()) {
    if (icon.svg.length <= ACTION_ICON_SVG_MAX) return { kind: "svg", value: icon.svg };
    return typeFallback(it.type, fallbackType);
  }
  if (typeof icon === "string" && icon) {
    // "icons/x.svg" deploy-asset paths cannot be resolved inside a card (no URL base
    // per-provider in this context) — degrade to the type fallback instead.
    if (icon.endsWith(".svg")) return typeFallback(it.type, fallbackType);
    if (hasName(icon)) return { kind: "name", value: icon };
    // short glyph / emoji (text markers stay readable at 12px; "/" implies a path-like string)
    if (icon.length <= 4 && !icon.includes("/")) return { kind: "text", value: icon };
    return typeFallback(it.type, fallbackType);
  }
  return typeFallback(it.type, fallbackType);
}

function typeFallback(type, fallbackType) {
  if (hasName(type)) return { kind: "name", value: type };
  if (hasName(fallbackType)) return { kind: "name", value: fallbackType };
  return null;
}

/** Name-table glyph → host contract form { svg: markup } (inner markup, no <svg> wrapper). */
export function actionIconDecl(name) {
  const nodes = ACTION_ICON_NODES[name];
  if (!nodes) return null;
  return {
    svg: nodes
      .map((n) => `<${n.tag} ${Object.entries(n.attrs).map(([k, v]) => `${k}="${v}"`).join(" ")} />`)
      .join(""),
  };
}

/** SVG kebab-case attr names → JSX camelCase (React rejects kebab-case SVG props with a
 *  dev warning); aria-/data- prefixed keys pass through unchanged. */
export function actionIconReactAttrs(attrs) {
  const out = {};
  for (const k of Object.keys(attrs)) {
    out[!k.includes("-") || k.startsWith("aria-") || k.startsWith("data-")
      ? k
      : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = attrs[k];
  }
  return out;
}

/** Dev-time table sanity (also unit-tested): every entry is a non-empty list of allowed nodes. */
export function validateActionIconTable() {
  const problems = [];
  for (const [name, nodes] of Object.entries(ACTION_ICON_NODES)) {
    if (!Array.isArray(nodes) || !nodes.length) { problems.push(`${name}: empty`); continue; }
    for (const n of nodes) {
      if (!ICON_TAGS.has(n.tag)) problems.push(`${name}: bad tag ${n.tag}`);
      if (!n.attrs || typeof n.attrs !== "object") problems.push(`${name}: missing attrs`);
    }
  }
  return problems;
}
