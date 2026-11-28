/**
 * `/secret` command registration. `recordInput: false` keeps the raw input
 * (the secret value) out of the `command/run` session-log record — a DSH
 *-native guarantee pi could not offer: commands never become model-facing
 * messages, so an inline `/secret add <value>` leaves no trace in the
 * session transcript at all.
 */

import type { CommandDefinition, PluginConfig, PluginContext } from "../dsh-types.ts";
import { handleSecretCommand } from "@aiti-ai/secret-mask-core";
import { refreshRules, reloadRules, stateFor } from "../state.ts";

export function registerSecretCommand(ctx: PluginContext, cfg: PluginConfig): void {
  const definition: CommandDefinition = {
    name: "secret",
    description:
      "Register/redact secrets: add/list/remove/clear, on/off, guard, rules, save|load <file>, audit, status",
    recordInput: false,
    handler: async (invocation) => {
      const st = stateFor(invocation.agent?.id, cfg);
      refreshRules(st);
      const outcome = await handleSecretCommand(st, invocation.rawInput ?? "", {
        reloadRules: () => reloadRules(st),
      });
      return outcome.ok ? { kind: "success", text: outcome.text } : { kind: "error", text: outcome.text };
    },
  };
  ctx.commands.register(definition);
}
