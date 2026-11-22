/**
 * aiti-sysmon · client panel (sidebar dock face + polling app).
 *
 * Lifecycle discipline: sampling runs only while the panel is actually visible —
 * paused when the dock block is collapsed (keepAlive keeps children mounted, so
 * collapse state gates the loop) and when the browser tab is hidden. Unmounting
 * the face tears the loop down. No other polling exists anywhere: the server has
 * no timers; the client cadence is the only sampling driver.
 */
import { useState, useEffect, useRef } from "react";
import { apiUrl, t, extFeatures, onFeatureChange } from "./host-shim";
import { usePresent, useBlockCollapsed, DockBody, isSidebarDockState, sidebarZoneOf } from "../../../_shared/ext-float-dock";
import { fmtBytes, fmtRate, fmtUptime, histPush } from "../../core.cjs";

export const SY_KEY = "aiti-sysmon:panel";

/** Complete URL form of the extension-local dock icon (five-form contract, {url}).
 *  Extension assets serve under /api/extensions/<id>/assets/<relpath>. */
export function gaugeIconUrl(): string {
  return apiUrl("/api/extensions/aiti-sysmon/assets/icons/gauge.svg");
}

const DOCS_URL = "https://aiti.pw/extensions/aiti-sysmon.html";

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function loadColor(v: number): string {
  if (v >= 90) return "#d4574e";
  if (v >= 70) return "#c9a227";
  return "var(--text-dim,#9aa0a6)";
}

/** Fixed-height micro bar row (history sparkline / per-core strip). */
function Bars(props: { values: number[]; height: number }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: props.height, minHeight: props.height }}>
      {props.values.map((v, i) => (
        <div key={i} title={String(Math.round(v)) + "%"}
          style={{ flex: 1, minWidth: 1, height: Math.max(4, Math.round(v)) + "%", background: loadColor(v), borderRadius: 1 }} />
      ))}
    </div>
  );
}

function SectionLabel(props: { children?: unknown }) {
  return <div style={{ fontSize: 10, letterSpacing: 0.5, color: "var(--text-dim,#888)", marginTop: 10, marginBottom: 3, textTransform: "uppercase" }}>{props.children}</div>;
}

// ---- Loading skeleton ----
// The first snapshot can take a moment (si computes its internal deltas and may
// shell out for disks/temperature), so the loading state mirrors the real layout
// with pulsing placeholder lines instead of scattered "…" markers. The pulse
// animation is disabled under prefers-reduced-motion.
let skStyleInjected = false;
function ensureSkeletonStyle() {
  if (skStyleInjected || typeof document === "undefined") return;
  skStyleInjected = true;
  try {
    if (document.getElementById("pi-sysmon-sk-style")) return;
    const st = document.createElement("style");
    st.id = "pi-sysmon-sk-style";
    st.textContent = "@keyframes pi-sysmon-sk-pulse{0%,100%{opacity:.45}50%{opacity:1}}"
      + ".pi-sysmon-sk{animation:pi-sysmon-sk-pulse 1.3s ease-in-out infinite}"
      + "@media (prefers-reduced-motion: reduce){.pi-sysmon-sk{animation:none!important;opacity:.5}}";
    document.head.appendChild(st);
  } catch { /* noop */ }
}

function SkLine(props: { w: string | number; h?: number; mt?: number }) {
  ensureSkeletonStyle();
  return <div className="pi-sysmon-sk" style={{ width: props.w, height: props.h ?? 7, borderRadius: 3, marginTop: props.mt ?? 0, background: "color-mix(in srgb, currentColor 10%, transparent)" }} />;
}

function LoadingSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 2 }}>
      <SkLine w="58%" h={13} />
      <SkLine w="34%" h={10} mt={2} />
      <SkLine w="30%" h={9} mt={10} />
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <SkLine w={52} h={24} />
        <SkLine w="100%" h={24} />
      </div>
      <SkLine w="100%" h={12} />
      <SkLine w="100%" h={8} />
      <SkLine w="30%" h={9} mt={8} />
      <SkLine w="100%" h={6} />
      <SkLine w="100%" h={6} />
      <SkLine w="30%" h={9} mt={8} />
      <SkLine w="100%" h={6} />
      <SkLine w="88%" h={6} />
      <SkLine w="30%" h={9} mt={8} />
      <SkLine w="100%" h={6} />
      <SkLine w="92%" h={6} />
      <SkLine w="76%" h={6} />
      <div style={{ fontSize: 11, color: "var(--text-dim,#888)", marginTop: 4 }}>{t("加载中")}…</div>
    </div>
  );
}

