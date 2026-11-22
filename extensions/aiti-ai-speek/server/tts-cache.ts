/**
 * tts-cache —— synthesized audio file cache (edge-tts mp3 + local wav)
 *
 * Design: single flat directory, file name = content hash.
 *   - hit  -> readFile the audio back
 *   - miss -> synthesize, write, then read back (file is closed on write completion)
 *
 * Multiple formats live side by side (.mp3 for edge-tts and mp3 fallback, .wav for the local
 * engine). Cleanup/statistics iterate every supported extension so old mp3 files keep being
 * reclaimed after the local engine shows up.
 *
 * Capacity policy (mtime semantics: write time = "last synthesis", which is equivalent to LRU
 * for never-rewritten cache files):
 *   - TTL_MS: mtime older than 30 days is expired (cleanExpired)
 *   - MAX_BYTES: over 1 GB -> delete oldest by mtime down to 80% (lruEvict)
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MAX_BYTES = 1024 * 1024 * 1024;     // 1 GB

/** Cache file extensions in use (edge-tts mp3, local engine wav/mp3). */
export const CACHE_EXTS = [".mp3", ".wav"] as const;

export function ttsCacheDir(configDir?: string): string {
  // PI_WEB_DATA_DIR first (Docker/Windows data root independent of ~/.pi); unset = ~/.pi/web/data
  return join(configDir || join(process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi", "web", "data"), "aiti-ai-speek"), "cache", "tts-cache");
}

/** Cache area root (`<configDir>/cache`): venv/models/logs for the local service live here. */
export function cacheRoot(configDir?: string): string {
  return join(dirname(configDir || join(process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi", "web", "data"), "aiti-ai-speek")), "cache");
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

export function isCacheFile(name: string): boolean {
  return (CACHE_EXTS as readonly string[]).some((ext) => name.endsWith(ext));
}

export function contentTypeOf(file: string): string {
  return file.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
}

/** Locate a cached file by content hash across all supported extensions. */
export function findCacheFile(dir: string, key: string): { file: string; ext: string } | null {
  for (const ext of CACHE_EXTS) {
    const file = join(dir, key + ext);
    if (existsSync(file)) return { file, ext };
  }
  return null;
}

/** Delete cache files whose mtime exceeds TTL_MS (also drops 0-byte corrupt entries). */
export function cleanExpired(dir: string, now = Date.now()): { cleaned: number; bytes: number } {
  if (!existsSync(dir)) return { cleaned: 0, bytes: 0 };
  let cleaned = 0, bytes = 0;
  for (const f of readdirSync(dir)) {
    if (!isCacheFile(f)) continue;
    const p = join(dir, f);
    try {
      const st = statSync(p);
      if (now - st.mtimeMs > TTL_MS || st.size === 0) {
        unlinkSync(p);
        cleaned++;
        bytes += st.size;
      }
    } catch { /* single-file failure is ignored */ }
  }
  return { cleaned, bytes };
}

/** Over MAX_BYTES -> delete oldest by mtime down to 80%. */
export function lruEvict(dir: string, cap = MAX_BYTES): { removed: number; bytes: number } {
  if (!existsSync(dir)) return { removed: 0, bytes: 0 };
  const items: { p: string; mtime: number; size: number }[] = [];
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!isCacheFile(f)) continue;
    const p = join(dir, f);
    try {
      const st = statSync(p);
      items.push({ p, mtime: st.mtimeMs, size: st.size });
      total += st.size;
    } catch { /* skip */ }
  }
  if (total <= cap) return { removed: 0, bytes: 0 };
  items.sort((a, b) => a.mtime - b.mtime);
  const target = cap * 0.8;
  let removed = 0, bytes = 0;
  for (const it of items) {
    if (total <= target) break;
    try { unlinkSync(it.p); removed++; bytes += it.size; total -= it.size; } catch { /* skip */ }
  }
  return { removed, bytes };
}

/** Cache statistics (files + bytes across all formats). */
export function cacheStats(dir: string): { count: number; bytes: number; byExt: Record<string, number> } {
  const out = { count: 0, bytes: 0, byExt: { ".mp3": 0, ".wav": 0 } as Record<string, number> };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!isCacheFile(f)) continue;
    try {
      const st = statSync(join(dir, f));
      out.count++;
      out.bytes += st.size;
      const ext = f.endsWith(".wav") ? ".wav" : ".mp3";
      out.byExt[ext] = (out.byExt[ext] || 0) + 1;
    } catch { /* skip */ }
  }
  return out;
}

/** Startup cleanup (async, non-blocking): expire + over-capacity sweep. */
export async function startupCleanup(configDir?: string): Promise<void> {
  const dir = ttsCacheDir(configDir);
  if (!existsSync(dir)) return;
  // setImmediate yields the main thread; a worker would just serialize the same fs calls.
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    const exp = cleanExpired(dir);
    const lru = lruEvict(dir);
    if (exp.cleaned || lru.removed) {
      console.log(`[aiti-ai-speek] tts-cache cleanup: expired ${exp.cleaned} (${(exp.bytes / 1024 / 1024).toFixed(2)}MB) + LRU ${lru.removed} (${(lru.bytes / 1024 / 1024).toFixed(2)}MB)`);
    }
  } catch (e) {
    console.warn("[aiti-ai-speek] tts-cache startup cleanup failed:", e);
  }
}

export { mkdirSync };
