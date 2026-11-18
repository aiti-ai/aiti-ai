/**
 * Storage locations for the vault edition under ~/.pi/agent.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_DIR = join(homedir(), ".pi", "agent");
export const VAULT_DIR = join(AGENT_DIR, "secret-vault");
export const MASTER_KEY_PATH = join(VAULT_DIR, "master.key");
export const SESSION_STATE_PATH = join(VAULT_DIR, "session-state.json");
export const AUDIT_LOG_PATH = join(AGENT_DIR, "secret-vault-audit.log");
export const RULES_PATH = join(AGENT_DIR, "secret-mask-rules.json");
/** Retired implicit-persistence file from the mask edition (migration notice). */
export const LEGACY_PERSIST_PATH = join(AGENT_DIR, "secret-mask.json");
export const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
