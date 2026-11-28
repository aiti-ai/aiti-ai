/**
 * _shared/reload-instances.mjs · pi-web dual-instance hot reload (shared by every extension deploy.mjs)
 *
 * dev 3001 / prod 3002; ports overridable via AITI_DEV_PORT / AITI_PROD_PORT;
 * basePath dual env (AITI_DEV_BASE_PATH / AITI_PROD_BASE_PATH) set per machine;
 *   recommended values without a slash (48: dev and empty; 155: system-level wdev and win) — when git-bash
 *   launches native programs it MSYS-path-converts env values starting with / (/wdev → D:/apps/Git/wdev),
 *   making the URL invalid; without a slash the conversion does not trigger. A / is added back here
 *   (the old /xxx format still works); when it cannot be handled, MSYS_NO_PATHCONV=1 is suggested.
 * Avoids "server code changed but the instance was not reloaded, so old logic keeps running".
 *
 * Usage (static import or top-level await import both fine):
 *   import { reloadInstances } from "@aiti-ai/ext-shared/reload-instances";
 *   await reloadInstances();              // default "[deploy] " prefix
 */
const BASE_PATH_RE = /^\/[A-Za-z0-9._-]*$/;

function buildInstance(name, portEnv, portDefault, pathEnv, pathDefault) {
  const origin = `http://127.0.0.1:${process.env[portEnv] || portDefault}`;
  const raw = process.env[pathEnv];
  if (raw === undefined || raw === null || String(raw).trim() === "") return { name, base: origin + pathDefault };
  // Add the / back: wdev → /wdev (recommended slash-less format, MSYS does not convert it); /wdev → /wdev (legacy format compat)
  const p = "/" + String(raw).trim().replace(/^\/+|\/+$/g, "");
  if (BASE_PATH_RE.test(p)) return { name, base: origin + p };
  return { name, base: null, raw };
}

/** Dual-instance list (dev/prod each {name, base}); shared by reload-instances, reconcile-deps, etc. */
export function buildInstances() {
  return [
    buildInstance("dev", "AITI_DEV_PORT", 3001, "AITI_DEV_BASE_PATH", "/dev"),
    buildInstance("prod", "AITI_PROD_PORT", 3002, "AITI_PROD_BASE_PATH", ""),
  ];
}

export async function reloadInstances(prefix = "[deploy] ") {
  // Batch merge (deploy-all case): when a child entry's deploy script is injected PI_WEB_DEFER_RELOAD=1
  // it does not reload on its own; deploy-all runs one unified round after all entries finish
  // (N entries × 2 instances → 2 POSTs). Avoids the reload storm during batch deploys
  // (measured 2026-09-15: 65 entries reloading one by one saturated the dev instance).
  // Running a single extension deploy.mjs without that env → behavior unchanged (reload right after deploy).
  if (process.env.PI_WEB_DEFER_RELOAD === "1") {
    console.log(`${prefix}reload deferred (PI_WEB_DEFER_RELOAD=1, deploy-all runs one unified pass at the end)`);
    return;
  }
  // Failures allowed: network errors / non-2xx / service not up / invalid env only log a hint, never throw — deploy exit code unaffected
  for (const inst of buildInstances()) {
    if (inst.base === null) {
      const msysHint = /[\\:]/.test(inst.raw) ? " — suspected git-bash MSYS path conversion, rerun with the MSYS_NO_PATHCONV=1 prefix" : "";
      console.log(`${prefix}reload ${inst.name} skipped: AITI_${inst.name.toUpperCase()}_BASE_PATH="${inst.raw}" invalid (must look like /xxx or be empty)${msysHint}`);
      continue;
    }
    try {
      const r = await fetch(inst.base + "/api/extensions/reload", { method: "POST" });
      console.log(`${prefix}reload ${inst.name} → HTTP ${r.status} ${r.ok ? "✓" : "⚠ failed (please POST /api/extensions/reload manually)"}`);
    } catch (e) {
      const cause = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : String((e && e.message) || e);
      console.log(`${prefix}reload ${inst.name} unreachable (${cause}) — POST /api/extensions/reload manually`);
    }
  }
}
