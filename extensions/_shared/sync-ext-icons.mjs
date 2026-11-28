/**
 * sync-ext-icons — copy every SVG icon an extension references into its deployed
 * extension directories.
 *
 * Why this exists: an item icon such as `icon: "icons/<name>.svg"` points at the shared
 * line-icon library (`extensions/_shared/icons`). Extensions declare icons in three
 * places — the extension-level `icon:`, the manifest `ui.<slot>[]` declarations, and
 * client registrations (evaluated strings inside the built client bundle). Several
 * several per-extension deploy scripts carried an empty icon-copy placeholder and
 * never implemented the copy, so deployed trees drifted into 404s for those icons (a missing
 * icon renders as a blank/fallback glyph). The unified deploy tooling calls this helper
 * per deployed extension so the copy is complete and idempotent.
 *
 * Resolution order per reference:
 *   1. `<root>/icons/<name>.svg` (extension-owned artwork under the same relative path)
 *   2. `<sharedIconDir>/<name>.svg` (shared line-icon library)
 * The extension-level `icon.svg` goes to the deployed extension root (the host resolves
 * it relative to the extension directory).
 *
 * Unresolvable references are reported and skipped — a missing icon must never fail a
 * deploy.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** `icons/<name>.svg` references inside a text file (source, client bundle, manifest). */
const ICON_REF_RE = /\bicons\/([A-Za-z0-9_.@-]+\.svg)\b/g;

/** Directories scanned for icon references (relative to the extension root). */
const REF_SOURCE_DIRS = ["client/src", "dist"];

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      walkFiles(p, out);
    } else if (/\.(m?js|ts|tsx|json)$/.test(entry.name)) {
      // Test files carry fixture icon names that must never be deployed: skip them.
      if (/\.test\.(m?js|ts|tsx)$/.test(entry.name) || /(^|\/)(tests?|__tests__)\//.test(p)) continue;
      out.push(p);
    }
  }
  return out;
}

/**
 * Collect the icon file names an extension references.
 * @param {string} root extension source directory
 * @returns {Set<string>} icon file names (e.g. "key-round.svg")
 */
export function collectIconRefs(root) {
  const names = new Set();
  const files = [join(root, "index.ts"), ...REF_SOURCE_DIRS.flatMap((d) => walkFiles(join(root, d)))];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(ICON_REF_RE)) names.add(m[1]);
  }
  return names;
}

/**
 * Copy the icons referenced by one extension into its deployed directories.
 *
 * @param {object} opts
 * @param {string} opts.root extension source directory
 * @param {string} [opts.extId] extension id (log prefix only)
 * @param {string[]} opts.targets deployed extension directories
 * @param {string} opts.sharedIconDir shared `icons/` directory (fallback source)
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ provenance: string[], copied: string[], missing: string[] }}
 */
export function syncExtIcons({ root, extId = root, targets, sharedIconDir, log }) {
  const say = typeof log === "function" ? log : () => {};
  const provenance = [];
  const copied = [];
  const missing = [];
  if (!root || !Array.isArray(targets) || targets.length === 0) return { provenance, copied, missing };
  if (!existsSync(root) || !statSync(root).isDirectory()) return { provenance, copied, missing };

  // Extension-level icon (served from the extension root, not from icons/).
  const extIcon = join(root, "icon.svg");
  if (existsSync(extIcon)) {
    for (const target of targets) {
      try {
        mkdirSync(target, { recursive: true });
        copyFileSync(extIcon, join(target, "icon.svg"));
        provenance.push(`${extId}: icon.svg`);
      } catch {
        /* best effort */
      }
    }
  }

  for (const name of collectIconRefs(root)) {
    const sources = [join(root, "icons", name)];
    if (sharedIconDir) sources.push(join(sharedIconDir, name));
    const src = sources.find((p) => existsSync(p));
    if (!src) {
      missing.push(name);
      say(`${extId}: icon referenced but not found (extension dir / shared library): icons/${name}`);
      continue;
    }
    for (const target of targets) {
      try {
        mkdirSync(join(target, "icons"), { recursive: true });
        copyFileSync(src, join(target, "icons", name));
        provenance.push(`${extId}: icons/${name}`);
        copied.push(name);
      } catch (e) {
        say(`${extId}: icon copy failed for icons/${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { provenance, copied, missing };
}
