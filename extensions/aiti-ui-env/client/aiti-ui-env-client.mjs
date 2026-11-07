/**
 * aiti-ui-env client bundle — 显示环境管理面板（4 模式 + 桌面/虚拟屏探测 + VNC-on-web）。
 *
 * 与 demo/aiti-extman 同模式：host 传 h/useState/useEffect/t/apiUrl。
 * toolbar 🖥️ 按钮 → dialogs 面板：
 *   - 模式区：4 单选（POST set-mode，即时生效，对新启动生效）
 *   - 环境卡 ×2：桌面 / 无头虚拟屏（探测结果 + 参数 + 错误/告警）
 *   - VNC 卡：web 地址（复制链接）+ 启停按钮 + noVNC 目录探测
 *   - 环境预览：当前裁决结果（target/export 行）
 *   - 安装卡：组件探测 + systemd unit 状态 + 安装指引
 */

let panelOpen = false;
const listeners = new Set();
function setPanelOpen(v) { panelOpen = v; for (const l of listeners) l(); }

// ── 主题（与宿主 CSS 变量对齐；extman/demo 已验证可用集） ──
const C = {
  panel: "var(--bg-panel, #1a1a22)",
  panel2: "var(--bg-hover, rgba(128,128,128,0.08))",
  border: "var(--border)",
  text: "var(--text)",
  muted: "var(--text-muted)",
  dim: "var(--text-dim)",
  accent: "var(--accent)",
  ok: "var(--ok, #22c55e)",
  bad: "var(--danger, #ef4444)",
  warn: "var(--warn, #f59e0b)",
  mono: "var(--font-mono, monospace)",
};

