/**
 * pi-side storage paths + re-export of the shared engine.
 *
 * The detection/registry/commands engine lives in @aiti-ai/secret-mask-core
 * (shared verbatim with the vault and DSH editions); this module only pins
 * pi's storage locations under ~/.pi/agent.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export * from "@aiti-ai/secret-mask-core";

/** Retired implicit-persistence file (migration notice only). */
export const PERSIST_PATH = join(homedir(), ".pi", "agent", "secret-mask.json");
/** Send-audit evidence log. */
export const AUDIT_LOG_PATH = join(homedir(), ".pi", "agent", "secret-mask-audit.log");
/** User-defined detection rules (hot reloaded). */
export const RULES_PATH = join(homedir(), ".pi", "agent", "secret-mask-rules.json");
