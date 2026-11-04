/**
 * tts-cache —— edge-tts mp3 文件缓存治理
 *
 * 设计：单层目录 + 文件名即内容 hash（sha256(voice|rate|text)）。
 *   - key 命中：直接 readFile 回 mp3
 *   - 未命中：合成 → 写盘 → 落盘后再读回（写完 file 已 close）
 *
 * 容量治理（mtime 语义，单平台 Linux，无需识别 windows）：
 *   - TTL_MS：mtime 超 30 天视为过期（cleanExpired 删除）
 *   - MAX_BYTES：总字节超 1GB 时按 mtime 升序删最旧（lruEvict，删到 80% 缓冲）
 *   - 启动时在 worker thread 跑一次（cleanExpired + lruEvict），不阻塞 pi-web
 *
 * 为什么 mtime：单平台、写入时间即"最近一次合成时间"；合成文件不会被覆写，
 *   mtime 随合成刷新；与 LRU 等价（用户最久没"听到"的语音，往往是合成时间最早的）。
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
export const MAX_BYTES = 1024 * 1024 * 1024;     // 1 GB

export function ttsCacheDir(configDir?: string): string {
  // PI_WEB_DATA_DIR 优先（Docker/Windows 数据根独立于 ~/.pi）；未设 = ~/.pi/web/data 原行为
  return join(configDir || join(process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi", "web", "data"), "aiti-ai-speek"), "cache", "tts-cache");
}

/** 删 mtime > TTL_MS 的 .mp3 残留（含 0KB 损坏文件） */
export function cleanExpired(dir: string, now = Date.now()): { cleaned: number; bytes: number } {
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
    } catch { /* 单文件失败忽略 */ }
  }
  return { cleaned, bytes };
}

/** 总字节超 MAX_BYTES 时按 mtime 升序删最旧（删到 80% 缓冲） */
export function lruEvict(dir: string, cap = MAX_BYTES): { removed: number; bytes: number } {
  if (!existsSync(dir)) return { removed: 0, bytes: 0 };
  const items: { p: string; mtime: number; size: number }[] = [];
  let total = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".mp3")) continue;
    const p = join(dir, f);
    try {
      const st = statSync(p);
      items.push({ p, mtime: st.mtimeMs, size: st.size });
      total += st.size;
    } catch { /* skip */ }
  }
  if (total <= cap) return { removed: 0, bytes: 0 };
  items.sort((a, b) => a.mtime - b.mtime);
  const target = cap * 0.8; // 删到 80% 留缓冲
  let removed = 0, bytes = 0;
  for (const it of items) {
    if (total <= target) break;
    try { unlinkSync(it.p); removed++; bytes += it.size; total -= it.size; } catch { /* skip */ }
  }
  return { removed, bytes };
}

/** 启动时跑一次（异步，不阻塞）：过期 + 超容清理 */
export async function startupCleanup(configDir?: string): Promise<void> {
  const dir = ttsCacheDir(configDir);
  if (!existsSync(dir)) return;
  // 用 setImmediate 让出主线程；用 worker 反而要序列化 fs 操作，不划算
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    const exp = cleanExpired(dir);
    const lru = lruEvict(dir);
    if (exp.cleaned || lru.removed) {
      console.log(`[aiti-ai-speek] tts-cache 清理：过期 ${exp.cleaned} 个（${(exp.bytes/1024/1024).toFixed(2)}MB）+ 超容 LRU ${lru.removed} 个（${(lru.bytes/1024/1024).toFixed(2)}MB）`);
    }
  } catch (e) {
    console.warn(`[aiti-ai-speek] tts-cache 启动清理失败:`, e);
  }
}
