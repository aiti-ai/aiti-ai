/**
 * Work-item header insertion via the aiti-codehub pick service.
 *
 * `getExtService("aiti-codehub.pickWorkItem")?.open()` → Promise<{ text } | null>:
 * the picker returns the work item formatted with the paste template
 * (e.g. `#123 Bug Fix login timeout`). The commit dialog prepends it as the message header
 * (see prependHeader in wi-pick-core.ts). Soft dependency: when the service is
 * absent the caller shows a hint and the dialog keeps working as before.
 */
import { extSvc, extEnsureMaterialized } from "./host-shim.ts";
import { ct } from "./comp-i18n.ts";
import { prependHeader } from "./wi-pick-core.ts";

export { prependHeader };

interface PickResult { text?: string }

const SERVICE_KEY = "aiti-codehub.pickWorkItem";

/** Lookup with a lazy-extension retry: aiti-codehub loads its client on demand
 * (clientImmediately:false), so the first lookup can miss — materialize it once
 * and retry before giving up. */
function lookup(): { open?: () => Promise<PickResult | null> } | undefined {
  return extSvc<{ open?: () => Promise<PickResult | null> }>(SERVICE_KEY);
}

/** Open the picker and return the formatted header, or null on cancel / when
 * the aiti-codehub extension is absent (a hint is shown in that case). */
export async function pickWorkItemHeader(): Promise<string | null> {
  let svc = lookup();
  if (!svc || typeof svc.open !== "function") {
    try { await extEnsureMaterialized("aiti-codehub"); } catch { /* absent */ }
    svc = lookup();
  }
  if (!svc || typeof svc.open !== "function") {
    try { window.alert(ct("git.wiPickMissing")); } catch { /* non-browser (tests) */ }
    return null;
  }
  try {
    const r = await svc.open();
    const text = String(r?.text || "").trim();
    return text || null;
  } catch {
    return null;
  }
}
