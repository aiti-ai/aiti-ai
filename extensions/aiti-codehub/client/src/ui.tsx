/**
 * Shared UI primitives + tokens for the CodeHub panels.
 */
import { extSvc, getLocale, t, useSyncExternalStore } from "./host-shim";

export const S = {
  panel: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    fontSize: 12.5,
    color: "var(--text, #ddd)",
    background: "var(--bg, transparent)",
  } as const,
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 10px",
    borderBottom: "1px solid var(--border, #3a3a3a)",
    flexWrap: "wrap",
    flexShrink: 0,
  } as const,
  body: { flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 8px 14px" } as const,
  muted: { color: "var(--text-muted, #999)", fontSize: 11.5 } as const,
  dim: { color: "var(--text-dim, #888)", fontSize: 11 } as const,
  row: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 8px",
    borderRadius: 7,
    cursor: "pointer",
    border: "1px solid transparent",
  } as const,
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "5px 8px",
    fontSize: 12,
    color: "var(--text, #ddd)",
    background: "var(--bg-panel, #141414)",
    border: "1px solid var(--border, #3a3a3a)",
    borderRadius: 6,
    outline: "none",
    fontFamily: "inherit",
  } as const,
  label: { fontSize: 11, color: "var(--text-muted, #999)", marginBottom: 3, display: "block" } as const,
  err: {
    padding: "6px 8px",
    margin: "6px 0",
    fontSize: 11.5,
    color: "var(--danger, #f87171)",
    background: "color-mix(in srgb, var(--danger, #f87171) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--danger, #f87171) 35%, transparent)",
    borderRadius: 6,
    whiteSpace: "pre-wrap",
  } as const,
  sectionTitle: { fontSize: 11.5, fontWeight: 600, color: "var(--text-muted, #bbb)", margin: "10px 0 6px" } as const,
};

export function Btn(p: {
  children?: unknown;
  onClick?: (e: any) => void;
  disabled?: boolean;
  primary?: boolean;
  small?: boolean;
  title?: string;
  style?: Record<string, unknown>;
}) {
  return (
    <button
      type="button"
      title={p.title}
      disabled={p.disabled}
      onClick={p.onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: p.small ? "2px 7px" : "4px 10px",
        fontSize: p.small ? 11 : 12,
        borderRadius: 6,
        cursor: p.disabled ? "not-allowed" : "pointer",
        opacity: p.disabled ? 0.5 : 1,
        color: p.primary ? "#fff" : "var(--text, #ddd)",
        background: p.primary ? "var(--accent, #2563eb)" : "transparent",
        border: p.primary ? "1px solid var(--accent, #2563eb)" : "1px solid var(--border, #3a3a3a)",
        fontFamily: "inherit",
        ...(p.style || {}),
      }}
    >
      {p.children}
    </button>
  );
}

export function Input(p: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  onEnter?: () => void;
  style?: Record<string, unknown>;
}) {
  return (
    <input
      type={p.type || "text"}
      value={p.value}
      disabled={p.disabled}
      placeholder={p.placeholder}
      onChange={(e: any) => p.onChange(e.target.value)}
      onKeyDown={(e: any) => {
        if (e.key === "Enter" && p.onEnter) {
          e.preventDefault();
          p.onEnter();
        }
      }}
      style={{ ...S.input, ...(p.style || {}) }}
    />
  );
}

