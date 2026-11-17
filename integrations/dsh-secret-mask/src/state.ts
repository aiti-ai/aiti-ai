/**
 * Per-session state for dsh-secret-mask.
 *
 * DSH is one process hosting many sessions (unlike pi, which is one process
 * per session): every value registry is keyed by the agent id — which is the
 * same string as the session id (dsh-agent: "Each agent and its session share
 * one caller-chosen SessionId"). `agent/disposed` drops the key so secrets
 * never outlive their session and concurrent sessions cannot cross-contaminate.
 */

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Registry, loadPersist, PERSIST_FILE_NAME, AUDIT_FILE_NAME, type SecretState } from "@aiti-ai/secret-mask-core";
import type { PluginConfig } from "./dsh-types.ts";

const sessions = new Map<string, SecretState>();

/** DSH storage locations (host side of the shared core contract). */
export const PERSIST_PATH = join(homedir(), ".dsh", PERSIST_FILE_NAME);
export const AUDIT_LOG_PATH = join(homedir(), ".dsh", AUDIT_FILE_NAME);

export function stateFor(agentId: string | undefined, cfg: PluginConfig): SecretState {
  const key = agentId && agentId.length ? agentId : "__global__";
  let st = sessions.get(key);
  if (!st) {
    st = {
      registry: new Registry(),
      enabled: cfg.enabled,
      salt: randomBytes(4).toString("hex"),
      cwd: cfg.workspaceDir || process.cwd(),
      persisted: false,
      audit: cfg.audit,
      persistPath: PERSIST_PATH,
      auditPath: cfg.auditPath || AUDIT_LOG_PATH,
    };
    sessions.set(key, st);
    // Opt-in persistence: restore this workspace's saved bucket on first use.
    loadPersist(st, st.persistPath);
  }
  return st;
}

export function dropSession(agentId: string | undefined): void {
  if (agentId && agentId.length) sessions.delete(agentId);
}

/** Redaction / detection master switches for one session (config × /secret toggles). */
export function active(st: SecretState): boolean {
  return st.enabled;
}
