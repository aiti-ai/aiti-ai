/**
 * _shared/reload-instances.mjs · pi-web dual-instance hot reload (shared by every extension deploy.mjs)
 *
 * dev 3001 / prod 3002; ports overridable via AITI_DEV_PORT / AITI_PROD_PORT;
 * basePath dual env (AITI_DEV_BASE_PATH / AITI_PROD_BASE_PATH) is set per machine;
 *   recommended values carry no leading slash (48: dev and empty; 155: system-level wdev and win)
 *   — git-bash applies MSYS path conversion to env values starting with "/" when launching native
 *   programs (/wdev → D:/apps/Git/wdev), producing an invalid URL; a slash-less value avoids the
 *   conversion. A leading "/" is re-added here (old /xxx format still supported); if unsalvageable, MSYS_NO_PATHCONV=1 is hinted.
 * Prevents "server code changed but the instance never reloaded, so it keeps running stale logic".
 *
 * Usage (static import or top-level await import both fine):
 *   import { reloadInstances } from "../../_shared/reload-instances.mjs";
 *   await reloadInstances();              // default "[deploy] " prefix
 */
const BASE_PATH_RE = /^\/[A-Za-z0-9._-]*$/;

function buildInstance(name, portEnv, portDefault, pathEnv, pathDefault) {
  const origin = `http://127.0.0.1:${process.env[portEnv] || portDefault}`;
  const raw = process.env[pathEnv];
  if (raw === undefined || raw === null || String(raw).trim() === "") return { name, base: origin + pathDefault };
  // auto-add the leading /: wdev → /wdev (recommended slash-less format, MSYS does not convert); /wdev → /wdev (old format kept working)
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
  // Batch merging (deploy-all scenario): child deploy scripts run with PI_WEB_DEFER_RELOAD=1 and
  // skip their own reload; deploy-all does one unified round after all entries finish (N × 2 → 2
  // POSTs), avoiding a reload storm (observed 2026-09-15: 65 entries reloaded one by one saturated dev).
  // Running one extension's deploy.mjs without the env → behavior unchanged (immediate reload).
  if (process.env.PI_WEB_DEFER_RELOAD === "1") {
    console.log(`${prefix}reload 已 defer（PI_WEB_DEFER_RELOAD=1，由 deploy-all 收尾统一执行）`);
    return;
  }
  // failure-tolerant: network errors / non-2xx / service down / invalid env only print a notice, never throw — the deploy exit code is unaffected
  for (const inst of buildInstances()) {
    if (inst.base === null) {
      const msysHint = /[\\:]/.test(inst.raw) ? "——疑似 git-bash MSYS 路径转换，用 MSYS_NO_PATHCONV=1 前缀重跑" : "";
      console.log(`${prefix}reload ${inst.name} 跳过：AITI_${inst.name.toUpperCase()}_BASE_PATH="${inst.raw}" 非法（须形如 /xxx 或留空）${msysHint}`);
      continue;
    }
    try {
      const r = await fetch(inst.base + "/api/extensions/reload", { method: "POST" });
      console.log(`${prefix}reload ${inst.name} → HTTP ${r.status} ${r.ok ? "✓" : "⚠ 失败（请手动 POST /api/extensions/reload）"}`);
    } catch (e) {
      const cause = e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : String((e && e.message) || e);
      console.log(`${prefix}reload ${inst.name} 不可达（${cause}）— 需手动 POST /api/extensions/reload`);
    }
  }
}
