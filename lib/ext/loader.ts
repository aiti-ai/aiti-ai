/**
 * Extension loader — scans the extensions root and loads each extension entry
 * with jiti (TypeScript transpilation, same mechanism the pi TUI uses).
 */
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { createJiti } from "jiti";
import type { PiWebExtension } from "./types.ts";

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

/** Load one extension directory into a PiWebExtension object (default export). */
export async function loadExtensionFromDir(dir: string): Promise<PiWebExtension | null> {
  const entry = resolveExtensionEntry(dir);
  if (!entry) return null;
  // moduleCache: false so POST /api/extensions/reload picks up code changes.
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const mod = (await jiti.import(pathToFileURL(entry).href)) as unknown;
  const ext = (mod as { default?: unknown } | undefined)?.default ?? mod;
  if (!ext || typeof ext !== "object") return null;
  const candidate = ext as Partial<PiWebExtension>;
  if (typeof candidate.id !== "string" || !candidate.id) return null;
  return candidate as PiWebExtension;
}
