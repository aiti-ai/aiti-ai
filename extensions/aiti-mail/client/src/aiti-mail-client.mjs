/**
 * aiti-mail client —— 管理弹窗（原生 mjs，宿主 h()/useState 委托）
 *
 * 插槽：toolbar（✉ 线图按钮入口，静态条目两段式——ui.toolbar id 与本注册 raw id 一致）
 *      + dialogs（面板，data-ext-float 规范：拖拽/缩放/持久化/小屏全屏由 aiti-float 接管）。
 * 两个页签：「配置」（SMTP 表单 + 发送测试）与「发送记录」（sqlite 记录表格）。
 * 右上角 AI 按钮（🤖）由框架在 dialog 渲染层统一注入——扩展不手写。
 */
let _ctx = null;
function __setCtx(ctx) { _ctx = ctx; }
function c(name) { return _ctx?.[name] ?? function () { return undefined; }; }
function h(type, props) {
  var args = Array.prototype.slice.call(arguments);
  return c("h").apply(null, args);
}
function useState(init) { return c("useState")(init); }
function useEffect(fn, deps) { return c("useEffect")(fn, deps); }
function useRef(v) { return c("useRef")(v); }
function apiUrl(p) {
  var fn = _ctx?.apiUrl;
  return typeof fn === "function" ? fn(p) : p;
}
var API = function (p) { return apiUrl("/api/extensions/aiti-mail" + p); };

// ── dock v3（P3 批）：显隐收口 aiti-float 展示状态机（手写 mjs 免构建，内联薄桥） ──
var MAIL_KEY = "aiti-mail:panel";
var mailLocalOpen = false; // 未装 aiti-float 的本地降级开关
var mailFloat = function () {
  var a = (typeof window !== "undefined") && window.__piweFloat;
  return a && typeof a.present === "function" ? a : null;
};
var mailPresented = function () {
  var a = mailFloat();
  return a ? (a.presented(MAIL_KEY) || "closed") : (mailLocalOpen ? "floating" : "closed");
};
var mailSetOpen = function (v) {
  var a = mailFloat();
  if (a) { a.present(MAIL_KEY, v ? "open" : "close"); return; }
  mailLocalOpen = v;
};
try { var mk = "pi-web:ext-float:dockpref:v1:" + MAIL_KEY; if (!localStorage.getItem(mk)) localStorage.setItem(mk, "right-panel"); } catch (e) {}
var mailFragment = (typeof Symbol !== "undefined" && Symbol.for) ? Symbol.for("react.fragment") : 0xacb;

// ── 线图（lucide 同风格，24×24 stroke） ──
var ICONS = {
  mail: ["M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z", "m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"],
  x: ["M18 6 6 18", "m6 6 12 12"],
};
function Ic(size, paths) {
  return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
    paths.map(function (d, i) { return h("path", { key: i, d: d }); }));
}

// ── 小工具 ──
var btnStyle = function (bg, color) {
  return { padding: "4px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
    background: bg, border: "1px solid var(--border)", color: color };
};
var inputStyle = { padding: "5px 8px", borderRadius: 6, fontSize: 12.5, border: "1px solid var(--border)",
  background: "var(--bg)", color: "var(--text)", width: "100%", boxSizing: "border-box" };
var tdStyle = { padding: "4px 8px", borderBottom: "1px solid var(--border)", verticalAlign: "top", fontSize: 11.5 };

// ── 打开句柄（toolbar onClick 在组件外触发；状态机收口） ──
function requestOpen() { mailSetOpen(true); }