export default function register(ctx) {
  const { h, useState, useEffect, t, apiUrl } = ctx;

  // lucide 图标（与系统内建线条图标同风格）
  const Ic = (size, paths) => {
    const el = h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, paths.map((d, i) => h("path", { key: i, d })));
    if (el._store) el._store.validated = 1;
    return el;
  };
  const ICONS = {
    monitor: ["M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M8 21h8", "M12 17v4"],
    cloud: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"],
    monitorPlay: ["M10 7.75a.75.75 0 0 1 1.142-.638l3.664 2.249a.75.75 0 0 1 0 1.278l-3.664 2.25a.75.75 0 0 1-1.142-.64z", "M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M8 21h8", "M12 17v4"],
    flask: ["M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2", "M8.5 2h7", "M7 16h10"],
    wrench: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
    check: ["M20 6 9 17l-5-5"],
    x: ["M18 6 6 18", "m6 6 12 12"],
    alert: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z", "M12 9v4", "M12 17h.01"],
  };

  function usePanelOpen() {
    const [open, setOpen] = useState(panelOpen);
    useEffect(() => {
      const l = () => setOpen(panelOpen);
      listeners.add(l);
      return () => listeners.delete(l);
    }, []);
    return open;
  }

  const card = (extra) => ({
    background: C.panel, border: "1px solid " + C.border, borderRadius: 12,
    padding: "12px 14px", marginBottom: 10, ...extra,
  });
  const secTitle = (color) => ({
    display: "flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 700,
    color: C.text, marginBottom: 10, letterSpacing: "0.01em",
  });
  const accentBar = (color) => ({ width: 3, height: 12, borderRadius: 2, background: color || C.accent, flexShrink: 0 });
  const dot = (color) => ({ width: 7, height: 7, borderRadius: 4, background: color, flexShrink: 0 });
  const chip = (color, bg) => ({
    fontSize: 10, padding: "1px 8px", borderRadius: 9, background: bg || "transparent",
    color, whiteSpace: "nowrap", flexShrink: 0, border: "1px solid " + (bg ? "transparent" : C.border),
  });
  const btn = (extra) => ({
    padding: "4px 11px", borderRadius: 7, fontSize: 11, cursor: "pointer",
    background: C.panel2, border: "1px solid " + C.border, color: C.muted,
    whiteSpace: "nowrap", transition: "all .12s", ...extra,
  });
  const rowStyle = { display: "flex", alignItems: "baseline", gap: 8, padding: "2.5px 0" };

  function copyText(text) {
    try { navigator.clipboard.writeText(text).catch(() => {}); } catch {}
  }

  /** 构建 VNC 访问 URL：POST /vnc-session 设 HttpOnly cookie（30min 会话，刷新/重复用可用）；
   *  URL 无任何凭据（防泄露/防跳板：复制到其他机器/浏览器无 cookie 直接 403）。
   *  instId：附加实例走 /ws/<id> 路由（多实例）；缺省=默认实例。 */
  async function buildVncUrl(instId) {
    const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc-session"), { method: "POST", cache: "no-store" });
    const d = await r.json();
    if (!d.ok) throw new Error("vnc-session 失败");
    const api = new URL(apiUrl("/x"), location.origin); // apiUrl 是相对路径（含 basePath）
    const basePath = api.pathname.endsWith("/x") ? api.pathname.slice(0, -2) : "";
    const wsSuffix = instId && instId !== "default" ? "/" + instId : "";
    const wsPath = (basePath + "/aiti-ui-env/vnc/ws" + wsSuffix).replace(/^\//, "");
    const query = "autoconnect=true&resize=scale&path=" + encodeURIComponent(wsPath);
    return location.origin + basePath + "/aiti-ui-env/vnc/vnc.html?" + query;
  }

  /** 分辨率解析：xdpyinfo 原始串 → "1920×1080" */
  function fmtRes(r) {
    if (!r) return "—";
    const m = String(r).match(/(\d+)\s*x\s*(\d+)/);
    return m ? `${m[1]}×${m[2]}` : String(r).slice(0, 24);
  }

  /* ── 主面板 ── */
  function Dialog() {
    const open = usePanelOpen();
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState(null);
    const [vncUrl, setVncUrl] = useState(null); // 默认实例会话 URL（无凭据，30min cookie 会话）
    const [deps, setDeps] = useState(null); // 依赖自检结果（多 OS）
    const [dispMode, setDispMode] = useState(null); // "auto" | "fixed"（DISPLAY 号配置）
    const [dispNum, setDispNum] = useState("");
    const [vncTab, setVncTab] = useState("own"); // VNC 卡视图：own=扩展实例 | sys=系统 VNC
    const [sysVnc, setSysVnc] = useState(null);   // 系统 VNC 列表（sys-scan 结果）
    const [sysBusy, setSysBusy] = useState(false);

    async function refresh() {
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/status?refresh=1"), { cache: "no-store" });
        const d = await r.json();
        if (!r.ok) throw new Error("HTTP " + r.status);
        setData(d); setErr(null);
        // DISPLAY 号配置：面板数据首次到达时初始化表单
        if (d.displayConfig) {
          setDispMode((prev) => prev || d.displayConfig.mode || "auto");
          setDispNum((prev) => prev || String(d.displayConfig.num || ""));
        }
        // VNC 会话 URL：POST vnc-session 建 30min HttpOnly cookie（刷新/重复打开可用）
        buildVncUrl().then((u) => setVncUrl(u)).catch(() => {}); // 默认实例会话 URL（string）
      } catch (e) { setErr(String(e && e.message || e)); }
    }
    useEffect(() => { if (open) refresh(); }, [open]);
    // 依赖自检（不阻塞主状态）：缺失组件 + 自动安装 + 手动指引
    async function loadDeps() {
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/deps"), { cache: "no-store" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        setDeps(await r.json());
      } catch { /* 忽略：deps 区块不强求 */ }
    }
    useEffect(() => { if (open) loadDeps(); }, [open]);

    async function installDepsBtn() {
      setBusy(true);
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/deps"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "install" }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        setDeps(await r.json());
      } catch (e) { setErr(String(e && e.message || e)); }
      setBusy(false);
    }
    // Esc 关闭（标准模态行为）—— 必须在 early return 之前（React hooks 规则：hooks 调用顺序必须稳定）
    useEffect(() => {
      const onKey = (e) => { if (e.key === "Escape") setPanelOpen(false); };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    async function setMode(mode) {
      setBusy(true);
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/set-mode"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
        await refresh();
      } catch (e) { setErr(String(e && e.message || e)); }
      setBusy(false);
    }

    const [vncBusy, setVncBusy] = useState(false);
    async function vncAction(action, id) {
      setVncBusy(true);
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, id }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        await refresh();
      } catch (e) { setErr(String(e && e.message || e)); }
      setVncBusy(false);
    }

    /* ── 系统 VNC：探测/打开/停止（自由切换扩展 VNC 与系统已有 VNC） ── */
    async function loadSysVnc() {
      setSysBusy(true);
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "sys-scan" }),
        });
        const d = await r.json();
        if (d.ok) setSysVnc(d.sysVnc || []); else setErr(d.error || "系统 VNC 扫描失败");
      } catch (e) { setErr(String(e && e.message || e)); }
      setSysBusy(false);
    }
    async function openSys(v) {
      setSysBusy(true);
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "sys-open", port: v.port, label: v.kind + v.display }),
        });
        const d = await r.json();
        if (d.ok) {
          buildVncUrl(d.inst.id).then((u) => window.open(u, "_blank")).catch(() => setErr("会话建立失败"));
        } else setErr(d.error || "打开失败");
      } catch (e) { setErr(String(e && e.message || e)); }
      setSysBusy(false);
    }
    // RDP 条目：noVNC 不能直连 RDP（协议不同），复制连接地址给 RDP 客户端用
    function openRdp(v) {
      const host = location.hostname || "127.0.0.1";
      const addr = host + ":" + v.port;
      copyText(addr);
      setErr("RDP 连接地址已复制：" + addr + "（用 Windows 远程桌面 / Remmina / FreeRDP 等 RDP 客户端连接）");
    }
    async function stopSys(v) {
      if (!window.confirm("确定停止系统 VNC 进程（" + (v.cmd || v.kind) + "）？该操作只发停止信号，权限不足会失败。")) return;
      setSysBusy(true);
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "sys-stop", pid: v.pid }),
        });
        const d = await r.json();
        if (d.ok) { loadSysVnc(); } else setErr(d.error || "停止失败");
      } catch (e) { setErr(String(e && e.message || e)); }
      setSysBusy(false);
    }

    const [headlessBusy, setHeadlessBusy] = useState(false);
    async function headlessAction(action) {
      setHeadlessBusy(true);
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/headless"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        await refresh();
      } catch (e) { setErr(String(e && e.message || e)); }
      setHeadlessBusy(false);
    }

    async function saveDispCfg() {
      setBusy(true);
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/display-config"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: dispMode === "fixed" ? "fixed" : "auto", num: dispMode === "fixed" ? Number(dispNum) : undefined }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        setData((prev) => ({ ...prev, displayConfig: d.config }));
        await refresh(); // 重新解析 DISPLAY（配置变更后下次启动生效）
      } catch (e) { setErr(String(e && e.message || e)); }
      setBusy(false);
    }

    async function loadPreview() {
      try {
        const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/resolve"), { cache: "no-store" });
        setPreview(await r.json());
      } catch (e) { setPreview({ error: String(e && e.message || e) }); }
    }

    if (!open) return null;

    const d = data || {};
    const mode = d.mode;
    const desktop = d.desktop || {};
    const headless = d.headless || {};
    const vnc = d.vnc || {};
    const install = d.install || {};
    const feats = d.features || {};
    const modeLabel = (d.modes || []).find((m) => m.id === mode);
    const vncUrlStr = vncUrl || (vnc.webUrl || ""); // 默认实例会话 URL（无凭据）；兜底本机 loopback
    const vncInsts = vnc.instances || [];

    return h("div", { onClick: () => setPanelOpen(false), style: { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" } },
      h("div", { onClick: (e) => e.stopPropagation(), style: { width: 780, maxWidth: "calc(100vw - 16px)", height: "min(720px, 86vh)", background: C.panel, border: "1px solid " + C.border, borderRadius: 12, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden", fontSize: 13, color: C.text } },
        /* ── 窗口标题栏：标题 + 模式徽章 + 关闭 ── */
        h("div", { key: "header", style: { display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderBottom: "1px solid " + C.border, flexShrink: 0 } },
          h("span", { key: "title", style: { fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 } }, Ic(15, ICONS.monitor), t("uiEnv.title")),
          modeLabel ? h("span", { key: "mode", style: chip("#a5b4fc", "rgba(99,102,241,0.16)") }, "当前：" + modeLabel.label) : null,
          h("span", { key: "info", style: { marginLeft: "auto", fontSize: 10.5, color: C.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "作用于新启动的 MCP / 应用"),
          err ? h("span", { key: "err", style: { color: C.bad, fontSize: 10.5 } }, String(err)) : null,
          h("button", { key: "close",
            onClick: () => setPanelOpen(false),
            title: t("uiEnv.close"),
            style: { background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4, fontSize: 14, lineHeight: 1, flexShrink: 0 },
          }, Ic(12, ICONS.x)),
        ),
        /* ── 内容区（可滚动） ── */
        h("div", { key: "body", style: { flex: 1, overflowY: "auto", padding: "14px 18px 20px" } },

      /* ── 模式区 ── */
      h("div", { style: card({ marginBottom: 12 }) },
        h("div", { style: secTitle() },
          h("span", { style: accentBar("#818cf8") }), "显示模式",
          d.envOverrides?.UI_ENV_MODE ? h("span", { style: chip(C.warn) }, "env 覆盖：UI_ENV_MODE=" + d.envOverrides.UI_ENV_MODE) : null),
        h("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 7 } },
          (d.modes || []).map((m) => {
            const active = mode === m.id;
            return h("button", {
              key: m.id, onClick: () => setMode(m.id), disabled: busy, title: m.desc,
              style: {
                display: "flex", alignItems: "flex-start", gap: 8, textAlign: "left",
                padding: "8px 10px", borderRadius: 9, cursor: "pointer", flex: 1, minWidth: 0,
                background: active ? "rgba(99,102,241,0.14)" : C.panel2,
                border: active ? "1px solid #818cf8" : "1px solid " + C.border,
                transition: "all .12s",
              },
            },
              h("span", {
                style: {
                  width: 13, height: 13, borderRadius: 7, marginTop: 1, flexShrink: 0,
                  border: "2px solid " + (active ? "#818cf8" : C.dim),
                  background: active ? "#818cf8" : "transparent",
                  display: "inline-block",
                },
              }),
              h("span", { style: { minWidth: 0 } },
                h("span", { style: { fontSize: 12, fontWeight: 600, color: active ? "#c7d2fe" : C.text, display: "block" } }, m.label),
                h("span", { style: { fontSize: 10.5, color: C.dim, lineHeight: 1.45, display: "block", marginTop: 2 } }, m.desc)),
            );
          })),
        d.target ? h("div", { style: { marginTop: 10, fontSize: 11, color: C.dim, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
          h("span", { style: dot(C.accent) }),
          "当前裁决：", h("b", { style: { color: "#a5b4fc", fontWeight: 600 } }, d.target.rationale),
          d.target.warnings?.length ? h("span", { style: { color: C.warn } }, Ic(11, ICONS.alert), " ", d.target.warnings.slice(0, 2).join("；")) : null) : null,
      ),

      /* ── DISPLAY 号配置（默认 auto 随机；可指定固定数字） ── */
      h("div", { style: card({ marginBottom: 12 }) },
        h("div", { style: secTitle() },
          h("span", { style: accentBar("var(--warn, #f59e0b)") }), "DISPLAY 号配置",
          d.randomDisplayFeature === false ? h("span", { style: chip(C.dim) }, "feature 关：不随机") : null,
          d.envOverrides?.UI_ENV_DISPLAY_NUM ? h("span", { style: chip(C.warn) }, "env 覆盖：UI_ENV_DISPLAY_NUM=" + d.envOverrides.UI_ENV_DISPLAY_NUM) : null),
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
          h("button", { onClick: () => setDispMode("auto"), disabled: busy, style: { ...btn({}), ...(dispMode === "auto" ? { color: "#a5b4fc", borderColor: "rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" } : {}) } }, "auto · 随机空闲"),
          h("button", { onClick: () => setDispMode("fixed"), disabled: busy, style: { ...btn({}), ...(dispMode === "fixed" ? { color: "#a5b4fc", borderColor: "rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" } : {}) } }, "指定数字"),
          dispMode === "fixed" ? h("input", {
            type: "number", min: 1, max: 65535, value: dispNum, placeholder: "如 99",
            onChange: (e) => setDispNum(e.target.value),
            style: { width: 70, padding: "3px 7px", borderRadius: 7, fontSize: 11, background: C.panel2, border: "1px solid " + C.border, color: C.text },
          }) : null,
          h("button", { onClick: saveDispCfg, disabled: busy, style: { ...btn({ color: "#a5b4fc", borderColor: "rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" }), cursor: busy ? "wait" : "pointer" } }, busy ? "保存中…" : "保存")),
        h("div", { style: { fontSize: 10, color: C.dim, marginTop: 6, lineHeight: 1.5 } },
          "当前 DISPLAY：" + (d.headless?.display || "—") + " · 默认 auto：启动时自动选空闲号（随机 90–189），避免固定 :99 被其他 X 服务占用" +
          (d.randomDisplayFeature === false ? "；feature 关时不随机，用固定号" : "")),
      ),

      /* ── 环境卡 ×2 ── */
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10, marginBottom: 12 } },
        envCard([Ic(13, ICONS.monitor), " ", "真实桌面"], desktop, desktop.available, [
          ["DISPLAY", desktop.display],
          ["类型", desktop.kind === "wayland" ? "Wayland" : "X11"],
          ["Xauthority", desktop.xauthority || "—"],
          ["分辨率", fmtRes(desktop.resolution)],
          ["WM", desktop.wm || "—"],
          ["AT-SPI", desktop.atspi ? "在跑" : "无"],
        ]),
        envCard([Ic(13, ICONS.cloud), " ", "无头虚拟屏 " + (headless.display || ":99")], headless, headless.available, [
          ["DISPLAY", headless.display],
          ["Xauthority", headless.xauthority || "—"],
          ["AT-SPI 总线", headless.dbusBus || "—"],
          ["openbox", headless.wm ? "在跑" : "无"],
          ["分辨率", fmtRes(headless.resolution)],
          ["VNC TCP", headless.vnc?.tcp ? `:${headless.vnc.tcpPort}` : "未起", headless.vnc?.tcp ? C.ok : C.warn],
          ["VNC web", headless.vnc?.web ? `:${headless.vnc.webPort}` : "未起", headless.vnc?.web ? C.ok : C.warn],
        ], h("div", { key: "extra", style: { marginTop: "auto", paddingTop: 6, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" } },
          headless.available
            ? h("button", {
                key: "stop", onClick: () => { if (window.confirm("确定停止虚拟屏？将关闭 VNC 与虚拟桌面上的所有程序（仅虚拟屏，不动真实桌面）。")) headlessAction("stop"); }, disabled: headlessBusy,
                title: "停止 Xvfb+openbox+dbus+AT-SPI 及 VNC 实例（仅虚拟屏，不碰真实桌面）",
                style: { ...btn({ color: "var(--danger, #f87171)", borderColor: "color-mix(in srgb, var(--danger, #ef4444) 45%, transparent)", background: "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)" }), cursor: headlessBusy ? "wait" : "pointer" },
              }, headlessBusy ? "停止中…" : "■ 停止虚拟屏")
            : h("button", {
                key: "start", onClick: () => headlessAction("start"), disabled: headlessBusy,
                title: "拉起 Xvfb+openbox+dbus+AT-SPI（幂等，已在跑则直接返回就绪）",
                style: { ...btn({ color: "#a5b4fc", borderColor: "rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" }), cursor: headlessBusy ? "wait" : "pointer" },
              }, headlessBusy ? "启动中…" : "▶ 启动虚拟屏"),
          feats.autostart === false ? h("span", { key: "autostart-note", style: { fontSize: 10, color: C.dim } }, "autostart 关：未启动时需手动点上方按钮启动") : null),
        ),
      ),

      /* ── VNC 卡（扩展 VNC / 系统 VNC，自由切换） ── */
      h("div", { style: card({}) },
        h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" } },
          h("span", { style: accentBar("var(--ok, #22c55e)") }),
          h("span", { style: { fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.monitorPlay), "VNC-on-web"),
          h("button", { onClick: () => setVncTab("own"), style: { ...btn({}), ...(vncTab === "own" ? { color: "#a5b4fc", borderColor: "rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" } : {}) } }, "扩展 VNC"),
          h("button", { onClick: () => { setVncTab("sys"); if (!sysVnc) loadSysVnc(); }, style: { ...btn({}), ...(vncTab === "sys" ? { color: "#a5b4fc", borderColor: "rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" } : {}) } }, "系统 VNC"),
          h("span", { style: chip(vnc.tcpRunning ? C.ok : C.dim, vnc.tcpRunning ? "color-mix(in srgb, var(--ok, #22c55e) 12%, transparent)" : undefined) }, vnc.tcpRunning ? Ic(11, ICONS.check) : Ic(11, ICONS.x), " RFB"),
          h("span", { style: chip(vnc.webRunning ? C.ok : C.dim, vnc.webRunning ? "color-mix(in srgb, var(--ok, #22c55e) 12%, transparent)" : undefined) }, vnc.webRunning ? Ic(11, ICONS.check) : Ic(11, ICONS.x), " Web"),
          vncTab === "sys" ? h("span", { style: { marginLeft: "auto", display: "flex", gap: 6 } },
            h("button", { style: btn({}), onClick: loadSysVnc, disabled: sysBusy }, "刷新")) :
            h("span", { style: { marginLeft: "auto", display: "flex", gap: 6 } },
              h("button", { style: btn({}), onClick: () => vncAction("start"), disabled: vncBusy }, vncBusy ? "启动中…" : "▶ 启动/新实例"),
              h("button", { style: btn({}), onClick: () => vncAction("stop"), disabled: vncBusy }, "■ 停默认")),
        ),

        /* ── 系统 VNC 视图：系统已有 VNC server（真实桌面/自起 vncserver），临时 bridge 转发查看 ── */
        vncTab === "sys" ? [
          sysVnc === null ? h("div", { style: { fontSize: 11, color: C.dim, padding: "6px 0" } }, "扫描系统 VNC 中…") :
          sysVnc.length === 0 ? h("div", { style: { fontSize: 11, color: C.dim, padding: "6px 0" } }, "未发现系统 VNC server（本扩展自启的已排除）。点「刷新」重扫。") :
            sysVnc.map((v) => h("div", { key: v.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid " + C.border, flexWrap: "wrap" } },
              h("span", { style: { fontSize: 11, fontWeight: 600, fontFamily: C.mono, color: v.protocol === "rdp" ? "var(--warn, #f59e0b)" : C.text } }, v.kind),
              v.display ? h("span", { style: chip(C.muted) }, v.display) : null,
              h("span", { style: chip(v.port ? (v.listening ? C.ok : C.warn) : C.dim, v.port ? "color-mix(in srgb, var(--ok, #22c55e) 10%, transparent)" : undefined) }, v.listening ? "port " + v.port : "port " + v.port + "·未监听"),
              v.pid ? h("span", { style: { fontSize: 10, color: C.dim } }, "pid " + v.pid + (v.stoppable ? "" : "（非本用户，不可停）")) : null,
              h("span", { style: { marginLeft: "auto", display: "flex", gap: 5 } },
                v.protocol === "rdp"
                  ? h("button", { style: btn({}), onClick: () => openRdp(v), disabled: sysBusy || !v.listening, title: "复制 RDP 连接地址（需 RDP 客户端连接）" }, v.listening ? "复制地址" : "不可连")
                  : h("button", { style: btn({}), onClick: () => openSys(v), disabled: sysBusy || !v.listening, title: v.listening ? "" : "端口无监听（-loop 等待中/未运行），无法连接" }, v.listening ? "打开" : "不可连"),
                v.stoppable && v.pid ? h("button", { style: { ...btn({}), color: C.bad }, onClick: () => stopSys(v), disabled: sysBusy }, "停止") : null)),
            ),
          h("div", { style: { marginTop: 8, fontSize: 10.5, color: C.dim, lineHeight: 1.6 } },
          "系统 VNC = 机器上已有的 VNC server（如真实桌面 :0 的 x11vnc、vncserver 起的虚拟桌面），本扩展起临时 bridge 转发，noVNC 直接连。",
          "系统 RDP = xrdp / gnome-remote-desktop 等监听 3389 的 RDP 服务——noVNC 不能直连 RDP（协议不同），「复制地址」后用 RDP 客户端（Windows 远程桌面 / Remmina / FreeRDP）连接。",
          "有密码的会在 noVNC/RDP 客户端里提示输入；「停止」仅对本用户启动的进程生效（root/gdm 的无权限会自动失败）。",
          "「打开」产生的临时实例也出现在扩展 VNC 列表（id 以 sys- 开头），可在那边停止。")
        ] : [
        /* ── 扩展 VNC 视图：多实例列表 ── */
        vncInsts.length === 0 ? h("div", { style: { fontSize: 11, color: C.dim, padding: "6px 0" } }, "无实例（点 ▶ 启动创建；端口每次随机分配，避免与桌面/其他服务冲突）") :
          vncInsts.map((inst) => h("div", { key: inst.id, style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid " + C.border, flexWrap: "wrap" } },
            h("span", { style: { fontSize: 11, fontWeight: 600, color: inst.id === "default" ? "#a5b4fc" : C.text, fontFamily: C.mono } }, inst.id === "default" ? "default" : inst.id),
            inst.sys ? h("span", { style: chip(C.warn) }, "系统:" + inst.sys.port) : h("span", { style: chip(C.muted) }, ":" + inst.displayNum),
            h("span", { style: chip(inst.tcp ? C.ok : C.dim, inst.tcp ? "color-mix(in srgb, var(--ok, #22c55e) 10%, transparent)" : undefined) }, "RFB :" + inst.rfbPort),
            h("span", { style: chip(inst.web ? C.ok : C.dim, inst.web ? "color-mix(in srgb, var(--ok, #22c55e) 10%, transparent)" : undefined) }, "Web :" + inst.webPort),
            h("span", { style: { marginLeft: "auto", display: "flex", gap: 5 } },
              h("button", { style: btn({}), onClick: () => { buildVncUrl(inst.id).then((u) => window.open(u, "_blank")).catch(() => setErr("会话建立失败")); } }, "打开"),
              h("button", { style: btn({}), onClick: () => { buildVncUrl(inst.id).then((u) => copyText(u)).catch(() => setErr("会话建立失败")); } }, "复制"),
              inst.id !== "default" ? h("button", { style: btn({}), onClick: () => vncAction("stop", inst.id), disabled: vncBusy }, "停止") : null)),
          ),
        h("div", { style: { marginTop: 8, fontSize: 10.5, color: C.dim, lineHeight: 1.6 } },
          "多实例：每次「▶ 启动」新实例随机分配 RFB/Web 端口（避免与桌面 gdm 或其他服务冲突），URL 走 /vnc/ws/<实例id> 路由。",
          "URL 零凭据——会话走 HttpOnly cookie（30 分钟，从本面板打开即自动建立），复制到别处无 cookie 打不开（防泄露）",
          " · noVNC 目录：" + (vnc.noVncDir || "未找到（跑 setup-linux.sh 下载）"))]
      ),

      /* ── 环境预览 ── */
      h("div", { style: card({}) },
        h("div", { style: { display: "flex", alignItems: "center", gap: 7 } },
          h("span", { style: accentBar(C.warn) }),
          h("span", { style: { fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.flask), "环境裁决预览"),
          h("button", { style: { ...btn({}), marginLeft: "auto" }, onClick: loadPreview }, "运行 resolve")),
        preview ? (preview.ok || preview.error === undefined ? h("div", { style: { marginTop: 9 } },
          h("div", { style: { fontSize: 11, color: C.dim, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
            h("span", { style: dot(C.accent) }),
            "target: ", h("b", { style: { color: "#a5b4fc" } }, preview.target),
            "· " + preview.rationale,
            preview.warnings?.length ? h("span", { style: { color: C.warn } }, Ic(11, ICONS.alert), " ", preview.warnings.join("；")) : null),
          h("pre", {
            style: {
              fontSize: 10.5, fontFamily: C.mono, background: C.panel2, padding: "9px 11px",
              borderRadius: 7, overflow: "auto", maxHeight: 170, marginTop: 7, lineHeight: 1.55, color: C.muted,
            },
          }, (preview.exportLines || []).join("\n") || "（无输出）"),
        ) : h("div", { style: { marginTop: 9, fontSize: 11, color: C.bad } }, "error: " + (preview.error || "resolve 失败") + (preview.hint ? " · " + preview.hint : ""))) : null,
      ),

      /* ── 安装状态 ── */
      h("div", { style: card({ marginBottom: 0 }) },
        h("div", { style: { display: "flex", alignItems: "center", gap: 7, marginBottom: 9 } },
          h("span", { style: accentBar(C.muted) }),
          h("span", { style: { fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.wrench), "组件安装状态"),
          h("span", { style: { marginLeft: "auto", fontSize: 10.5, color: C.dim } }, "OS: " + (install.os || "?")),
        ),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 } },
          Object.entries(install.tools || {}).map(([k, v]) =>
            h("span", { key: k, style: chip(v ? C.ok : C.bad, v ? "color-mix(in srgb, var(--ok, #22c55e) 10%, transparent)" : "color-mix(in srgb, var(--danger, #ef4444) 10%, transparent)") }, v ? Ic(11, ICONS.check) : Ic(11, ICONS.x), k))),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 } },
          Object.entries(install.units || {}).map(([k, v]) =>
            h("span", {
              key: k, style: chip(
                v === "active" ? C.ok : (v === "missing" ? C.dim : C.bad),
                v === "active" ? "color-mix(in srgb, var(--ok, #22c55e) 10%, transparent)" : undefined,
              ),
            }, k + ": " + v))),
        h("div", { style: { fontSize: 10, color: C.dim, lineHeight: 1.6, marginTop: 6 } },
          "安装：scripts/linux/setup-linux.sh（apt + justget 兜底）· 服务化：install-service.sh · Windows：setup-windows.ps1"),
        /* ── 依赖自检 + 自动安装（多 OS） ── */
        deps ? h("div", { key: "deps", style: { borderTop: "1px solid " + C.border, marginTop: 9, paddingTop: 8 } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 } },
            h("span", { style: dot(deps.allInstalled ? C.ok : C.warn) }),
            h("span", { style: { fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 } }, Ic(11, ICONS.check), "依赖自检"),
            h("button", { style: { ...btn({}), marginLeft: "auto" }, onClick: loadDeps, disabled: busy }, "重新自检"),
          ),
          h("div", { style: { fontSize: 10, color: C.dim, marginBottom: 6 } },
            (deps.distro || "?") + " · 包管理器 " + (deps.pkgMgr || "无") + (deps.sudo ? " · 有 sudo" : " · 无免密 sudo")),
          deps.allInstalled
            ? h("div", { style: { fontSize: 10.5, color: C.ok, marginBottom: 4 } }, "全部组件已就绪 ✓")
            : h("div", { style: { display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 } },
                ...(deps.coreMissing || []).map((i) => h("span", { key: "c-" + i.bin, style: chip(C.bad, "color-mix(in srgb, var(--danger, #ef4444) 10%, transparent)") }, Ic(10, ICONS.x), i.label, "（必需）")),
                ...(deps.uiMissing || []).map((i) => h("span", { key: "u-" + i.bin, style: chip(C.warn) }, Ic(10, ICONS.x), i.label, "（可选）"))),
          !deps.allInstalled && deps.sudo && deps.pkgMgr
            ? h("button", {
                key: "install", onClick: installDepsBtn, disabled: busy,
                style: { ...btn({ color: "#a5b4fc", borderColor: "rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" }), cursor: busy ? "wait" : "pointer" },
              }, busy ? "安装中…（可能需 1-3 分钟）" : "▶ 自动安装缺失组件")
            : null,
          (deps.manualHints || []).length ? h("div", { key: "hints", style: { fontSize: 10, color: C.dim, lineHeight: 1.5, marginTop: 5 } },
            deps.manualHints.map((ht, i) => h("div", { key: i, style: { marginTop: 2 } }, "· " + ht))) : null,
        ) : null,
      ),
        ),
      ),
    );
  }

  function envCard(title, info, available, rows, extra) {
    const statusColor = available ? C.ok : C.bad;
    return h("div", { style: { ...card({ marginBottom: 0 }), display: "flex", flexDirection: "column" } },
      h("div", { key: "title-row", style: { display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }, title: info.error || "" },
        h("span", { key: "dot", style: dot(statusColor) }),
        h("span", { key: "label", style: { fontSize: 12, fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, title),
        h("span", { key: "status", style: { ...chip(statusColor, undefined), marginLeft: "auto" } }, available ? "可用" : "不可用")),
      info.error ? h("div", { key: "err", style: { fontSize: 10, color: C.warn, marginBottom: 5, lineHeight: 1.5 } }, Ic(11, ICONS.alert), " ", info.error) : null,
      rows.map(([k, v, vColor]) => h("div", { key: k, style: rowStyle },
        h("span", { style: { fontSize: 10.5, color: C.dim, flexShrink: 0, width: 74, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, k),
        h("span", { style: { fontSize: 11, color: vColor || C.text, wordBreak: "break-all", lineHeight: 1.4 } }, String(v ?? "—")))),
      extra ? h("div", { key: "extra", style: { marginTop: "auto", paddingTop: 6 } }, extra) : null,
    );
  }

  /* ── toolbar 按钮：系统标准（AppShell topbarRowBtnStyle：flex 居中 + fixed 36×36（=系统 TOP_BAR_ICON_BUTTON_SIZE） + hover 变色） ── */
  function ToolbarButton() {
    const open = usePanelOpen();
    return h("button", {
      title: t("uiEnv.title"),
      onClick: () => setPanelOpen(!open),
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
      // lucide monitor：显示环境——与系统内建线条图标同风格
      h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("rect", { key: "r1", width: 20, height: 14, x: 2, y: 3, rx: 2 }),
        h("line", { key: "l1", x1: 8, y1: 21, x2: 16, y2: 21 }),
        h("line", { key: "l2", x1: 12, y1: 17, x2: 12, y2: 21 })));
  }

  ctx.registerItems("dialogs", [{ id: "ui-env-dialog", render: Dialog }]);
  ctx.registerItems("toolbar", [{ id: "ui-env-toolbar", render: ToolbarButton, meta: { label: "显示环境" } }]);
}