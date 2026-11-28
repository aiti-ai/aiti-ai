/**
 * aiti-feedback client — compose → preview → open prefilled GitHub issue.
 *
 * The dialog preview IS the final content (redaction applied, user-confirmed
 * before redirect). Full text always goes to the clipboard as the fallback when
 * GitHub truncates the prefilled body. Zero tokens, zero server round-trips.
 *
 * i18n: abstract keys (fb.*) resolved via ctx.t against the per-locale tables
 * in index.ts (host locales are exactly "zh-CN" / "en").
 */
import { useState, useEffect } from "react";
import { t } from "./host-shim";
import { envInfo, buildMarkdown, buildIssueUrl, BODY_SAFE, type FeedbackForm, type FeedbackKind } from "./feedback-build";

// ---- module-level state (host re-renders via listener subscription) ----
interface FbState extends FeedbackForm { open: boolean; copied: boolean; hint: string }
let state: FbState = { open: false, kind: "bug", title: "", desc: "", steps: "", contact: "", context: "", includeEnv: true, copied: false, hint: "" };
const listeners = new Set<() => void>();
function fbSet(patch: Partial<FbState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
function useStateOf(): FbState {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return state;
}

/** Toolbar / ⋮ menu entry point. */
export function openFeedback(): void {
  fbSet({ open: true, copied: false, hint: "" });
}

// ---- icons (lucide paths) ----
const ICONS: Record<string, string[]> = {
  x: ["M18 6 6 18", "m6 6 12 12"],
  chat: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
  copy: ["M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"],
};

function Ic(props: { size?: number; paths: string[] }) {
  return (
    <svg width={props.size ?? 13} height={props.size ?? 13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      {props.paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

// ---- styles ----
const btn = { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12.5, cursor: "pointer" } as Record<string, string | number>;
const btnPrimary = { ...btn, background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" } as Record<string, string | number>;
const input = { width: "100%", boxSizing: "border-box", padding: "6px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg-input, transparent)", color: "var(--text)", fontSize: 12.5, fontFamily: "inherit" } as Record<string, string | number>;
const fieldLabel = { display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 4, fontWeight: 500 } as Record<string, string | number>;

const KINDS: Array<{ v: FeedbackKind; label: string }> = [
  { v: "bug", label: "fb.kind.bug" },
  { v: "suggestion", label: "fb.kind.suggestion" },
  { v: "other", label: "fb.kind.other" },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

export function FeedbackDialog() {
  const s = useStateOf();
  if (!s.open) return null;
  const env = s.includeEnv ? envInfo() : {};
  const md = buildMarkdown(s, env);
  const issue = buildIssueUrl(s.title || (s.desc ? s.desc.slice(0, 40) : ""), md);
  const missing = !s.desc.trim();

  const submit = () => {
    if (missing) { fbSet({ hint: t("fb.err.descRequired") }); return; }
    void copyText(issue.fullBody).then(() => {
      fbSet({ copied: true, hint: issue.truncated ? t("fb.err.tooLong") : "" });
      try { window.open(issue.url, "_blank", "noopener"); } catch { location.href = issue.url; }
    });
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 335, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => fbSet({ open: false })}>
      <div
        data-ext-float="1" data-ext-float-w="560" data-ext-float-autoh="1" data-ext-float-full="1"
        style={{ width: "min(560px, 94vw)", maxHeight: "86vh", overflow: "auto", padding: 16, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <b style={{ fontSize: 14, display: "inline-flex", alignItems: "center", gap: 6 }}><Ic size={15} paths={ICONS.chat} />{t("fb.open.label")}</b>
          <button onClick={() => fbSet({ open: false })} style={{ ...btn, padding: "2px 8px" }} aria-label={t("fb.close")}><Ic size={12} paths={ICONS.x} /></button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>{t("fb.hint.disclaimer")}</div>

        <label style={fieldLabel}>{t("fb.kind")}</label>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {KINDS.map((k) => (
            <button
              key={k.v} type="button"
              onClick={() => fbSet({ kind: k.v })}
              style={{ ...btn, ...(s.kind === k.v ? { background: "color-mix(in srgb, var(--accent) 14%, transparent)", borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}
            >{t(k.label)}</button>
          ))}
        </div>

        <label style={fieldLabel}>{t("fb.field.title")}</label>
        <input style={{ ...input, marginBottom: 10 }} value={s.title} placeholder={t("fb.field.title.ph")} onChange={(e) => fbSet({ title: e.target.value })} />

        <label style={fieldLabel}>{t("fb.field.desc")}</label>
        <textarea style={{ ...input, height: 72, minHeight: 72, resize: "vertical", marginBottom: 10 }} value={s.desc} placeholder={t("fb.field.desc.ph")} onChange={(e) => fbSet({ desc: e.target.value })} />

        <label style={fieldLabel}>{t("fb.field.steps")}</label>
        <textarea style={{ ...input, height: 56, minHeight: 56, resize: "vertical", marginBottom: 10 }} value={s.steps} placeholder={t("fb.field.steps.ph")} onChange={(e) => fbSet({ steps: e.target.value })} />

        <details style={{ marginBottom: 10 }}>
          <summary style={{ fontSize: 11, color: "var(--text-muted)", cursor: "pointer", userSelect: "none" }}>{t("fb.field.context")}</summary>
          <textarea style={{ ...input, height: 64, minHeight: 64, resize: "vertical", marginTop: 6 }} value={s.context} placeholder={t("fb.field.context.ph")} onChange={(e) => fbSet({ context: e.target.value })} />
        </details>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <input style={{ width: "100%", boxSizing: "border-box", padding: "6px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg-input, transparent)", color: "var(--text)", fontSize: 12.5 }} value={s.contact} placeholder={t("fb.field.contact")} onChange={(e) => fbSet({ contact: e.target.value })} />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted)", marginBottom: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={s.includeEnv} onChange={(e) => fbSet({ includeEnv: e.target.checked })} />
          {t("fb.opt.env")}
        </label>

        <label style={fieldLabel}>{t("fb.preview")}</label>
        <pre style={{ margin: "0 0 10px", padding: 10, borderRadius: 8, border: "1px solid var(--border)", background: "color-mix(in srgb, var(--text) 4%, transparent)", fontSize: 11, fontFamily: "var(--font-mono)", maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-muted)" }}>{md}</pre>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button" style={btn}
            onClick={() => { void copyText(issue.fullBody).then((ok) => fbSet({ copied: ok, hint: ok ? "" : t("fb.err.copyFailed") })); }}
          ><Ic size={12} paths={ICONS.copy} />{s.copied ? t("fb.copied") : t("fb.copy")}</button>
          <button type="button" style={{ ...btnPrimary, opacity: missing ? 0.5 : 1 }} onClick={submit} title={missing ? t("fb.err.descRequired") : undefined}>{t("fb.submit")}</button>
          <span style={{ fontSize: 11, color: issue.truncated ? "var(--danger, #ef4444)" : "var(--text-dim)" }}>{issue.truncated ? t("fb.err.tooLong") : `${md.length} / ${BODY_SAFE}`}</span>
        </div>
        {s.hint && <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--danger, #ef4444)" }}>{s.hint}</div>}
      </div>
    </div>
  );
}
