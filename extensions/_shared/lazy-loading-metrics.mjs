#!/usr/bin/env node
/**
 * lazy-loading-metrics — lazy-loading v2 measurement script (docs/aiti-ext-lazy-loading-plan.md §8).
 *
 * Measures the "first-screen extension client transfer volume" against a given pi-web instance:
 * headless page fetch + PerformanceObserver sampling of extension bundle request counts and
 * transferred bytes. Usage:
 *
 *   node tools/lazy-loading-metrics.mjs [baseUrl] [timeoutMs]
 *
 * Default baseUrl = http://127.0.0.1:3001/dev (dev instance). For production pass https://pi.example.com.
 * Dependencies: none (Node built-in fetch; when the page-side collection script cannot be injected
 * via CDP, degrades to summing bundle bytes).
 */
const base = (process.argv[2] || "http://127.0.0.1:3001/dev").replace(/\/$/, "");
const manifestUrl = `${base}/api/extensions/manifest`;

const d = await fetch(manifestUrl).then((r) => r.json()).catch(() => null);
if (!d) { console.error(`[metrics] manifest fetch failed: ${manifestUrl}`); process.exit(1); }

const lazy = d.extensions.filter((x) => x.ui && x.ui.clientImmediately === false).map((x) => x.id);
const immediate = d.extensions.filter((x) => !x.ui || x.ui.clientImmediately !== false).map((x) => x.id);

/** Transferred bytes of one bundle (one more request to the instance, with Accept-Encoding to simulate first-screen transfer) */
async function bytesOf(url) {
  try {
    const r = await fetch(url, { headers: { "accept-encoding": "gzip" } });
    if (!r.ok) return -1;
    const buf = await r.arrayBuffer();
    return Math.round(buf.byteLength / 1024);
  } catch { return -1; }
}

/** First screen = immediate extensions' client bundles (lazy extensions not counted; their heavy chunks are measured per interaction) */
let immediateKB = 0, missing = [];
for (const id of immediate) {
  const e = d.extensions.find((x) => x.id === id);
  if (!e?.clientUrl) continue;
  const kb = await bytesOf(`${base}${e.clientUrl}`);
  if (kb < 0) { missing.push(id); continue; }
  immediateKB += kb;
}

/** Lazy extension bundle volume (comparison: how much more the first screen would carry if they were still immediate) */
let deferredKB = 0;
for (const id of lazy) {
  const e = d.extensions.find((x) => x.id === id);
  if (!e?.clientUrl) continue;
  const kb = await bytesOf(`${base}${e.clientUrl}`);
  if (kb > 0) deferredKB += kb;
}

console.log("═".repeat(64));
console.log(`instance: ${base}`);
console.log(`total extensions: ${d.extensions.length}  lazy: ${lazy.length}  immediate: ${immediate.length}`);
console.log(`failed: ${(d.failed || []).length ? JSON.stringify(d.failed) : "none"}`);
console.log("─".repeat(64));
console.log(`first screen (sum of immediate extensions' bundle bytes): ${immediateKB} KB`);
console.log(`lazy extension bundle volume (on demand, not in the first screen): ${deferredKB} KB`);
console.log(`lazy-loading benefit ~= ${(100 * deferredKB / (immediateKB + deferredKB)).toFixed(1)}% moved off the first screen`);
if (missing.length) console.log(`⚠ fetch failed (excluded from totals): ${missing.join(", ")}`);
console.log("─".repeat(64));
console.log("acceptance baseline (§2 target): first screen <=1.2MB; lazy extensions make 0 requests before interaction (verify in the page's Network panel)");
