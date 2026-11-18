/**
 * aiti-cmd client · kit — ctx-bound runtime helpers + shared UI atoms.
 *
 * The extension used to be one 2200-line closure; the three dialog apps
 * (favorites / running / terminal) and their views now share this module:
 *   - module-level constants (styles, terminal theme, palette, clipboard/link helpers)
 *   - createKit(ctx): t / h / hooks / api / icons / terminal keypad tables / liveness keepalive
 *
 * Everything here is UI plumbing only — no app state (see state.js).
 */

// ---------- shared styles ----------
export const btnStyle = {
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--border)", background: "var(--bg-hover)",
  borderRadius: 6, padding: "5px 12px", cursor: "pointer",
  fontSize: 13, color: "var(--text)", fontFamily: "inherit",
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
  whiteSpace: "nowrap", flexShrink: 0,
};
export const rowStyle = { display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" };
export const inputStyle = {
  flex: 1, borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border)", borderRadius: 6,
  padding: "5px 10px", fontSize: 13, background: "var(--bg)", color: "var(--text)",
  fontFamily: "inherit",
};
export const smallStyle = { fontSize: 13, color: "var(--text-muted)", margin: 0, wordBreak: "break-all", lineHeight: 1.5 };
// topbar button: identical metrics to the host's built-in 36×36 icon buttons
export const topbarBtnStyle = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 36, height: 36, padding: 0,
  background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
  color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
  transition: "color 0.12s",
};

// Sort order of the sandbox presets (labels live in createKit — they need t()).
export const SANDBOX_ORDER = ["none", "bwrap-ro", "bwrap-offline", "bwrap-tmp"];

// ---------- terminal palette ----------
// slate palette on a dark background: the default white-on-black clashes with a light UI,
// and brightBlack(#666) is unreadable on black.
export const TERM_THEME = {
  background: "#0f172a",
  foreground: "#e2e8f0",
  cursor: "#93c5fd",
  cursorAccent: "#0f172a",
  selectionBackground: "#334155",
  black: "#0f172a", brightBlack: "#7c8ba1",
  red: "#f87171", brightRed: "#fca5a5",
  green: "#4ade80", brightGreen: "#86efac",
  yellow: "#facc15", brightYellow: "#fde047",
  blue: "#60a5fa", brightBlue: "#93c5fd",
  magenta: "#c084fc", brightMagenta: "#e9d5ff",
  cyan: "#22d3ee", brightCyan: "#67e8f9",
  white: "#cbd5e1", brightWhite: "#f8fafc",
};
// Do not use the page's --font-mono (next/font Noto Sans Mono loads asynchronously — xterm
// measures cell width with the fallback first, and the font swap leaves the grid misaligned).
export const TERM_FONT = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, 'DejaVu Sans Mono', 'Liberation Mono', monospace";

// Terminal size presets: fit = follow the container (desktop default); the rest are fixed cols×rows.
export const TERM_SIZES = [
  // label resolves lazily via labelKey (t() at render points) — this module has no t
  { id: "fit", labelKey: "cmd.k344", label: "自适应", cols: null, rows: null },
  { id: "80x24", label: "80×24", cols: 80, rows: 24 },
  { id: "100x30", label: "100×30", cols: 100, rows: 30 },
  { id: "120x40", label: "120×40", cols: 120, rows: 40 },
  { id: "160x50", label: "160×50", cols: 160, rows: 50 },
];

// quote/backslash keycaps (built from char codes so the source stays quote-safe)
export const KBD_DQUOTE = String.fromCharCode(34); // "
export const KBD_BSLASH = String.fromCharCode(92); // \

// terminal preferences (localStorage: window size / on-screen keyboard)
export const LS_TERM_SIZE = "aiti-cmd:term-size";
export const LS_TERM_KBD = "aiti-cmd:term-kbd";
export function lsGet(key, def) { try { const v = localStorage.getItem(key); if (v == null) return def; return JSON.parse(v); } catch { return def; } }
export function lsSet(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }

// UI locale (same source as the host's useI18n: localStorage pi-locale; the host dispatches
// pi-web:locale-changed when the language changes)
export const LOCALE_CHANGED_EVENT = "pi-web:locale-changed";
export function uiLocale() { try { return localStorage.getItem("pi-locale") || "en"; } catch { return "en"; } }

