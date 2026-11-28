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

/** Unified chip design: single-letter label + percentage, NO icon. Two different
 *  glyphs (chip / stick) read as inconsistent at 12px, and a processor chip
 *  collides with the model-selector's icon — plain text keeps both chips
 *  pixel-identical in structure and lets them join the host stats row's
 *  compressed flow (density plan, scheme E: `11% · C17% · M88%`).
 *  Full words (CPU load / memory) stay in each chip's title tooltip. */

/**
 * Latest brief sample, kept at module scope so the registered slot item's
 * `meta.tooltip` callback can read it on hover (the host appends that line to the
 * session-info button's own tooltip). Updated by the sampling loop below.
 */
let latestBrief: any = null;
let latestAt = 0;

/** One-line system summary for the host's session-info tooltip, e.g.
 *  `system: CPU 8% · MEM 87% · 49.9 GB / 58.6 GB · swap 16.8 GB / 34.0 GB`.
 *  Returns null until the first sample lands (the host then shows its own lines only). */
export function sysmonTooltipLine(): string | null {
  // Respect the feature switch: a user who turned the chips off should not still
  // see CPU/memory in the stats tooltip.
  if (extFeatures().topbarChips === false) return null;
  const d = latestBrief;
  // Sampling stops while the tab is hidden (and while the feature is off), so the
  // last sample can go stale. Refuse to report a reading older than 90s instead of
  // showing a number that no longer reflects the machine.
  if (!d || Date.now() - latestAt > 90_000) return null;
  const cpu = d.cpu && Number.isFinite(Number(d.cpu.load)) ? Math.round(Number(d.cpu.load)) + "%" : "—";
  const m = d.mem;
  // `system:` prefix keeps the line in step with the host's own `tokens:` / `cost:`
  // / `context:` topics (the host owns the line breaks, not the labels).
  if (!m) return "system: CPU " + cpu;
  const parts = [
    "CPU " + cpu,
    t("内存占用") + " " + Math.round(m.pct) + "%",
    fmtBytes(m.used) + " / " + fmtBytes(m.total),
  ];
  if (m.swapTotal > 0) parts.push("swap " + fmtBytes(m.swapUsed) + " / " + fmtBytes(m.swapTotal));
  return "system: " + parts.join(" · ");
}

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
        else {
          const brief = await r.json();
          setErr(false);
          setData(brief);
          latestBrief = brief; // feeds meta.tooltip (read on hover)
          latestAt = Date.now();
        }
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
  // One wrapper span for both chips: the host stats button is a flex container with
  // a 7px gap, so returning two siblings would pay that gap between the chips too.
  // A single wrapper pays it once (host→chips) and keeps C·M tight at 6px.
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
      <span
        data-sysmon-chip="cpu"
        title={"CPU " + (cpuLoad != null ? Math.round(cpuLoad) + "%" : "—") + errSuffix}
        style={{ ...chipBase, color: chipColor(cpuLoad) }}
      >
        C{cpuLoad != null ? Math.round(cpuLoad) : "—"}%
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
        M{mem ? Math.round(mem.pct) : "—"}%
      </span>
    </span>
  );
}
