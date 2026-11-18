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
        fl("ok", t("sv.saved") + " · " + d.result.alias + " v" + d.result.version);
        props.reload();
      })
      .catch(function (e) { setBusy(false); fl("err", t("sv.failed") + " " + String(e)); });
  }
  function reveal(a) {
    fetch(API("/entries/" + encodeURIComponent(a) + "/reveal"), { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) setRevealed({ alias: d.alias, value: d.value }); else fl("err", t("sv.failed") + " " + (d.error || "")); });
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
            h("td", { style: tdStyle }, h("b", null, e.alias), e.scope === "project" ? h("span", { style: { color: "var(--text-muted)" } }, " [" + t("sv.project") + "]") : null),
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
  var ids = Object.keys(sessions);
  if (ids.length === 0) return h("div", { style: { padding: "18px 0", textAlign: "center", color: "var(--text-muted)" } }, t("sv.session.empty"));
  return h("table", { style: { width: "100%", borderCollapse: "collapse", marginTop: 4 } },
    h("thead", null, h("tr", null, ["session", "cwd", t("sv.session.landing"), t("sv.session.mounted"), t("sv.updated")].map(function (x) {
      return h("th", { key: x, style: { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border,#ddd)", color: "var(--text-muted)", fontWeight: 600 } }, x);
    }))),
    h("tbody", null, ids.map(function (id) {
      var s = sessions[id] || {};
      return h("tr", { key: id },
        h("td", { style: Object.assign({}, tdStyle, { fontFamily: "monospace" }) }, id.slice(0, 8)),
        h("td", { style: Object.assign({}, tdStyle, { maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }), title: s.cwd }, s.cwd || ""),
        h("td", { style: tdStyle }, s.landing || ""),
        h("td", { style: tdStyle }, (s.mounted || []).join(", ")),
        h("td", { style: tdStyle }, s.updatedAt ? String(s.updatedAt).slice(0, 16).replace("T", " ") : ""));
    })));
}

function VaultPanel() {
  var [tab, setTab] = useState("vault");
  var [status, setStatus] = useState(null);
  var [entries, setEntries] = useState([]);
  var [sessions, setSessions] = useState({});
  var fl = useFlash();
  var [busy, setBusy] = useState(false);

  function reload() {
    setBusy(true);
    Promise.all([
      fetch(API("/status")).then(function (r) { return r.json(); }),
      fetch(API("/entries")).then(function (r) { return r.json(); }),
    ]).then(function (res) {
      setBusy(false);
      if (res[0] && res[0].ok) { setStatus(res[0].status); setSessions(res[0].sessions || {}); }
      else if (res[0] && !res[0].ok) fl[1]("err", t("sv.failed") + " " + (res[0].error || ""));
      if (res[1] && res[1].ok) setEntries(res[1].entries || []);
    }).catch(function (e) { setBusy(false); fl[1]("err", t("sv.failed") + " " + String(e)); });
  }
  useEffect(function () { reload(); }, []);

  var tabBtn = function (id, label) {
    return h("button", { key: id, onClick: function () { setTab(id); }, disabled: busy,
      style: btn(tab === id ? "var(--accent,#2563eb)" : "var(--bg)", tab === id ? "#fff" : undefined) }, label);
  };
  var msg = fl[0] && h("div", { role: "alert", style: { margin: "0 12px 0", padding: "6px 10px", borderRadius: 6, fontSize: 12,
    background: fl[0].kind === "ok" ? "color-mix(in srgb, var(--ok,#10b981) 12%, transparent)" : "color-mix(in srgb, var(--danger,#ef4444) 12%, transparent)",
    color: fl[0].kind === "ok" ? "var(--ok,#10b981)" : "var(--danger,#ef4444)" } }, fl[0].text);

  return h("div", { "data-ext-float": "1", "data-ext-float-key": SV_KEY, "data-ext-float-w": 760, "data-ext-float-h": 560,
    "data-ext-float-full": "1", style: dlgRoot },
    h("div", { style: headStyle },
      h("span", { style: { fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6 } }, Ic(15, ICONS.key), t("sv.panel.label")),
      h("span", { style: { flex: 1 } }),
      tabBtn("vault", t("sv.tab.vault")),
      tabBtn("sessions", t("sv.tab.sessions")),
      h("button", { onClick: function () { setOpen(false); }, "aria-label": "close", style: { background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" } }, Ic(13, ICONS.x))),
    msg,
    h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: 12 } },
      tab === "vault"
        ? h(VaultTab, { status: status, entries: entries, reload: reload, flash: fl[1] })
        : h(SessionsTab, { sessions: sessions })));
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
  try { console.log("[aiti-secret-vault] management dialog attached (toolbar key icon → dialog)"); } catch (e) {}
}

export { register as default };
