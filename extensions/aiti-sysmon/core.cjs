/**
 * aiti-sysmon · core.cjs — pure formatting / cache helpers (zero deps, unit-testable
 * without systeminformation). index.ts keeps all si I/O; the client bundle imports the
 * same formatters from here (vite bundles the CJS file in).
 */

/** Bytes → human string with binary units; invalid/negative input renders as an em dash. */
function fmtBytes(n, digits) {
  if (n == null || !isFinite(Number(n)) || Number(n) < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const d = digits == null ? (v >= 100 ? 0 : 1) : digits;
  return (i === 0 ? String(Math.round(v)) : v.toFixed(d)) + " " + units[i];
}

/** Bytes/sec → human rate string (fmtBytes + "/s"). */
function fmtRate(nPerSec) {
  if (nPerSec == null || !isFinite(Number(nPerSec)) || Number(nPerSec) < 0) return "—";
  return fmtBytes(nPerSec) + "/s";
}

/** Seconds → compact uptime: "2d 3h" / "5h 3m" / "42s"; invalid input renders as an em dash. */
function fmtUptime(sec) {
  const s = Number(sec);
  if (sec == null || !isFinite(s) || s < 0) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + m + "m";
  return Math.floor(s) + "s";
}

/** Celsius reading → displayable integer temp, or null when the platform reports none
 *  (systeminformation yields -1 / NaN / 0 on unsupported platforms). Range sanity: (0, 150). */
function pickTemp(main) {
  const n = Number(main);
  return Number.isFinite(n) && n > 0 && n < 150 ? Math.round(n) : null;
}

/** Fixed-cap ring push for client-side sparkline history (returns the same array). */
function histPush(arr, v, cap) {
  const limit = cap == null ? 60 : cap;
  arr.push(v);
  while (arr.length > limit) arr.shift();
  return arr;
}

/** Clamp a percent value into 0..100; null/NaN collapses to 0. */
function pct(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

/** Minimal TTL cache for slow-changing snapshot sections (fsSize, osInfo, temperature). */
class TTLCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) { this.map.delete(key); return undefined; }
    return hit.value;
  }
  set(key, value) {
    this.map.set(key, { at: Date.now(), value });
    return value;
  }
  clear() { this.map.clear(); }
}

module.exports = { fmtBytes, fmtRate, fmtUptime, pickTemp, histPush, pct, TTLCache };
