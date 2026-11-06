/**
 * aiti-configs client —— 安全盾 UI（🛡）
 *
 * 设计：docs/aiti-configs-extension-plan.md §4.2
 * 功能：状态（变更清单 + 提交）/ 历史（版本列表 + diff 预览 + 恢复）/ 自检报告 / 配置查看编辑
 * 架构：toolbar 🛡 按钮 → 独立置顶 dialog（pages slot，不随 session 切换关闭）
 */
export default function register(ctx) {
  const { h, useState, useEffect, useCallback } = ctx;
  const api = (p, init) => fetch(ctx.apiUrl("/api/extensions/aiti-configs" + p), { cache: "no-store", ...init });
  const jsonBody = (o) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

  // lucide 图标（与系统内建线条图标同风格）
  const Ic = (size, paths) => {
    const el = h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, paths.map((d, i) => h("path", { key: i, d })));
    if (el._store) el._store.validated = 1;
    return el;
  };
  const ICONS = {
    shield: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z", "m9 12 2 2 4-4"],
    package: ["m7.5 4.27 9 5.15", "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z", "M3.3 7 12 12l8.7-5", "M12 22V12"],
    tag: ["M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z", "M7.5 7.5h.01"],
    camera: ["M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
    check: ["M20 6 9 17l-5-5"],
    x: ["M18 6 6 18", "m6 6 12 12"],
  };

  const C = {
    root: { position: "fixed", right: 18, bottom: 70, width: 560, maxWidth: "92vw", maxHeight: "76vh",
      display: "flex", flexDirection: "column", zIndex: 2147483101, background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)",
      border: "1px solid var(--border,#e0e0e0)", borderRadius: 16, boxShadow: "0 16px 64px rgba(0,0,0,.25)",
      font: "13px/1.5 system-ui, -apple-system, sans-serif", overflow: "hidden" },
    head: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f5f5f5)" },
    tabs: { display: "flex", gap: 4, flex: 1, overflowX: "auto" },
    tab: { padding: "5px 12px", border: "none", borderRadius: 8, cursor: "pointer", background: "transparent", color: "var(--text,#1a1a1a)", fontWeight: 500 },
    tabOn: { background: "var(--accent,#2563eb)", color: "#fff" },
    body: { padding: 12, overflow: "auto", flex: 1 },
    btn: { padding: "5px 12px", borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border,#e0e0e0)", borderRadius: 8, cursor: "pointer", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontWeight: 500 },
    btnPrimary: { background: "var(--accent,#2563eb)", borderColor: "var(--accent,#2563eb)", color: "#fff" },
    row: { padding: "6px 8px", borderBottom: "1px solid var(--border,#e0e0e0)", cursor: "pointer" },
    mono: { font: "11.5px/1.5 ui-monospace, monospace", wordBreak: "break-all" },
    pre: { background: "var(--bg-subtle,#f5f5f5)", border: "1px solid var(--border,#e0e0e0)", borderRadius: 8, padding: 10, overflow: "auto", maxHeight: 260, whiteSpace: "pre-wrap", wordBreak: "break-all", font: "11.5px/1.5 ui-monospace, monospace" },
    msg: { padding: "6px 10px", borderRadius: 8, background: "var(--bg-subtle,#f5f5f5)", marginBottom: 8, fontSize: 12 },
  };

  function App({ open, onClose }) {
    const [tab, setTab] = useState("status");
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState("");
    const [diff, setDiff] = useState(null);
    const [tagList, setTagList] = useState(null);
    const [encStatus, setEncStatus] = useState(null);

    const load = useCallback(async (t) => {
      if (!open) return;
      setBusy(true); setMsg("");
      try {
        const ep = t === "status" ? "/status" : t === "log" ? "/log?n=15" : t === "selfcheck" ? "/selfcheck" : "/config";
        const r = await api(ep);
        setData(await r.json());
        if (t === "config") { try { setEncStatus(await (await api("/key")).json()); } catch (e) {} }
      } catch (e) { setMsg("加载失败：" + (e.message || e)); }
      setBusy(false);
    }, [open]);

    useEffect(() => { if (open) load(tab); }, [open, tab, load]);

    const doCommit = async () => {
      setBusy(true); setMsg("");
      try {
        const r = await api("/commit", { method: "POST", ...jsonBody({}) });
        const d = await r.json();
        setMsg(d.noop ? "无可提交变更" : "✅ 已提交 " + d.hash + " · " + String(d.message || "").split("\n")[0]);
        load("status");
      } catch (e) { setMsg("提交失败：" + (e.message || e)); }
      setBusy(false);
    };
    const doRestore = async (version) => {
      if (!confirm("恢复至 " + version + "？恢复协议五步走：先固化现场+打 tag，可回退，不丢数据。")) return;
      setBusy(true); setMsg("");
      try {
        const r = await api("/restore", { method: "POST", ...jsonBody({ version, confirm: "确认恢复" }) });
        const d = await r.json();
        setMsg(d.ok ? "✅ 恢复完成（tag=" + d.tag + "）" : "❌ " + (d.error || d.hint || JSON.stringify(d.steps || "")));
        if (d.ok) { load("log"); setDiff(null); }
      } catch (e) { setMsg("恢复失败：" + (e.message || e)); }
      setBusy(false);
    };
    const showDiff = async (version) => {
      setBusy(true);
      try { const r = await api("/diff?version=" + encodeURIComponent(version)); setDiff(await r.json()); } catch (e) { setDiff({ error: e.message }); }
      setBusy(false);
    };
    const doSaveConfig = async (setObj) => {
      setBusy(true); setMsg("");
      try {
        const r = await api("/config", { method: "POST", ...jsonBody({ set: setObj }) });
        const d = await r.json();
        setMsg(d.ok ? "已更新配置" : "失败：" + d.error);
        if (d.ok) load("config");
      } catch (e) { setMsg("保存失败：" + (e.message || e)); }
      setBusy(false);
    };
    const doTag = async (hash) => {
      const name = prompt("给此版本打 tag（标记'好用版本'，如 good-v1）：", "good-v" + hash.slice(0, 4));
      if (!name) return;
      setBusy(true); setMsg("");
      try {
        const r = await api("/tag", { method: "POST", ...jsonBody({ name: name.trim() }) });
        const d = await r.json();
        setMsg(d.ok ? "✅ 已打 tag: " + d.name : "失败：" + (d.error || ""));
        load("log"); loadTags();
      } catch (e) { setMsg("打 tag 失败：" + (e.message || e)); }
      setBusy(false);
    };
    const doDelTag = async (name) => {
      if (!confirm("删除 tag: " + name + "？")) return;
      setBusy(true); setMsg("");
      try {
        const r = await api("/tag?name=" + encodeURIComponent(name), { method: "DELETE" });
        const d = await r.json();
        setMsg(d.ok ? "已删 tag: " + name : "失败：" + (d.error || ""));
        loadTags();
      } catch (e) { setMsg("删 tag 失败：" + (e.message || e)); }
      setBusy(false);
    };
    const loadTags = async () => {
      try { const r = await api("/tag"); setTagList(await r.json()); } catch (e) {}
    };
    const doSnapshot = async () => {
      setBusy(true); setMsg("");
      try {
        const r = await api("/snapshot", { method: "POST", ...jsonBody({}) });
        const d = await r.json();
        setMsg(d.noop ? "已是最新（无变更可固化）" : "✅ 已固化现场：" + d.hash);
        load("status"); load("log");
      } catch (e) { setMsg("快照失败：" + (e.message || e)); }
      setBusy(false);
    };

    const renderStatus = () => {
      const d = data || {};
      const rs = d.remote || {};
      return h("div", {},
        rs && rs.url
          ? h("div", { style: { fontSize: 12, marginBottom: 8, padding: "6px 8px", borderRadius: 8, background: "#eff6ff", border: "1px solid #bfdbfe", color: "#1d4ed8" } },
              "远端同步：" + (rs.push ? "启用" : "停用") + " · " + rs.url + (rs.autoPull ? " · pull --rebase" : "") + " · branch=" + (rs.branch || "main"))
          : null,
        h("div", { style: { display: "flex", gap: 8, marginBottom: 8 } },
          h("button", { style: Object.assign({}, C.btn, C.btnPrimary, { display: "inline-flex", alignItems: "center", gap: 5 }), onClick: doCommit }, Ic(13, ICONS.package), "提交变更"),
          h("button", { style: C.btn, onClick: () => load("status") }, "↻ 刷新")),
        d.clean === true
          ? h("div", { style: { color: "#16a34a", fontWeight: 600 } }, "✅ 工作区干净（无可提交变更）")
          : (d.changed && d.changed.length
              ? h("div", {},
                  h("div", { style: { fontWeight: 600, marginBottom: 6 } }, "待提交 " + d.changed.length + " 个文件："),
                  d.changed.map((c, i) => h("div", { key: i, style: C.row },
                    h("span", { style: { color: c.status === "D" ? "#dc2626" : c.status === "??" ? "#16a34a" : "#2563eb", fontWeight: 700, marginRight: 6 } }, c.status === "D" ? "DEL" : c.status === "??" ? "NEW" : "MOD"),
                    h("span", { style: C.mono }, c.path))))
              : null),
        d.skipped && d.skipped.length > 0
          ? h("div", { style: { marginTop: 8, fontSize: 12, color: "#d97706" } }, "⏭ 拦截 " + d.skipped.length + " 项：" + d.skipped.map((s) => s.reason).slice(0, 5).join("；") + (d.skipped.length > 5 ? "…" : ""))
          : null);
    };

    const renderLog = () => {
      const d = data || {};
      return h("div", {},
        h("div", { style: { display: "flex", gap: 8, marginBottom: 8 } },
          h("button", { style: Object.assign({}, C.btn, { padding: "3px 10px", display: "inline-flex", alignItems: "center", gap: 4 }), onClick: loadTags }, Ic(12, ICONS.tag), "tags"),
          h("button", { style: Object.assign({}, C.btn, { padding: "3px 10px", display: "inline-flex", alignItems: "center", gap: 4 }), onClick: doSnapshot }, Ic(12, ICONS.camera), "固化现场")),
        tagList && tagList.tags && tagList.tags.length > 0
          ? h("div", { style: { marginBottom: 8 } }, tagList.tags.map((t) => h("span", { key: t.name, style: { display: "inline-flex", alignItems: "center", gap: 4, margin: "0 6px 4px 0", padding: "2px 8px", borderRadius: 10, background: "#fef3c7", color: "#92400e", fontSize: 11, border: "1px solid #fcd34d" } }, Ic(11, ICONS.tag), " ", t.name, h("button", { style: { border: "none", background: "transparent", cursor: "pointer", color: "#92400e", display: "flex" }, onClick: () => doDelTag(t.name), "aria-label": "删除 tag" }, Ic(10, ICONS.x)))))
          : null,
        (d.log || []).map((r) => h("div", { key: r.hash, style: C.row, onClick: () => showDiff(r.hash) },
          h("div", {},
            h("span", { style: { color: "var(--accent,#2563eb)", fontWeight: 700, marginRight: 6 } }, r.hash),
            h("span", { style: { color: "var(--text-subtle,#666)", marginRight: 6 } }, String(r.date || "").slice(5, 16)),
            (r.tags || []).map((t) => h("span", { key: t, style: { marginRight: 4, padding: "1px 6px", borderRadius: 8, background: "#fef3c7", color: "#92400e", fontSize: 10 } }, Ic(10, ICONS.tag), t)),
            h("span", {}, r.subject)),
          h("div", { style: { marginTop: 4, display: "flex", gap: 6 } },
            h("button", { style: Object.assign({}, C.btn, { padding: "2px 8px" }), onClick: (e) => { e.stopPropagation(); doRestore(r.hash); } }, "↩ 恢复"),
            h("button", { style: Object.assign({}, C.btn, { padding: "2px 8px", display: "inline-flex", alignItems: "center", gap: 4 }), onClick: (e) => { e.stopPropagation(); doTag(r.hash); } }, Ic(11, ICONS.tag), "tag")))),
        diff
          ? h("div", { style: { marginTop: 10 } },
              h("div", { style: { fontWeight: 600, marginBottom: 4 } }, "版本 diff 预览"),
              h("pre", { style: C.pre }, String((diff.show || "") + "\n" + (diff.diff || diff.error || "")).slice(0, 3000)))
          : null);
    };

    const renderSelfcheck = () => {
      const d = data || {};
      return h("div", {},
        h("div", { style: { fontWeight: 600, marginBottom: 6, color: d.ok ? "#16a34a" : "#dc2626" } },
          d.ok ? "✅ 自检通过" : "❌ 自检未通过（" + ((d.bad || []).length) + " 项）"),
        (d.rows || []).map((r, i) => h("div", { key: i, style: C.row },
          h("span", { style: { marginRight: 6, display: "inline-flex" } }, r.ok ? Ic(13, ICONS.check) : Ic(13, ICONS.x)),
          h("b", {}, r.name),
          h("span", { style: { color: "var(--text-subtle,#666)", marginLeft: 6 } }, r.detail))),
        h("button", { style: Object.assign({}, C.btn, { marginTop: 8 }), onClick: () => load("selfcheck") }, "↻ 重新自检"));
    };

    const doGenKey = async () => {
      setBusy(true); setMsg("");
      try {
        const r = await api("/key", { method: "POST", ...jsonBody({}) });
        const d = await r.json();
        setMsg(d.ok ? "✅ 已生成密钥：" + d.keyFile + "（请立即备份！）" : "生成失败：" + d.error);
        load("config");
      } catch (e) { setMsg("生成失败：" + (e.message || e)); }
      setBusy(false);
    };

    const renderConfig = () => {
      const d = data || {};
      const rc = (d.config && d.config.remote) || {};
      const en = (d.config && d.config.encrypt) || {};
      const es = encStatus && encStatus.encrypt ? encStatus.encrypt : {};
      const warn = { padding: "8px 10px", borderRadius: 8, background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 12, marginBottom: 8, lineHeight: 1.6 };
      const inp = { padding: "5px 8px", border: "1px solid var(--border,#e0e0e0)", borderRadius: 6, background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontSize: 12 };
      return h("div", {},
        h("div", { style: warn },
          "⚠ 本仓包含 settings/models.json 等含 API Key 的敏感配置——", h("b", {}, "严禁配置为公开仓库（GitHub/Gitee 公开仓、任意公网可见仓）"), "！只能配私有/自建 git 仓；url 内嵌 token 仅存本机，不写日志不展示明文。"),
        h("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 4, marginTop: 4 } }, "远端同步（remote）"),
        h("div", { style: { display: "flex", gap: 6, marginBottom: 6, alignItems: "center" } },
          h("input", { id: "cfg-remote-url", type: "text", placeholder: "git@github.com:user/private-configs.git 或 https://token@…", defaultValue: rc.url || "", style: Object.assign({ flex: 1 }, inp) })),
        h("div", { style: { display: "flex", gap: 14, marginBottom: 8, fontSize: 12 } },
          h("label", { style: { display: "flex", alignItems: "center", gap: 4 } }, h("input", { id: "cfg-remote-push", type: "checkbox", defaultChecked: rc.push === true }), "提交后自动 push"),
          h("label", { style: { display: "flex", alignItems: "center", gap: 4 } }, h("input", { id: "cfg-remote-pull", type: "checkbox", defaultChecked: rc.autoPull !== false }), "push 前 pull --rebase")),
        h("div", { style: { display: "flex", gap: 8, marginBottom: 8 } },
          h("button", { style: Object.assign({}, C.btn, C.btnPrimary), onClick: () => {
            const g = (id) => document.getElementById(id);
            const url = (g("cfg-remote-url") || {}).value || "";
            const push = g("cfg-remote-push") ? g("cfg-remote-push").checked : false;
            const autoPull = g("cfg-remote-pull") ? g("cfg-remote-pull").checked : true;
            doSaveConfig({ remote: { url, push, autoPull } });
          } }, "保存 remote"),
          h("button", { style: C.btn, onClick: () => doSaveConfig({ remote: { url: "", push: false, autoPull: true } }) }, "清除 remote")),
        h("div", { style: { fontSize: 12, fontWeight: 600, marginBottom: 4, marginTop: 10 } }, "密文 commit（encrypt）"),
        h("div", { style: warn },
          "🔑 开启后仓内为密文，push 到任何仓库（含公开仓）都安全；但密钥文件（" + (en.keyFile || "{repo}/.git/configs-key") + "）", h("b", {}, "丢失则永远无法恢复"), "！请备份密钥；密钥文件在 .git 下，git 永不跟踪、不入仓。"),
        h("div", { style: { display: "flex", gap: 14, marginBottom: 6, fontSize: 12, alignItems: "center" } },
          h("label", { style: { display: "flex", alignItems: "center", gap: 4 } }, h("input", { id: "cfg-enc-enabled", type: "checkbox", defaultChecked: en.enabled === true }), "启用密文 commit"),
          h("span", { style: { color: es.keyExists === true ? "#16a34a" : "#dc2626" } }, es.keyExists === true ? "✅ 密钥已生成（" + (es.keyFile || "") + "）" : "❌ 密钥未生成（先点生成密钥）")),
        h("div", { style: { display: "flex", gap: 6, marginBottom: 6 } },
          h("input", { id: "cfg-enc-patterns", type: "text", defaultValue: (en.patterns || ["pi/agent/**"]).join(","), placeholder: "加密文件 glob（逗号分隔，如 pi/agent/**）", style: Object.assign({ flex: 1 }, inp) })),
        h("div", { style: { display: "flex", gap: 8, marginBottom: 8 } },
          h("button", { style: Object.assign({}, C.btn, C.btnPrimary), onClick: () => {
            const g = (id) => document.getElementById(id);
            const enabled = g("cfg-enc-enabled") ? g("cfg-enc-enabled").checked : false;
            const patterns = (g("cfg-enc-patterns") || {}).value ? String(g("cfg-enc-patterns").value).split(",").map((s) => s.trim()).filter(Boolean) : ["pi/agent/**"];
            doSaveConfig({ encrypt: { enabled: enabled, algo: en.algo || "aes-256-gcm", keyFile: en.keyFile || "", patterns: patterns } });
          } }, "保存 encrypt"),
          h("button", { style: C.btn, onClick: doGenKey }, "生成密钥")),
        h("pre", { style: Object.assign({}, C.pre, { maxHeight: 320 }) }, JSON.stringify(d.config || {}, null, 2)),
        h("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
          h("button", { style: Object.assign({}, C.btn, C.btnPrimary), onClick: () => doSaveConfig({ sentry: { enabled: true } }) }, "开启自动哨兵"),
          h("button", { style: C.btn, onClick: () => load("config") }, "↻ 刷新")));
    };

    if (!open) return null;
    return h("div", { style: C.root },
      h("div", { style: C.head },
        h("span", { style: { fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6 } }, Ic(15, ICONS.shield), "配置安全盾"),
        h("div", { style: C.tabs },
          [["status", "状态"], ["log", "历史"], ["selfcheck", "自检"], ["config", "配置"]].map(([k, label]) =>
            h("button", { key: k, style: Object.assign({}, C.tab, tab === k ? C.tabOn : {}), onClick: () => { setTab(k); setDiff(null); } }, label))),
        h("button", { style: C.btn, onClick: () => onClose(), "aria-label": "关闭" }, Ic(12, ICONS.x))),
      h("div", { style: C.body },
        busy ? h("div", { style: { color: "var(--text-subtle,#666)", marginBottom: 6 } }, "处理中…") : null,
        msg ? h("div", { style: C.msg }, msg) : null,
        tab === "status" ? renderStatus() : tab === "log" ? renderLog() : tab === "selfcheck" ? renderSelfcheck() : renderConfig()));
  }

  // toolbar 按钮：只负责触发全局打开（真正的 dialog 在 pages slot，避免 toolbar 容器裁剪 fixed 弹层）
  function ConfigsButton() {
    const open = () => { try { window.__aitiConfigsOpen && window.__aitiConfigsOpen(); } catch (e) {} };
    // 顶栏按钮样式与系统内建按钮一致（AppShell topbarRowBtnStyle：flex 居中 + fixed 36×36（=系统 TOP_BAR_ICON_BUTTON_SIZE））
    return h("button", {
      title: "aiti-configs：配置版本化 + 自检",
      onClick: open,
      onMouseEnter: (e) => { e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { e.currentTarget.style.color = "var(--text-muted)"; },
      style: {
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", border: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      },
    },
      // lucide shield：安全盾——与系统内建线条图标同风格
      h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { key: "p1", d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }),
        h("path", { key: "p2", d: "m9 12 2 2 4-4" })));
  }

  // pages dialog：常驻 host 渲染层，注册全局打开函数，打开时渲染安全盾
  function ConfigsDialog() {
    const [open, setOpen] = useState(false);
    useEffect(() => {
      window.__aitiConfigsOpen = () => setOpen(true);
      return () => { delete window.__aitiConfigsOpen; };
    }, []);
    if (!open) return null;
    return h(App, { open: true, onClose: () => setOpen(false) });
  }

  // 渲染注册
  ctx.registerItems("toolbar", [{ id: "aiti-configs-open", render: ConfigsButton, meta: { label: "配置" } }]);
  ctx.registerItems("pages", [{ id: "aiti-configs-dialog", render: ConfigsDialog }]);
  try { console.log("[aiti-configs] client 安全盾已挂载（toolbar 触发 → pages 渲染，状态/历史/自检/配置）"); } catch (e) {}
}
