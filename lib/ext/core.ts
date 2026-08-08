/**
 * Core data contract handed to extensions (ExtServerContext.core).
 *
 * Kept behind explicit functions so extensions never re-implement session
 * reading, running-state tracking, or home resolution — and so the underlying
 * implementations can evolve (e.g. the incremental list cache) without
 * breaking extensions.
 */
import { homedir } from "os";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
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
  };
}