function MailPanel() { return renderMailPanel("float"); }
function MailDockFace() { return renderMailPanel("dock"); }
function renderMailPanel(face) {
  // 机器态 → 本组件同步：force-update 计数器（状态机 CHANGE_EVENT 驱动，无轮询）；
  // 机器态在渲染时直读（useState 存值会过期）
  var fuS = useState(0); var fuSet = fuS[1];
  useEffect(function () {
    var sync = function () { fuSet(function (n) { return n + 1; }); };
    window.addEventListener("piwe-float-present-change", sync);
    return function () { window.removeEventListener("piwe-float-present-change", sync); };
  }, []);
  var st = mailPresented();
  var open = face === "float" ? st === "floating" : st === "docked:right-panel";
  var floating = face === "float";
  var setOpen = function (v) { mailSetOpen(v); };
  var tabS = useState("config"); var tab = tabS[0]; var setTab = tabS[1];
  var cfgS = useState(null); var cfg = cfgS[0]; var setCfg = cfgS[1];
  var formS = useState({ host: "", port: "465", secure: "starttls", user: "", pass: "", from: "", testTo: "" });
  var form = formS[0]; var setForm = formS[1];
  var logS = useState(null); var log = logS[0]; var setLog = logS[1];
  var msgS = useState(null); var msg = msgS[0]; var setMsg = msgS[1];
  var busyS = useState(false); var busy = busyS[0]; var setBusy = busyS[1];
  var liveRef = useRef(true);

  var setF = function (k, v) { setForm(function (f0) { var f = Object.assign({}, f0); f[k] = v; return f; }); };

  var loadConfig = function () {
    return fetch(API("/config")).then(function (r) { return r.json(); }).then(function (d) {
      if (!liveRef.current) return;
      setCfg(d.config || null);
      if (d.config) {
        setForm(function (f0) {
          var f = Object.assign({}, f0);
          f.host = d.config.host || "";
          f.port = String(d.config.port || 465);
          f.secure = d.config.secure ? "ssl" : (d.config.noStarttls ? "none" : "starttls");
          f.user = d.config.user || "";
          f.from = d.config.from || "";
          return f;
        });
      }
    }).catch(function () {});
  };
  var loadLog = function () {
    fetch(API("/log?limit=100")).then(function (r) { return r.json(); })
      .then(function (d) { if (liveRef.current) setLog(d.sends || []); })
      .catch(function () { if (liveRef.current) setLog([]); });
  };
  useEffect(function () {
    liveRef.current = true;
    if (open) { loadConfig(); loadLog(); }
    return function () { liveRef.current = false; };
  }, [open]);

  var save = function () {
    setBusy(true); setMsg(null);
    var body = { host: form.host, port: Number(form.port) || (form.secure === "ssl" ? 465 : 25),
      secure: form.secure === "ssl", noStarttls: form.secure === "none",
      user: form.user, from: form.from };
    if (form.pass) body.pass = form.pass; // 缺省=保留旧值（服务端语义）
    fetch(API("/config"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!liveRef.current) return;
        setMsg(d.ok ? { kind: "ok", text: "已保存" } : { kind: "err", text: "保存失败：" + (d.error || "?") });
        if (d.ok) loadConfig();
      })
      .catch(function (e) { if (liveRef.current) setMsg({ kind: "err", text: "保存失败：" + e }); })
      .finally(function () { if (liveRef.current) setBusy(false); });
  };
  var sendTest = function () {
    setBusy(true); setMsg(null);
    fetch(API("/test"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: form.testTo }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!liveRef.current) return;
        var rs = d.results || [];
        var bad = rs.filter(function (r) { return r.status !== "ok"; });
        if (d.ok) setMsg({ kind: "ok", text: "测试邮件已发送 → " + rs.map(function (r) { return r.to; }).join(", ") + "（" + rs.map(function (r) { return r.durationMs; }).join("/") + "ms）" });
        else setMsg({ kind: "err", text: "发送失败：" + (d.error || (bad[0] && bad[0].error) || "?") });
        loadLog();
      })
      .catch(function (e) { if (liveRef.current) setMsg({ kind: "err", text: "发送失败：" + e }); })
      .finally(function () { if (liveRef.current) setBusy(false); });
  };

  if (!open) return null;

  var row = function (label, el) {
    return h("label", { key: label, style: { display: "grid", gridTemplateColumns: "72px 1fr", gap: 8, alignItems: "center", fontSize: 12 } },
      h("span", { style: { color: "var(--text-muted)" } }, label), el);
  };
  var dlgRoot = {
    position: "fixed", right: 18, bottom: 70, width: 620, maxWidth: "94vw", maxHeight: "80vh",
    display: "flex", flexDirection: "column", zIndex: 2147483101,
    background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)",
    border: "1px solid var(--border,#e0e0e0)", borderRadius: 16,
    boxShadow: "0 16px 64px rgba(0,0,0,.25)", fontFamily: "inherit", overflow: "hidden",
  };
  var head = { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
    borderBottom: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f5f5f5)", flexShrink: 0 };
  var tabBtn = function (id, label) {
    return h("button", { key: id, onClick: function () { setTab(id); setMsg(null); if (id === "log") loadLog(); },
      style: { padding: "3px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer", border: "1px solid " + (tab === id ? "var(--border)" : "transparent"),
        background: tab === id ? "var(--bg)" : "transparent", color: tab === id ? "var(--text)" : "var(--text-muted)",
        fontWeight: tab === id ? 600 : 400 } }, label);
  };

  var bodyEl;
  if (tab === "config") {
    var hasCfg = !!cfg;
    bodyEl = h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      row("SMTP 服务器", h("input", { value: form.host, onChange: function (e) { setF("host", e.target.value); }, placeholder: "如 smtp.qq.com", style: inputStyle })),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
        row("端口", h("input", { value: form.port, onChange: function (e) { setF("port", e.target.value.replace(/\D/g, "")); }, placeholder: "465 / 587 / 25", style: inputStyle })),
        row("加密", h("select", { value: form.secure, onChange: function (e) { setF("secure", e.target.value); }, style: inputStyle },
          h("option", { value: "ssl" }, "SSL/TLS（465 隐式）"),
          h("option", { value: "starttls" }, "STARTTLS（587 推荐，服务器支持则自动升级）"),
          h("option", { value: "none" }, "不加密直连（25 等，永不升级）")))),
      row("用户名", h("input", { value: form.user, onChange: function (e) { setF("user", e.target.value); }, placeholder: " usually 即发件邮箱", style: inputStyle })),
      row("密码/授权码", h("input", { type: "password", value: form.pass, onChange: function (e) { setF("pass", e.target.value); },
        placeholder: hasCfg && cfg && cfg.hasPass ? "已保存（留空=不修改）" : "SMTP 授权码（非登录密码）", style: inputStyle })),
      row("发件人", h("input", { value: form.from, onChange: function (e) { setF("from", e.target.value); }, placeholder: "可选，缺省用用户名", style: inputStyle })),
      h("div", { style: { display: "flex", justifyContent: "flex-end" } },
        h("button", { disabled: busy || !form.host.trim(), onClick: save,
          style: Object.assign(btnStyle("#3b82f6", "#fff"), { opacity: busy || !form.host.trim() ? 0.5 : 1 }) }, busy ? "保存中…" : "保存配置")),
      h("div", { style: { borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 8 } },
        h("div", { style: { fontSize: 12, fontWeight: 600 } }, "发送测试"),
        row("测试收件人", h("input", { value: form.testTo, onChange: function (e) { setF("testTo", e.target.value); },
          placeholder: "you@example.com", style: inputStyle })),
        h("div", { style: { display: "flex", justifyContent: "flex-end" } },
          h("button", { disabled: busy || !form.testTo.trim() || !cfg, onClick: sendTest,
            style: Object.assign(btnStyle("var(--bg-hover)", "var(--text)"), { opacity: busy || !form.testTo.trim() || !cfg ? 0.5 : 1 }),
            title: !cfg ? "先保存配置" : "" }, "发送测试")),
        h("div", { style: { fontSize: 11, color: "var(--text-muted)" } },
          "提示：QQ/163 邮箱需在邮箱设置里开启 SMTP 并使用「授权码」。密码只存本机 configDir/config.json（0600），API 不回显。")));
  } else {
    bodyEl = h("div", null,
      h("div", { style: { display: "flex", justifyContent: "flex-end", marginBottom: 6 } },
        h("button", { onClick: loadLog, style: btnStyle("var(--bg-hover)", "var(--text)") }, "刷新")),
      log === null
        ? h("div", { style: { color: "var(--text-muted)", fontSize: 12 } }, "加载中…")
        : log.length === 0
          ? h("div", { style: { color: "var(--text-muted)", fontSize: 12, padding: "20px 0", textAlign: "center" } }, "暂无发送记录")
          : h("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 11.5 } },
              h("thead", null, h("tr", null, ["时间", "收件人", "主题", "状态", "耗时", "来源"].map(function (th) {
                return h("th", { key: th, style: { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)" } }, th);
              }))),
              h("tbody", null, log.map(function (r) {
                return h("tr", { key: r.id },
                  h("td", { style: tdStyle, title: r.ts }, new Date(r.ts).toLocaleString()),
                  h("td", { style: tdStyle }, r.to_addr),
                  h("td", { style: Object.assign({}, tdStyle, { maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }), title: r.subject }, r.subject),
                  h("td", { style: Object.assign({}, tdStyle, { color: r.status === "ok" ? "#10b981" : "var(--danger, #ef4444)" }), title: r.error || "" }, r.status === "ok" ? "ok" : "error"),
                  h("td", { style: tdStyle }, r.duration_ms != null ? r.duration_ms + "ms" : ""),
                  h("td", { style: tdStyle }, r.source || ""));
              }))),
      h("div", { style: { fontSize: 11, color: "var(--text-muted)", marginTop: 8 } }, "记录保留 90 天（cache/mails.db）。"));
  }

  var panelEl = h(mailFragment, null,
    h("div", { style: head },
      floating ? h("span", { style: { fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6 } },
        Ic(15, ICONS.mail), "邮件") : null,
      h("span", { style: { flex: 1 } }),
      tabBtn("config", "配置"),
      tabBtn("log", "发送记录"),
      floating ? h("button", { onClick: function () { setOpen(false); }, "aria-label": "关闭", title: "关闭",
        style: { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "2px 6px", flexShrink: 0 } },
        Ic(12, ICONS.x)) : null),
    h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto", padding: 12 } },
      msg && h("div", { role: "alert",
        style: { marginBottom: 8, padding: "6px 10px", borderRadius: 6, fontSize: 12,
          background: msg.kind === "ok" ? "rgba(16,185,129,.12)" : "rgba(239,68,68,.12)",
          color: msg.kind === "ok" ? "#10b981" : "var(--danger, #ef4444)" } }, msg.text),
      bodyEl));
  // dock v3 分面：float = 浮窗壳（float 契约）；dock = 右栏 tab（embedded 铺满，TabBar ✕ 关闭）
  if (floating) {
    return h("div", { "data-ext-float": "1", "data-ext-float-key": MAIL_KEY, "data-ext-float-dock": "right-panel",
      "data-ext-float-dock-default": "right-panel",
      "data-ext-float-w": 620, "data-ext-float-h": 540, "data-ext-float-full": "1", style: dlgRoot }, panelEl);
  }
  return h("div", { style: { width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", overflow: "hidden" } }, panelEl);
}

function register(ctx) {
  __setCtx(ctx);
  ctx.registerItems("toolbar", [{
    id: "aiti-mail-open",
    meta: {
      label: "邮件",
      title: "邮件：SMTP 配置 / 发送测试 / 发送记录",
      icon: "icons/mail.svg",
      onClick: function () { requestOpen(); },
    },
  }]);
  ctx.registerItems("dialogs", [{ id: "aiti-mail-panel", render: MailPanel }]);
  // aiti-float dock v3（P3 批）：右栏「邮件」tab（id 拼后 = MAIL_KEY）
  ctx.registerItems("rightFileDock", [{ id: "panel", render: MailDockFace, meta: { title: "邮件" } }]);
  try { console.log("[aiti-mail] 管理弹窗已挂载（toolbar ✉ 入口 → dialogs 弹窗）"); } catch (e) { /* noop */ }
}

export { register as default };