export function Select(p: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  style?: Record<string, unknown>;
}) {
  return (
    <select
      value={p.value}
      disabled={p.disabled}
      onChange={(e: any) => p.onChange(e.target.value)}
      style={{ ...S.input, cursor: p.disabled ? "not-allowed" : "pointer", ...(p.style || {}) }}
    >
      {p.options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function Spinner(p: { text?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, ...S.muted }}>
      <span
        style={{
          width: 11,
          height: 11,
          borderRadius: "50%",
          border: "2px solid var(--border, #444)",
          borderTopColor: "var(--accent, #2563eb)",
          display: "inline-block",
          animation: "codehub-spin 0.8s linear infinite",
        }}
      />
      {p.text || t("ch.common.loading")}
    </span>
  );
}

if (typeof document !== "undefined" && !document.getElementById("codehub-spin-style")) {
  const st = document.createElement("style");
  st.id = "codehub-spin-style";
  st.textContent = "@keyframes codehub-spin { to { transform: rotate(360deg); } }";
  document.head.appendChild(st);
}

export function StateBadge(p: { state: string; status?: string }) {
  const color = p.state === "closed"
    ? "var(--text-dim, #888)"
    : p.state === "open"
      ? "var(--ok, #22c55e)"
      : "var(--accent, #2563eb)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "0 6px",
        fontSize: 10.5,
        lineHeight: "17px",
        borderRadius: 999,
        color,
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        whiteSpace: "nowrap",
      }}
    >
      {p.status || p.state}
    </span>
  );
}

