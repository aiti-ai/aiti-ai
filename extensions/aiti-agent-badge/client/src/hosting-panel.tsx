import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ensureReadability, agentMeta, agentShort } from "./agent-meta";
import { fetchBackendUsage, localizeText, type BackendUsage, type HostingController, type HostingMode, type HostingModeOption } from "./hosting-client";
import { getLocale, showToast, t } from "./host-shim";

function tOr(key: string, fallback: string): string {
  const value = t(key);
  return !value || value === key ? fallback : value;
}

function modeLabel(mode: HostingMode | "external" | "tui-bridge" | null): string {
  if (!mode) return t("badge.mode.cold");
  return tOr(`badge.mode.${mode}`, mode);
}

function reasonText(option: HostingModeOption, controller: HostingController): string {
  if (option.reason === "only_pi") return t("badge.onlyPi");
  if (option.reason === "no_provider") return t("badge.noProvider");
  if (option.reason === "detach_unavailable") {
    return t("badge.detachUnavailable", { reason: controller.info?.detachReason || "unknown" });
  }
  return t("badge.switch.unavailable");
}

const sectionLabelStyle = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.4,
  color: "var(--text-dim, #777)",
  textTransform: "uppercase" as const,
  margin: "12px 0 6px",
};

// Two-column grid shared by all rows: the label column sizes itself to the
// longest localized label (no wrapping), values align on one edge.
const rowsGridStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(min-content, max-content) minmax(0, 1fr)",
  columnGap: 12,
  alignItems: "baseline",
  fontSize: 11.5,
  lineHeight: 1.45,
};

const rowLabelStyle = {
  padding: "3px 0",
  color: "var(--text-dim, #777)",
  whiteSpace: "nowrap" as const,
};

const rowValueStyle = {
  padding: "3px 0",
  minWidth: 0,
  color: "var(--text, #ddd)",
  overflowWrap: "anywhere" as const,
};

/** Renders as two grid items of the surrounding `rowsGridStyle` container. */
function Row(props: { label: string; value: string; title?: string; mono?: boolean }) {
  return (
    <>
      <span style={rowLabelStyle}>{props.label}</span>
      <span
        style={{ ...rowValueStyle, ...(props.mono ? { fontFamily: "var(--font-mono, monospace)", fontSize: 11 } : {}) }}
        title={props.title ?? props.value}
      >
        {props.value}
      </span>
    </>
  );
}

const fmtNum = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * Account quota row for backend sessions (get_usage capability; qoder credits/buckets today).
 * Fetches once on mount, click-to-refresh; no polling. Failure semantics: never fetched → the
 * row renders nothing; fetched before but refresh failed → last value dims with the fetch time
 * in the title (data courtesy of the backend extension, so a stale number beats no number).
 */
