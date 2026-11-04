// 在真实目录 dry-run 一次，看会删多少（不改文件）
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 1024 * 1024 * 1024;
const dir = join(homedir(), ".pi", "web", "data", "aiti-ai-speek", "tts-cache");

if (!existsSync(dir)) { console.log("目录不存在"); process.exit(0); }

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

let totalCount = 0, totalBytes = 0, expiredCount = 0, expiredBytes = 0, emptyCount = 0;
const ages = [];

for (const f of readdirSync(dir)) {
  if (!f.endsWith(".mp3")) continue;
  const st = statSync(join(dir, f));
  totalCount++;
  totalBytes += st.size;
  if (st.size === 0) { emptyCount++; continue; }
  const ageDays = (NOW - st.mtimeMs) / DAY;
  ages.push(ageDays);
  if (st.mtimeMs - NOW < -TTL_MS) { expiredCount++; expiredBytes += st.size; }
}

ages.sort((a, b) => a - b);
console.log("=== 真实缓存统计 ===");
console.log(`目录: ${dir}`);
console.log(`文件数: ${totalCount} (空 0KB 文件: ${emptyCount})`);
console.log(`总大小: ${(totalBytes / 1048576).toFixed(2)} MB / 1024 MB (${((totalBytes / MAX_BYTES) * 100).toFixed(2)}%)`);
console.log(`过 30 天: ${expiredCount} 个（${(expiredBytes / 1048576).toFixed(2)} MB）`);
if (ages.length) {
  console.log(`mtime 年龄: 最旧=${ages[0].toFixed(1)}d, p25=${ages[Math.floor(ages.length*0.25)].toFixed(1)}d, p50=${ages[Math.floor(ages.length*0.5)].toFixed(1)}d, p75=${ages[Math.floor(ages.length*0.75)].toFixed(1)}d, 最新=${ages[ages.length-1].toFixed(1)}d`);
}

if (totalBytes > MAX_BYTES) {
  const items = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".mp3")) continue;
    try { const st = statSync(join(dir, f)); items.push({ p: join(dir, f), mtime: st.mtimeMs, size: st.size }); } catch {}
  }
  items.sort((a, b) => a.mtime - b.mtime);
  const target = MAX_BYTES * 0.8;
  let total = totalBytes, removed = 0, bytes = 0;
  for (const it of items) {
    if (total <= target) break;
    total -= it.size; removed++; bytes += it.size;
  }
  console.log(`\n超容 LRU dry-run: 会删 ${removed} 个（${(bytes/1048576).toFixed(2)} MB）→ 剩余 ${(total/1048576).toFixed(2)} MB`);
} else {
  console.log(`\n未超容，不触发 LRU（剩余 ${((MAX_BYTES - totalBytes) / 1048576).toFixed(0)} MB 缓冲）`);
}
