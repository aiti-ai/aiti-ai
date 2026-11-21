/**
 * aiti-secret-vault client — management dialog (zero-build, host h()/useState).
 *
 * Two tabs:
 *   Vault     aliases + metadata, add/rotate (masked value field), reveal, delete,
 *             lock/unlock, unlock-mode switch (keyfile ↔ OS keychain)
 *   Sessions  zero-value session records (landing mode + mounted alias names)
 *
 * The value never goes to the AI: it travels browser → local pi-web server →
 * encrypted vault. The AI button / extman button are injected by the host
 * dialog layer (never hand-written here).
 */
let _ctx = null;
function __setCtx(ctx) { _ctx = ctx; }
function c(name) { return _ctx?.[name] ?? function () { return undefined; }; }
function t(k) { var fn = _ctx && _ctx.t; return typeof fn === "function" ? fn(k) : k; }
function h(type) { return c("h").apply(null, arguments); }
function useState(init) { return c("useState")(init); }
function useEffect(fn, deps) { return c("useEffect")(fn, deps); }
function apiUrl(p) { var fn = _ctx?.apiUrl; return typeof fn === "function" ? fn(p) : p; }
var API = function (p) { return apiUrl("/api/extensions/aiti-secret-vault" + p); };

var SV_KEY = "aiti-secret-vault:panel";
var localOpen = false;
function floatApi() {
  var a = typeof window !== "undefined" ? window.__piweFloat : null;
  return a && typeof a.present === "function" ? a : null;
}
function isOpen() {
  var a = floatApi();
  return a ? (a.presented(SV_KEY) || "closed") !== "closed" : localOpen;
}
function setOpen(v) {
  var a = floatApi();
  if (a) { a.present(SV_KEY, v ? "open" : "close"); return; }
  localOpen = v;
  try { window.dispatchEvent(new Event("piwe-float-present-change")); } catch (e) {}
}

var ICONS = {
  key: ["M21 2l-2 2", "M15.5 8.5 19 12", "M10.5 13.5a5.5 5.5 0 1 1-8 8 5.5 5.5 0 0 1 8-8z", "M11 12l4-4"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  copy: ["M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z", "M5 15V5a2 2 0 0 1 2-2h10"],
};
function Ic(size, paths) {
  return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
    paths.map(function (d, i) { return h("path", { key: i, d: d }); }));
}

var dlgRoot = { position: "absolute", inset: "6% 8%", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)",
  border: "1px solid var(--border,#ddd)", borderRadius: 10, boxShadow: "0 18px 50px rgba(0,0,0,.25)",
  display: "flex", flexDirection: "column", overflow: "hidden", fontSize: 12.5 };
