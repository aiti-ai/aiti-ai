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
import { getHandle, putHandleAt, rebindHandle } from "../session/handle-store.ts";
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
          // File-form parse failed → continue with the live handle fallback
        }
      }
      // External-backend sessions (zcode/codex/…) have no pi session file — fall back to the
      // live handle's in-memory history (getMessages capability), adapted into the {messages,
      // entryIds} file form so consumers reading sessions in file form (ai-speek follow-read
      // etc.) consume them with zero changes.
      return readLiveHandleSession(id);
    },
    async readModelsConfig() {
      return readModelsConfig();
    },
    async writeModelsConfig(data) {
      writeModelsConfig(data);
    },
    rebindSessionBackend(oldId: string, newId: string): boolean {
      // A03/B4: once the real id is read back, attach an alias key to the handle (the old
      // placeholder key stays — draft rows and existing references keep working). If newId is
      // already taken by another handle → reject (no clobbering); unusable oldId → false.
      if (!oldId || !newId || oldId === newId) return false;
      const h = getHandle(oldId);
      if (!h) return false;
      if (getHandle(newId)) return false;
      putHandleAt(newId, h);
      return true;
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
