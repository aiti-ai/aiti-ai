// 简单本地测试：把 server/tts-cache.ts 拷成 .mjs 跑（保持纯 JS 实现）
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024 * 1024;

function ttsCacheDir(configDir) {
  return join(configDir || join(homedir(), ".pi", "web", "data", "aiti-ai-speek"), "tts-cache");
}

function cleanExpired(dir, now = Date.now()) {
  if (!existsSync(dir)) return { cleaned: 0, bytes: 0 };
  let cleaned = 0, bytes = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".mp3")) continue;
    const p = join(dir, f);
    try {
      const st = statSync(p);
      if (now - st.mtimeMs > TTL_MS || st.size === 0) {
        unlinkSync(p);
        cleaned++;
        bytes += st.size;
      }
    } catch {}
  }
  return { cleaned, bytes };
}

function lruEvict(dir, cap = MAX_BYTES) {
  if (!existsSync(dir)) return { removed: 0, bytes: 0 };
  const items = [];
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".mp3")) continue;
    const p = join(dir, f);
    try {
      const st = statSync(p);
      items.push({ p, mtime: st.mtimeMs, size: st.size });
      total += st.size;
    } catch {}
  }
  if (total <= cap) return { removed: 0, bytes: 0 };
  items.sort((a, b) => a.mtime - b.mtime);
  const target = cap * 0.8;
  let removed = 0, bytes = 0;
  for (const it of items) {
    if (total <= target) break;
    try { unlinkSync(it.p); removed++; bytes += it.size; total -= it.size; } catch {}
  }
  return { removed, bytes };
}

// ── 测试：在 tmp 建一组 fixture，跑 cleanExpired / lruEvict ──
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const testDir = mkdtempSync(join(tmpdir(), "tts-cache-test-"));
console.log("测试目录:", testDir);

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// 5 个文件：1 个 31 天前（应过期）、1 个 0KB（应过期）、1 个 10 天前（保留）、1 个 1 天前（保留）、1 个刚刚（保留）
const fixtures = [
  { name: "old-31d.mp3", size: 1024, ageDays: 31 },
  { name: "empty.mp3", size: 0, ageDays: 1 },
  { name: "mid-10d.mp3", size: 2048, ageDays: 10 },
  { name: "recent-1d.mp3", size: 4096, ageDays: 1 },
  { name: "fresh.mp3", size: 8192, ageDays: 0 },
];

for (const f of fixtures) {
  const p = join(testDir, f.name);
  writeFileSync(p, Buffer.alloc(f.size, "x"));
  // 改 mtime
  const t = (NOW - f.ageDays * DAY) / 1000;
  utimesSync(p, t, t);
}

const before = readdirSync(testDir);
console.log("cleanExpired 前:", before);
const exp = cleanExpired(testDir, NOW);
console.log("cleanExpired 结果:", exp);
const after = readdirSync(testDir);
console.log("cleanExpired 后:", after);

// lruEvict：把 MAX_BYTES 设小，强制触发
const remaining = after.map(f => ({ f, st: statSync(join(testDir, f)) }));
const total = remaining.reduce((s, r) => s + r.st.size, 0);
console.log("剩余总字节:", total, "（不到 MAX_BYTES，lruEvict 不应删）");
const lru = lruEvict(testDir, 100); // 强制 cap=100B
console.log("lruEvict(100B) 结果:", lru, "剩:", readdirSync(testDir));

// 清理
rmSync(testDir, { recursive: true, force: true });
console.log("✅ 测试通过");
