/**
 * /secret command surface for pi — storage paths + re-exports.
 *
 * The command logic (add/list/remove, landing, guard, strict, rules,
 * explicit save/load, audit) lives in @aiti-ai/secret-mask-core; pi pins its
 * storage locations here and keeps the masked interactive input (`io.input`)
 * — values typed into the input never reach the chat.
 */

import { AUDIT_LOG_PATH, PERSIST_PATH, RULES_PATH } from "./mask.ts";

export * from "@aiti-ai/secret-mask-core";
export { AUDIT_LOG_PATH, PERSIST_PATH, RULES_PATH };