// ---------- terminal link detection (xterm link provider): URL → confirm → open in a new window ----------
export const TERM_URL_RE = /https?:\/\/[^\s"'<>\[\]{}()]+/g;
export function installTermLinkProvider(term, onLink) {
  try {
    return term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        // xterm's linkifier passes 1-based line numbers; getLine is 0-based (same convention
        // as the official WebLinksAddon: range.y stays 1-based)
        let line = null;
        try { line = term.buffer.active.getLine(bufferLineNumber - 1); } catch (e) {}
        if (!line) { callback(undefined); return; }
        const text = line.translateToString(true);
        const links = [];
        TERM_URL_RE.lastIndex = 0;
        let m;
        while ((m = TERM_URL_RE.exec(text)) !== null) {
          let raw = m[0];
          const start = m.index;
          // trim trailing punctuation and unpaired closing parens
          let tail = raw.replace(/[.,;:!?]+$/, "");
          const cp = tail.lastIndexOf(")");
          const op = tail.lastIndexOf("(");
          if (cp > op) tail = tail.slice(0, cp);
          raw = tail;
          if (raw.length < 9 || !/^https?:\/\//.test(raw)) continue;
          const end = start + raw.length;
          links.push({
            range: { start: { x: start + 1, y: bufferLineNumber }, end: { x: end, y: bufferLineNumber } },
            text: raw,
            decorations: { pointerCursor: true, underline: true },
            activate: (_event, uri) => onLink(uri),
          });
        }
        callback(links);
      },
    });
  } catch (e) { return null; }
}

// ---------- terminal copy/paste: right-click copies the selection; Ctrl+Shift+C / Ctrl+Insert
// copy, Ctrl+Shift+V / Shift+Insert paste. Returns handleKey for attachCustomKeyEventHandler
// (true = consumed; the caller should have prevented the default and return false).
// Ctrl+C stays SIGINT — copying in a terminal can only go through these bindings.
export function installTermClipboard(term, el, onPaste) {
  const copySel = () => {
    try {
      const s = term.getSelection();
      if (!s) return false;
      navigator.clipboard?.writeText(s)?.catch?.(() => {});
      return true;
    } catch { return false; }
  };
  const onCtx = (e) => { if (copySel()) e.preventDefault(); };
  el.addEventListener("contextmenu", onCtx);
  return {
    copySel,
    handleKey(ev) {
      if (ev.type !== "keydown" || !ev.key) return false;
      const k = ev.key.toLowerCase();
      if (ev.ctrlKey && ev.shiftKey && k === "c") { if (copySel()) { ev.preventDefault(); return true; } return false; }
      if (ev.ctrlKey && !ev.shiftKey && k === "insert") { ev.preventDefault(); return copySel(); }
      if (ev.shiftKey && !ev.ctrlKey && k === "insert") { ev.preventDefault(); onPaste?.(); return true; }
      if (ev.ctrlKey && ev.shiftKey && k === "v") { ev.preventDefault(); onPaste?.(); return true; }
      return false;
    },
    dispose() { el.removeEventListener("contextmenu", onCtx); },
  };
}

