/**
 * controlled-login — External agent controlled login standard · unified frontend dialog (native h() rendering, zero build step).
 *
 * ⚠ Copy sync (byte-level copies; changes must be synced to all copies; test `_shared/controlled-login.test.mjs` pins consistency).
 * Authoritative source: pi-web-ext/_shared/controlled-login-dialog.mjs
 * Deployed copies (client side imports relative to the deployment tree — a zero-build client cannot inline ../../_shared
 * at build time the way a vite client can; the asset route rejects traversal above the tree; same convention as draft-keeper's ./core.mjs):
 *   pi-web-ext/aiti-{zcode,cursor,qoder,claude-code,codex}-agent/client/controlled-login-dialog.mjs
 *
 * Contract (docs/ext-controlled-login-standard.md §3.5):
 *   🔗 "Open authorization page" button (target=_blank) + copyable URL text + mode explanation line
 *   + status area (waiting spinner / success ✅ username / failed / timeout / cancelled, all with retry)
 *   + B mode (paste)-only code input + submit.
 * Status refresh: while the dialog is open, poll GET /login/status every 2s; stops on close
 * (the polling exception argued and decided in plan §3.6: login is a minutes-scale one-shot interaction).
 *
 * Float contract: panel root node data-ext-float="1" + data-ext-float-w/-h + data-ext-float-full="1"
 * (aiti-float takes over dragging/resizing/persistence/small-screen fullscreen; without it, its own style centers as a fallback).
 *
 * Wiring (each extension's client/controlled-login-client.mjs, two lines):
 *   import { registerControlledLoginClient } from "./controlled-login-dialog.mjs";
 *   export default function register(ctx) { registerControlledLoginClient(ctx, { … }); }
 */

// ---------- Module-scoped open state (shared by the toolbar entry and the dialogs entry within one module; never a window global) ----------
let moduleSetOpen = null;
// Under lazy loading (clientImmediately:false) the dialog component may not be mounted yet when the toolbar static entry is clicked:
// record pending; the mount effect consumes it — avoids a dead first click.
let pendingOpen = false;

/** Opens this extension's controlled login dialog (for the toolbar 🔑 button / static entry meta.onClick). */
export function openControlledLogin() {
  if (moduleSetOpen) moduleSetOpen(true);
  else pendingOpen = true;
}

// ---------- Self-contained style layer (idempotent injection; clg- prefix + var(--x, fallback), zero host coupling) ----------
const STYLE_ID = "aiti-controlled-login-styles";
const STYLES = `
.clg-mask { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.32); display: flex; align-items: center; justify-content: center; }
.clg-panel { width: 520px; max-width: calc(100vw - 16px); display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg,#fff); color: var(--text,#1a1a1a); border: 1px solid var(--border,#e0e0e0); border-radius: 12px;
  box-shadow: 0 16px 64px rgba(0,0,0,.25); font-size: 13px; line-height: 1.55; }
.clg-head { display: flex; align-items: center; gap: 10px; padding: 11px 16px; border-bottom: 1px solid var(--border,#e0e0e0); flex-shrink: 0; background: var(--bg-subtle,#f7f7f7); }
.clg-title { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
.clg-x { margin-left: auto; border: none; background: none; cursor: pointer; color: var(--text-muted,#888); font-size: 16px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
.clg-x:hover { background: var(--bg-hover,#eee); color: var(--text,#1a1a1a); }
.clg-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; }
.clg-intro { color: var(--text-muted,#777); font-size: 12.5px; }
.clg-urlrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.clg-open { display: inline-flex; align-items: center; gap: 6px; padding: 7px 16px; border: 1px solid var(--accent,#2563eb); border-radius: 8px;
  cursor: pointer; background: var(--accent,#2563eb); color: #fff; font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; }
.clg-open:hover { background: var(--accent-hover,#1d4ed8); }
.clg-url { flex: 1; min-width: 200px; font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-muted,#777);
  word-break: break-all; cursor: pointer; padding: 5px 8px; border: 1px dashed var(--border,#d8d8d8); border-radius: 6px; }
.clg-url:hover { border-color: var(--accent,#2563eb); color: var(--text,#1a1a1a); }
.clg-copied { color: #16a34a; font-size: 11.5px; }
.clg-status { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 8px; font-size: 12.5px; flex-wrap: wrap; }
.clg-status.waiting { background: rgba(37,99,235,.08); color: var(--accent,#2563eb); }
.clg-status.success { background: color-mix(in srgb, var(--ok, #22c55e) 12%, transparent); color: #16a34a; }
.clg-status.failed, .clg-status.timeout, .clg-status.cancelled { background: color-mix(in srgb, var(--danger, #ef4444) 8%, transparent); color: #dc2626; }
.clg-spin { width: 14px; height: 14px; flex-shrink: 0; border: 2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color: currentColor;
  border-radius: 50%; animation: clg-rotate .9s linear infinite; }
@keyframes clg-rotate { to { transform: rotate(360deg); } }
.clg-errline { font-size: 12px; color: #dc2626; word-break: break-all; }
.clg-tail { font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-muted,#888); background: var(--bg-subtle,#f5f5f5);
  border: 1px solid var(--border,#e0e0e0); border-radius: 8px; padding: 8px 10px; max-height: 140px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.clg-coderow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.clg-input { flex: 1; min-width: 180px; padding: 7px 10px; border: 1px solid var(--border,#d8d8d8); border-radius: 8px;
  background: var(--bg,#fff); color: var(--text,#1a1a1a); font-size: 12.5px; outline: none; }
.clg-input:focus { border-color: var(--accent,#2563eb); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent,#2563eb) 18%, transparent); }
.clg-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 14px; border: 1px solid var(--border,#d8d8d8); border-radius: 7px;
  cursor: pointer; background: var(--bg,#fff); color: var(--text,#1a1a1a); font-size: 12.5px; font-weight: 500; white-space: nowrap; }
.clg-btn:hover { background: var(--bg-hover,#f0f0f0); }
.clg-btn:disabled { opacity: .5; cursor: not-allowed; }
.clg-btn.primary { background: var(--accent,#2563eb); border-color: var(--accent,#2563eb); color: #fff; }
.clg-btn.primary:hover { background: var(--accent-hover,#1d4ed8); }
.clg-foot { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.clg-hint { color: var(--text-dim,#999); font-size: 11.5px; }
`;

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  if (typeof document === "undefined") return;
  if (!document.getElementById(STYLE_ID)) {
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = STYLES;
    document.head.appendChild(el);
  }
  stylesInjected = true;
}

