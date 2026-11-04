/**
 * demo client — 扩展自检面板 + 各插槽的小入口。
 *
 * 面板（dialogs 插槽）实时调用 server api / middleware 并逐项显示 ✓/✗ + 延迟；
 * toolbar / sidebar / sessionTopbar / chatInputTop 都只是一键打开面板的小按钮。
 * banners 插槽默认不渲染，面板里点「测试横幅」显示 5s 后 disposeItems 自毁。
 */

// 自检面板开关（模块级，多个入口共享）。
let panelOpen = false;
const panelListeners = new Set();
function setPanelOpen(v) {
  panelOpen = v;
  for (const l of panelListeners) l();
}

// 横幅测试状态（面板触发，5s 自毁演示 disposeItems）。
let bannerVisible = false;
const bannerListeners = new Set();
function setBannerVisible(v) {
  bannerVisible = v;
  for (const l of bannerListeners) l();
}

// 会话行 🧪 demo 标记状态（内部变量名保留 starred，仅 UI 图标已换成 demo 专属 🧪）。
const starred = new Set();
const starredListeners = new Set();
function toggleStarred(key) {
  if (starred.has(key)) starred.delete(key);
  else starred.add(key);
  for (const l of starredListeners) l();
}

export default function register(ctx) {
  const { h, useState, useEffect, t, apiUrl } = ctx;

  // lucide 图标（与系统内建线条图标同风格）：demo 标记 flask-conical · 状态 check/x
  const Ic = (size, paths) => {
    const el = h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, paths.map((d, i) => h("path", { key: i, d })));
    if (el._store) el._store.validated = 1;
    return el;
  };
  const ICONS = {
    flask: ["M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2", "M8.5 2h7", "M7 16h10"],
    check: ["M20 6 9 17l-5-5"],
    x: ["M18 6 6 18", "m6 6 12 12"],
  };

  function usePanelOpen() {
    const [open, setOpen] = useState(panelOpen);
    useEffect(() => {
      const l = () => setOpen(panelOpen);
      panelListeners.add(l);
      return () => panelListeners.delete(l);
    }, []);
    return open;
  }

  function useBannerVisible() {
    const [v, setV] = useState(bannerVisible);
    useEffect(() => {
      const l = () => setV(bannerVisible);
      bannerListeners.add(l);
      return () => bannerListeners.delete(l);
    }, []);
    return v;
  }

  function useStarred(key) {
    const [is, setIs] = useState(starred.has(key));
    useEffect(() => {
      const l = () => setIs(starred.has(key));
      starredListeners.add(l);
      return () => starredListeners.delete(l);
    }, [key]);
    return is;
  }

  /* ── 自检面板（dialogs 插槽）：逐项运行检查 ── */
  function SelfCheckDialog() {
    const open = usePanelOpen();
    const [results, setResults] = useState([]); // {label, ok, ms, detail}
    const [running, setRunning] = useState(false);

    async function runChecks() {
      setRunning(true);
      const out = [];

      async function check(label, fn) {
        const start = performance.now();
        try {
          const detail = await fn();
          out.push({ label, ok: true, ms: Math.round(performance.now() - start), detail });
        } catch (e) {
          out.push({ label, ok: false, ms: Math.round(performance.now() - start), detail: String(e?.message ?? e) });
        }
      }

      await check(t("demo.check.api"), async () => {
        const r = await fetch(apiUrl("/api/extensions/demo/ping"));
        const d = await r.json();
        if (!r.ok || !d.pong) throw new Error(`HTTP ${r.status}`);
        return "pong ✓";
      });
      await check(t("demo.check.core"), async () => {
        const r = await fetch(apiUrl("/api/extensions/demo/core"));
        const d = await r.json();
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return `${d.sessionCount} sessions · ${d.runningCount} running`;
      });
      await check(t("demo.check.counter"), async () => {
        const r = await fetch(apiUrl("/api/extensions/demo/counter"));
        const d = await r.json();
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return `count = ${d.count}`;
      });
      await check(t("demo.check.middleware"), async () => {
        const r = await fetch(apiUrl("/demo-middleware"));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.text()).slice(0, 40);
      });
      // client bundle：本面板正在运行即是证明。
      out.push({ label: t("demo.check.client"), ok: true, ms: 0, detail: "running ✓" });
      // agent 工具：无法从 client 直测，提示注入状态（agentTools 注册即生效）。
      out.push({ label: t("demo.check.agent"), ok: true, ms: 0, detail: "demo_ping injected" });

      setResults(out);
      setRunning(false);
    }

    useEffect(() => {
      if (open && results.length === 0 && !running) void runChecks();
    }, [open]);

    if (!open) return null;
    const passed = results.filter((r) => r.ok).length;
    return h("div", {
      style: {
        position: "fixed", inset: 0, zIndex: 310, background: "rgba(0,0,0,0.35)",
        display: "flex", alignItems: "center", justifyContent: "center",
      },
      onClick: () => setPanelOpen(false),
    },
      h("div", {
        "data-ext-float": "1", /* aiti-float 扩展自动接管：拖拽/缩放/持久化（首个子元素=标题栏作把手） */
        style: {
          width: 400, padding: 16, borderRadius: 10,
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          color: "var(--text)", boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
        },
        onClick: (e) => e.stopPropagation(),
      },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 } },
          h("h3", { style: { margin: 0, fontSize: 14, fontWeight: 600, flex: 1, display: "flex", alignItems: "center", gap: 6 } }, Ic(15, ICONS.flask), t("demo.title")),
          results.length > 0 && h("span", {
            style: {
              fontSize: 11, padding: "1px 8px", borderRadius: 9,
              background: passed === results.length ? "rgba(16,185,129,0.14)" : "rgba(239,68,68,0.14)",
              color: passed === results.length ? "#10b981" : "#ef4444",
            },
          }, `${passed}/${results.length}`),
        ),
        h("div", { style: { display: "flex", flexDirection: "column", gap: 6, flex: 1, minHeight: 0, overflowY: "auto" } },
          results.map((r) => h("div", {
            key: r.label,
            style: {
              display: "flex", alignItems: "center", gap: 8, fontSize: 12,
              padding: "6px 8px", borderRadius: 6, background: "var(--bg)",
            },
          },
            h("span", { style: { color: r.ok ? "#10b981" : "#ef4444", flexShrink: 0, display: "flex" } }, r.ok ? Ic(13, ICONS.check) : Ic(13, ICONS.x)),
            h("span", { style: { color: "var(--text)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.label),
            r.detail && h("span", {
              title: r.detail,
              style: { color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            }, r.detail),
            r.ms > 0 && h("span", { style: { color: "var(--text-dim)", fontSize: 10 } }, t("demo.ms", { ms: r.ms })),
          )),
          (running || results.length === 0) && h("div", { style: { fontSize: 12, color: "var(--text-muted)", padding: "4px 8px" } }, "…"),
        ),
        h("div", { style: { display: "flex", gap: 8, marginTop: 12 } },
          h("button", {
            onClick: () => { setBannerVisible(true); setTimeout(() => { setBannerVisible(false); ctx.disposeItems?.("banners", ["demo-banner"]); }, 5000); },
            style: { ...btnStyle, background: "var(--bg-hover)", color: "var(--text-muted)" },
          }, t("demo.bannerTest")),
          h("button", { onClick: () => void runChecks(), disabled: running, style: { ...btnStyle, background: "var(--bg-hover)", color: "var(--text-muted)" } }, t("demo.rerun")),
          h("button", { onClick: () => setPanelOpen(false), "aria-label": t("demo.close"), title: t("demo.close"), style: btnStyle }, t("demo.close")),
        ),
      ),
    );
  }

  /* ── toolbar：🧪 小按钮（与系统内建顶栏按钮一致：fixed 36×36（=系统 TOP_BAR_ICON_BUTTON_SIZE））── */
  function ToolbarButton() {
    return h("button", {
      title: t("demo.open"),
      onClick: () => setPanelOpen(true),
      onMouseEnter: (e) => { e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { e.currentTarget.style.color = "var(--text-muted)"; },
      style: {
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      },
    },
      // lucide flask-conical：自检实验瓶——与系统内建线条图标同风格
      h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { key: "p1", d: "M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2" }),
        h("path", { key: "p2", d: "M8.5 2h7" }),
        h("path", { key: "p3", d: "M7 16h10" })));
  }

  /* ── sidebar：紧凑入口 ── */
  function SidebarEntry() {
    return h("button", {
      title: t("demo.open"),
      onClick: () => setPanelOpen(true),
      style: {
        display: "flex", alignItems: "center", gap: 5,
        height: 30, padding: "0 10px", marginRight: 6,
        background: "var(--bg-hover)", border: "1px solid var(--border)",
        borderRadius: 7, color: "var(--text-muted)", cursor: "pointer",
        fontSize: 11, flexShrink: 0,
      },
    }, h("span", { key: "icon", style: { display: "inline-flex", alignItems: "center" } }, Ic(13, ICONS.flask)), " ", t("demo.open"));
  }

  /* ── sessionTopbar：小 chip ── */
  function SessionTopbarChip() {
    return h("button", {
      title: t("demo.open"),
      onClick: () => setPanelOpen(true),
      style: {
        padding: "1px 7px", borderRadius: 9, fontSize: 10, cursor: "pointer",
        background: "rgba(139,92,246,0.16)", color: "#a78bfa", border: "none",
        whiteSpace: "nowrap",
      },
    }, Ic(11, ICONS.flask));
  }

  /* ── sessionRowActions：hover 🧪 demo 标记（非通用收藏星标） ── */
  function SessionRowStar(props) {
    const sessionId = props.session?.id ?? props.currentSession?.id ?? "";
    const is = useStarred(`row:${sessionId}`);
    return h("button", {
      title: t("demo.toggleStar"),
      onClick: () => toggleStarred(`row:${sessionId}`),
      style: {
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 32, height: 32, padding: 0,
        background: "var(--bg-hover)", border: "1px solid var(--border)",
        borderRadius: 7, cursor: "pointer", flexShrink: 0,
        color: is ? "#a78bfa" : "var(--text-muted)",
      },
    }, Ic(14, ICONS.flask));
  }

  /* ── chatInputTop：一个 🧪 小按钮（不再有长提示条） ── */
  function ChatInputTop() {
    return h("button", {
      title: t("demo.open"),
      onClick: () => setPanelOpen(true),
      style: {
        padding: "1px 7px", borderRadius: 6, fontSize: 11, cursor: "pointer",
        background: "none", border: "1px solid var(--border)",
        color: "var(--text-dim)", flexShrink: 0,
      },
    }, Ic(12, ICONS.flask));
  }

  /* ── userMessageActions：紧凑 🧪（demo 专属标记，非通用收藏图标） ── */
  function UserMsgActions(props) {
    const text = props.text ?? "";
    const key = `msg:${props.entryId ?? text.slice(0, 32)}`;
    const is = useStarred(key);
    return h("button", {
      title: t("demo.pinTitle"),
      onClick: () => toggleStarred(key),
      style: {
        padding: "1px 7px", borderRadius: 6, fontSize: 11, cursor: "pointer",
        background: is ? "rgba(167,139,250,0.16)" : "var(--bg-hover)",
        border: "1px solid var(--border)",
        color: is ? "#a78bfa" : "var(--text-muted)",
      },
    }, Ic(12, ICONS.flask));
  }

  /* ── banners：默认不渲染；面板「测试横幅」显示 5s ── */
  function TestBanner() {
    const visible = useBannerVisible();
    if (!visible) return null;
    return h("div", {
      style: {
        display: "flex", alignItems: "center", gap: 8,
        padding: "4px 14px", fontSize: 11,
        background: "rgba(139,92,246,0.12)", color: "#a78bfa",
        borderBottom: "1px solid var(--border)",
      },
    }, t("demo.bannerText"));
  }

  /* ── pages：声明占位（框架覆盖用，不渲染内容） ── */
  function Page() {
    return null;
  }

  // ── 注册全部 slot ──
  ctx.registerItems("dialogs", [{ id: "demo-selfcheck", render: SelfCheckDialog, meta: { label: "demo 自检面板" } }]);
  ctx.registerItems("toolbar", [{ id: "demo-toolbar", render: ToolbarButton, meta: { label: "demo 自检" } }]);
  ctx.registerItems("sidebar", [{ id: "demo-sidebar", render: SidebarEntry, meta: { label: "demo 自检" } }]);
  ctx.registerItems("sessionTopbar", [{ id: "demo-topbar", render: SessionTopbarChip, meta: { label: "demo 自检" } }]);
  ctx.registerItems("sessionRowActions", [{ id: "demo-star", render: SessionRowStar, meta: { label: "demo 标记" } }]);
  ctx.registerItems("banners", [{ id: "demo-banner", render: TestBanner, meta: { label: "demo 横幅测试" } }]);
  ctx.registerItems("pages", [{ id: "demo-page", render: Page, meta: { label: "demo 自检页面" } }]);
  ctx.registerItems("chatInputTop", [{ id: "demo-check", render: ChatInputTop, meta: { label: "demo 自检" } }]);
  ctx.registerItems("userMessageActions", [{ id: "demo-pin", render: UserMsgActions, meta: { label: "demo 标记" } }]);

  // ── 非 UI 扩展点 ──
  // chat hook（preSend）：/demo-send <text> → 替换为带前缀的真实内容（无可见 UI）。
  ctx.registerChatHook({
    preSend(text) {
      if (typeof text === "string" && text.startsWith("/demo-send")) {
        const rest = text.slice("/demo-send".length).trim();
        return { text: rest ? `[demo-send] ${rest}` : "[demo-send]" };
      }
      return { text };
    },
  });
}

const btnStyle = {
  padding: "6px 14px", borderRadius: 7, fontSize: 12, cursor: "pointer",
  background: "var(--accent)", color: "#fff", border: "none", fontWeight: 600,
};
