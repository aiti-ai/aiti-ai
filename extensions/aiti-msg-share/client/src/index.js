/**
 * aiti-msg-share client — share dialog, target manager and host entry points.
 *
 * Renders via ctx.h and the host's dialogs slot (data-ext-float contract).
 * Other extensions call our service: aiti-msg-share.openShare(payload).
 * QR codes are generated here (browser side) with qrcode — the provider package
 * stops at URL generation.
 */
import QRCode from "qrcode";

const RECENT_KEY = "pi-web:recent-share-targets";
const API = (path) => `/api/extensions/aiti-msg-share/${path}`;

/** i18n lookup via host ctx.t (extman pattern); {param} interpolation. */
let tFn = null;
function kindLabel(k) { return shareT("share.kind." + k); }
function shareT(key, params) {
  if (!tFn) return key;
  try {
    const raw = tFn(key, params);
    if (!params) return raw;
    return raw.replace(/\{(\w+)\}/g, (_m, k) => String(params[k] ?? ""));
  } catch { return key; }
}

let h = null;
let ctxRef = null;
let apiUrlFn = null;
const state = {
  open: false, manager: false, loading: true,
  targets: [], history: [],
  payload: null, kind: "message", text: "", rawText: "", baseText: "", title: "", tags: "",
  // Which page-context fields get prepended to the shared content (multi-select).
  stamp: { os: true, browser: true, url: false, sessionId: true, sessionName: true },
  targetId: null, meta: {}, redact: true, redactHits: [],
  result: null, busy: false, error: "", errorDetail: "", errorCode: "", errorTarget: "", errorProvider: "", search: "", probe: [],
  editing: null, form: {},
  /** Local favourite sinks (share-sink topic): { ok, message, action } of the last run. */
  sinkResult: null, sinkBusy: "",
};
const listeners = new Set();

function api(path) {
  // Use the host's apiUrl() (basePath-aware, /dev-safe) when available; fall back
  // to the absolute extension API path otherwise.
  return apiUrlFn ? apiUrlFn(`/api/extensions/aiti-msg-share/${path}`) : API(path);
}
async function getJSON(path, opts) {
  let r, data;
  try {
    r = await fetch(api(path), opts);
  } catch (e) {
    const err = new Error(`无法连接 pi-web 服务：${e?.message || e}`);
    err.detail = String(e?.message || e);
    throw err;
  }
  data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) {
    const err = new Error(data.error || `HTTP ${r.status} (${api(path)})`);
    err.detail = data.detail || `${r.status} ${api(path)}`;
    err.kind = data.errorCode || data.errorKind;
    err.targetId = data.errorTarget;
    err.providerLabel = data.providerLabel;
    throw err;
  }
  return data;
}

function recentGet() {
  try { return JSON.parse(window.localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
}
function recentAdd(id) {
  if (!id) return;
  const next = [id, ...recentGet().filter((x) => x !== id)].slice(0, 10);
  try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
}
function recentClear() { try { window.localStorage.removeItem(RECENT_KEY); } catch {} }

function set(partial) { Object.assign(state, partial); emit(); }

/** Pick a target for the pending share and return to the share dialog. */
function chooseTarget(id) {
  recentAdd(id);
  set({ targetId: id, manager: false, editing: null, error: "", errorDetail: "" });
}
function emit() { listeners.forEach((fn) => fn()); }

// Content-kind labels resolved via shareT() at render time; status uses icons only.
const STATUS_ICONS = { recent: "🕘", recommended: "★", dead: "⚠", legacy: "⚠" };
const CFG_BADGE = {
  anonymous: { icon: "🟢", key: "share.cfg.anonymous", color: "var(--accent, #4d8dff)" },
  ready: { icon: "✓", key: "share.cfg.ready", color: "var(--accent, #4d8dff)" },
  "needs-setup": { icon: "🟠", key: "share.cfg.needs", color: "#d9a13c" },
  dead: { icon: "💀", key: "share.cfg.dead", color: "var(--text-muted, #8b909b)" },
};

const ICONS = {
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.5" x2="15.4" y2="6.5"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21h-4v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1L4.1 16.6l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 13.5H3v-3h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.3 7.5 7.1 4.7l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.6V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1H21v4h-.1a1.7 1.7 0 0 0-1.6 1z"/>',
};

function icon(name, size = 13) {
  const markup = ICONS[name];
  if (!markup) return null;
  // The glyphs mix circles/lines/paths, so the markup must land in the DOM as
  //-is (a single <path d> wrapper would render nothing — that was the bug that
  // made the share icon invisible on the message buttons).
  return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
    dangerouslySetInnerHTML: { __html: markup } });
}

// Share icon handed to topic consumers (session-manager more-menu, editor
// toolbars, msg-smart popover): { svg } = inner markup of a 24×24 line icon,
// the same form manifest declarative icons use; consumers without {svg}
// support ignore it and keep their text label.
const SHARE_ICON = { svg: ICONS.share };

function btn(label, onClick, opts = {}) {
  return h("button", {
    type: "button", onClick,
    title: opts.title || label,
    style: { border: "1px solid " + (opts.primary ? "var(--accent, #4d8dff)" : "var(--border, #34363c)"),
      background: opts.primary ? "var(--accent, #4d8dff)" : "var(--bg-hover, #25272c)", color: opts.primary ? "#fff" : "var(--text, #d8dade)",
      borderRadius: 7, padding: "5px 12px", fontSize: 12, cursor: "pointer", opacity: opts.disabled ? 0.5 : 1 },
    disabled: opts.disabled,
  }, label);
}