/**
 * Unified dialog registration (called once from each extension client's thin shell).
 *
 * @param {*} ctx host client context (h/useState/useEffect/apiUrl/registerItems)
 * @param {object} config
 * @param {string} config.extId        extension id (used for API prefix / toolbar item id)
 * @param {string} config.toolbarLabel toolbar button title/label (e.g. "Sign in to ZCode")
 * @param {string} config.title        dialog title
 * @param {string} [config.urlHint]    A url-only mode explanation line
 * @param {string} [config.pasteHint]  B paste-relay mode explanation line
 * @param {string} [config.successHint] supplementary note after success (e.g. credentials-to-key hint)
 */
export function registerControlledLoginClient(ctx, config) {
  ensureStyles();
  const h = (...a) => ctx.h(...a);
  const useState = (v) => ctx.useState(v);
  const useEffect = (fn, deps) => ctx.useEffect(fn, deps);
  const api = (p, init) => fetch(ctx.apiUrl("/api/extensions/" + config.extId + p), { cache: "no-store", ...init });
  const jsonInit = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // ---- Toolbar entry: declarative icon button (meta.icon + meta.onClick, no render — the host uniformly renders 36×36 line-icon buttons, emoji forbidden) ----
  ctx.registerItems("toolbar", [{
    id: `${config.extId}-controlled-login`,
    meta: {
      label: config.toolbarLabel,
      title: config.toolbarLabel,
      icon: "icons/key-round.svg",
      onClick: () => openControlledLogin(),
    },
  }]);
  // ---- Dialog entry (dialogs slot; the host wraps it in a display:contents shell, the float persistence key keys on it) ----
  ctx.registerItems("dialogs", [{
    id: `${config.extId}-controlled-login-dialog`,
    render: () => h(ControlledLoginDialog),
  }]);

  function ControlledLoginDialog() {
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState(null);   // /login/status response ({state,...})
    const [busy, setBusy] = useState(false);
    const [reqError, setReqError] = useState(null); // request-layer error (network/400)
    const [code, setCode] = useState("");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
      moduleSetOpen = setOpen;
      if (pendingOpen) { pendingOpen = false; setOpen(true); }
      return () => { if (moduleSetOpen === setOpen) moduleSetOpen = null; };
    }, []);

    // While open, poll /login/status every 2s (§3.6 decided exception); stops on close
    useEffect(() => {
      if (!open) return;
      let stopped = false;
      let timer = null;
      const tick = async () => {
        try {
          const r = await api("/login/status");
          const d = await r.json();
          if (!stopped) { setStatus(d); setReqError(null); }
        } catch { /* ignore network jitter; retry next round */ }
        if (!stopped) timer = setTimeout(tick, 2000);
      };
      tick();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    }, [open]);

    if (!open) return null;

    const st = status?.state ?? "idle";
    const mode = status?.mode ?? "url";
    const pasteMode = mode === "paste";

    async function call(p, init) {
      setBusy(true); setReqError(null);
      try {
        const r = await api(p, init);
        const d = await r.json();
        if (d && d.error) setReqError(d.error);
        if (d) setStatus(d);
      } catch (e) {
        setReqError(e?.message || String(e));
      }
      setBusy(false);
    }
    const startLogin = () => call("/login/start", jsonInit({}));
    const cancelLogin = () => call("/login/cancel", jsonInit({}));
    const submitCode = () => { if (code.trim()) call("/login/submit", jsonInit({ code })); };

    async function copyUrl() {
      const url = status?.url || "";
      if (!url) return;
      try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable: the URL text itself stays selectable/copyable */ }
    }

    // ---- Status area ----
    let statusLine = null;
    if (st === "idle") {
      statusLine = h("div", { className: "clg-status waiting" }, "No login started yet");
    } else if (st === "waiting") {
      statusLine = h("div", { className: "clg-status waiting" },
        h("span", { className: "clg-spin" }),
        status?.url ? "Waiting for you to complete authorization in the browser… (auto-detected on this page, within ~2s)" : "Starting the official login process, waiting for the authorization link…",
        h("button", { className: "clg-btn", disabled: busy, style: { marginLeft: "auto" }, onClick: cancelLogin }, "Cancel"),
      );
    } else if (st === "success") {
      statusLine = h("div", { className: "clg-status success" },
        "Login successful", status?.user ? h("span", { style: { fontWeight: 700 } }, status.user) : null,
        config.successHint ? h("span", { className: "clg-hint", style: { color: "inherit" } }, config.successHint) : null,
      );
    } else if (st === "failed" || st === "timeout" || st === "cancelled") {
      const label = st === "failed" ? "Login failed" : st === "timeout" ? "Login timed out" : "Cancelled";
      statusLine = h("div", { className: "clg-status " + st },
        h("span", null, (st === "timeout" ? "⏱ " : st === "cancelled" ? "⚪ " : "❌ ") + label),
        status?.error ? h("span", { className: "clg-errline" }, status.error) : null,
      );
    }

    return h("div", { className: "clg-mask", onClick: () => setOpen(false) },
      h("div", {
        className: "clg-panel",
        "data-ext-float": "1", "data-ext-float-w": 520, "data-ext-float-h": 380, "data-ext-float-full": "1",
        onClick: (e) => e.stopPropagation(),
      },
        // ── Title bar (first child = float drag handle) ──
        h("div", { className: "clg-head" },
          h("span", { className: "clg-title" }, "🔑 " + config.title),
          h("button", { className: "clg-x", title: "Close", onClick: () => setOpen(false) }, "✕"),
        ),
        h("div", { className: "clg-body" },
          config.urlHint && !pasteMode ? h("div", { className: "clg-intro" }, config.urlHint) : null,
          pasteMode && config.pasteHint ? h("div", { className: "clg-intro" }, config.pasteHint) : null,

          // ── URL area (waiting and link captured) ──
          st === "waiting" && status?.url
            ? h("div", { className: "clg-urlrow" },
                h("a", { className: "clg-open", href: status.url, target: "_blank", rel: "noopener noreferrer" }, "Open authorization page"),
                h("span", { className: "clg-url", title: "Click to copy link", onClick: copyUrl }, status.url),
                copied ? h("span", { className: "clg-copied" }, "Copied") : null,
              )
            : null,

          // ── B mode code input (paste and waiting) ──
          pasteMode && st === "waiting"
            ? h("div", { className: "clg-coderow" },
                h("input", {
                  className: "clg-input",
                  placeholder: "Paste the code shown on the authorization-completed page (or the full callback link)",
                  value: code,
                  onChange: (e) => setCode(e.target.value),
                  onKeyDown: (e) => { if (e.key === "Enter") submitCode(); },
                }),
                h("button", { className: "clg-btn primary", disabled: busy || !code.trim(), onClick: submitCode }, busy ? "…" : "Submit code"),
              )
            : null,

          statusLine,
          reqError ? h("div", { className: "clg-errline" }, reqError) : null,

          // When a CLI upgrade changes the output format and URL capture fails: surface the raw text (human-readable and copyable, plan §7)
          (st === "failed" || st === "timeout") && status?.outputTail
            ? h("div", { className: "clg-tail" }, status.outputTail)
            : null,

          // ── Footer actions: idle/terminal states get a start/(re)try button ──
          h("div", { className: "clg-foot" },
            st === "idle" || st === "failed" || st === "timeout" || st === "cancelled" || st === "success"
              ? h("button", { className: "clg-btn primary", disabled: busy, onClick: startLogin }, busy ? "…" : st === "idle" ? "Start login" : "Retry")
              : null,
            h("span", { className: "clg-hint" }, "Authorization completes in the browser; credentials are persisted by the official CLI. Closing this page does not affect a login in progress."),
          ),
        ),
      ),
    );
  }
}
