/**
 * _shared/reconcile-deps.mjs · notify the pi-web dual instances to reconcile extension shared deps (shared by every extension deploy.mjs)
 *
 * Background: extension runtime deps are installed into the shared root <webRoot>/node_modules
 * (jiti resolves upward from the extension dir and hits it automatically; mechanism modeled on
 * pi core's npm: package install). The only writer of the shared root is aiti-extman's
 * shared-deps reconcile — after deploy.mjs finishes copying, just POST this notification;
 * no npm runs inside deploy scripts.
 *
 * Usage (same contract as reload-instances: failures allowed, never throws, deploy exit code unaffected):
 *   import { notifyReconcile } from "@aiti-ai/ext-shared/reconcile-deps";
 *   await notifyReconcile();               // default "[deploy] " prefix; call before reloadInstances()
 *
 * Failure is harmless: extman self-heals the alignment on the next install/remove/reconcile-deps;
 * the dual instances each reconcile their own webRoot (~/.pi/web and ~/.pi/web-dev), independent of each other.
 */
import { buildInstances } from "./reload-instances.mjs";

export async function notifyReconcile(prefix = "[deploy] ") {
  for (const inst of buildInstances()) {
    if (inst.base === null) {
      console.log(`${prefix}reconcile ${inst.name} skipped: invalid basePath`);
      continue;
    }
    try {
      const r = await fetch(inst.base + "/api/extensions/aiti-extman/ops", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reconcile-deps", source: "deploy" }),
      });
      const body = await r.json().catch(() => null);
      const err = body && body.deps && body.deps.error;
      if (r.ok && body && body.ok) {
        console.log(`${prefix}reconcile ${inst.name} → ✓ (${Object.keys(body.deps?.deps || {}).length} shared deps)`);
      } else {
        console.log(`${prefix}reconcile ${inst.name} → HTTP ${r.status} ⚠${err ? " " + err : " (extman not ready? realigns on next install)"}`);
      }
    } catch (e) {
      const cause = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : String((e && e.message) || e);
      console.log(`${prefix}reconcile ${inst.name} unreachable (${cause}) — realigns on next install`);
    }
  }
}
