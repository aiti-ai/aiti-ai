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
import { Registry } from "./core/mask.ts";
import { loadPersist, type SecretState } from "./core/commands.ts";
import type { AgentLike, PluginConfig, SessionState } from "./dsh-types.ts";

const sessions = new Map<string, SessionState>();

export function stateFor(agentId: string | undefined, cfg: PluginConfig): SessionState {
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
    };
    sessions.set(key, st);
    // Opt-in persistence: restore this workspace's saved bucket on first use.
    loadPersist(st);
  }
  return st;
}

export function dropSession(agentId: string | undefined): void {
  if (agentId && agentId.length) sessions.delete(agentId);
}

/** Redaction / detection master switches for one session (config × /secret toggles). */
export function active(st: SessionState): boolean {
  return st.enabled;
}

export type { SecretState };
export type { AgentLike };
