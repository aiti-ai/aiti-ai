/**
 * aiti-sysmon · top-bar session-info chips (host slot "sessionStatsInline").
 *
 * Two tiny indicators (CPU load % / memory usage %) rendered at the tail of the
 * host's session-info stats button. Style blends into the stats row: same 11px
 * size, tabular numerals, muted color by default — color kicks in only at high
 * load (≥70 yellow / ≥90 red, same thresholds as the dock panel's loadColor).
 *
 * Sampling discipline mirrors the dock panel: one fetch loop that only runs
 * while the document is visible (visibilitychange gates it); hidden tab → no
 * requests at all. Cadence follows the shared `interval` feature (default 3s).
 * Feature `topbarChips` (toggle in the extension manager) removes the chips
 * entirely — zero render, zero polling.
 *
 * Narrow tiers render nothing: the host passes isMobile/isCompact as slot-extra
 * data, and the stats row width on those tiers is reserved for the context %.
 *
 * Contract: inline content only (span/svg) — this mounts inside the host's
 * stats <button>; no block elements, no nested interactive elements. Clicks
 * bubble and open the session panel (expected behavior).
 */
import { useState, useEffect } from "react";
import { apiUrl, t, extFeatures, onFeatureChange } from "./host-shim";
import { fmtBytes } from "../../core.cjs";

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** Load-graded color: muted by default (blends into the stats row), yellow/red
 *  only when the value is actually high — same thresholds as the dock panel. */
function chipColor(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "var(--text-muted,#9aa0a6)";
  if (v >= 90) return "#d4574e";
  if (v >= 70) return "#c9a227";
  return "var(--text-muted,#9aa0a6)";
}

/** Unified chip design: text label + percentage, NO icon. Two different glyphs
 *  (chip / stick) read as inconsistent at 12px, and a processor chip collides
 *  with the model-selector's icon — plain text labels keep both chips pixel-
 *  identical in structure (status-bar convention: CPU 12% · MEM 61%), stay
 *  compact, and color still carries the load state. */

export function TopChips(props: { isMobile?: boolean; isCompact?: boolean }) {
  const [featTick, setFeatTick] = useState(0);
  const [visible, setVisible] = useState(typeof document === "undefined" || document.visibilityState === "visible");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState(false);

  // featTick re-reads features after extension-manager edits (topbarChips off →
  // chips disappear and the loop stops; interval edits re-gear the cadence).
  void featTick;
  const enabled = extFeatures().topbarChips !== false;
  const intervalSec = clampInt(extFeatures().interval, 3, 1, 600);

  useEffect(() => onFeatureChange(() => setFeatTick((x: number) => x + 1)), []);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // The single sampling loop: runs only while enabled and the tab is visible;
  // one immediate fetch then a plain timeout chain (canceled in cleanup).
  useEffect(() => {
    if (!enabled || !visible) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-sysmon/brief"), { cache: "no-store" });
        if (stopped) return;
        if (!r.ok) setErr(true);
        else { setErr(false); setData(await r.json()); }
      } catch { if (!stopped) setErr(true); }
      if (!stopped) timer = setTimeout(tick, intervalSec * 1000);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [enabled, visible, intervalSec]);

  // Narrow tiers: render nothing (row width stays with the context percentage).
  if (props.isMobile || props.isCompact || !enabled) return null;

  const cpuLoad: number | null = data?.cpu && Number.isFinite(Number(data.cpu.load)) ? Number(data.cpu.load) : null;
  const mem = data?.mem ?? null;
  const errSuffix = err ? " · " + t("快照错误") : "";

  const chipBase: Record<string, unknown> = {
    display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
    // 10px — one step below the stats row's 11px so the chips read as subtle
    // metadata, not competing content (user feedback: 11px letters looked loud).
    fontSize: 10, fontVariantNumeric: "tabular-nums" as const, whiteSpace: "nowrap" as const,
  };

  return (
    <>
      <span
        data-sysmon-chip="cpu"
        title={"CPU " + (cpuLoad != null ? Math.round(cpuLoad) + "%" : "—") + errSuffix}
        style={{ ...chipBase, color: chipColor(cpuLoad) }}
      >
        CPU {cpuLoad != null ? Math.round(cpuLoad) : "—"}%
      </span>
      <span
        data-sysmon-chip="mem"
        title={
          mem
            ? t("内存占用") + " " + Math.round(mem.pct) + "% · " + fmtBytes(mem.used) + " / " + fmtBytes(mem.total)
              + (mem.swapTotal > 0 ? " · swap " + fmtBytes(mem.swapUsed) + " / " + fmtBytes(mem.swapTotal) : "")
              + errSuffix
            : (data ? "MEM —" : t("加载中") + "…") + errSuffix
        }
        style={{ ...chipBase, color: chipColor(mem?.pct) }}
      >
        MEM {mem ? Math.round(mem.pct) : "—"}%
      </span>
    </>
  );
}