export function Tag(p: { children?: unknown; title?: string }) {
  return (
    <span
      title={p.title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "0 6px",
        fontSize: 10.5,
        lineHeight: "17px",
        borderRadius: 4,
        color: "var(--text-muted, #aaa)",
        border: "1px solid var(--border, #3a3a3a)",
        whiteSpace: "nowrap",
        maxWidth: 180,
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {p.children}
    </span>
  );
}

export function Empty(p: { text: string; action?: unknown }) {
  return (
    <div style={{ padding: "26px 12px", textAlign: "center", ...S.muted }}>
      <div style={{ marginBottom: p.action ? 10 : 0 }}>{p.text}</div>
      {p.action}
    </div>
  );
}

export function ErrBox(p: { text: string; onRetry?: () => void; onSetup?: () => void }) {
  return (
    <div style={S.err}>
      {p.text}
      {p.onRetry || p.onSetup ? (
        <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
          {p.onRetry ? <Btn small onClick={p.onRetry}>{t("ch.common.retry")}</Btn> : null}
          {p.onSetup ? <Btn small onClick={p.onSetup}>{t("ch.err.setup")}</Btn> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Tabs(p: {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {p.tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => p.onChange(t.id)}
          style={{
            padding: "3px 10px",
            fontSize: 11.5,
            borderRadius: 999,
            cursor: "pointer",
            fontFamily: "inherit",
            color: p.active === t.id ? "#fff" : "var(--text-muted, #aaa)",
            background: p.active === t.id ? "var(--accent, #2563eb)" : "transparent",
            border: `1px solid ${p.active === t.id ? "var(--accent, #2563eb)" : "var(--border, #3a3a3a)"}`,
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Section(p: { title: string; right?: unknown; children?: unknown }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ ...S.sectionTitle, flex: 1 }}>{p.title}</div>
        {p.right}
      </div>
      {p.children}
    </div>
  );
}

export function fmtTime(ms?: number): string {
  if (!ms) return "";
  try {
    const loc = getLocale();
    return new Date(ms).toLocaleString(loc.startsWith("zh") ? loc : undefined, {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString().slice(5, 16).replace("T", " ");
  }
}

export function toast(text: string): void {
  try {
    const svc = extSvc<{ show?: (t: string, o?: { ms?: number }) => void }>("pi-web.toast");
    if (svc?.show) {
      svc.show(text);
      return;
    }
  } catch { /* ignore */ }
  console.log("[aiti-codehub] " + text);
}

export async function clip(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(t("ch.common.copiedClipboard"));
  } catch {
    toast(t("ch.common.copyFailed"));
  }
}

/** Float-only dialog shell (used with useGate(key,"float") in the face). */
export function FloatShell(p: {
  title: string;
  onClose: () => void;
  children?: unknown;
  width?: number;
  height?: number;
  footer?: unknown;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 311,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e: any) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <div
        data-ext-float="1"
        data-ext-float-full="1"
        data-ext-float-w={String(p.width || 820)}
        data-ext-float-h={String(p.height || 620)}
        onClick={(e: any) => e.stopPropagation()}
        style={{
          display: "flex",
          flexDirection: "column",
          width: `min(${p.width || 820}px, 94vw)`,
          height: `min(${p.height || 620}px, 86vh)`,
          overflow: "hidden",
          background: "var(--bg-panel, #1a1a1a)",
          border: "1px solid var(--border, #444)",
          borderRadius: 12,
          boxShadow: "0 18px 60px rgba(0,0,0,0.45)",
          color: "var(--text, #ddd)",
          fontSize: 12.5,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 6px", flexShrink: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</h3>
          <button
            type="button"
            aria-label={t("ch.common.close")}
            title={t("ch.common.close")}
            onClick={p.onClose}
            style={{ background: "none", border: "none", color: "var(--text-muted, #888)", cursor: "pointer", fontSize: 15, padding: "2px 8px", fontFamily: "inherit" }}
          >
            ✕
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>{p.children}</div>
        {p.footer ? <div style={{ padding: "8px 14px", borderTop: "1px solid var(--border, #3a3a3a)", flexShrink: 0 }}>{p.footer}</div> : null}
      </div>
    </div>
  );
}

export const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.14.6.66 1.05 1.28 1h.32a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  branch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  robot: '<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4M8 4h8"/><circle cx="9" cy="14" r="1"/><circle cx="15" cy="14" r="1"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  commit: '<circle cx="12" cy="12" r="4"/><path d="M12 2v6M12 16v6"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
};

export function Ic(p: { paths: string; size?: number }) {
  return (
    <svg
      width={p.size || 13}
      height={p.size || 13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: p.paths }}
    />
  );
}

/* ── i18n support ── */

/* The host re-renders its own tree on locale change, but extension clients must
 * listen themselves. Host useI18n dispatches "pi-web:locale-changed" (ExtSlots
 * exports it as LOCALE_CHANGED_EVENT). */
const LOCALE_CHANGED_EVENT = "pi-web:locale-changed";
let localeTick = 0;
const localeListeners = new Set<() => void>();
if (typeof window !== "undefined") {
  try {
    window.addEventListener(LOCALE_CHANGED_EVENT, () => {
      localeTick++;
      for (const l of localeListeners) {
        try { l(); } catch { /* ignore */ }
      }
    });
  } catch { /* non-browser build (tests) */ }
}

/** Subscribe to host locale switches: re-renders the calling component so every
 * t() in its subtree re-evaluates against the new table. Call once per top panel. */
export function useLocaleTick(): number {
  return useSyncExternalStore(
    (cb: () => void) => {
      localeListeners.add(cb);
      return () => { localeListeners.delete(cb); };
    },
    () => localeTick,
  );
}

/** t() with a caller fallback: dictionary miss returns the bare key, so this
 * substitutes the server-provided descriptor copy (auth fields / filters). */
export function tf(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

/** Normalize provider auth failures into a localized hint; anything else passes
 * through so debugging info is never swallowed. Auth failures are classified by
 * the server error code / HTTP status (stable wire contract, ForgeHttpError.code
 * = "auth" / status 401) — never by message phrasing, which is localized
 * independently of the UI locale. The regex only covers raw provider 401 copy
 * that arrives as plain strings (e.g. settings toast frames) without a code. */
export function friendlyError(e: unknown): string {
  const err = (e || {}) as { message?: unknown; code?: unknown; status?: unknown };
  const msg = String(err.message ?? e ?? "");
  const auth = err.code === "auth" || err.status === 401
    || /登录失效|无权限访问该资源|bad credentials|401 unauthorized|unauthorized|token.*(expired|invalid)/i.test(msg);
  return auth ? t("ch.err.authInvalid") : msg;
}