function QuotaRow(props: { sessionId: string }) {
  const [usage, setUsage] = useState<BackendUsage | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    fetchBackendUsage(props.sessionId).then((u) => {
      if (!alive) return;
      setBusy(false);
      if (u) {
        setUsage(u);
        setFetchedAt(Date.now());
        setStale(false);
      } else {
        setStale(true); // never fetched → stays hidden below; had a value → keep it dimmed
      }
    }).catch(() => {
      if (alive) { setBusy(false); setStale(true); }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);
  if (!usage) return null;
  const unit = usage.credits?.unit ?? "credits";
  const parts: string[] = [];
  if (usage.credits?.remaining !== undefined) parts.push(tOr("badge.quota.remaining", "{remaining} {unit} left").replace("{remaining}", fmtNum(usage.credits.remaining)).replace("{unit}", unit));
  else if (usage.credits?.usedPercent !== undefined) parts.push(tOr("badge.quota.usedPercent", "{pct}% used").replace("{pct}", fmtNum(Math.round(usage.credits.usedPercent))));
  for (const b of usage.buckets ?? []) {
    if (b.remaining !== undefined && b.total !== undefined) parts.push(`${b.name} ${fmtNum(b.remaining)}/${fmtNum(b.total)}`);
  }
  if (parts.length === 0) return null;
  const exceeded = usage.quotaExceeded === true;
  const title = [tOr("badge.quota.refreshHint", "Click to refresh"), fetchedAt ? new Date(fetchedAt).toLocaleTimeString() : "", stale ? tOr("badge.quota.stale", "Refresh failed — showing the last result") : ""].filter(Boolean).join(" · ");
  return (
    <>
      <span style={rowLabelStyle}>{tOr("badge.field.quota", "Quota")}</span>
      <span
        role="button"
        tabIndex={0}
        title={title}
        onClick={() => { if (!busy) { setStale(false); void fetchBackendUsage(props.sessionId).then((u) => { if (u) { setUsage(u); setFetchedAt(Date.now()); } else { setStale(true); } }); } }}
        style={{ ...rowValueStyle, cursor: busy ? "default" : "pointer", color: exceeded ? "var(--danger, #ef4444)" : stale ? "var(--text-dim, #777)" : "var(--text, #ddd)", opacity: stale ? 0.75 : 1 }}
      >
        {parts.join(" · ")}{exceeded ? ` · ${tOr("badge.quota.exceeded", "quota exhausted")}` : ""}
      </span>
    </>
  );
}

function OptionRow(props: {
  option: HostingModeOption;
  controller: HostingController;
  busy: boolean;
  onSelect: (option: HostingModeOption) => void;
}) {
  const { option, controller, busy } = props;
  const info = controller.info;
  if (!info) return null;
  const current = info.mode === option.mode;
  const next = info.mode === null && info.nextStartMode === option.mode;
  const unavailable = !option.available;
  const running = info.running;
  const right = current
    ? t("badge.switch.current")
    : next
      ? t("badge.switch.next")
      : unavailable
        ? t("badge.switch.unavailable")
        : null;
  const descKey = `badge.mode.${option.mode}.desc`;
  return (
    <button
      type="button"
      data-agent-badge-option={option.mode}
      data-agent-badge-active={current ? "1" : next ? "next" : "0"}
      aria-disabled={busy || unavailable || running ? "true" : "false"}
      onClick={() => props.onSelect(option)}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        width: "100%",
        textAlign: "left",
        padding: "9px 10px",
        marginBottom: 6,
        borderRadius: 8,
        border: `1px solid ${current ? "var(--accent, #2563eb)" : "var(--border, #444)"}`,
        background: current ? "var(--bg-selected, #2a2a2a)" : "transparent",
        color: "var(--text, #ddd)",
        fontFamily: "inherit",
        cursor: busy ? "default" : "pointer",
        opacity: unavailable && !running ? 0.62 : 1,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flexShrink: 0,
          width: 14,
          height: 14,
          marginTop: 1,
          borderRadius: 99,
          border: `1.5px solid ${current ? "var(--accent, #2563eb)" : "var(--text-dim, #777)"}`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {current ? (
          <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--accent, #2563eb)" }} />
        ) : next ? (
          <span style={{ width: 6, height: 6, borderRadius: 99, border: "1px solid var(--text-muted, #888)" }} />
        ) : null}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{modeLabel(option.mode)}</span>
          {right ? (
            <span
              style={{
                fontSize: 9,
                lineHeight: "15px",
                padding: "0 5px",
                borderRadius: 6,
                color: current ? "var(--accent, #2563eb)" : "var(--text-muted, #888)",
                border: `1px solid ${current ? "var(--accent, #2563eb)" : "var(--border, #444)"}`,
              }}
            >
              {right}
            </span>
          ) : null}
        </span>
        <span style={{ display: "block", marginTop: 2, fontSize: 10.5, color: "var(--text-muted, #888)", lineHeight: 1.45 }}>
          {tOr(descKey, modeLabel(option.mode))}
        </span>
        {!option.available ? (
          <span style={{ display: "block", marginTop: 2, fontSize: 10.5, color: "var(--warn, #f59e0b)" }}>
            {reasonText(option, controller)}
          </span>
        ) : null}
      </span>
      {busy && controller.switching === option.mode ? (
        <span style={{ fontSize: 10, color: "var(--text-muted, #888)", flexShrink: 0 }}>{t("badge.switching")}</span>
      ) : null}
    </button>
  );
}

export function HostingPanel(props: {
  controller: HostingController;
  isMobile: boolean;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const { controller, isMobile, anchor, onClose } = props;
  const info = controller.info;
  const [notice, setNotice] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const locale = getLocale();

  useEffect(() => {
    setNotice(null);
  }, [info?.sessionId]);

  const onSelect = async (option: HostingModeOption) => {
    if (controller.switching) return;
    if (!info) return;
    if (info.running) {
      const message = t("badge.needStop");
      setNotice(message);
      showToast(message);
      return;
    }
    if (!option.available) {
      const message = reasonText(option, controller);
      setNotice(message);
      showToast(message);
      return;
    }
    if (info.mode === option.mode) {
      setNotice(t("badge.already"));
      return;
    }
    const result = await controller.switchMode(option.mode);
    if (result.ok) {
      const message = t("badge.switched", { mode: modeLabel(option.mode) });
      setNotice(message);
      showToast(message);
    } else {
      const message = t("badge.switchFailed", { error: result.error || "unknown" });
      setNotice(message);
      showToast(message);
    }
  };

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (panelRef.current?.contains(target) || anchor?.contains(target))) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    if (isMobile) {
      setPos(null);
      return;
    }
    const panel = panelRef.current;
    if (!panel || !anchor) return;
    const update = () => {
      const rect = panel.getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      const margin = 12;
      const width = rect.width || 380;
      const height = rect.height || 420;
      const left = Math.min(Math.max(margin, a.left), Math.max(margin, window.innerWidth - width - margin));
      let top = a.top - height - 8;
      if (top < margin) top = a.bottom + 8;
      if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);
      setPos((prev) => (prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5 ? prev : { left, top }));
    };
    update();
    let observer: ResizeObserver | null = null;
    try {
      observer = new ResizeObserver(update);
      observer.observe(panel);
    } catch {
      /* layout still updates on content changes below */
    }
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      try { observer?.disconnect(); } catch { /* ignore */ }
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [isMobile, anchor, info, controller.loading, controller.error, notice]);

  const agent = info?.agent ?? "pi";
  const meta = agentMeta(agent);
  const color = ensureReadability(meta.color);
  const i18nLabel = tOr(`badge.agent.${agent}`, "");
  const serverLabel = localizeText(info?.agentLabel, locale);
  const label = serverLabel && serverLabel !== agent ? serverLabel : (i18nLabel || serverLabel || agent);
  const short = info ? agentShort(agent, label) : "…";
  const description = localizeText(info?.agentDescription, locale)
    || tOr(`badge.agent.${agent}.desc`, t("badge.agent.default.desc"));
  const hint = localizeText(info?.agentHint, locale);
  const status = info?.running ? t("badge.status.running") : info?.alive ? t("badge.status.idle") : t("badge.status.cold");
  const modeText = info
    ? info.mode
      ? modeLabel(info.mode)
      : `${t("badge.mode.cold")} · ${t("badge.mode.next", { mode: modeLabel(info.nextStartMode) })}`
    : "…";
  const backend = info?.providerType === "local"
    ? t("badge.backend.local")
    : info?.providerLabel || info?.providerType || (info?.mode === "external" ? info.agent : "—");
  const detached = info?.mode
    ? info.detached
    : info?.nextStartMode === "subprocess-detached";

  const panelStyle: any = {
    position: "fixed",
    zIndex: 1300,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    background: "var(--bg-panel, #1a1a1a)",
    border: "1px solid var(--border, #444)",
    boxShadow: "0 18px 50px rgba(0,0,0,0.35)",
    color: "var(--text, #ddd)",
    fontFamily: "inherit",
    ...(isMobile
      ? {
          left: 0,
          right: 0,
          bottom: 0,
          width: "100%",
          maxHeight: "82vh",
          borderRadius: "14px 14px 0 0",
          paddingBottom: "env(safe-area-inset-bottom)",
        }
      : {
          width: "min(380px, calc(100vw - 24px))",
          maxHeight: "min(76vh, 620px)",
          borderRadius: 12,
          ...(pos ? { left: pos.left, top: pos.top } : { left: -99999, top: -99999, visibility: "hidden" }),
        }),
  };

  return (
    <>
      {isMobile ? (
        <div
          data-agent-badge-overlay="1"
          onClick={onClose}
          style={{ position: "fixed", inset: 0, zIndex: 1299, background: "rgba(0,0,0,0.38)" }}
        />
      ) : null}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={isMobile ? "true" : "false"}
        aria-label={`${label} · ${status}`}
        data-agent-badge-panel="1"
        data-agent-badge-mode={info?.mode ?? "cold"}
        onClick={(event) => event.stopPropagation()}
        style={panelStyle}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "12px 12px 8px", flexShrink: 0 }}>
          <span
            style={{
              flexShrink: 0,
              width: 30,
              height: 30,
              borderRadius: 8,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color,
              background: meta.color + "1f",
              border: `1px solid ${color}55`,
              ...(detached ? { outline: `1px dashed ${color}aa`, outlineOffset: 2 } : {}),
            }}
          >
            {short}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
              <span style={{ fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {label}
              </span>
            </div>
            <div style={{ marginTop: 2, fontSize: 10.5, color: "var(--text-muted, #888)" }}>{status}</div>
          </div>
          <button
            type="button"
            aria-label={t("badge.close")}
            title={t("badge.close")}
            onClick={onClose}
            style={{
              flexShrink: 0,
              background: "none",
              border: "none",
              color: "var(--text-muted, #888)",
              cursor: "pointer",
              fontSize: 15,
              lineHeight: 1,
              padding: "2px 5px",
              fontFamily: "inherit",
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 12px 12px" }}>
          <p style={{ margin: "0 0 8px", fontSize: 11.5, lineHeight: 1.55, color: "var(--text-muted, #888)" }}>{description}</p>
          {hint && hint !== description ? (
            <p style={{ margin: "0 0 8px", fontSize: 10.5, lineHeight: 1.5, color: "var(--text-dim, #777)" }}>{hint}</p>
          ) : null}

          {info ? (
            <div style={{ ...rowsGridStyle, borderTop: "1px solid var(--border, #333)", paddingTop: 6 }}>
              <Row label={t("badge.field.agent")} value={agent} mono />
              <Row label={t("badge.field.backend")} value={backend} />
              <Row label={t("badge.mode.title")} value={modeText} />
              {info.runner ? <Row label={t("badge.field.detachRunner")} value={info.runner} /> : null}
              {info.alive ? <Row label={t("badge.field.detached")} value={detached ? t("badge.yes") : t("badge.no")} /> : null}
              <Row label={t("badge.field.session")} value={info.nativeSessionId} mono />
              {info.cwd ? <Row label={t("badge.field.cwd")} value={info.cwd} mono /> : null}
              {info.agentKind === "external" ? <QuotaRow key={info.sessionId} sessionId={info.sessionId} /> : null}
            </div>
          ) : null}

          {controller.error ? (
            <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--danger, #ef4444)18", color: "var(--danger, #ef4444)", fontSize: 11 }}>
              {t("badge.loadFailed", { error: controller.error })}
            </div>
          ) : null}
          {notice ? (
            <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg-selected, #2a2a2a)", color: "var(--text, #ddd)", fontSize: 11 }}>
              {notice}
            </div>
          ) : null}

          {info?.switchSupported ? (
            <div>
              <div style={sectionLabelStyle}>{t("badge.switch.title")}</div>
              {info.running ? (
                <div style={{ marginBottom: 8, padding: "6px 8px", borderRadius: 6, background: "var(--warn, #f59e0b)16", color: "var(--text-muted, #888)", fontSize: 10.5, lineHeight: 1.5 }}>
                  {t("badge.runningNotice")}
                </div>
              ) : null}
              {info.modes
                .filter((option) => option.mode !== "in-process" || info.agentKind === "pi")
                .map((option) => (
                  <OptionRow
                    key={option.mode}
                    option={option}
                    controller={controller}
                    busy={controller.switching !== null}
                    onSelect={(next) => { void onSelect(next); }}
                  />
                ))}
            </div>
          ) : info ? (
            <div style={{ marginTop: 10, padding: "7px 8px", borderRadius: 6, background: "var(--bg-selected, #2a2a2a)", color: "var(--text-muted, #888)", fontSize: 10.5, lineHeight: 1.5 }}>
              {info.switchDisabledReason === "tui-bridge"
                ? t("badge.bridgeNotice")
                : t("badge.externalNotice", { backend })}
            </div>
          ) : null}

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, borderTop: "1px solid var(--border, #333)", paddingTop: 8 }}>
            <button
              type="button"
              onClick={() => { void controller.refresh(); }}
              disabled={controller.loading}
              style={{
                background: "none",
                border: "1px solid var(--border, #444)",
                borderRadius: 6,
                color: "var(--text-muted, #888)",
                cursor: controller.loading ? "default" : "pointer",
                fontSize: 10.5,
                padding: "4px 8px",
                fontFamily: "inherit",
                flexShrink: 0,
              }}
            >
              {controller.loading ? t("badge.refreshing") : t("badge.refresh")}
            </button>
            <span style={{ fontSize: 9.5, color: "var(--text-dim, #777)", lineHeight: 1.4 }}>{t("badge.instanceHint")}</span>
          </div>
        </div>
      </div>
    </>
  );
}