var headStyle = { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border,#ddd)" };
var btn = function (bg, color) { return { padding: "4px 10px", borderRadius: 6, fontSize: 12, cursor: "pointer",
  background: bg, border: "1px solid var(--border,#ddd)", color: color }; };
var inputStyle = { padding: "5px 8px", borderRadius: 6, fontSize: 12.5, border: "1px solid var(--border,#ddd)",
  background: "var(--bg)", color: "var(--text)", width: "100%", boxSizing: "border-box" };
var tdStyle = { padding: "4px 8px", borderBottom: "1px solid var(--border,#eee)", verticalAlign: "top", fontSize: 11.5 };

function useFlash() {
  var s = useState(null);
  return [s[0], function (kind, text) { s[1]({ kind: kind, text: text }); }];
}

function VaultTab(props) {
  var st = props.status || {};
  var entries = props.entries || [];
  var fl = props.flash;
  var [alias, setAlias] = useState("");
  var [desc, setDesc] = useState("");
  var [tags, setTags] = useState("");
  var [value, setValue] = useState("");
  var [project, setProject] = useState(false);
  var [revealed, setRevealed] = useState(null);
  var [pendingDelete, setPendingDelete] = useState("");
  var [busy, setBusy] = useState(false);
  var [targetMode, setTargetMode] = useState(st.mode || "keyfile");

  function save() {
    if (!alias.trim() || !value) { fl("err", t("sv.alias") + " / " + t("sv.value")); return; }
    setBusy(true);
    fetch(API("/entries"), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ alias: alias.trim(), value: value, desc: desc.trim(), tags: tags, project: project }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        setBusy(false);
        if (!d.ok) { fl("err", t("sv.failed") + " " + (d.error || "")); return; }
        setAlias(""); setDesc(""); setTags(""); setValue("");
        if (d.warning) fl("warn", t("sv.saved") + " · " + d.result.alias + " — " + d.warning);
        else fl("ok", t("sv.saved") + " · " + d.result.alias + " v" + d.result.version);
        props.reload();
      })
      .catch(function (e) { setBusy(false); fl("err", t("sv.failed") + " " + String(e)); });
  }
  function reveal(a) {
    fetch(API("/entries/" + encodeURIComponent(a) + "/reveal"), { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) setRevealed({ alias: d.alias, value: d.value, weak: d.weak }); else fl("err", t("sv.failed") + " " + (d.error || "")); });
  }
  function remove(a) {
    if (pendingDelete !== a) { setPendingDelete(a); return; }
    setPendingDelete("");
    fetch(API("/entries/" + encodeURIComponent(a)), { method: "DELETE" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { fl("err", t("sv.failed") + " " + (d.error || "")); return; }
        setRevealed(null);
        fl("ok", t("sv.removed") + " · " + a);
        props.reload();
      });
  }
  function lockToggle() {
    var path = st.locked ? "/unlock" : "/lock";
    fetch(API(path), { method: "POST" }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) { props.reload(); } else fl("err", t("sv.failed") + " " + (d.error || ""));
    });
  }
  function switchMode() {
    if (targetMode === st.mode) return;
    if (typeof window !== "undefined" && !window.confirm(t("sv.mode.confirm"))) return;
    fetch(API("/mode"), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: targetMode }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { fl("err", t("sv.failed") + " " + (d.error || "")); return; }
        fl("ok", t("sv.mode") + " → " + targetMode + " (" + d.result.files + " file(s))");
        props.reload();
      });
  }

  var statusLine = h("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 11.5, color: "var(--text-muted)" } },
    h("span", null, (st.locked ? "🔒 " + t("sv.locked") : "🔓 " + t("sv.unlocked"))),
    h("span", null, t("sv.entries") + ": " + (props.entries ? props.entries.length : 0)),
    st.weakEntries ? h("span", { style: { color: "var(--danger,#ef4444)" } }, "⚠ " + t("sv.weakCount") + ": " + st.weakEntries) : null,
    h("span", null, t("sv.mode") + ": " + (st.mode || "keyfile")),
    h("span", null, t("sv.keychain") + ": " + (st.keychainBackend || "-")),
    h("span", { style: { flex: 1 } }),
    h("button", { style: btn("var(--bg)"), onClick: lockToggle }, st.locked ? t("sv.unlock") : t("sv.lock")),
    h("button", { style: btn("var(--bg)"), onClick: props.reload }, t("sv.refresh")));

  var modeRow = h("div", { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 6, fontSize: 11.5 } },
    h("span", { style: { color: "var(--text-muted)" } }, t("sv.mode") + ":"),
    h("select", { value: targetMode, onChange: function (e) { setTargetMode(e.target.value); }, style: Object.assign({}, inputStyle, { width: 220 }) },
      h("option", { value: "keyfile" }, t("sv.mode.keyfile")),
      h("option", { value: "keychain" }, t("sv.mode.keychain"))),
    h("button", { style: btn("var(--bg)"), onClick: switchMode, disabled: targetMode === st.mode }, t("sv.mode.switch")));

  var form = h("div", { style: { border: "1px solid var(--border,#ddd)", borderRadius: 8, padding: 10, marginTop: 8 } },
    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 } },
      h("input", { style: inputStyle, placeholder: t("sv.alias"), value: alias, onChange: function (e) { setAlias(e.target.value); } }),
      h("input", { style: inputStyle, placeholder: t("sv.desc"), value: desc, onChange: function (e) { setDesc(e.target.value); } }),
      h("input", { style: inputStyle, placeholder: t("sv.tags"), value: tags, onChange: function (e) { setTags(e.target.value); } }),
      h("input", { style: inputStyle, type: "password", placeholder: t("sv.value"), value: value, autoComplete: "new-password",
        onChange: function (e) { setValue(e.target.value); } })),
    h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginTop: 6 } },
      h("label", { style: { display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--text-muted)" } },
        h("input", { type: "checkbox", checked: project, onChange: function (e) { setProject(e.target.checked); } }), t("sv.project")),
      h("span", { style: { flex: 1 } }),
      h("button", { style: btn("var(--accent,#2563eb)", "#fff"), onClick: save, disabled: busy }, t("sv.add"))));

  var revealedBox = revealed ? h("div", { style: { marginTop: 8, padding: 8, border: "1px solid var(--border,#ddd)", borderRadius: 8,
    background: "color-mix(in srgb, var(--warning,#f59e0b) 10%, transparent)" } },
    h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
      h("code", { style: { flex: 1, fontSize: 12, wordBreak: "break-all" } }, revealed.alias + " = " + revealed.value),
      revealed.weak ? h("span", { style: { color: "var(--danger,#ef4444)", fontSize: 11.5 } }, "⚠ " + t("sv.weak")) : null,
      h("button", { style: btn("var(--bg)"), onClick: function () { try { navigator.clipboard.writeText(revealed.value); fl("ok", t("sv.copied")); } catch (e) {} } }, t("sv.copy")),
      h("button", { style: btn("var(--bg)"), onClick: function () { setRevealed(null); } }, t("sv.hide")))) : null;

  var rows = entries.length === 0
    ? h("div", { style: { padding: "18px 0", textAlign: "center", color: "var(--text-muted)" } }, t("sv.empty"))
    : h("table", { style: { width: "100%", borderCollapse: "collapse", marginTop: 8 } },
        h("thead", null, h("tr", null, [t("sv.alias"), t("sv.desc"), t("sv.tags"), "v", t("sv.updated"), ""].map(function (x) {
          return h("th", { key: x, style: { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border,#ddd)", color: "var(--text-muted)", fontWeight: 600 } }, x);
        }))),
        h("tbody", null, entries.map(function (e) {
          return h("tr", { key: e.scope + ":" + e.alias },
            h("td", { style: tdStyle }, h("b", null, e.alias), e.scope === "project" ? h("span", { style: { color: "var(--text-muted)" } }, " [" + t("sv.project") + "]") : null,
              e.weak ? h("span", { style: { color: "var(--danger,#ef4444)", marginLeft: 6 } }, "⚠ " + t("sv.weak")) : null),
            h("td", { style: tdStyle }, e.desc || ""),
            h("td", { style: tdStyle }, (e.tags || []).join(", ")),
            h("td", { style: tdStyle }, String(e.version)),
            h("td", { style: tdStyle }, e.lastUsedAt ? t("sv.updated") + " " + String(e.lastUsedAt).slice(0, 16).replace("T", " ") : ""),
            h("td", { style: Object.assign({}, tdStyle, { whiteSpace: "nowrap" }) },
              h("button", { style: Object.assign({}, btn("var(--bg)"), { marginRight: 4 }), onClick: function () { reveal(e.alias); } }, t("sv.reveal")),
              h("button", { style: btn(pendingDelete === e.alias ? "var(--danger,#ef4444)" : "var(--bg)", pendingDelete === e.alias ? "#fff" : undefined), onClick: function () { remove(e.alias); } },
                pendingDelete === e.alias ? t("sv.deleteConfirm") : t("sv.delete"))));
        })));

  return h("div", null, statusLine, modeRow, form, revealedBox, rows,
    h("div", { style: { marginTop: 10, fontSize: 11, color: "var(--text-muted)" } }, t("sv.hint")));
}

function SessionsTab(props) {
  var sessions = props.sessions || {};
  // Only sessions that actually have an alias mounted: empty historical
  // records are noise (every session writes one on startup).
  var ids = Object.keys(sessions).filter(function (id) {
    var s = sessions[id];
    return !!(s && Array.isArray(s.mounted) && s.mounted.length > 0);
  });
  if (ids.length === 0) {
    return h("div", { style: { padding: "18px 0", textAlign: "center", color: "var(--text-muted)" } },
      h("div", null, t("sv.session.empty")),
      h("div", { style: { fontSize: 11, marginTop: 6 } }, t("sv.session.retention")));
  }
  return h("table", { style: { width: "100%", borderCollapse: "collapse", marginTop: 4 } },
    h("thead", null, h("tr", null, ["session", "cwd", t("sv.session.landing"), t("sv.session.mounted"), t("sv.updated"), ""].map(function (x) {
      return h("th", { key: x, style: { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border,#ddd)", color: "var(--text-muted)", fontWeight: 600 } }, x);
    }))),
    h("tbody", null, ids.map(function (id) {
      var s = sessions[id] || {};
      var meta = (props.names && props.names[id]) || {};
      var first = meta.firstMessage ? String(meta.firstMessage).replace(/\s+/g, " ").trim().slice(0, 80) : "";
      var title = s.name || meta.name || first || id.slice(0, 8);
      var openIt = function (e) { if (e) e.stopPropagation(); if (props.onOpen) props.onOpen(s, id); };
      return h("tr", { key: id, onClick: openIt, style: { cursor: "pointer" }, title: id },
        h("td", { style: Object.assign({}, tdStyle, { fontFamily: "inherit" }) },
          h("div", { style: { fontWeight: 600 } }, title),
          h("div", { style: { fontFamily: "monospace", fontSize: 10.5, color: "var(--text-muted)" } }, id.slice(0, 8))),
        h("td", { style: Object.assign({}, tdStyle, { maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }), title: s.cwd }, s.cwd || ""),
        h("td", { style: tdStyle }, s.landing || ""),
        h("td", { style: tdStyle }, (s.mounted || []).join(", ")),
        h("td", { style: tdStyle }, s.updatedAt ? String(s.updatedAt).slice(0, 16).replace("T", " ") : ""),
        h("td", { style: Object.assign({}, tdStyle, { whiteSpace: "nowrap" }) },
          h("button", { style: btn("var(--bg)"), onClick: openIt, title: id }, t("sv.open"))));
    })),
    h("tfoot", null, h("tr", null, h("td", { colSpan: 6, style: { padding: "8px", fontSize: 11, color: "var(--text-muted)" } }, t("sv.session.retention")))));
}

function VaultPanel() {
  var [tab, setTab] = useState("vault");
  var [status, setStatus] = useState(null);
  var [entries, setEntries] = useState([]);
  var [sessions, setSessions] = useState({});
  var [sessionNames, setSessionNames] = useState({});
  var fl = useFlash();
  var [busy, setBusy] = useState(false);
  var [openTick, setOpenTick] = useState(0);

  // The dialog is registered as a React dialog and must render nothing while
  // aiti-float says it is closed; otherwise the panel stays visible and its
  // close button only changes the float state (window "cannot be closed").
  useEffect(function () {
    var sync = function () { setOpenTick(function (n) { return n + 1; }); };
    window.addEventListener("piwe-float-present-change", sync);
    return function () { window.removeEventListener("piwe-float-present-change", sync); };
  }, []);
  var open = isOpen();

  function reload() {
    setBusy(true);
    Promise.all([
      fetch(API("/status")).then(function (r) { return r.json(); }),
      fetch(API("/entries")).then(function (r) { return r.json(); }),
      fetch(apiUrl("/api/sessions")).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
    ]).then(function (res) {
      setBusy(false);
      if (res[0] && res[0].ok) { setStatus(res[0].status); setSessions(res[0].sessions || {}); }
      else if (res[0] && !res[0].ok) fl[1]("err", t("sv.failed") + " " + (res[0].error || ""));
      if (res[1] && res[1].ok) setEntries(res[1].entries || []);
      var rows = (res[2] && res[2].sessions) || [];
      var map = {};
      rows.forEach(function (row) { if (row && row.id) map[row.id] = row; });
      setSessionNames(map);
    }).catch(function (e) { setBusy(false); fl[1]("err", t("sv.failed") + " " + String(e)); });
  }
  useEffect(function () { if (open) reload(); }, [open]);

  if (!open) return null;
  void openTick;
  var tabBtn = function (id, label) {
    return h("button", { key: id, onClick: function () { setTab(id); }, disabled: busy,
      style: btn(tab === id ? "var(--accent,#2563eb)" : "var(--bg)", tab === id ? "#fff" : undefined) }, label);
  };
  var msg = fl[0] && h("div", { role: "alert", style: { margin: "0 12px 0", padding: "6px 10px", borderRadius: 6, fontSize: 12,
    background: fl[0].kind === "ok" ? "color-mix(in srgb, var(--ok,#10b981) 12%, transparent)" : fl[0].kind === "warn" ? "color-mix(in srgb, var(--warning,#f59e0b) 14%, transparent)" : "color-mix(in srgb, var(--danger,#ef4444) 12%, transparent)",
    color: fl[0].kind === "ok" ? "var(--ok,#10b981)" : fl[0].kind === "warn" ? "var(--warning,#b45309)" : "var(--danger,#ef4444)" } }, fl[0].text);

  return h("div", { "data-ext-float": "1", "data-ext-float-key": SV_KEY, "data-ext-float-w": 760, "data-ext-float-h": 560,
    "data-ext-float-full": "1", style: dlgRoot },
    h("div", { style: headStyle },
      h("span", { style: { fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6 } }, Ic(15, ICONS.key), t("sv.panel.label")),
      h("span", { style: { flex: 1 } }),
      h("button", { key: "pf", onClick: function () {
          setPreflightEnabled(!preflightEnabled());
          setPreflightAuto(null);
          setOpenTick(openTick + 1); // re-render the chip label
        }, title: t("sv.pf.toggleTitle"), style: btn("var(--bg)") },
        t("sv.pf.toggle") + ": " + (preflightEnabled() ? t("sv.on") : t("sv.off"))),
      tabBtn("vault", t("sv.tab.vault")),
      tabBtn("sessions", t("sv.tab.sessions")),
      h("button", { onClick: function () { setOpen(false); }, "aria-label": "close", style: { background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" } }, Ic(13, ICONS.x))),
    msg,
    h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: 12 } },
      tab === "vault"
        ? h(VaultTab, { status: status, entries: entries, reload: reload, flash: fl[1] })
        : h(SessionsTab, { sessions: sessions, names: sessionNames, onOpen: function (record, id) {
          if (!id) return;
          try { window.dispatchEvent(new CustomEvent("pi-web:open-session", { detail: { id } })); } catch (e) {}
          setOpen(false);
        } })));
}

// ---------------------------------------------------------------------------
// Pre-send preflight: the message is checked in the browser before it leaves the
// composer. Detection here is deliberately stricter than auto-masking (a human
// confirms), and "mask" encrypts into the vault first, so the model never sees
// the plaintext — not in the session log, not in the provider payload.
// ---------------------------------------------------------------------------

var PF_OFF_KEY = "aiti-secret-vault:preflight-off";
var PF_AUTO_KEY = "aiti-secret-vault:preflight-auto";

/** Persistent off-switch (panel toggle). */
function preflightEnabled() {
  try { return window.localStorage.getItem(PF_OFF_KEY) !== "1"; } catch (e) { return true; }
}
function setPreflightEnabled(on) {
  try { window.localStorage.setItem(PF_OFF_KEY, on ? "0" : "1"); } catch (e) {}
}
/** Session-scoped auto answer ("mask" | "raw" | null) remembered from the dialog. */
function preflightAuto() {
  try { return window.sessionStorage.getItem(PF_AUTO_KEY) || null; } catch (e) { return null; }
}
function setPreflightAuto(mode) {
  try {
    if (mode) window.sessionStorage.setItem(PF_AUTO_KEY, mode);
    else window.sessionStorage.removeItem(PF_AUTO_KEY);
  } catch (e) {}
}

/** Three-way decision dialog. Resolves: { decision: "mask"|"raw"|"cancel", remember: boolean }. */
function preflightDialog(candidates, locked) {
  return new Promise(function (resolve) {
    var settled = false;
    var remember = false;
    var dlg = document.createElement("dialog");
    function done(v) {
      if (settled) return;
      settled = true;
      try { dlg.close(); } catch (e) {}
      try { dlg.remove(); } catch (e) {}
      resolve({ decision: v, remember: remember });
    }
    var wrap = { padding: "18px 20px", fontFamily: "inherit", fontSize: 13, color: "var(--text,#e8e8ec)",
      background: "var(--bg-panel,#1c1c20)", border: "1px solid var(--border,#3a3a42)", borderRadius: 12,
      maxWidth: "min(560px, 92vw)", minWidth: "min(360px, 92vw)" };
    var row = { display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 0" };
    var mono = { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12,
      background: "var(--bg-hover,#2a2a30)", borderRadius: 4, padding: "1px 6px" };
    var mkBtn = function (label, primary, on) {
      var b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = "padding:6px 14px;border-radius:6px;font-size:13px;cursor:pointer;font-family:inherit;" +
        (primary ? "background:var(--accent,#4f8ef7);border:1px solid transparent;color:#fff;font-weight:600;"
                 : "background:var(--bg-hover,#2a2a30);border:1px solid var(--border,#3a3a42);color:var(--text,#e8e8ec);");
      b.addEventListener("click", on);
      return b;
    };

    var box = document.createElement("div");
    box.setAttribute("style", ""); // placeholder, styles applied below
    Object.assign(box.style, wrap);

    var title = document.createElement("div");
    title.textContent = t("sv.pf.title");
    title.style.cssText = "font-size:15px;font-weight:700;margin-bottom:6px;";
    box.appendChild(title);

    var hint = document.createElement("div");
    hint.textContent = locked ? t("sv.pf.locked") : t("sv.pf.hint");
    hint.style.cssText = "color:var(--text-muted,#9a9aa4);line-height:1.5;margin-bottom:8px;";
    box.appendChild(hint);

    var list = document.createElement("div");
    list.style.cssText = "max-height:34vh;overflow:auto;margin-bottom:10px;";
    candidates.forEach(function (c) {
      var r = document.createElement("div");
      r.setAttribute("style", "");
      Object.assign(r.style, row);
      var dot = document.createElement("span");
      dot.textContent = c.confidence === "high" ? "●" : "○";
      dot.title = c.confidence === "high" ? t("sv.pf.high") : t("sv.pf.medium");
      dot.style.cssText = "color:" + (c.confidence === "high" ? "var(--danger,#ef4444)" : "var(--warn,#f59e0b)") + ";";
      var pv = document.createElement("code");
      pv.textContent = c.preview;
      Object.assign(pv.style, mono);
      var lab = document.createElement("span");
      lab.textContent = c.label + (c.stored ? " · " + t("sv.pf.stored") : "");
      lab.style.cssText = "color:var(--text-muted,#9a9aa4);font-size:11.5px;";
      r.appendChild(dot); r.appendChild(pv); r.appendChild(lab);
      list.appendChild(r);
    });
    box.appendChild(list);

    // "remember this answer" — session scoped, so a long paste-heavy session is
    // not interrupted every time while a reload forgets it again.
    var rememberRow = document.createElement("label");
    rememberRow.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0 10px;color:var(--text-muted,#9a9aa4);font-size:12px;cursor:pointer;";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", function () { remember = !!cb.checked; });
    rememberRow.appendChild(cb);
    rememberRow.appendChild(document.createTextNode(t("sv.pf.remember")));
    box.appendChild(rememberRow);

    var foot = document.createElement("div");
    foot.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;";
    foot.appendChild(mkBtn(t("sv.pf.cancel"), false, function () { done("cancel"); }));
    foot.appendChild(mkBtn(t("sv.pf.raw"), false, function () { done("raw"); }));
    foot.appendChild(mkBtn(t("sv.pf.mask"), true, function () { done("mask"); }));
    box.appendChild(foot);
    dlg.appendChild(box);

    dlg.addEventListener("cancel", function (e) { e.preventDefault(); done("cancel"); });
    document.body.appendChild(dlg);
    try { dlg.showModal(); } catch (e) { done("cancel"); }
  });
}

function pfPost(path, body) {
  return fetch(API(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(function (r) { return r.json(); });
}

/** Composer pre-send gate: returns replacement text, or {cancel}. */
async function preflightGate(text) {
  if (!preflightEnabled() || !text || text.length < 8) return undefined;
  if (text.indexOf("rsec_") >= 0) return undefined; // already masked
  var auto = preflightAuto();
  if (auto === "raw") return undefined;             // asked and answered "send as-is" this session
  var scan;
  try { scan = await pfPost("/preflight/scan", { text: text, strict: true }); } catch (e) { return undefined; }
  if (!scan || !scan.ok || !scan.candidates || scan.candidates.length === 0) return undefined;
  var decision = auto || "ask";
  if (decision === "ask") {
    var answer = await preflightDialog(scan.candidates, !!scan.locked);
    decision = answer.decision;
    if (answer.remember && (decision === "mask" || decision === "raw")) setPreflightAuto(decision);
  }
  if (decision === "cancel") return { cancel: true };
  if (decision !== "mask") return undefined;
  try {
    var res = await pfPost("/preflight/mask", { text: text, indices: scan.candidates.map(function (c) { return c.index; }), strict: true });
    if (res && res.ok && typeof res.text === "string") return { text: res.text };
  } catch (e) {}
  // Masking failed (locked / write error): do not silently send plaintext.
  return { cancel: true };
}

function register(ctx) {
  __setCtx(ctx);
  ctx.registerItems("toolbar", [{
    id: "aiti-secret-vault-open",
    meta: {
      label: "i18n:sv.open.label",
      title: "i18n:sv.open.title",
      icon: "icons/key-round.svg",
      onClick: function () { setOpen(true); },
    },
  }]);
  ctx.registerItems("dialogs", [{ id: "aiti-secret-vault-panel", render: VaultPanel }]);
  // Pre-send gate (composer contract v0.3 onBeforeSend): stricter detection than
  // auto-masking, human decision, vault-first masking.
  try {
    if (typeof ctx.registerComposerEnhancement === "function") {
      ctx.registerComposerEnhancement({ id: "aiti-secret-vault-preflight", onBeforeSend: preflightGate });
    }
  } catch (e) {}
  try { console.log("[aiti-secret-vault] management dialog attached (toolbar key icon → dialog)"); } catch (e) {}
}

export { register as default };
