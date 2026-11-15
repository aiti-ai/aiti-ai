/**
 * pi-side storage paths + re-export of the shared engine.
 *
 * The detection/registry/commands engine lives in @aiti-ai/secret-mask-core
 * (shared verbatim with the DSH edition); this module only pins pi's storage
 * locations under ~/.pi/agent.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export * from "@aiti-ai/secret-mask-core";

export const PERSIST_PATH = join(homedir(), ".pi", "agent", "secret-mask.json");
export const AUDIT_LOG_PATH = join(homedir(), ".pi", "agent", "secret-mask-audit.log");
