/**
 * aiti-append-system · client（手写 h() 版，免构建链）
 *
 * register(ctx) 装配：
 *   - pages slot 常驻面板（meta.open 供 extman 直接打开）
 *   - toolbar 📝 按钮（声明式 feature 门控：behavior.showToolbar，默认关——宿主统一过滤显隐）
 *
 * 面板走 data-ext-float 契约（aiti-float 自动接管拖拽/缩放/持久化 + 小屏全屏；未装时自身 style 居中兜底）。
 * 样式自持（aas- 前缀 + var(--x, 兜底)），ensureStyles 幂等注入。
 */

// ---------- 模块级 ctx（register 时设置） ----------
let ctx = null;
const h = (...a) => ctx.h(...a);
const useState = (v) => ctx.useState(v);
const useEffect = (fn, deps) => ctx.useEffect(fn, deps);
const useCallback = (fn, deps) => ctx.useCallback(fn, deps);

const api = (p, init) => fetch(ctx.apiUrl("/api/extensions/aiti-append-system" + p), { cache: "no-store", ...init });
const Fragment = (typeof Symbol !== "undefined" && Symbol.for) ? Symbol.for("react.fragment") : 0xacb;
const jsonInit = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------- dock v3（P3 批）：显隐收口 aiti-float 展示状态机（手写 h() 免构建，内联薄桥） ----------
const AAS_KEY = "aiti-append-system:panel";
let aasLocalOpen = false; // 未装 aiti-float 的本地降级开关
function aasFloat() {
  const a = (typeof window !== "undefined") && window.__piweFloat;
  return a && typeof a.present === "function" ? a : null;
}
function aasPresented() {
  const a = aasFloat();
  return a ? (a.presented(AAS_KEY) || "closed") : (aasLocalOpen ? "floating" : "closed");
}
function aasSetOpen(v) {
  const a = aasFloat();
  if (a) { a.present(AAS_KEY, v ? "open" : "close"); return; }
  aasLocalOpen = v;
}
// 播种默认落位：用户无偏好时 open 直达右栏 tab
try { const pk = "pi-web:ext-float:dockpref:v1:" + AAS_KEY; if (!localStorage.getItem(pk)) localStorage.setItem(pk, "right-panel"); } catch (e) {}
// 草稿模块级自管（切面 remount 不丢未保存内容）
const aasDraftStore = { global: "", project: "", inited: false };

