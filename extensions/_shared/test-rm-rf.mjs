/**
 * test-rm-rf — Windows-friendly test temp-directory cleanup.
 *
 * On Windows, rmSync hits EPERM/ENOTEMPTY when the target tree still holds open handles
 * (node:sqlite WAL, transient AV/indexer locks); POSIX has no such problem. This helper first closes
 * the session-manager runtime index handle (optional), then retries the deletion with backoff
 * (200ms×5). Failures still throw — swallowing them silently would turn "cleanup failed" into
 * "dirty state between test cases".
 *
 * Usage:
 *   import { rmRf } from "@aiti-ai/ext-shared/test-rm-rf";
 *   finally { await rmRf(dir); }        // general case
 *   finally { await rmRf(dir, true); }  // when the directory holds a session-manager runtime index
 */
import { rmSync } from "node:fs";

export async function rmRf(p, opts = {}) {
  if (opts.closeSessionIndex) {
    try {
      const { runtime } = await import("../session-manager/server/runtime.ts");
      runtime(opts.sessionIndexConfigDir ?? p).index.close();
    } catch { /* runtime never created / already closed — ignore */ }
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