/** Open the share dialog with a payload (also the cross-extension service). */
function openShare(payload = {}) {
  const kind = payload.kind || "message";
  const raw = payload.text || "";
  primeSinks();
  set({ open: true, manager: false, payload, kind,
    text: raw, rawText: raw, baseText: raw, title: payload.title || "",
    tags: payload.tags || "", targetId: payload.targetId || null,
    result: null, error: "", errorDetail: "", errorCode: "", errorTarget: "", errorProvider: "", redact: true, redactHits: [],
    sinkResult: null, sinkBusy: "" });
  void refresh();
  // Compose from scratch so the page-info stamp reflects this dialog's context.
  void refreshPreview();
  return true;
}

async function refresh(force = false) {
  set({ loading: true });
  try {
    const [catalog, history, probe] = await Promise.all([
      getJSON("catalog"), getJSON("history"), getJSON("probe", { method: "POST" }).catch(() => ({ services: [] })),
    ]);
    const targets = catalog.targets || [];
    set({ targets, history: history.items || [], probe: probe.services || [], loading: false,
      targetId: state.targetId || targets.find((t) => t.recommended)?.id || targets[0]?.id });
    if (force) await getJSON("refresh", { method: "POST" }).catch(() => {});
  } catch (e) { set({ loading: false, error: e.message, errorDetail: e.detail || "catalog/history" }); }
}

function targetCard(target, selected, badge) {
  const disabled = target.status === "dead" || target.enabled === false;
  return h("button", { type: "button", key: target.id, disabled,
    onClick: () => set({ targetId: target.id, error: "" }),
    title: target.note || target.name,
    style: { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px",
      border: "1px solid " + (selected ? "var(--accent, #4d8dff)" : "var(--border, #34363c)"), borderRadius: 8,
      background: selected ? "rgba(77, 141, 255, 0.15)" : "var(--bg-hover, #25272c)", color: disabled ? "var(--text-muted, #8b909b)" : "var(--text, #d8dade)",
      fontSize: 12, cursor: "pointer", opacity: disabled ? 0.45 : 1 } },
    h("span", null, STATUS_ICONS[badge] || "🔗"),
    target.name || target.id,
    ...(target.kinds?.length ? [h("span", { style: { color: "var(--text-muted, #8b909b)", fontSize: 10 } },
      target.kinds.map(kindLabel).join("/"))] : []),
    ...(() => { const b = CFG_BADGE[target.configState]; return b
      ? [h("span", { title: shareT(b.key), style: { fontSize: 10 } }, b.icon)] : []; })());
}

/**
 * Local "favourite" sinks — the second, semantically different provider family.
 *
 * Contract (owned here): other extensions publish to the `share-sink` topic:
 *   { id, order?, label, icon? { svg }, accepts?(payload), save(payload) → { ok, message?, action?: { label, run } } }
 * Sinks store locally (no upload, no URL, no redaction) — unlike content-share *target*
 * providers, which are upload destinations. payload.text is the UNREDACTED body on purpose.
 *
 * A built-in "copy" sink always exists, mirroring mobile share sheets where copy/save sit
 * next to the network targets.
 */
/** Fixed sink partners shipped with this product (commands + prompt snippets). Lazy clients
 *  register their sink only after materializing, so opening the dialog primes them once;
 *  any other provider that happens to be loaded is picked up by the topic read anyway. */
const SINK_PRIME_EXTS = ["aiti-cmd", "aiti-prompts"];
let sunkPrimed = false;
function primeSinks() {
  if (sunkPrimed) return;
  sunkPrimed = true;
  const ensure = ctxRef?.ensureMaterialized;
  if (typeof ensure !== "function") return;
  for (const id of SINK_PRIME_EXTS) {
    try { Promise.resolve(ensure(id)).then(() => emit()).catch(() => {}); } catch (e) { /* ignore */ }
  }
}

