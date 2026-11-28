/**
 * The single place that turns a client-supplied "provider" value into an instance.
 *
 * Clients may send a platform id ("github", meaning the default account), an instance
 * id ("github~work"), or a platform id plus an alias/slug via the optional `account`
 * argument (agent tools). Everything else in the server keys off `id` (the instance).
 */
import type { ForgeProvider, ProviderConfig } from "./contract.ts";
import { ForgeHttpError } from "./http.ts";
import { getRegistry, getStore } from "./runtime.ts";
import { isValidInstanceId, platformOf } from "./instances.ts";

export interface InstanceBinding {
  /** Instance id (`github` or `github~work`). */
  id: string;
  /** Platform id that selects the adapter. */
  platform: string;
  adapter: ForgeProvider;
}

export function bind(requested: string | undefined, account?: string | undefined): InstanceBinding {
  const raw = String(requested || "").trim();
  if (!raw) throw new ForgeHttpError("provider is required", { status: 400, code: "bad_request" });

  let id = raw;
  if (account && String(account).trim()) {
    const want = String(account).trim();
    const platform = platformOf(raw);
    if (raw.includes("~") && raw !== platform) {
      throw new ForgeHttpError("provider is already an instance id — do not send account", { status: 400, code: "bad_request" });
    }
    const resolved = getStore().resolveInstance(platform, want);
    if (!resolved) throw new ForgeHttpError(`unknown account: ${want}`, { status: 404, code: "not_found" });
    id = resolved;
  }

  if (!isValidInstanceId(id)) throw new ForgeHttpError(`unknown provider: ${raw}`, { status: 404, code: "not_found" });
  const platform = platformOf(id);
  const adapter = getRegistry().get(platform);
  if (!adapter) throw new ForgeHttpError(`unknown provider: ${raw}`, { status: 404, code: "not_found" });

  // Non-default instances must exist; the default instance keeps the legacy behaviour
  // ("provider not configured yet" instead of 404) so old clients/tools never break.
  if (id !== platform && !getStore().hasInstance(id)) {
    throw new ForgeHttpError(`unknown account: ${id}`, { status: 404, code: "not_found" });
  }
  return { id, platform, adapter };
}

/** Instance config for a binding (optionally refreshed through the OAuth driver). */
export function configFor(binding: InstanceBinding): ProviderConfig {
  return getStore().provider(binding.id);
}

/** Platform label for template variables / UI text. */
export function platformLabel(binding: InstanceBinding): string {
  return binding.adapter.label;
}
