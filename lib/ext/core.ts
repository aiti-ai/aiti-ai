/**
 * Core data contract handed to extensions (ExtServerContext.core).
 *
 * Kept behind explicit functions so extensions never re-implement session
 * reading, running-state tracking, home resolution, or file-access rules —
 * and so the underlying implementations can evolve (e.g. the incremental
 * list cache) without breaking extensions.
 */
import { homedir } from "os";
import { listAllSessions, resolveSessionPath, getSessionEntries, buildSessionContext } from "@/lib/session-reader.ts";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager.ts";
import { allowFileRoot, getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access.ts";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store.ts";
import type { ExtCoreApi } from "./types.ts";

export function makeExtCore(): ExtCoreApi {
  return {
    async listSessions() {
      return listAllSessions();
    },
    async getRunningSessionIds() {
      return getRunningRpcSessionIds();
    },
    async getHomeDir() {
      return homedir();
    },
    async readSession(id) {
      const path = await resolveSessionPath(id);
      if (!path) return null;
      try {
        const entries = getSessionEntries(path);
        return buildSessionContext(entries);
      } catch {
        return null;
      }
    },
    async readModelsConfig() {
      return readModelsConfig();
    },
    async writeModelsConfig(data) {
      writeModelsConfig(data);
    },
    refreshProxies(providerId?: string) {
      // pi-models-respect 把 refresh 入口挂到 globalThis.__piModelsRespect.refresh；
      // 未装载（没配该扩展）时静默返回空。
      try {
        const g = globalThis as any;
        const fn = g.__piModelsRespect?.refresh;
        if (typeof fn !== "function") return [];
        const res = fn(providerId);
        return Array.isArray(res) ? res : [];
      } catch {
        return [];
      }
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
