/**
 * test-rm-rf —— Windows 友好的测试临时目录清理。
 *
 * Windows 上 rmSync 目标树里若有未关闭句柄（node:sqlite WAL、AV/索引器瞬时锁）会
 * EPERM/ENOTEMPTY；POSIX 无此问题。本助手：closeIndex(dir) 先关 session-manager
 * runtime 索引句柄（可选），然后带退避重试删除（200ms×5）。失败照抛——静默吞掉会把
 * 「清理失败」变成「用例间脏状态」。
 *
 * 用法：
 *   import { rmRf } from "../../_shared/test-rm-rf.mjs";
 *   finally { await rmRf(dir); }        // 一般场景
 *   finally { await rmRf(dir, true); }  // 该目录若含 session-manager runtime 索引
 */
import { rmSync } from "node:fs";

export async function rmRf(p, opts = {}) {
  if (opts.closeSessionIndex) {
    try {
      const { runtime } = await import("../session-manager/server/runtime.ts");
      runtime(opts.sessionIndexConfigDir ?? p).index.close();
    } catch { /* 没建过 runtime/已关——忽略 */ }
  }
  for (let i = 0; ; i++) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (e) {
      const retriable = e && ["EPERM", "ENOTEMPTY", "EACCES"].includes(e.code);
      if (!retriable || i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
}
