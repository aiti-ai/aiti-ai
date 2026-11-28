/**
 * session-manager · topbarMobileLeading — "new session" for the phone top bar.
 *
 * A phone turns the left sidebar into a drawer, so the drawer header's "+" is unreachable
 * until the drawer opens. The host's topbarMobileLeading slot puts the same action at the
 * top bar's start (right after the sidebar toggle); the host renders it only on small
 * screens and feeds it data only (`cwd`), the action goes through the host
 * "pi-web.newSession" client service.
 *
 * Without a cwd (first run, no workspace picked yet) it renders nothing: there the
 * drawer's project list is the first step, and a button that cannot start anything would
 * only be a dead affordance.
 */
import { t, getExtService } from "./host-shim";
import { startNewSessionAt, type NewSessionService } from "./topbar-new-session.pure";

interface Props {
  /** The cwd a new session would start in (selected session's, or the fresh composer's). */
  cwd?: string | null;
}

export function TopbarNewSession({ cwd }: Props) {
  if (!cwd) return null;
  return (
    <button
      type="button"
      data-new-session="true"
      title={t("sm.newSessionIn", { path: cwd })}
      aria-label={t("sm.newSession")}
      onClick={() => { startNewSessionAt(getExtService<NewSessionService>("pi-web.newSession"), cwd); }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: "var(--top-bar-height)", height: "100%", padding: 0, flexShrink: 0,
        background: "none", border: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", transition: "color 0.12s",
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
    </button>
  );
}
