/**
 * _shared/reconcile-deps.mjs · notifies the pi-web dual instances to reconcile shared extension deps (shared by every extension deploy.mjs)
 *
 * Background: extension runtime deps are installed into the shared root <webRoot>/node_modules
 * (jiti resolves upward from the extension dir and hits it automatically; mechanism modeled on
 * pi's own npm: package installs). The only writer of the shared root is aiti-extman's
 * shared-deps reconcile — deploy.mjs just POSTs this notification after copying files; npm never
 * runs inside deploy scripts.
 *
 * Usage (same as reload-instances: failure-tolerant, never throws, deploy exit code unaffected):
 *   import { notifyReconcile } from "../../_shared/reconcile-deps.mjs";
 *   await notifyReconcile();               // default "[deploy] " prefix; call before reloadInstances()
 *
 * Harmless on failure: extman self-heals on the next install/remove/reconcile-deps; each instance
 * reconciles its own webRoot (~/.pi/web vs ~/.pi/web-dev), fully independent.
 */
import { buildInstances } from "./reload-instances.mjs";

export async function notifyReconcile(prefix = "[deploy] ") {
  for (const inst of buildInstances()) {
    if (inst.base === null) {
      console.log(`${prefix}reconcile ${inst.name} 跳过：basePath 非法`);
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
        console.log(`${prefix}reconcile ${inst.name} → ✓（${Object.keys(body.deps?.deps || {}).length} 个共享依赖）`);
      } else {
        console.log(`${prefix}reconcile ${inst.name} → HTTP ${r.status} ⚠${err ? " " + err : "（extman 未就绪？下次安装时自动对齐）"}`);
      }
    } catch (e) {
      const cause = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : String((e && e.message) || e);
      console.log(`${prefix}reconcile ${inst.name} 不可达（${cause}）— 下次安装时自动对齐`);
    }
  }
}
