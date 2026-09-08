/**
 * Core data contract handed to extensions (ExtServerContext.core).
 *
 * Kept behind explicit functions so extensions never re-implement session
 * reading, running-state tracking, home resolution, or file-access rules —
 * and so the underlying implementations can evolve (e.g. the incremental
 * list cache) without breaking extensions.
 */
import { homedir } from "os";
import { listAllSessions, resolveSessionPath, getSessionEntries, buildSessionContext } from "../session-reader.ts";
import { getRunningRpcSessionIds, getAliveRpcSessionIds, stopIdleRpcSession } from "../rpc-manager.ts";
import { allowFileRoot, getAllowedFileRoots, isFilePathAllowed } from "../file-access.ts";
import { readModelsConfig, writeModelsConfig } from "../models-config-store.ts";
import { readLiveHandleSession } from "./core-live-session.ts";
import type { ExtCoreApi } from "./types.ts";

export { readLiveHandleSession };

export function makeExtCore(): ExtCoreApi {
  return {
    async listSessions(options?: { refresh?: boolean }) {
      return listAllSessions(options?.refresh ? { force: true } : {});
    },
    async getRunningSessionIds() {
      return getRunningRpcSessionIds();
    },
    async getAliveSessionIds() {
      return getAliveRpcSessionIds();
    },
    async stopAliveSession(id) {
      return stopIdleRpcSession(id);
    },
    async getHomeDir() {
      return homedir();
    },
    async readSession(id) {
      const path = await resolveSessionPath(id);
      if (path) {
        try {
          const entries = getSessionEntries(path);
          return buildSessionContext(entries);
        } catch {
          return null;
        }
      }
      // 外部后端会话（zcode/codex/…）无 pi 会话文件——回退到活 handle 的内存历史
      //（getMessages capability），适配成 {messages, entryIds} 文件形态供扩展零改动消费
      //（ai-speek 跟读等按文件形态 readSession 的消费方）。
      return readLiveHandleSession(id);
    },
    async readModelsConfig() {
      return readModelsConfig();
    },
    async writeModelsConfig(data) {
      writeModelsConfig(data);
    },
    fileAccess: {
      allowRoot(root) {
        allowFileRoot(root);
      },
      async isAllowed(p) {
        const roots = await getAllowedFileRoots();
        return isFilePathAllowed(p, roots);
      },
    },
  };
}
