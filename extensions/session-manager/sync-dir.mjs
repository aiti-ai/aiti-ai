/**
 * rsync 式目录同步（纯 node 零依赖，跨平台 win/linux/mac 通用）。
 *
 * syncDir(src, dst, { del, exclude, keepHashedMs }) — 把 src 增量同步到 dst：
 *   - 目标不存在或 (mtimeMs, size) 不同才拷贝（增量跳过相同文件）
 *   - del: true 时删除 dst 里 src 没有的多余文件/目录（rsync --delete 语义）；
 *     被进程占用的文件删除/覆盖失败仅警告跳过，**不中断**（Windows 文件锁友好）
 *   - exclude(rel): 排除规则，rel 为相对 srcDir 的路径（统一 / 分隔）；
 *     exclude 的条目不拷贝、delete 时也不删（保护部署目录里 npm install 出的 node_modules 等）
 *   - delGraceMs（缺省 6h，仅 del:true 生效）: dst 独有文件的 mtime 在窗内不删。动机：vite
 *     懒 chunk 是**点击时才 import**，而部署把上一轮 chunk 直接 --delete 掉 → 部署前打开的
 *     页面点入口（如 All Sessions）拉旧 chunk 名 404 → 面板「打不开」，顶栏点了没反应
 *     （实证 2026-09-22：dev 并发部署后 sessions-panel-BjL2YIya.js 404，用户报「全部会话
 *     无法打开了」）。文件 mtime = 部署拷贝时刻（copyFileSync 不保留源 mtime），故窗内 =
 *     最近一次部署留下的产物，超窗才清理（磁盘不无限增长）。传 0 恢复立即删。
 *
 * 部署场景用法（替代「rmSync 整目录 + 全量重拷」）：
 *   import { syncDir } from "../../_shared/sync-dir.mjs";
 *   const st = syncDir(resolve(root, "dist"), resolve(dest, "dist"), { del: true });
 *   // st = { copied, skipped, deleted, kept }
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";

/** 残留保留窗（ms，仅 del:true 生效）：窗内（= 最近一轮部署拷进来的）残留不删，理由见文件头。 */
const DEL_GRACE_MS = 6 * 3600 * 1000;

function copyChunk(src, dst) {
  try {
    copyFileSync(src, dst);
    return true;
  } catch {
    // Windows 上目标被占用覆盖失败：先改名挪开旧文件再拷（rename 对已打开句柄通常可行）
    try {
      renameSync(dst, dst + ".old-" + Date.now());
      copyFileSync(src, dst);
      return true;
    } catch {
      console.warn("[sync-dir] 跳过被占用文件: " + dst);
      return false;
    }
  }
}

export function syncDir(srcDir, dstDir, { del = false, exclude = null, delGraceMs = DEL_GRACE_MS } = {}) {
  let copied = 0, skipped = 0, deleted = 0, kept = 0;
  const relOf = (parentRel, name) => (parentRel ? parentRel + "/" + name : name);
  const walk = (src, dst, rel) => {
    mkdirSync(dst, { recursive: true });
    const names = new Set();
    for (const name of readdirSync(src)) {
      if (exclude && exclude(relOf(rel, name))) continue;
      names.add(name);
    }
    // src → dst：新增/变更才拷
    for (const name of names) {
      const s = join(src, name), d = join(dst, name);
      const st = statSync(s);
      if (st.isDirectory()) { walk(s, d, relOf(rel, name)); continue; }
      let same = false;
      try {
        const dt = statSync(d);
        same = dt.size === st.size && dt.mtimeMs === st.mtimeMs;
      } catch { /* dst 无此文件 */ }
      if (same) { skipped++; continue; }
      if (copyChunk(s, d)) copied++;
    }
    // dst 清理 src 没有的（--delete；exclude 条目保护不删）
    if (del) {
      for (const name of readdirSync(dst)) {
        if (names.has(name)) continue;
        if (exclude && exclude(relOf(rel, name))) continue;
        const d = join(dst, name);
        if (delGraceMs > 0) {
          let age = Infinity;
          try { age = Date.now() - statSync(d).mtimeMs; } catch { /* 读不到按最老处理，照删 */ }
          if (age < delGraceMs) { kept++; continue; } // 上轮部署的产物：在网页面还可能指着
        }
        try {
          rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
          deleted++;
        } catch {
          console.warn("[sync-dir] 多余文件删除失败（被占用？）: " + d);
        }
      }
    }
  };
  if (!existsSync(srcDir)) throw new Error("syncDir: 源目录不存在 " + srcDir);
  walk(srcDir, dstDir, "");
  return { copied, skipped, deleted, kept };
}
