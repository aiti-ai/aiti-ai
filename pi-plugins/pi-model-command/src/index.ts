/**
 * pi-model-command — expose the model picker as a session command.
 *
 * pi's TUI has a built-in `/model`, but built-in interactive commands are
 * handled only in interactive mode: the SDK and RPC paths do not execute them
 * when they arrive as prompts (see pi's extensions.md, `pi.getCommands()`).
 * A host without a TUI therefore has no way to switch the session model from
 * its composer — `/model` reaches the model as plain text.
 *
 * This extension registers `/models` through the ordinary extension command
 * channel (`pi.registerCommand` → `get_commands` → `prompt`), so every host
 * works the same way: the TUI renders its selector, an RPC host renders its
 * own dialog for `ctx.ui.select`. `/models <provider/modelId>` sets one
 * directly, for scripts and hosts without dialogs.
 *
 * The name is `models`, not `model`: a command that clashes with a built-in
 * interactive command is only reachable with a numeric suffix (`/model:1`).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** The slice of a pi model this command reads. */
export interface ModelLike {
  provider: string;
  id: string;
  name?: string;
}

/** `provider/id` — unique per model, and what the picker lists. */
export function modelLabel(model: ModelLike): string {
  return `${model.provider}/${model.id}`;
}

export type ModelResolution<T extends ModelLike = ModelLike> =
  | { kind: "model"; model: T }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: T[] };

/**
 * Resolve a user-typed model reference. An exact `provider/id` wins, then an
 * exact id, then an exact display name, then a single case-insensitive
 * substring match over both. Several substring matches are reported as
 * ambiguous rather than silently picking one.
 */
export function resolveModelChoice<T extends ModelLike>(models: readonly T[], query: string): ModelResolution<T> {
  const q = query.trim().toLowerCase();
  if (!q) return { kind: "none" };
  const exact = models.find((model) => modelLabel(model).toLowerCase() === q);
  if (exact) return { kind: "model", model: exact };
  const byId = models.filter((model) => model.id.toLowerCase() === q);
  if (byId.length === 1) return { kind: "model", model: byId[0] };
  const byName = models.filter((model) => (model.name ?? "").toLowerCase() === q);
  if (byName.length === 1) return { kind: "model", model: byName[0] };
  const partial = models.filter((model) =>
    modelLabel(model).toLowerCase().includes(q) || (model.name ?? "").toLowerCase().includes(q));
  if (partial.length === 1) return { kind: "model", model: partial[0] };
  if (partial.length === 0) return { kind: "none" };
  return { kind: "ambiguous", candidates: partial };
}

/**
 * The models this session can switch to: the session's own scope when one is
 * configured (the same shortlist the built-in picker shows), otherwise every
 * model with a loaded provider. `modelRegistry.getAvailable()` is the
 * authenticated catalogue, matching what `set_model` accepts.
 */
export function pickerModels(ctx: ExtensionCommandContext): ReturnType<ExtensionCommandContext["modelRegistry"]["getAvailable"]> {
  const scoped = ctx.scopedModels?.map((entry) => entry.model) ?? [];
  return (scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable()) as ReturnType<
    ExtensionCommandContext["modelRegistry"]["getAvailable"]
  >;
}

/** Output through the host UI when it has one, console otherwise (print/json modes). */
function emit(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (typeof ctx.ui?.notify === "function") ctx.ui.notify(message, level);
  else console.log(message);
}

/** List labels in a stable, readable order, capped so a huge catalogue stays usable. */
export function formatCandidates(candidates: readonly ModelLike[], limit = 12): string {
  const labels = candidates.map(modelLabel);
  if (labels.length <= limit) return labels.join(", ");
  return `${labels.slice(0, limit).join(", ")} (+${labels.length - limit} more)`;
}

export default function modelCommand(pi: ExtensionAPI): void {
  try {
    pi.registerCommand("models", {
      description: "Select the session model, or set it with /models <provider/modelId>",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const models = pickerModels(ctx);
        if (models.length === 0) {
          emit(ctx, "No models are available in this session", "error");
          return;
        }

        const query = (args ?? "").trim();
        if (query) {
          const resolved = resolveModelChoice(models, query);
          if (resolved.kind === "ambiguous") {
            emit(ctx, `Ambiguous model "${query}": ${formatCandidates(resolved.candidates)}`, "warning");
            return;
          }
          if (resolved.kind === "none") {
            emit(ctx, `Model not found: ${query}`, "error");
            return;
          }
          await applyModel(pi, ctx, resolved.model);
          return;
        }

        // No argument: a picker when the host can show one, the list otherwise.
        if (!ctx.hasUI) {
          emit(ctx, `Models: ${formatCandidates(models, 40)}`);
          return;
        }
        const labels = models.map(modelLabel);
        const choice = await ctx.ui.select("Select model", labels);
        if (!choice) return; // cancelled
        const picked = models[labels.indexOf(choice)];
        if (picked) await applyModel(pi, ctx, picked);
      },
    });
  } catch {
    // Older hosts without registerCommand: nothing to wire, nothing to break.
  }
}

/** Switch the session model; `false` means this provider has no usable credentials. */
async function applyModel(pi: ExtensionAPI, ctx: ExtensionCommandContext, model: ModelLike): Promise<void> {
  const target = ctx.modelRegistry.find(model.provider, model.id) ?? model;
  const ok = await pi.setModel(target as Parameters<ExtensionAPI["setModel"]>[0]);
  if (ok === false) emit(ctx, `No credentials configured for ${modelLabel(model)}`, "error");
  else emit(ctx, `Model: ${modelLabel(model)}`);
}
