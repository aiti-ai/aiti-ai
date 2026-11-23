import { useRef, useState } from "react";
import { agentMeta, agentShort, ensureReadability } from "./agent-meta";
import { HostingPanel } from "./hosting-panel";
import { localizeText, useHosting } from "./hosting-client";
import { getLocale, t } from "./host-shim";

function tOr(key: string, fallback: string): string {
  const value = t(key);
  return !value || value === key ? fallback : value;
}

function modeText(mode: string | null, nextStart: string): string {
  if (!mode) return t("badge.mode.next", { mode: tOr(`badge.mode.${nextStart}`, nextStart) });
  return tOr(`badge.mode.${mode}`, mode);
}

/**
 * composerTools item: a 32px agent badge with a status dot.
 *
 * The same registration renders in the desktop toolbar and in the mobile +
 * sheet's bottom action area (the host renders one slot in both places).
 */
export function AgentBadge(props: { sessionId?: string | null; isMobile?: boolean }) {
  const sessionId = props.sessionId ?? null;
  const hosting = useHosting(sessionId);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  if (!sessionId) return null;

  const info = hosting.info;
  const agent = info?.agent ?? "pi";
  const meta = agentMeta(agent);
  const color = ensureReadability(meta.color);
  const locale = getLocale();
  const i18nLabel = tOr(`badge.agent.${agent}`, "");
  const label = i18nLabel || localizeText(info?.agentLabel, locale) || agent;
  const short = info ? agentShort(agent, label) : "…";
  const running = info?.running === true;
  const alive = info?.alive === true;
  const detached = (info?.detached || info?.detachedPreference) === true;
  const status = running
    ? t("badge.status.running")
    : alive
      ? t("badge.status.idle")
      : t("badge.status.cold");
  const mode = info ? modeText(info.mode, info.nextStartMode) : "";
  const title = `${label} · ${status}${mode ? " · " + mode : ""}`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-agent-badge="1"
        data-agent-badge-agent={agent}
        data-agent-badge-state={running ? "running" : alive ? "idle" : "cold"}
        data-agent-badge-mode={info?.mode ?? "cold"}
        data-agent-badge-detached={detached ? "1" : "0"}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open ? "true" : "false"}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => {
          if (!open) void hosting.refresh(true);
          setOpen(!open);
        }}
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          padding: 0,
          background: hover || open ? "var(--bg-hover, #262626)" : "none",
          border: "none",
          borderRadius: 9,
          cursor: "pointer",
          color: "var(--text-muted, #888)",
          transition: "background 0.12s",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 21,
            height: 21,
            borderRadius: 7,
            fontSize: short.length > 2 ? 8 : 9.5,
            fontWeight: 800,
            letterSpacing: "-0.02em",
            lineHeight: 1,
            color,
            background: meta.color + "1f",
            border: `1px solid ${color}55`,
            ...(detached ? { outline: `1px dashed ${color}aa`, outlineOffset: 2 } : {}),
          }}
        >
          {short}
        </span>
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 3,
            right: 2,
            width: 7,
            height: 7,
            borderRadius: 99,
            background: running ? "var(--ok, #22c55e)" : alive ? "var(--text-muted, #888)" : "transparent",
            border: alive ? "1px solid var(--bg-panel, #1a1a1a)" : "1px solid var(--text-dim, #777)",
            boxShadow: running ? "0 0 0 2px rgba(34,197,94,0.22)" : undefined,
          }}
        />
      </button>
      {open ? (
        <HostingPanel
          controller={hosting}
          isMobile={Boolean(props.isMobile)}
          anchor={buttonRef.current}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