// ---------- 自持样式层（幂等注入；模块级 guard 防 reload 后叠加） ----------
const STYLE_ID = "aiti-append-system-styles";
const STYLES = `
.aas-mask { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.32); display: flex; align-items: center; justify-content: center; }
.aas-panel { width: 660px; max-width: calc(100vw - 16px); height: min(600px, 88vh); display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg,#fff); color: var(--text,#1a1a1a); border: 1px solid var(--border,#e0e0e0); border-radius: 12px;
  box-shadow: 0 16px 64px rgba(0,0,0,.25); font-size: 13px; line-height: 1.5; }
.aas-head { display: flex; align-items: center; gap: 10px; padding: 11px 16px; border-bottom: 1px solid var(--border,#e0e0e0); flex-shrink: 0; background: var(--bg-subtle,#f7f7f7); }
.aas-title { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
.aas-sub { color: var(--text-muted,#888); font-size: 11.5px; }
.aas-x { margin-left: auto; border: none; background: none; cursor: pointer; color: var(--text-muted,#888); font-size: 16px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
.aas-x:hover { background: var(--bg-hover,#eee); color: var(--text,#1a1a1a); }
.aas-tabs { display: flex; gap: 6px; padding: 10px 14px 0; flex-shrink: 0; }
.aas-tab { padding: 5px 14px; border: 1px solid var(--border,#e0e0e0); border-bottom: none; border-radius: 8px 8px 0 0; cursor: pointer;
  background: var(--bg-subtle,#f5f5f5); color: var(--text-muted,#777); font-size: 12.5px; font-weight: 500; }
.aas-tab.on { background: var(--bg,#fff); color: var(--text,#1a1a1a); border-color: var(--border,#d8d8d8); }
.aas-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 14px 12px; }
.aas-pathrow { display: flex; align-items: center; gap: 8px; padding: 8px 2px; flex-wrap: wrap; }
.aas-path { font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-muted,#777); word-break: break-all; }
.aas-badge { padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
.aas-badge.on { background: rgba(34,197,94,.15); color: #16a34a; }
.aas-badge.off { background: rgba(148,163,184,.18); color: #64748b; }
.aas-ta { flex: 1; min-height: 0; width: 100%; box-sizing: border-box; resize: none; padding: 10px 12px; border: 1px solid var(--border,#d8d8d8); border-radius: 8px;
  background: var(--bg,#fff); color: var(--text,#1a1a1a); font: 12.5px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; outline: none; }
.aas-ta:focus { border-color: var(--accent,#2563eb); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent,#2563eb) 18%, transparent); }
.aas-ta:disabled { background: var(--bg-subtle,#f5f5f5); color: var(--text-dim,#aaa); cursor: not-allowed; }
.aas-foot { display: flex; align-items: center; gap: 8px; padding-top: 10px; flex-shrink: 0; flex-wrap: wrap; }
.aas-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 14px; border: 1px solid var(--border,#d8d8d8); border-radius: 7px;
  cursor: pointer; background: var(--bg,#fff); color: var(--text,#1a1a1a); font-size: 12.5px; font-weight: 500; white-space: nowrap; }
.aas-btn:hover { background: var(--bg-hover,#f0f0f0); }
.aas-btn:disabled { opacity: .5; cursor: not-allowed; }
.aas-btn.primary { background: var(--accent,#2563eb); border-color: var(--accent,#2563eb); color: #fff; }
.aas-btn.primary:hover { background: var(--accent-hover,#1d4ed8); }
.aas-btn.danger { color: #dc2626; }
.aas-btn.danger:hover { background: rgba(239,68,68,.1); }
.aas-count { margin-left: auto; color: var(--text-dim,#999); font-size: 11.5px; }
.aas-msg { width: 100%; padding: 6px 10px; border-radius: 8px; font-size: 12px; }
.aas-msg.ok { background: rgba(34,197,94,.12); color: #16a34a; }
.aas-msg.err { background: rgba(239,68,68,.1); color: #dc2626; }
.aas-hint { padding: 8px 2px; color: var(--text-muted,#888); font-size: 12px; }
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

// ---------- 动作文案 ----------
const ACTION_TEXT = { written: "已保存", appended: "已追加", deleted: "已删除（回到未设置）", absent: "本就未设置" };

// ---------- 工具条按钮（feature 门控由宿主过滤，此处只管渲染） ----------
function ToolbarButton() {
  return h("button", {
    className: "aas-toolbar-btn",
    title: "追加系统提示词（全局 / 项目）",
    onClick: () => { try { window.__aitiAppendSystemOpen && window.__aitiAppendSystemOpen(); } catch (e) {} },
  }, "📝 提示词");
}

// ---------- 主面板（dock v3：双面 face 参数化——pages=float 浮窗 / rightFileDock=右栏 tab） ----------
function PanelDialog(props) { return renderAAS(props, "float"); }
function AASDockFace(props) { return renderAAS(props, "dock"); }
function renderAAS(props, face) {
  // 页面当前项目 cwd：宿主 pages 插槽 extra.activeCwd（新建会话页也有值）优先；
  // currentSession.cwd 只是选中会话的 cwd（未选会话时为 null，不能作为「有无项目」的判据）。
  const cwd = ((props && (props.activeCwd || (props.currentSession && props.currentSession.cwd))) || "") + "";
  const st0 = aasPresented();
  const [st, setSt] = useState(st0);
  useEffect(() => {
    const sync = () => setSt(aasPresented());
    window.addEventListener("piwe-float-present-change", sync);
    const iv = sync;
    window.addEventListener("piwe-float-present-command", iv);
    return () => { window.removeEventListener("piwe-float-present-change", sync); window.removeEventListener("piwe-float-present-command", iv); };
  }, []);
  const open = face === "float" ? st === "floating" : st === "docked:right-panel";
  const floating = face === "float";
  const setOpen = (v) => aasSetOpen(v);
  const [tab, setTab] = useState("global");                 // "global" | "project"
  const [info, setInfo] = useState(null);                   // { global, project, cwd? }
  const [drafts, setDraftsState] = useState(() => {
    if (!aasDraftStore.inited) { aasDraftStore.inited = true; }
    return { global: aasDraftStore.global, project: aasDraftStore.project };
  });
  const setDrafts = (fn) => setDraftsState((d) => {
    const next = typeof fn === "function" ? fn(d) : fn;
    aasDraftStore.global = next.global || ""; aasDraftStore.project = next.project || "";
    return next;
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);                     // { kind: "ok"|"err", text }
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    window.__aitiAppendSystemOpen = () => setOpen(true);
    return () => { delete window.__aitiAppendSystemOpen; };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api("/files?cwd=" + encodeURIComponent(cwd));
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "读取失败");
      setInfo(d);
      setDrafts({ global: d.global.content || "", project: d.project && d.project.content ? d.project.content : "" });
    } catch (e) { setMsg({ kind: "err", text: "读取失败：" + (e.message || e) }); }
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    setMsg(null); setConfirmClear(false);
    load();
  }, [open, load]);

  if (!open) return null;

  const cur = info ? info[tab] : null;
  const projectOk = !!(info && info.project && !info.project.error);
  const tabDisabled = tab === "project" && (!cwd || !projectOk);
  const curDraft = drafts[tab] || "";
  const dirty = !!(cur && !cur.error && curDraft !== cur.content);
  const hasContent = !!(cur && cur.exists);

  const setDraft = (v) => { setDrafts((d) => ({ ...d, [tab]: v })); setConfirmClear(false); };

  async function save(mode) {
    setBusy(true); setMsg(null);
    try {
      const body = { scope: tab, content: curDraft, mode: mode || "write" };
      if (tab === "project") body.cwd = cwd;
      const r = await api("/save", jsonInit(body));
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "保存失败");
      setMsg({ kind: "ok", text: (ACTION_TEXT[d.action] || "已保存") + " · 对新会话生效（当前会话不受影响）" });
      await load();
    } catch (e) { setMsg({ kind: "err", text: e.message || String(e) }); }
    setBusy(false);
  }

  function switchTab(t) {
    if (dirty) setMsg({ kind: "err", text: "有未保存的修改——先保存或放弃（切走即弃）再切换" });
    setTab(t); setConfirmClear(false);
    if (!dirty) setMsg(null);
  }

  const projErr = tab === "project" && info && info.project && info.project.error ? info.project.error : null;

  const aasContent = h(Fragment, null,
      // ── 标题栏（首个子元素 = float 拖拽把手；仅浮窗态——停靠 chrome 已带标题/✕）──
      floating ? h("div", { className: "aas-head" },
        h("span", { className: "aas-title" }, "📝 追加系统提示词"),
        h("span", { className: "aas-sub" }, "pi 会话启动时追加进 system prompt · 保存后新会话生效"),
        h("button", { className: "aas-x", title: "关闭", onClick: () => setOpen(false) }, "✕"),
      ) : null,
      // ── tabs ──
      h("div", { className: "aas-tabs" },
        h("div", { className: "aas-tab" + (tab === "global" ? " on" : ""), onClick: () => switchTab("global") }, "🌐 全局"),
        h("div", { className: "aas-tab" + (tab === "project" ? " on" : ""), onClick: () => switchTab("project") }, "📁 项目" + (cwd ? "" : "（无项目）")),
      ),
      // ── 编辑区 ──
      h("div", { className: "aas-body" },
        cur && !cur.error
          ? h("div", { className: "aas-pathrow" },
              h("span", { className: "aas-path" }, cur.path),
              h("span", { className: "aas-badge " + (hasContent ? "on" : "off") }, hasContent ? "已设置" : "未设置"),
              hasContent ? h("span", { className: "aas-path" }, new Date(cur.mtime).toLocaleString("zh-CN", { hour12: false })) : null,
            )
          : h("div", { className: "aas-hint" }, projErr || "读取中…"),
        h("textarea", {
          className: "aas-ta", spellCheck: false,
          disabled: tabDisabled || !cur || !!cur.error,
          placeholder: "每行一条规则，如：请用中文进行交流和回复。\n\n写入空内容并保存 = 删除该文件（回到未设置）。",
          value: curDraft,
          onChange: (e) => setDraft(e.target.value),
        }),
        // ── 底部操作 ──
        h("div", { className: "aas-foot" },
          h("button", {
            className: "aas-btn primary", disabled: busy || tabDisabled || !dirty,
            onClick: () => save("write"), title: "覆盖写入该文件",
          }, busy ? "…" : "💾 保存"),
          h("button", {
            className: "aas-btn", disabled: busy || tabDisabled || !curDraft.trim(),
            onClick: () => save("append"), title: "把当前文本追加到现有内容末尾（不覆盖）",
          }, "➕ 追加保存"),
          h("button", {
            className: "aas-btn danger", disabled: busy || tabDisabled || !hasContent,
            onClick: () => { if (confirmClear) { setDraft(""); save("write"); } else setConfirmClear(true); },
            title: "清空内容并删除文件（回到未设置）",
          }, confirmClear ? "确认删除？" : "🗑 清空"),
          h("span", { className: "aas-count" }, curDraft.length + " 字符" + (dirty ? " · 未保存" : "")),
        ),
        msg ? h("div", { className: "aas-msg " + msg.kind, style: { marginTop: 8 } }, msg.text) : null,
      ),
  );
  // dock v3 分面：float = 遮罩+浮窗壳；dock = 右栏 tab（嵌入形态铺满 DockBody，TabBar ✕ 关闭）
  if (floating) {
    return h("div", { className: "aas-mask", onClick: () => setOpen(false) },
      h("div", {
        className: "aas-panel",
        "data-ext-float": "1", "data-ext-float-key": AAS_KEY, "data-ext-float-dock": "right-panel",
        "data-ext-float-dock-default": "right-panel",
        "data-ext-float-w": 660, "data-ext-float-h": 600, "data-ext-float-full": "1",
        onClick: (e) => e.stopPropagation(),
      }, aasContent),
    );
  }
  return h(Fragment, null,
    h("div", { className: "aas-dockwrap", style: { width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", overflow: "hidden" } }, aasContent),
  );
}

// ---------- register 入口 ----------
export default function register(c) {
  ctx = c;
  ensureStyles();
  // toolbar 按钮：声明式 feature 门控（item.feature → 宿主统一过滤显隐，extman 切换即时生效）
  ctx.registerItems("toolbar", [{
    id: "aiti-append-system-open",
    render: ToolbarButton,
    feature: "behavior.showToolbar",
    meta: { label: "追加系统提示词" },
  }]);
  // pages 面板：常驻注册（不带 feature）→ 扩展管理器随时可「打开」
  ctx.registerItems("pages", [{
    id: "aiti-append-system-panel",
    render: PanelDialog,
    meta: {
      open: () => { try { window.__aitiAppendSystemOpen && window.__aitiAppendSystemOpen(); } catch (e) {} },
    },
  }]);
  // aiti-float dock v3（P3 批）：右栏「提示词」tab（face 参数防双实例同渲；id 拼后 = AAS_KEY）
  ctx.registerItems("rightFileDock", [{ id: "panel", render: AASDockFace, meta: { title: "提示词" } }]);
  try { console.log("[aiti-append-system] client 已挂载（pages 面板 + toolbar 📝 按钮 feature 门控）"); } catch (e) {}
}
