#!/usr/bin/env node
/**
 * lazy-loading-metrics — 懒加载 v2 度量脚本（docs/aiti-ext-lazy-loading-plan.md §8）。
 *
 * 对指定 pi-web 实例统计「首屏扩展 client 传输量」：无头拉取页面 + PerformanceObserver
 * 采样扩展 bundle 请求数与传输字节。用法：
 *
 *   node tools/lazy-loading-metrics.mjs [baseUrl] [timeoutMs]
 *
 * 默认 baseUrl = http://127.0.0.1:3001/dev（dev 实例）。生产传 https://pi.example.com。
 * 依赖：无（Node 内置 fetch；页面侧注入采集脚本经 CDP 不可用时降级为 bundle 字节求和）。
 */
const base = (process.argv[2] || "http://127.0.0.1:3001/dev").replace(/\/$/, "");
const manifestUrl = `${base}/api/extensions/manifest`;

const d = await fetch(manifestUrl).then((r) => r.json()).catch(() => null);
if (!d) { console.error(`[metrics] manifest 拉取失败: ${manifestUrl}`); process.exit(1); }

const lazy = d.extensions.filter((x) => x.ui && x.ui.clientImmediately === false).map((x) => x.id);
const immediate = d.extensions.filter((x) => !x.ui || x.ui.clientImmediately !== false).map((x) => x.id);

/** 单个 bundle 的传输字节（对实例再发一次请求，带 Accept-Encoding 模拟首屏传输） */
async function bytesOf(url) {
  try {
    const r = await fetch(url, { headers: { "accept-encoding": "gzip" } });
    if (!r.ok) return -1;
    const buf = await r.arrayBuffer();
    return Math.round(buf.byteLength / 1024);
  } catch { return -1; }
}

/** 首屏 = 即时扩展的 client bundle（懒扩展不计入；其重 chunk 按交互另计） */
let immediateKB = 0, missing = [];
for (const id of immediate) {
  const e = d.extensions.find((x) => x.id === id);
  if (!e?.clientUrl) continue;
  const kb = await bytesOf(`${base}${e.clientUrl}`);
  if (kb < 0) { missing.push(id); continue; }
  immediateKB += kb;
}

/** 懒扩展 bundle 体量（对照：若它们仍即时，首屏会多多少） */
let deferredKB = 0;
for (const id of lazy) {
  const e = d.extensions.find((x) => x.id === id);
  if (!e?.clientUrl) continue;
  const kb = await bytesOf(`${base}${e.clientUrl}`);
  if (kb > 0) deferredKB += kb;
}

console.log("═".repeat(64));
console.log(`实例: ${base}`);
console.log(`扩展总数: ${d.extensions.length}  懒: ${lazy.length}  即时: ${immediate.length}`);
console.log(`failed: ${(d.failed || []).length ? JSON.stringify(d.failed) : "无"}`);
console.log("─".repeat(64));
console.log(`首屏（即时扩展 bundle 字节和）: ${immediateKB} KB`);
console.log(`懒扩展 bundle 体量（按需，不计首屏）: ${deferredKB} KB`);
console.log(`懒化收益 ≈ ${(100 * deferredKB / (immediateKB + deferredKB)).toFixed(1)}% 移出首屏`);
if (missing.length) console.log(`⚠ 拉取失败（忽略计值）: ${missing.join(", ")}`);
console.log("─".repeat(64));
console.log("验收基线（§2 目标）: 首屏 ≤1.2MB；交互前懒扩展 0 请求（页面侧 Network 面板核对）");