function sinkItems() {
  const items = [];
  items.push({
    id: "copy", order: -1000, builtin: true,
    get label() { return shareT("share.sink.copy"); },
    icon: { svg: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>' },
    run: async () => {
      try { await navigator.clipboard.writeText(state.text); return { ok: true, message: shareT("share.sink.copied") }; }
      catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
    },
  });
  try {
    for (const it of (ctxRef?.getTopicItems?.("share-sink") || [])) if (it && it.id) items.push(it);
  } catch (e) { /* topic registry absent (old host) — copy only */ }
  return items.sort((a, b) => (Number(a.order) || 100) - (Number(b.order) || 100));
}

/** Strip the "page info" stamp block (leading `> **Label**: value` lines) from a body. */
function stripStamp(text) {
  const lines = String(text || "").split("\n");
  let i = 0;
  while (i < lines.length && /^>\s*\*\*[^*]+\*\*\s*:/.test(lines[i])) i++;
  return lines.slice(i).join("\n").trim();
}

/** Sink payload: original body (unredacted, page-info stamp removed) + share metadata. */
function sinkPayload() {
  // baseText is the unredacted body; when it is empty the textarea content is the only source
  // (e.g. a session share fills the body server-side, so the preview holds the stamp only).
  // Either way the stamp is metadata for external sharing — never part of a local favourite.
  const raw = (typeof state.baseText === "string" && state.baseText.length) ? state.baseText : state.text;
  return { ...(state.payload || {}), kind: state.kind, text: stripStamp(raw), title: state.title, tags: state.tags };
}

async function runSink(item) {
  if (state.sinkBusy) return;
  const payload = sinkPayload();
  if (!item.builtin && typeof item.accepts === "function") {
    let ok = false;
    try { ok = !!item.accepts(payload); } catch (e) { ok = false; }
    if (!ok) {
      const empty = !String(payload.text || "").trim();
      set({ sinkResult: { ok: false, message: empty ? shareT("share.sink.empty") : shareT("share.sink.unsupported") } });
      return;
    }
  }
  set({ sinkBusy: item.id, sinkResult: null });
  try {
    const r = item.builtin ? await item.run(payload) : await item.save(payload);
    set({ sinkBusy: "", sinkResult: r || { ok: true } });
  } catch (e) {
    set({ sinkBusy: "", sinkResult: { ok: false, message: String((e && e.message) || e) } });
  }
}

function sinkSection() {
  const items = sinkItems();
  if (!items.length) return null;
  const res = state.sinkResult;
  return h("div", null,
    h("div", { style: { color: "var(--text-muted, #8b909b)", fontSize: 11, marginBottom: 5 } }, shareT("share.sinks")),
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
      ...items.map((it) => {
        const label = typeof it.label === "function" ? it.label() : (it.label || it.id);
        const svg = it.icon && it.icon.svg;
        return h("button", {
          type: "button", key: it.id, disabled: !!state.sinkBusy,
          onClick: () => { void runSink(it); },
          title: label,
          style: { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px",
            border: "1px solid var(--border, #34363c)", borderRadius: 8,
            background: "var(--bg-hover, #25272c)", color: "var(--text, #d8dade)",
            fontSize: 12, cursor: state.sinkBusy ? "default" : "pointer", opacity: state.sinkBusy && state.sinkBusy !== it.id ? 0.55 : 1 },
        },
          svg ? h("span", { style: { display: "inline-flex" }, dangerouslySetInnerHTML: { __html: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>` } }) : null,
          label,
          state.sinkBusy === it.id ? h("span", { style: { fontSize: 10, opacity: 0.7 } }, "…") : null,
        );
      })),
    res ? h("div", { style: { marginTop: 6, fontSize: 11, display: "flex", alignItems: "center", gap: 8,
        color: res.ok ? "var(--ok, #4ade80)" : "#e05d5d", wordBreak: "break-word" } },
      h("span", null, (res.ok ? "✓ " : "⚠ ") + (res.message || (res.ok ? shareT("share.sink.saved") : ""))),
      res.ok && res.action && typeof res.action.run === "function"
        ? h("button", { type: "button", onClick: () => { try { res.action.run(); } catch (e) {} },
            style: { border: "1px solid var(--accent, #4d8dff)", background: "none", color: "var(--accent, #4d8dff)",
              borderRadius: 6, padding: "1px 8px", fontSize: 11, cursor: "pointer" } }, res.action.label || "→")
        : null) : null);
}

function targetSection() {
  const recent = recentGet();
  const t = state.targets;
  const byId = new Map(t.map((x) => [x.id, x]));
  const recentItems = recent.map((id) => byId.get(id)).filter(Boolean).slice(0, 5);
  // Targets the user has configured (saved) are always visible here.
  const mine = t.filter((x) => x.custom && !recent.includes(x.id));
  const recs = t.filter((x) => x.recommended && !recent.includes(x.id) && !x.custom).slice(0, 8);
  const shown = [];
  for (const item of recentItems) shown.push(targetCard(item, state.targetId === item.id, "recent"));
  for (const item of mine) shown.push(targetCard(item, state.targetId === item.id, null));
  for (const item of recs) shown.push(targetCard(item, state.targetId === item.id, "recommended"));
  // Currently selected but not in any of the above (picked from the manager).
  const sel = byId.get(state.targetId);
  if (sel && !recent.includes(sel.id) && !sel.custom && !sel.recommended) {
    shown.unshift(targetCard(sel, true, null));
  }
  shown.push(h("button", { type: "button", onClick: () => set({ manager: true }),
    style: { border: "1px dashed var(--border, #34363c)", background: "none", color: "var(--text-muted, #8b909b)",
      borderRadius: 8, padding: "4px 10px", fontSize: 12, cursor: "pointer" } }, shareT("share.more")));
  return h("div", null,
    h("div", { style: { color: "var(--text-muted, #8b909b)", fontSize: 11, marginBottom: 5 } }, shareT("share.targets")),
    h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, ...shown));
}

/** Collect page context for the optional "page info" stamp. */
function pageInfo() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  let os = "";
  if (/Windows NT 10|Windows NT 11/.test(ua)) os = "Windows 10/11";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";
  let browser = "";
  const b = (re, name) => { const m = ua.match(re); if (m) browser = name + " " + (m[1] || ""); };
  b(/Edg\/([\d.]+)/, "Edge");
  if (!browser) b(/OPR\/([\d.]+)/, "Opera");
  if (!browser) b(/Chrome\/([\d.]+)/, "Chrome");
  if (!browser) b(/Firefox\/([\d.]+)/, "Firefox");
  if (!browser) b(/Version\/([\d.]+).*Safari/, "Safari");
  const svc = ctxRef?.getExtService?.("pi-web.session");
  const cur = (() => { try { return svc?.get?.() ?? svc; } catch { return null; } })();
  // Verified snapshot summary: name/firstMessage live under `session`, not on the snapshot itself.
  const sum = cur?.session || null;
  // A shared session row (session-manager menu payload) describes its own session and wins
  // over the currently active one.
  const rowSess = state.payload?.session;
  // List title semantics (session-manager sessionTitle): name || first message || id prefix.
  const listTitle = (s) => (s ? (s.name || s.firstMessage || String(s.id || "").slice(0, 12)) : "");
  // Session ID is the raw canonical id, never the display title: row id → snapshot summary id
  // → verified snapshot id → payload id → URL ?session=.
  const sessionId = rowSess?.id || sum?.id || cur?.sessionId
    || state.payload?.sessionId || state.payload?.sessionName
    || (typeof location !== "undefined" ? new URL(location.href).searchParams.get("session") : "") || "";
  // Session name follows the session list title so it stays meaningful even when the
  // session has no explicit name (falls back to first message, then id prefix).
  const sessionName = listTitle(rowSess) || listTitle(sum) || state.payload?.sessionName || "";
  return { os, browser, url: typeof location !== "undefined" ? location.href : "", sessionId, sessionName };
}

const STAMP_LABELS = { os: "share.pi.os", browser: "share.pi.browser", url: "share.pi.url", sessionId: "share.pi.sessionId", sessionName: "share.pi.sessionName" };

/** Build the stamp block from the selected fields. */
function stampBlock(stamp = state.stamp) {
  const info = pageInfo();
  const lines = [];
  for (const key of Object.keys(STAMP_LABELS)) {
    if (!stamp?.[key]) continue;
    const value = info[key];
    if (!value) continue;
    lines.push(`> **${shareT(STAMP_LABELS[key])}**: ${value}`);
  }
  return lines.length ? lines.join("\n") + "\n\n" : "";
}

/** Final text = stamp block + base text. */
function composeText() {
  return stampBlock() + (state.baseText ?? "");
}

/** Render a localized error message from the server's stable errorCode. */
function errorText() {
  const code = state.errorCode || "";
  const name = state.errorProvider || (state.targets.find((t) => t.id === state.errorTarget)?.name) || state.errorTarget || "";
  const rawDetail = state.errorDetail || "";
  // Provider errors can carry stack traces; keep the first meaningful chunk.
  const detail = rawDetail.length > 220 ? rawDetail.slice(0, 220) + "…" : rawDetail;
  const key = {
    network: "share.err.network", timeout: "share.err.timeout", incomplete: "share.err.incomplete",
    auth: "share.err.auth", tooLarge: "share.err.tooLarge", unavailable: "share.err.unavailable",
    disabled: "share.err.disabled", unknownTarget: "share.err.unknownTarget",
    noSession: "share.err.noSession", imageFetch: "share.err.imageFetch", endpoint: "share.err.endpoint",
    badRequest: "share.err.badRequest", badSxcu: "share.err.badSxcu", noProbe: "share.err.noProbe",
    forbidden: "share.err.forbidden",
  }[code];
  if (key) return shareT(key, { name, detail });
  return state.error || shareT("share.err.generic", { detail });
}

/** Rebuild the preview after stamp/redact changes. */
async function refreshPreview() {
  const raw = composeText();
  set({ rawText: raw });
  await applyRedaction(raw, state.redact);
}

/** Checkbox group for page-context stamping (rendered in the preview header). */
function stampToggles() {
  return h("span", { style: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } },
    ...Object.keys(STAMP_LABELS).map((key) => h("label", { key, title: shareT(STAMP_LABELS[key]),
      style: { display: "flex", gap: 3, alignItems: "center", cursor: "pointer", fontSize: 10,
        color: state.stamp[key] ? "var(--accent, #4d8dff)" : "var(--text-muted, #8b909b)" } },
      h("input", { type: "checkbox", checked: !!state.stamp[key],
        onChange: (e) => {
          set({ stamp: { ...state.stamp, [key]: e.target.checked } });
          void refreshPreview();
        } }),
      shareT(STAMP_LABELS[key]))));
}
async function applyRedaction(raw, redact) {
  try {
    const r = await getJSON("preview-redact", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: raw, redact }) });
    set({ text: r.text, redactHits: r.hits || [], redact });
  } catch (e) {
    // Server unavailable → keep showing raw text with no redaction claim.
    set({ text: raw, redactHits: [], redact });
  }
}

function previewSection() {
  return h("div", null,
    // Header row: label | page-info multi-select | redact toggle
    h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 5, flexWrap: "wrap" } },
      h("span", { style: { color: "var(--text-muted, #8b909b)", fontSize: 11 } }, shareT("share.preview")),
      h("span", { style: { color: "var(--text-muted, #8b909b)", fontSize: 10, opacity: 0.8 } }, shareT("share.pageInfo") + ":"),
      stampToggles(),
      h("label", { title: shareT("share.redactAuto"),
        style: { marginLeft: "auto", display: "flex", gap: 5, alignItems: "center", cursor: "pointer",
          fontSize: 11, color: state.redactHits.length ? "#d9a13c" : "var(--text-muted, #8b909b)" } },
        h("input", { type: "checkbox", checked: state.redact, onChange: (e) => {
          set({ redact: e.target.checked });
          void applyRedaction(state.rawText, e.target.checked);
        } }), shareT("share.redactToggle"),
        state.redactHits.length ? ` (${state.redactHits.reduce((a, b) => a + b.count, 0)})` : "")),
    h("textarea", { value: state.text, onInput: (e) => {
      const v = e.target.value;
      // Direct edits replace the body; the stamp block (if any) stays as typed.
      set({ text: v, rawText: v, baseText: v, redactHits: [] });
    },
      style: { width: "100%", minHeight: 100, resize: "vertical", background: "var(--bg-hover, #25272c)",
        border: "1px solid var(--border, #34363c)", color: "var(--text, #d8dade)", borderRadius: 8, padding: 9,
        font: "12px/1.6 ui-monospace, Consolas, monospace" } }),
    ...(state.redactHits.length ? [h("div", { style: { color: "#d9a13c", fontSize: 11, marginTop: 4 } },
      "🛡 " + state.redactHits.map((x) => `${x.rule}×${x.count}`).join(" · "))] : []));
}

function resultSection() {
  const r = state.result;
  const rurl = r.url;
  const isDeep = /^(joplin|obsidian|siyuan):/.test(rurl);
  return h("div", { style: { border: "1px solid #3fbf6e55", background: "#3fbf6e10", borderRadius: 9,
      padding: 11, display: "flex", gap: 12, alignItems: "center" } },
    h("div", { style: { flex: 1, minWidth: 0 } },
      h("a", { href: rurl, target: "_blank", rel: "noopener noreferrer", title: shareT("share.openInNewTab") || rurl,
        style: { color: "var(--accent, #4d8dff)", fontFamily: "monospace", fontSize: 12, wordBreak: "break-all",
          textDecoration: "none", cursor: "pointer" },
        onMouseEnter: (e) => { e.currentTarget.style.textDecoration = "underline"; },
        onMouseLeave: (e) => { e.currentTarget.style.textDecoration = "none"; } }, rurl),
      h("div", { style: { display: "flex", gap: 7, marginTop: 9, flexWrap: "wrap" } },
        btn(shareT("share.copy"), () => navigator.clipboard?.writeText(rurl).catch(() => {})),
        !isDeep && typeof navigator !== "undefined" && navigator.share
          ? btn(shareT("share.system"), () => navigator.share({ url: rurl, title: state.title }).catch(() => {})) : null,
        r.extra?.rawUrl ? h("a", { href: r.extra.rawUrl, target: "_blank", rel: "noopener",
          style: { fontSize: 12, color: "var(--accent, #4d8dff)" } }, shareT("share.raw")) : null,
        r.extra?.deletionUrl ? h("a", { href: r.extra.deletionUrl, target: "_blank", rel: "noopener",
          style: { fontSize: 12, color: "#e05d5d" } }, shareT("share.delete")) : null)),
    h("canvas", { ref: (el) => { if (el && !isDeep) QRCode.toCanvas(el, rurl, { width: 84, margin: 1 }).catch(() => {}); },
      style: { display: isDeep ? "none" : "block", width: 84, height: 84, background: "#fff", borderRadius: 6, padding: 4 } }));
}

async function doShare() {
  if (!state.targetId || state.busy) return;
  set({ busy: true, error: "" });
  try {
    // The textarea already shows the redacted text (preview-redact ran on load/toggle),
    // so upload exactly what the user sees; no second redaction on the server.
    const body = { ...(state.payload || {}), targetId: state.targetId, kind: state.kind,
      text: state.text, title: state.title, tags: state.tags, redact: false };
    const r = await getJSON("share", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body) });
    recentAdd(state.targetId);
    set({ result: r, busy: false, redactHits: r.hits || [] });
  } catch (e) {
    set({ busy: false, error: e.message, errorDetail: e.detail || api("share"),
      errorCode: e.kind || "", errorTarget: e.targetId || "", errorProvider: e.providerLabel || "" });
  }
}

/** Dialog component: React-managed re-render via a subscription + tick. */
let dialogBodyEl = null;
function ShareDialogHost() {
  const [, setTick] = ctxRef.useState(0);
  ctxRef.useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  const result = state.result;
  ctxRef.useEffect(() => {
    // When a share result arrives, scroll the body to reveal the URL/QR block.
    if (result && dialogBodyEl) {
      try { dialogBodyEl.scrollTop = dialogBodyEl.scrollHeight; } catch (e) {}
    }
  }, [result]);
  return shareDialog();
}

function shareDialog() {
  if (!state.open) return null;
  if (state.manager) return managerDialog();
  const head = h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", flexShrink: 0,
      borderBottom: "1px solid var(--border, #34363c)", background: "var(--bg-hover, #25272c)", borderRadius: "9px 9px 0 0" } },
    h("span", { style: { fontWeight: 600 } }, shareT("share.action")),
    h("span", { style: { color: "var(--text-muted, #8b909b)", fontSize: 11 } }, shareT("share.subtitle", { kind: state.kind, chars: state.text.length })),
    h("div", { style: { flex: 1 } }),
    h("button", { type: "button", onClick: () => set({ open: false }),
      style: { background: "none", border: "none", color: "var(--text-muted, #8b909b)", cursor: "pointer", fontSize: 14 } }, "✕"));
  const body = h("div", { ref: (el) => { dialogBodyEl = el; },
    style: { padding: "12px 14px", display: "flex", flexDirection: "column", gap: 12, flex: 1, minHeight: 0, overflowY: "auto" } },
    previewSection(), sinkSection(), targetSection(),
    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 } },
      h("input", { value: state.title, placeholder: shareT("share.titleField"), onInput: (e) => set({ title: e.target.value }),
        style: { background: "var(--bg-hover, #25272c)", border: "1px solid var(--border, #34363c)", color: "var(--text, #d8dade)", borderRadius: 7, padding: "6px 9px", fontSize: 12 } }),
      h("input", { value: state.tags, placeholder: shareT("share.tagsField"), onInput: (e) => set({ tags: e.target.value }),
        style: { background: "var(--bg-hover, #25272c)", border: "1px solid var(--border, #34363c)", color: "var(--text, #d8dade)", borderRadius: 7, padding: "6px 9px", fontSize: 12 } })),
    state.error ? h("div", { style: { border: "1px solid #e05d5d66", background: "#e05d5d18", borderRadius: 8,
        padding: "8px 10px", color: "#e05d5d", fontSize: 12, userSelect: "text", cursor: "text", wordBreak: "break-word" } },
        errorText(),
        state.errorDetail && state.errorDetail !== errorText()
          ? h("div", { style: { fontSize: 10, opacity: 0.75, marginTop: 4, fontFamily: "monospace" } }, state.errorDetail) : null,
        state.errorTarget ? h("div", { style: { marginTop: 6 } },
          h("button", { type: "button", onClick: () => set({ manager: true, editing: state.errorTarget } ),
            style: { border: "1px solid #e05d5d", background: "none", color: "#e05d5d", borderRadius: 6,
              padding: "3px 9px", fontSize: 11, cursor: "pointer" } }, shareT("share.fixTarget"))) : null) : null,
    state.result ? resultSection() : null);
  // Footer is pinned outside the scroll area so the action buttons never clip.
  const footer = h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0,
      padding: "10px 14px", borderTop: "1px solid var(--border, #34363c)", background: "var(--bg-hover, #25272c)" } },
    btn(shareT("share.manage"), () => set({ manager: true,
      ...(state.errorTarget ? { editing: state.errorTarget } : {}) })),
    btn(state.busy ? shareT("share.uploading") : shareT("share.action"), doShare, { primary: true, disabled: state.busy }));
  return h("div", { "data-ext-float": "1", "data-ext-float-w": "640", "data-ext-float-h": "520",
    style: { background: "var(--bg-panel, #1e2021)", border: "1px solid var(--border, #34363c)", borderRadius: 10,
      boxShadow: "0 14px 44px #000a", overflow: "hidden", font: "13px/1.5 system-ui, sans-serif", color: "var(--text, #d8dade)",
      display: "flex", flexDirection: "column", maxHeight: "88vh" } }, head, body, footer);
}

function managerDialog() {
  const q = state.search.toLowerCase();
  const groups = { recent: [], recommended: [], all: [] };
  const recentIds = recentGet();
  for (const t of state.targets) {
    if (q && !(t.name || t.id).toLowerCase().includes(q)) continue;
    if (recentIds.includes(t.id)) groups.recent.push(t);
    else if (t.recommended) groups.recommended.push(t);
    else groups.all.push(t);
  }
  const item = (t) => h("div", { key: t.id, onClick: () => set({ editing: t.id,
      form: { ...((t.values && !Array.isArray(t.values)) ? t.values : {}) } }),
    style: { display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: 7, cursor: "pointer",
      background: state.editing === t.id ? "rgba(77, 141, 255, 0.15)" : "none", opacity: t.status === "dead" ? 0.5 : 1 } },
    h("span", null, t.status === "dead" ? "💀" : t.category === "archive" ? "📓" : "🔗"),
    h("div", { style: { flex: 1, minWidth: 0 } },
      h("div", { style: { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, t.name || t.id),
      h("div", { style: { fontSize: 10, color: "var(--text-muted, #8b909b)" } }, (t.kinds || []).map(kindLabel).join("/") + (t.note ? " · " + t.note : ""))),
    (() => { const b = CFG_BADGE[t.configState]; return b ? h("span", { title: shareT(b.key),
      style: { color: b.color, fontSize: 9, whiteSpace: "nowrap", flexShrink: 0 } }, b.icon) : null; })(),
    t.recommended ? h("span", { style: { color: "var(--accent, #4d8dff)", fontSize: 10 } }, "★") : null,
    // "Use" closes the loop: pick this target for the pending share and return to it.
    t.status !== "dead" && t.configState !== "needs-setup"
      ? h("button", { type: "button", title: shareT("share.useTarget"),
        onClick: (e) => { e.stopPropagation(); chooseTarget(t.id); },
        style: { border: "1px solid var(--accent, #4d8dff)", background: state.targetId === t.id ? "var(--accent, #4d8dff)" : "none",
          color: state.targetId === t.id ? "#fff" : "var(--accent, #4d8dff)", borderRadius: 6, padding: "2px 8px",
          fontSize: 10, cursor: "pointer", flexShrink: 0 } }, shareT("share.use"))
      : h("button", { type: "button", title: shareT("share.setupFirst"),
        onClick: (e) => { e.stopPropagation(); set({ editing: t.id, form: {} }); },
        style: { border: "1px solid #d9a13c", background: "none", color: "#d9a13c", borderRadius: 6,
          padding: "2px 8px", fontSize: 10, cursor: "pointer", flexShrink: 0 } }, shareT("share.setup")),
    );
  const edit = state.targets.find((t) => t.id === state.editing);
  const fields = edit?.fields || [];
  const form = edit ? h("div", { style: { flex: 1, padding: 14, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" } },
    h("div", { style: { fontWeight: 600 } }, edit.name || edit.id),
    edit.note ? h("div", { style: { fontSize: 11, color: "var(--text-muted, #8b909b)" } }, edit.note) : null,
    ...fields.map((f) => {
      const key = typeof f === "string" ? f : f.key;
      const label = typeof f === "string" ? f : (f.label || f.key);
      const type = typeof f === "string" ? "password" : (f.type || "text");
      const hint = typeof f === "string" ? "" : (f.hint || "");
      const opts = typeof f === "string" ? null : f.options;
      return h("div", null,
        h("div", { style: { color: "var(--text-muted, #8b909b)", fontSize: 11, marginBottom: 3 } }, label + (f.required ? " *" : "")),
        opts ? h("select", { value: state.form[key] ?? edit.values?.[key] ?? opts[0]?.value ?? "",
          onChange: (e) => set({ form: { ...state.form, [key]: e.target.value } }),
          style: { width: "100%", background: "var(--bg-hover, #25272c)", border: "1px solid var(--border, #34363c)", borderRadius: 7, padding: "6px 9px", color: "var(--text, #d8dade)" } },
          ...opts.map((o) => h("option", { value: o.value }, o.label)))
          : h("input", { type: type === "password" ? "password" : "text", value: state.form[key] ?? "",
            placeholder: edit.values?.[key] ? shareT("share.notSet") + " " + edit.values[key] : (hint || label),
            onInput: (e) => set({ form: { ...state.form, [key]: e.target.value } }),
            style: { width: "100%", background: "var(--bg-hover, #25272c)", border: "1px solid var(--border, #34363c)", borderRadius: 7, padding: "6px 9px", color: "var(--text, #d8dade)" } }),
        hint ? h("div", { style: { color: "var(--text-muted, #8b909b)", fontSize: 10, marginTop: 3 } }, hint) : null);
    }),
    fields.length === 0 ? h("div", { style: { fontSize: 12, color: "var(--text-muted, #8b909b)" } },
      shareT("share.noSetup")) : null,
    ...(edit.custom ? [btn(shareT("share.deleteTarget"), () => void getJSON(`targets?id=${encodeURIComponent(edit.id)}`, { method: "DELETE" }).then(() => refresh()), { title: shareT("share.delete") })] : []),
    btn(shareT("share.saveTest"), async () => {
      try {
        const saved = await getJSON("targets", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: edit.id, provider: edit.provider, name: edit.name, values: { ...edit.values, ...state.form } }) });
        const probe = await getJSON("targets/test", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: edit.provider, values: { ...edit.values, ...state.form } }) });
        set({ error: probe.ok ? shareT("share.testOk") : shareT("share.testFail", { detail: probe.detail || "" }) });
        void refresh(); void saved;
      } catch (e) { set({ error: e.message }); }
    }),
    // After configuring, jump straight back into the share flow with this target.
    btn(shareT("share.saveUse"), async () => {
      try {
        await getJSON("targets", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: edit.id, provider: edit.provider, name: edit.name, values: { ...edit.values, ...state.form } }) });
        void refresh();
        chooseTarget(edit.id);
      } catch (e) { set({ error: e.message }); }
    }, { primary: true })) : h("div", { style: { flex: 1, padding: 20, color: "var(--text-muted, #8b909b)" } }, shareT("share.selectTarget"));
  const localProbe = state.probe.length
    ? h("div", { style: { background: "#3fbf6e10", border: "1px solid #3fbf6e44", borderRadius: 7, padding: "6px 9px", fontSize: 11, color: "var(--accent, #4d8dff)" } },
        shareT("share.probeDetected", { ports: state.probe.map((p) => ":" + p.port).join(", ") })) : null;
  return h("div", { "data-ext-float": "1", "data-ext-float-w": "820", "data-ext-float-h": "560",
    style: { display: "flex", flexDirection: "column", maxHeight: "88vh", background: "var(--bg-panel, #1e2021)", border: "1px solid var(--border, #34363c)",
      borderRadius: 10, boxShadow: "0 14px 44px #000a", overflow: "hidden", color: "var(--text, #d8dade)", font: "13px/1.5 system-ui" } },
    h("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", background: "var(--bg-hover, #25272c)", borderBottom: "1px solid var(--border, #34363c)" } },
      // Return to the share flow without losing the pending content.
      h("button", { type: "button", title: shareT("share.backToShare"), onClick: () => set({ manager: false }),
        style: { background: "none", border: "none", color: "var(--accent, #4d8dff)", cursor: "pointer", fontSize: 14 } }, "←"),
      h("span", { style: { fontWeight: 600 } }, shareT("share.targets")),
      h("div", { style: { flex: 1 } }),
      btn("⟳", () => void refresh(true), { title: shareT("share.refresh") }),
      h("button", { type: "button", onClick: () => set({ manager: false, open: false }),
        style: { background: "none", border: "none", color: "var(--text-muted, #8b909b)", cursor: "pointer" } }, "✕")),
    localProbe,
    h("div", { style: { display: "flex", flex: 1, minHeight: 0 } },
      h("div", { style: { width: 300, borderRight: "1px solid var(--border, #34363c)", display: "flex", flexDirection: "column" } },
        h("div", { style: { padding: 8 } }, h("input", { value: state.search, placeholder: shareT("share.search"),
          onInput: (e) => set({ search: e.target.value }),
          style: { width: "100%", background: "var(--bg-hover, #25272c)", border: "1px solid var(--border, #34363c)", borderRadius: 7, padding: "6px 9px", color: "var(--text, #d8dade)", fontSize: 12 } })),
        h("div", { style: { overflow: "auto", flex: 1, padding: "0 8px 10px" } },
          groups.recent.length ? h("div", null, h("div", { style: { color: "var(--text-muted, #8b909b)", fontSize: 11, padding: "6px" } }, shareT("share.recent")), ...groups.recent.map(item)) : null,
          groups.recommended.length ? h("div", null, h("div", { style: { color: "var(--text-muted, #8b909b)", fontSize: 11, padding: "6px" } }, shareT("share.recommended")), ...groups.recommended.map(item)) : null,
          h("div", null, h("div", { style: { color: "var(--text-muted, #8b909b)", fontSize: 11, padding: "6px" } }, shareT("share.allTargets", { n: state.targets.length })), ...groups.all.map(item))),
        h("div", { style: { borderTop: "1px solid var(--border, #34363c)", padding: 8, display: "flex", gap: 6 } },
          btn(shareT("share.importSxcu"), () => {
            const text = window.prompt(shareT("share.importPrompt"));
            if (!text) return;
            void getJSON("import-sxcu", { method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ config: text }) }).then(() => refresh()).catch((e) => set({ error: e.message }));
          }),
          btn(shareT("share.clearRecent"), () => { recentClear(); emit(); }))),
      form),
    state.error ? h("div", { style: { padding: "6px 14px", color: "var(--accent, #4d8dff)", fontSize: 11 } }, state.error) : null);
}

export default function register(ctx) {
  h = ctx.h;
  ctxRef = ctx;
  tFn = typeof ctx.t === "function" ? ctx.t.bind(ctx) : null;
  if (typeof ctx.apiUrl === "function") apiUrlFn = ctx.apiUrl.bind(ctx);

  ctx.registerItems("dialogs", [{ id: "aiti-msg-share-dialog", render: () => ShareDialogHost() }]);

  const shareAction = (label) => (props) => h("button", {
    type: "button", title: label,
    onClick: () => openShare({ kind: "message", text: props?.text || "", sessionId: props?.sessionId }),
    style: { display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", height: 22,
      border: "none", background: "none", borderRadius: 5, color: "var(--text-dim, #8b909b)", cursor: "pointer", fontSize: 11 },
  }, icon("share", 12), label);
  ctx.registerItems("userMessageActions", [{ id: "aiti-msg-share-user", render: shareAction(shareT("share.action")) }]);
  // Assistant messages mount the same share button at both ends (meta.placement):
  // long replies put one end off-screen, so top (meta row) + bottom carry identical buttons.
  ctx.registerItems("assistantMessageActions", [
    { id: "aiti-msg-share-assistant", render: shareAction(shareT("share.action")) },
    { id: "aiti-msg-share-assistant-top", render: shareAction(shareT("share.action")), meta: { placement: "top" } },
  ]);
  // Session row share lives in session-manager's ⋯ more-menu, not as a bare row
  // button (too many row actions). Registered via that extension's topic contract.
  // (sessionRowActions intentionally not used here.)
  ctx.registerItems("commands", [{ id: "aiti-msg-share.center", render: () => null,
    meta: { label: shareT("share.center"), onClick: () => openShare({ kind: "session" }) } }]);

  if (typeof ctx.registerExtService === "function") {
    ctx.registerExtService("aiti-msg-share.openShare", (payload) => openShare(payload));
  }
  // msg-smart extension points (topic contracts defined by that extension).
  // Topic registration avoids hard-coded share buttons in msg-smart.
  if (typeof ctx.registerTopicItem === "function") {
    // aiti-editor extension points (contracts defined by that extension):
    // image preview toolbar + file toolbar. No hard-coded share button in editor.
    ctx.registerTopicItem("editor-image-action", {
      id: "aiti-msg-share-image",
      label: shareT("share.action"),
      icon: SHARE_ICON,
      onClick: (img) => openShare({ kind: "image", imageSrc: img.src, filename: img.alt || "image" }),
    });
    ctx.registerTopicItem("editor-file-action", {
      id: "aiti-msg-share-file",
      label: shareT("share.action"),
      icon: SHARE_ICON,
      onClick: (file) => file.selectionText
        ? openShare({ kind: "selection", text: file.selectionText, title: file.filePath?.split("/").pop() })
        : openShare({ kind: "file", filePath: file.filePath, filename: file.filePath?.split("/").pop() }),
    });
    // session-manager's ⋯ more-menu action (contract: session-row-menu-action).
    ctx.registerTopicItem("session-row-menu-action", {
      id: "aiti-msg-share-session",
      label: shareT("share.session"),
      title: shareT("share.sessionTip"),
      icon: SHARE_ICON,
      match: () => true,
      onClick: (sess) => openShare({ kind: "session", sessionId: sess?.id,
        session: sess, title: sess?.name || sess?.title || "" }),
    });
    // File card's first-row action (file recognition).
    ctx.registerTopicItem("msg-file-action", {
      id: "aiti-msg-share-file",
      label: shareT("share.action"),
      title: shareT("share.fileTip"),
      icon: SHARE_ICON,
      type: "share",
      match: (abs, isDir) => !isDir,
      onClick: (abs) => openShare({ kind: "file", filePath: abs, filename: abs.split("/").pop() }),
    });
    // Top-row popover action: rendered in the first row after the new-session button
    // (paragraph / code-line / selection cards). Signature: onClick(text, cwd).
    ctx.registerTopicItem("msg-popover-top-action", {
      id: "aiti-msg-share-popover",
      label: shareT("share.action"),
      title: shareT("share.content"),
      icon: SHARE_ICON,
      onClick: (text) => { if (text && text.trim()) openShare({ kind: "selection", text }); },
    });
  }
  void ctxRef;
}