/** Icons shared by every app (lucide geometry, 24×24 stroke). */
export const ICON_PATHS = {
  terminal: ["M4 17l6-6-6-6", "M12 19h8"],
  play: ["m6 3 14 9-14 9V3z"],
  pencil: ["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z", "m15 5 4 4"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  list: ["M8 6H21", "M8 12H21", "M8 18H21", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  lock: ["M18 8h1a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4h1", "M7 8V6a5 5 0 0 1 10 0v2", "M12 13v4"],
  alert: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z", "M12 9v4", "M12 17h.01"],
  bot: ["M12 8V4H8", "M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"],
  monitor: ["M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M8 21h8", "M12 17v4"],
  star: ["m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"],
  clock: ["M12 6v6l4 2", "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z"],
};

/**
 * Build the ctx-bound runtime shared by every app/view.
 * @param {Record<string, any>} ctx host extension client context
 */
export function createKit(ctx) {
  const t = (k, p2) => { const fn = ctx.t; return typeof fn === "function" ? fn(k, p2) : k; };
  const { h, useState, useEffect, useRef, apiUrl } = ctx;
  const api = (path) => apiUrl("/api/extensions/aiti-cmd" + path);

  /** lucide-style icon (same stroke geometry as the host's built-in icons). */
  const Ic = (size, paths) => {
    const el = h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, paths.map((d, i) => h("path", { key: i, d })));
    if (el._store) el._store.validated = 1;
    return el;
  };

  // UI language (zh → text labels; other locales → glyphs) — re-renders on host locale change
  function useIsZh() {
    const [zh, setZh] = useState(() => uiLocale() === "zh-CN");
    useEffect(() => {
      const onChange = () => setZh(uiLocale() === "zh-CN");
      window.addEventListener(LOCALE_CHANGED_EVENT, onChange);
      return () => window.removeEventListener(LOCALE_CHANGED_EVENT, onChange);
    }, []);
    return zh;
  }

  // shift-lock map: digits/punctuation → shifted symbols
  const SHIFTED = { "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(", "0": ")", "-": "_", "=": "+", "`": "~", "[": "{", "]": "}", "\\": "|", ";": ":", "'": "\"", ",": "<", ".": ">", "/": "?" };
  // KEYPAD_FN_ROW must be declared before KEYPAD_FULL_ROWS/KEYPAD_ROWS (both reference it at the end;
  // declaring it later is a TDZ ReferenceError)
  const KEYPAD_FN_ROW = [
    { k: "F1", seq: "\x1bOP", c: t("cmd.k133") },
    { k: "F2", seq: "\x1bOQ", c: t("cmd.k137") },
    { k: "F3", seq: "\x1bOR", c: t("cmd.k138") },
    { k: "F4", seq: "\x1bOS", c: t("cmd.k139") },
    { k: "F5", seq: "\x1b[15~", c: t("cmd.k140") },
    { k: "F6", seq: "\x1b[17~", c: t("cmd.k141") },
    { k: "F7", seq: "\x1b[18~", c: t("cmd.k142") },
    { k: "F8", seq: "\x1b[19~", c: t("cmd.k143") },
    { k: "F9", seq: "\x1b[20~", c: t("cmd.k144") },
    { k: "F10", seq: "\x1b[21~", c: t("cmd.k134") },
    { k: "F11", seq: "\x1b[23~", c: t("cmd.k135") },
    { k: "F12", seq: "\x1b[24~", c: t("cmd.k136") },
  ];
  // full keyboard ("ABC" mode): letters / digits / symbols / space; CTRL/SHIFT/ALT/WIN lock + key = combo
  const KEYPAD_FULL_ROWS = [
    [
      { k: "1", txt: "1" }, { k: "2", txt: "2" }, { k: "3", txt: "3" }, { k: "4", txt: "4" }, { k: "5", txt: "5" },
      { k: "6", txt: "6" }, { k: "7", txt: "7" }, { k: "8", txt: "8" }, { k: "9", txt: "9" }, { k: "0", txt: "0" },
      { k: "-", txt: "-" }, { k: "=", txt: "=" },
    ],
    [
      { k: "Q", txt: "q" }, { k: "W", txt: "w" }, { k: "E", txt: "e" }, { k: "R", txt: "r" }, { k: "T", txt: "t" },
      { k: "Y", txt: "y" }, { k: "U", txt: "u" }, { k: "I", txt: "i" }, { k: "O", txt: "o" }, { k: "P", txt: "p" },
    ],
    [
      { k: "A", txt: "a" }, { k: "S", txt: "s" }, { k: "D", txt: "d" }, { k: "F", txt: "f" }, { k: "G", txt: "g" },
      { k: "H", txt: "h" }, { k: "J", txt: "j" }, { k: "K", txt: "k" }, { k: "L", txt: "l" },
    ],
    [
      { k: "Z", txt: "z" }, { k: "X", txt: "x" }, { k: "C", txt: "c" }, { k: "V", txt: "v" }, { k: "B", txt: "b" },
      { k: "N", txt: "n" }, { k: "M", txt: "m" }, { k: "⌫", seq: "\x7f", c: t("cmd.k376") },
    ],
    [
      { k: "&", txt: "&" }, { k: ";", txt: ";" }, { k: ":", txt: ":" }, { k: "'", txt: "'" }, { k: KBD_DQUOTE, txt: KBD_DQUOTE },
      { k: KBD_BSLASH, txt: KBD_BSLASH }, { k: "/", txt: "/" }, { k: "?", txt: "?" }, { k: "!", txt: "!" }, { k: "$", txt: "$" },
      { k: "#", txt: "#" }, { k: "@", txt: "@" }, { k: "%", txt: "%" }, { k: "^", txt: "^" }, { k: "*", txt: "*" },
    ],
    [
      { k: "(", txt: "(" }, { k: ")", txt: ")" }, { k: "[", txt: "[" }, { k: "]", txt: "]" }, { k: "{", txt: "{" },
      { k: "}", txt: "}" }, { k: "<", txt: "<" }, { k: ">", txt: ">" }, { k: "=", txt: "=" }, { k: "+", txt: "+" },
      { k: ".", txt: "." }, { k: ",", txt: "," }, { k: "|", txt: "|" }, { k: "~", txt: "~" },
    ],
    [
      { k: "ESC", seq: "\x1b", c: t("cmd.k155") }, { k: "TAB", seq: "\t", c: t("cmd.k352") },
      { k: "SHIFT", mod: "shift" }, { k: "CTRL", mod: "ctrl" }, { k: "ALT", mod: "alt" }, { k: "WIN", mod: "win" },
      { k: "␣", txt: " ", c: t("cmd.k313") }, { k: "↵", seq: "\r", c: t("cmd.k177") },
    ],
    KEYPAD_FN_ROW,
  ];
  // compact keyboard (default on small screens): Termux-style extra keys
  const KEYPAD_ROWS = [
    [
      { k: "ESC", seq: "\x1b", c: t("cmd.k155") },
      { k: "TAB", seq: "\t", c: t("cmd.k352") },
      { k: "SHIFT", mod: "shift" },
      { k: "CTRL", mod: "ctrl" },
      { k: "ALT", mod: "alt" },
      { k: "WIN", mod: "win" },
      { k: "|", txt: "|" },
      { k: "~", txt: "~" },
      { k: "-", txt: "-" },
      { k: "_", txt: "_" },
      { k: "HOME", seq: "\x1b[H", c: t("cmd.k350") },
      { k: "END", seq: "\x1b[F", c: t("cmd.k349") },
      { k: "PGUP", seq: "\x1b[5~", c: t("cmd.k71") },
      { k: "PGDN", seq: "\x1b[6~", c: t("cmd.k74") },
    ],
    [
      { k: "↑", seq: "\x1b[A", c: t("cmd.k69") },
      { k: "↓", seq: "\x1b[B", c: t("cmd.k73") },
      { k: "←", seq: "\x1b[D", c: t("cmd.k197") },
      { k: "→", seq: "\x1b[C", c: t("cmd.k163") },
      { k: "⌫", seq: "\x7f", c: t("cmd.k376") },
      { k: "↵", seq: "\r", c: t("cmd.k177") },
      { k: "C-c", seq: "\x03", c: t("cmd.k77") },
      { k: "C-d", seq: "\x04", c: t("cmd.k374") },
      { k: "C-z", seq: "\x1a", c: t("cmd.k234") },
      { k: "C-l", seq: "\x0c", c: t("cmd.k301") },
      { k: "C-a", seq: "\x01", c: t("cmd.k98") },
      { k: "C-e", seq: "\x05", c: t("cmd.k97") },
      { k: "C-r", seq: "\x12", c: t("cmd.k153") },
      { k: "C-u", seq: "\x15", c: t("cmd.k123") },
      { k: "C-w", seq: "\x17", c: t("cmd.k124") },
    ],
    KEYPAD_FN_ROW,
  ];
  // toolbar legend for the in-terminal help sheet (touch devices have no hover titles)
  const TOOLBAR_LEGEND = (zh) => [
    [zh ? t("cmd.k54") : "⇊", t("cmd.k303")],
    ["⌨", t("cmd.k347")],
    ["?", t("cmd.k280")],
    ["＋", t("cmd.k268")],
    [t("cmd.k259"), t("cmd.k264")],
    ["⇲", t("cmd.k233")],
    ["⛶", t("cmd.k104")],
  ];
  const TERM_SHORTCUTS = [
    ["Ctrl+C", t("cmd.k78")],
    ["Ctrl+D", t("cmd.k373")],
    ["Ctrl+Z", t("cmd.k235")],
    ["Ctrl+L", t("cmd.k301")],
    ["Ctrl+A / Ctrl+E", t("cmd.k99")],
    ["Ctrl+U / Ctrl+K", t("cmd.k128")],
    ["Ctrl+W", t("cmd.k129")],
    ["Ctrl+R", t("cmd.k154")],
    ["Ctrl+← / Ctrl+→", t("cmd.k236")],
    ["Ctrl+↑ / Ctrl+↓", t("cmd.k67")],
    ["Tab", t("cmd.k168")],
    ["↑ / ↓", t("cmd.k68")],
    ["← / →", t("cmd.k100")],
    ["Home / End", t("cmd.k351")],
    ["PgUp / PgDn", t("cmd.k72")],
    ["Esc", t("cmd.k156")],
    [t("cmd.k164"), t("cmd.k184")],
    ["Ctrl+Shift+V / Shift+Insert", t("cmd.k317")],
    ["Ctrl+Shift+F", t("cmd.k118")],
    ["Ctrl+Shift+K", t("cmd.k119")],
    ["Ctrl+Shift+S", t("cmd.k218")],
    ["F1–F12", t("cmd.k327")],
  ];
  const SANDBOX = {
    none: { label: t("cmd.k270"), icon: "", short: t("cmd.k269"), hint: t("cmd.k76"), warn: true },
    "bwrap-ro": { label: t("cmd.k318"), icon: " 🛡", short: t("cmd.k160"), hint: t("cmd.k256"), warn: false },
    "bwrap-offline": { label: t("cmd.k161"), icon: " 🛡", short: t("cmd.k162"), hint: t("cmd.k255"), warn: false },
    "bwrap-tmp": { label: t("cmd.k79"), icon: " ♻", short: t("cmd.k80"), hint: t("cmd.k66"), warn: false },
  };
  const SOURCE_LABEL = { manual: t("cmd.k222"), message: t("cmd.k300"), shell: t("cmd.k325"), favorite: t("cmd.k245"), "asr-selfheal": t("cmd.k31"), schedule: t("cmd.k190"), suggest: t("cmd.k338"), "ai-helper": "AI", codebuddy: "CodeBuddy", service: t("cmd.k276"), unknown: t("cmd.k278") };

  // ---------- terminal stream keepalive (the event bus stops publishing idle types) ----------
  // While a subscription is live we POST /alive every 15s; the backend stops pushing a type
  // that has not been refreshed for 45s (panel closed → source goes quiet).
  // Ref-counted per type: the running and terminal windows may subscribe to the same topic,
  // so one window closing must not stop the stream for the other.
  const aliveTypes = new Map();
  let aliveTimer = null;
  const alivePing = () => {
    if (!aliveTypes.size) return;
    try { fetch(api("/alive"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ types: [...aliveTypes.keys()] }) }).catch(() => {}); } catch {}
  };
  const aliveAdd = (...types) => {
    let added = false;
    for (const ty of types) {
      const n = aliveTypes.get(ty) || 0;
      aliveTypes.set(ty, n + 1);
      if (!n) added = true;
    }
    if (added) alivePing(); // report immediately so the backend flips from optimistic to managed
    if (!aliveTimer) aliveTimer = setInterval(alivePing, 15000);
  };
  const aliveDel = (...types) => {
    let removed = false;
    for (const ty of types) {
      const n = aliveTypes.get(ty) || 0;
      if (n <= 0) continue;
      if (n === 1) { aliveTypes.delete(ty); removed = true; } else aliveTypes.set(ty, n - 1);
    }
    if (removed) alivePing();
    if (!aliveTypes.size && aliveTimer) { clearInterval(aliveTimer); aliveTimer = null; }
  };

  // live shell cwd: GET /sessions/{id}/cwd reads the interactive shell's real pwd; failures
  // (win32 / exited / unsupported) fall back to the creation-time cwd
  const liveCwdOf = async (sessionId, fallbackCwd) => {
    try {
      const r = await fetch(api(`/sessions/${encodeURIComponent(sessionId)}/cwd`)).then((x) => x.json()).catch(() => null);
      if (r && r.ok && typeof r.cwd === "string" && r.cwd) return r.cwd;
    } catch {}
    return fallbackCwd || undefined;
  };

  // host "new pi-web session" channel (AppShell registers pi-web:new-session + __piWebPendingComposer):
  // write the prefill (@ path, same format as the host's @mention) → dispatch. Returns dispatch success.
  const openNewPiSession = (cwd) => {
    if (!cwd) return false;
    const text = cwd.includes(" ") ? `@"${cwd}"/ ` : `@${cwd}/ `;
    try { window.__piWebPendingComposer = { text, at: Date.now() }; } catch {}
    try { window.dispatchEvent(new CustomEvent("pi-web:new-session", { detail: { cwd } })); } catch { return false; }
    return true;
  };

  return {
    ctx, t, h, useState, useEffect, useRef, apiUrl, api,
    Ic, ICONS: ICON_PATHS, ICON_PATHS, useIsZh,
    SHIFTED, KEYPAD_FN_ROW, KEYPAD_FULL_ROWS, KEYPAD_ROWS, TOOLBAR_LEGEND, TERM_SHORTCUTS,
    SANDBOX, SOURCE_LABEL,
    aliveAdd, aliveDel, liveCwdOf, openNewPiSession,
  };
}
