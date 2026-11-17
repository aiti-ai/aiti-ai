/**
 * session-manager — enrich layer for the agent-facing session_search / session_read tools
 * (docs/pi-session-search-enrich-tags-plan.md §3/§4.2, 1:1 contract with the TUI-side
 * pi-session-search plugin).
 *
 * Two additive lines per hit:
 *   tags: <tag tree paths, " / "-joined segments, ", "-joined tags>
 *   plan: <md path> [fm tags]（状态: 方案/*）   // cjk-ok (protocol literal: plan-status tag prefix)
 *
 * Pure/injectable so node:test can exercise both sources without the extension host.
 * Any absent source (tags file missing, plan-first not installed, read error) simply
 * omits its line — never blocks the search main path.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { byIdMap, tagPath, type TagData } from "../lib/session-tags.ts";

export interface PlanSvcRow {
  sessionId: string;
  path: string;
  fmTags: string[];
  statusPhase: string | null;
}

export type PlanSvc = { planDocsWithTags?: (sids?: string[]) => PlanSvcRow[] } | null | undefined;

/** Probe the aiti-plan-first service outlet (services.get table first, __piWebExt.byId fallback).
 *  a throwing get counts as absent (the two tracks are independent, no mutual dragging). */
export function probePlanSvc(servicesGet: ((key: string) => unknown) | null): PlanSvc {
  let viaSvc: PlanSvc = null;
  try { viaSvc = (servicesGet?.("aiti-plan-first.plans") ?? null) as PlanSvc; } catch { /* throwing get = absent */ }
  if (viaSvc && typeof viaSvc.planDocsWithTags === "function") return viaSvc;
  try {
    const reg = (globalThis as any).__piWebExt;
    const s = reg && typeof reg.byId === "function" ? reg.byId("aiti-plan-first")?.ext?.services?.plans : null; // dualtrack fallback (services absent / old-core transition; same pattern as aiti-plan-first consuming doc-center)
    return s && typeof s.planDocsWithTags === "function" ? s : null;
  } catch { return null; }
}

/** Extra lines per session: Map<sid, "tags: …\nplan: …">. Both sources are best-effort. */
export function enrichForSession(
  sids: string[],
  smConfigDir: string,
  readTagDataFn: (configDir: string) => TagData,
  planSvc: PlanSvc,
): Map<string, string> {
  const out = new Map<string, string>();
  const uniq = [...new Set(sids.filter(Boolean))];
  if (!uniq.length) return out;
  try {
    // tags: own configDir/session-tags.json (mtime-cached in readTagData); leaf id → tree path
    const data = readTagDataFn(smConfigDir);
    if (data.tags.length) {
      const byId = byIdMap(data);
      for (const sid of uniq) {
        const ids = data.sessionTags[sid];
        if (!ids?.length) continue;
        const paths = ids.map((id) => { const n = byId.get(id); return n ? tagPath(n, byId) : ""; }).filter(Boolean);
        if (paths.length) out.set(sid, `tags: ${paths.join(", ")}`);
      }
    }
  } catch { /* tags absent → no line */ }
  try {
    // plan: aiti-plan-first services outlet (fm tags parsed by the data owner, mtime-cached)
    const rows = planSvc?.planDocsWithTags?.(uniq) ?? [];
    for (const r of rows) {
      // the bracket display excludes 方案/* status items (they go into "Status: …" separately, contract §3)   // cjk-ok (protocol literal)
      const fmTags = (r.fmTags ?? []).filter((t) => !t.startsWith("方案/"));
      const fm = fmTags.length ? ` [${fmTags.join(", ")}]` : "";
      const st = r.statusPhase ? `（状态: ${r.statusPhase}）` : "";
      const line = `plan: ${r.path}${fm}${st}`;
      const prev = out.get(r.sessionId);
      out.set(r.sessionId, prev ? `${prev}\n${line}` : line);
    }
  } catch { /* outlet absent / throws → no line */ }
  return out;
}

/** Persist the agentTools kill-switch for the TUI-side pi-session-search plugin
 *  (pi-git-trace × aiti-git-trace kill-switch precedent): feature value from
 *  <dataRoot>/features.json (configDir up two levels) → <configDir>/config.json.
 *  Missing features.json / key = enabled (default on). Write failure is tolerated. */
export function writeAgentToolsKillswitch(smConfigDir: string, readFileSyncFn: typeof fs.readFileSync = fs.readFileSync): { enabled: boolean } {
  let enabled = true;
  try {
    const feats = JSON.parse(readFileSyncFn(path.join(path.dirname(path.dirname(smConfigDir)), "features.json"), "utf8"));
    enabled = (feats["session-manager"] ?? {})["agentTools.enabled"] !== false;
  } catch { /* missing/broken features.json: default on */ }
  try { fs.writeFileSync(path.join(smConfigDir, "config.json"), JSON.stringify({ agentTools: { enabled } }), "utf8"); } catch { /* read-only disk etc.: plugin sees no file = registers (acceptable) */ }
  return { enabled };
}
