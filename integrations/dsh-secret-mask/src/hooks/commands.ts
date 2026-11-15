/**
 * `/secret` command registration. `recordInput: false` keeps the raw input
 * (the secret value) out of the `command/run` session-log record — a DSH
 *-native guarantee pi could not offer: commands never become model-facing
 * messages, so an inline `/secret add <value>` leaves no trace in the
 * session transcript at all.
 */

import type { CommandDefinition, PluginConfig, PluginContext } from "../dsh-types.ts";
import { handleSecretCommand } from "../core/commands.ts";
import { stateFor } from "../state.ts";

export function registerSecretCommand(ctx: PluginContext, cfg: PluginConfig): void {
  const definition: CommandDefinition = {
    name: "secret",
    description:
      "Register/redact secrets: add <value> [as <alias>], list, remove, clear, on/off, status, save/unload, audit [on|off|show]",
    recordInput: false,
    handler: async (invocation) => {
      const st = stateFor(invocation.agent?.id, cfg);
      const outcome = await handleSecretCommand(st, invocation.rawInput ?? "");
      return outcome.ok ? { kind: "success", text: outcome.text } : { kind: "error", text: outcome.text };
    },
  };
  ctx.commands.register(definition);
}