function MeterBar(props: { pct: number; color?: string }) {
  return (
    <div style={{ flex: 1, height: 6, background: "color-mix(in srgb, currentColor 10%, transparent)", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: Math.max(0, Math.min(100, props.pct)) + "%", height: "100%", background: props.color || "var(--text-dim,#9aa0a6)", borderRadius: 3 }} />
    </div>
  );
}

function SnapshotApp() {
  const collapsed = useBlockCollapsed(SY_KEY)[0];
  const [visible, setVisible] = useState(typeof document === "undefined" || document.visibilityState === "visible");
  const [data, setData] = useState<any>(null);
  const [paused, setPaused] = useState(false);
  const [bump, setBump] = useState(0);
  const [featTick, setFeatTick] = useState(0);
  // Session-scope interval override from the bottom toolbar (null = follow feature).
  const [intervalSel, setIntervalSel] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const hist = useRef<number[]>([]);

  // featTick in deps re-reads features after extension-manager edits.
  void featTick;
  const featInterval = clampInt(extFeatures().interval, 3, 1, 600);
  const showSensors = extFeatures().showSensors !== false;
  const intervalSec = intervalSel ?? featInterval;
  const active = !paused && visible && !collapsed;

  useEffect(() => onFeatureChange(() => setFeatTick((x: number) => x + 1)), []);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // The single sampling loop: runs only while `active`; one immediate snapshot
  // then a plain timeout chain (canceled in cleanup).
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-sysmon/snapshot"), { cache: "no-store" });
        if (stopped) return;
        if (!r.ok) setErr("HTTP " + r.status);
        else {
          const snap = await r.json();
          setErr("");
          if (snap?.cpu) hist.current = histPush(hist.current, Number(snap.cpu.load) || 0, 60);
          setData(snap);
        }
      } catch { if (!stopped) setErr("fetch failed"); }
      if (!stopped) timer = setTimeout(tick, intervalSec * 1000);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [active, intervalSec, bump]);

  const os = data?.os;
  const cpu = data?.cpu;
  const mem = data?.mem;
  const tempVal = showSensors && cpu && typeof cpu.temp === "number" ? cpu.temp : null;
  const disks: any[] = Array.isArray(data?.disks)
    ? data.disks.filter((d: any) => !/squashfs|loop|overlay|efivarfs|devtmpfs|tmpfs/i.test(String(d.type || "") + " " + String(d.fs || "")) && !/^\/sys|^\/proc/i.test(String(d.mount || "")))
    : [];
  const sensors: any[] = Array.isArray(data?.sensors) ? data.sensors : [];
  const nets: any[] = Array.isArray(data?.net) ? data.net : [];

  const btnStyle = { fontSize: 11, padding: "2px 8px", borderRadius: 6, cursor: "pointer", color: "var(--text,#1a1a1a)", background: "transparent", border: "1px solid color-mix(in srgb, currentColor 20%, transparent)" };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", overflow: "auto", fontSize: 12, color: "var(--text,#1a1a1a)", padding: "8px 12px 10px" }}>
      {!data ? (
        err
          ? <div style={{ color: "#d4574e", marginTop: 10 }}>{t("快照错误")}：{err}</div>
          : <LoadingSkeleton />
      ) : (
        <>
      {/* OS header */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px" }}>
        <b style={{ fontSize: 13 }}>{os?.hostname || "…"}</b>
        <span style={{ color: "var(--text-dim,#888)" }}>{[os?.distro, os?.kernel].filter(Boolean).join(" · ")}</span>
        <span style={{ color: "var(--text-dim,#888)" }}>{t("已运行")} {fmtUptime(os?.uptime)}</span>
      </div>

      {/* CPU */}
      <SectionLabel>CPU {cpu ? `· ${cpu.cores} ${t("核")}` : ""}</SectionLabel>
      {cpu ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
            <span style={{ fontSize: 22, fontWeight: 600, lineHeight: 1, color: loadColor(cpu.load) }}>{Math.round(cpu.load)}<span style={{ fontSize: 12, fontWeight: 400 }}>%</span></span>
            <div style={{ flex: 1 }}><Bars values={hist.current} height={26} /></div>
          </div>
          {Array.isArray(cpu.perCore) && cpu.perCore.length > 1 ? <div title={t("每核占用")}><Bars values={cpu.perCore} height={14} /></div> : null}
          <div style={{ color: "var(--text-dim,#888)", fontSize: 11 }}>
            {t("负载")} {Array.isArray(cpu.loadavg) ? cpu.loadavg.map((x: number) => Number(x).toFixed(2)).join(" / ") : "—"}
            {showSensors ? (
              <span style={{ marginLeft: 10 }}>
                {tempVal != null ? `${t("温度")} ${tempVal}°C` : <>{t("温度不可用")} <a href={DOCS_URL} target="_blank" rel="noreferrer" title={t("打开配置指南")}>{t("如何启用？")}</a></>}
              </span>
            ) : null}
          </div>
        </div>
      ) : <div style={{ color: "var(--text-dim,#888)" }}>…</div>}

      {/* Sensors (Linux hwmon chips, lm-sensors style; hidden when the platform reports none) */}
      {showSensors && sensors.length ? (
        <>
          <SectionLabel>{t("传感器")}</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {sensors.map((s: any, i: number) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span style={{ width: 84, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim,#888)" }}>{s.chip}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim,#888)" }}>{s.label}</span>
                <span style={{ marginLeft: "auto", flexShrink: 0, color: loadColor(Number(s.temp)) }}>{s.temp}°C</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {/* Memory */}
      {mem ? (
        <>
          <SectionLabel>MEM · SWAP</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 84, color: "var(--text-dim,#888)" }}>{fmtBytes(mem.used)} / {fmtBytes(mem.total)}</span>
              <MeterBar pct={mem.total ? (mem.used / mem.total) * 100 : 0} />
            </div>
            {mem.swapTotal > 0 ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 84, color: "var(--text-dim,#888)" }}>swap {fmtBytes(mem.swapUsed)} / {fmtBytes(mem.swapTotal)}</span>
                <MeterBar pct={mem.swapTotal ? (mem.swapUsed / mem.swapTotal) * 100 : 0} />
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {/* Disks */}
      {disks.length ? (
        <>
          <SectionLabel>DISK</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {disks.map((d: any, i: number) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }} title={String(d.fs) + " · " + String(d.type || "fs")}>
                <span style={{ width: 84, color: "var(--text-dim,#888)" }}>{fmtBytes(d.used)} / {fmtBytes(d.total)}</span>
                <MeterBar pct={Number(d.use)} color={d.use >= 90 ? "#d4574e" : d.use >= 80 ? "#c9a227" : undefined} />
                <span style={{ width: 72, textAlign: "right", color: "var(--text-dim,#888)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.mount}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {/* Network */}
      {nets.length ? (
        <>
          <SectionLabel>NET</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {nets.map((n: any, i: number) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", opacity: n.operState && n.operState !== "up" ? 0.55 : 1 }}>
                <span style={{ width: 84, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim,#888)" }}>{n.iface}</span>
                <span>↓ {fmtRate(n.rxSec)}</span>
                <span>↑ {fmtRate(n.txSec)}</span>
                <span style={{ marginLeft: "auto", color: "var(--text-dim,#888)", fontSize: 11 }}>Σ {fmtBytes(n.rxTotal)} / {fmtBytes(n.txTotal)}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
        </>
      )}

      {/* Toolbar (always visible, bottom) */}
      <div style={{ marginTop: "auto", paddingTop: 12, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => setPaused((p: boolean) => !p)} style={{ ...btnStyle, color: paused ? "var(--text-dim,#888)" : "var(--text,#1a1a1a)" }}>{paused ? t("恢复") : t("暂停")}</button>
        <button onClick={() => setBump((x: number) => x + 1)} style={btnStyle}>{t("刷新")}</button>
        <span style={{ marginLeft: "auto", display: "flex", gap: 4, alignItems: "center", color: "var(--text-dim,#888)", fontSize: 11 }}>
          {[2, 5, 15].map((s: number) => (
            <button key={s} onClick={() => setIntervalSel(s)} title={s + "s"}
              style={{ fontSize: 10, padding: "1px 5px", borderRadius: 5, cursor: "pointer", border: "1px solid color-mix(in srgb, currentColor 20%, transparent)", background: intervalSec === s ? "color-mix(in srgb, currentColor 12%, transparent)" : "transparent", color: "inherit" }}>{s}s</button>
          ))}
          {paused ? <span style={{ color: "#c9a227" }}>{t("已暂停")}</span> : null}
        </span>
      </div>
    </div>
  );
}

/** Left sidebar dock face: unified DockBody chrome, renders only while docked. */
export function SysmonDockFace() {
  const st = usePresent(SY_KEY);
  const open = isSidebarDockState(st);
  if (!open) return null;
  return (
    <DockBody itemKey={SY_KEY} title={t("系统状态")} icon={{ url: gaugeIconUrl() }} chrome="section" kind="dockable"
      zones={[sidebarZoneOf(SY_KEY)]} defaultZone={sidebarZoneOf(SY_KEY)}>
      <SnapshotApp />
    </DockBody>
  );
}

