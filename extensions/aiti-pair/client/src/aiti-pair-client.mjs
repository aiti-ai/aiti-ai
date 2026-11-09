/**
 * aiti-pair client —— 设备互连面板（零构建，ctx.h hyperscript）
 *
 * 结构（照 demo-client.mjs 范式）：
 *   - toolbar 按钮（lucide message-circle 线条图标）→ 开面板
 *   - dialogs 浮窗（data-ext-float 契约：aiti-float 接管拖拽/持久化 + 小屏全屏；
 *     框架自动注入右上角 AI 按钮）内懒挂 pair widget：
 *     首开才动态加载 aiti-devtools 扩展的 pair-client.js（软依赖，缺席给引导），
 *     AitiPair.mount(host, { base: 内嵌桥 mcp 端点 })——可达域 = 本实例内嵌桥设备集合。
 *
 * 协议唯一来源：packages/aiti-devtools-core/src/pair-client.js（本文件零协议实现）。
 */
let panelOpen = false;
const listeners = new Set();
function setPanelOpen(v) {
  panelOpen = v;
  if (v) setUnread(0); // 开面板即清未读
  for (const l of listeners) l();
}

// 未读徽标 store（面板关闭时收到 pair 消息 → toolbar 按钮红点）
let unread = 0;
const unreadListeners = new Set();
function setUnread(n) {
  unread = n;
  for (const l of unreadListeners) l();
}
function bumpUnread() { setUnread(unread + 1); }

// widget 挂载去重（React 重渲染/StrictMode ref 双触发不重复 mount；AitiPair 实例模块级保活）
let mounted = null; // { el, instance }
let mountPromise = null; // 在途挂载（异步加载竞态去重：ref 回调可能并发触发多次）

export default function register(ctx) {
  const { h, useState, useEffect, apiUrl } = ctx;

  const ASSET_BASE = "/api/extensions/aiti-devtools";
  const LIB_URL = () => apiUrl(ASSET_BASE + "/pair-client.js");
  const BRIDGE_BASE = () => apiUrl(ASSET_BASE + "/mcp"); // 内嵌桥端点（bridge-client 同款）

  function loadPairLib() {
    if (globalThis.AitiPair) return Promise.resolve(globalThis.AitiPair);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LIB_URL() + "?v=" + Date.now(); // cache-bust：扩展资产更新后浏览器子资源缓存可能不失效
      s.onload = () => (globalThis.AitiPair ? resolve(globalThis.AitiPair) : reject(new Error("pair-client.js 加载后未暴露 AitiPair")));
      s.onerror = () => reject(new Error("pair-client.js 加载失败（aiti-devtools 扩展未部署？）"));
      document.head.appendChild(s);
    });
  }

  function ensureWidget(host) {
    if (mounted && mounted.el && mounted.el.isConnected) return Promise.resolve(mounted);
    if (mountPromise) return mountPromise;
    // 重开面板 = React 重建 host DOM（旧 el 已摘除）→ 先停旧实例再重挂（AitiPair 实例同 peerId 幂等，SSE 重连无感）
    if (mounted) { try { mounted.instance.stop(); } catch (e) {} mounted = null; }
    mountPromise = loadPairLib().then((AitiPair) => {
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;inset:0;display:flex;min-height:0";
      host.innerHTML = ""; // 防御：同 host 重复挂载时清旧（幂等）
      host.appendChild(el);
      const instance = AitiPair.mount(el, { base: BRIDGE_BASE() });
      instance.on('message', () => { if (!panelOpen) bumpUnread(); }); // 面板外收到消息 → 未读 +1
      mounted = { el, instance };
      mountPromise = null; // 成功即清：下次面板重开（DOM 已换）必须重新挂载，不能返回旧 promise
      return mounted;
    }).catch((e) => { mountPromise = null; throw e; }); // 失败也允许重试
    return mountPromise;
  }

  /* ── 浮窗面板（dialogs 插槽） ── */
  function PairDialog() {
    const [open, setOpen] = useState(panelOpen);
    const [err, setErr] = useState("");
    const [ready, setReady] = useState(false);
    useEffect(() => {
      const l = () => setOpen(panelOpen);
      listeners.add(l);
      return () => listeners.delete(l);
    }, []);
    useEffect(() => {
      if (!open || ready || mounted) { if (open && mounted) setReady(true); return; }
      let dead = false;
      ensureWidget(hostEl()).then(() => { if (!dead) setReady(true); }).catch((e) => { if (!dead) setErr(String((e && e.message) || e)); });
      return () => { dead = true; };
    }, [open]);

    if (!open) return null;
    return h("div", {
      style: {
        position: "fixed", inset: 0, zIndex: 310, background: "rgba(0,0,0,0.35)",
        display: "flex", alignItems: "center", justifyContent: "center",
      },
      onClick: () => setPanelOpen(false),
    },
      h("div", {
        "data-ext-float": "1",      // aiti-float 接管：拖拽/缩放/持久化/置前
        "data-ext-float-full": "1", // 小屏（≤640px）铺满视口
        "data-ext-float-w": "460",
        "data-ext-float-h": "560",
        style: {
          width: "min(460px, 94vw)", height: "min(560px, 86vh)", padding: 0, overflow: "hidden",
          borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)",
          color: "var(--text)", boxShadow: "0 10px 40px rgba(0,0,0,0.35)", position: "relative",
        },
        onClick: (e) => e.stopPropagation(),
      },
        h("div", {
          style: {
            display: "flex", alignItems: "center", gap: 8, padding: "10px 12px",
            borderBottom: "1px solid var(--border)", flexShrink: 0, cursor: "grab",
          },
        },
          h("h3", { style: { margin: 0, fontSize: 13, fontWeight: 600, flex: 1 } }, "✉ 设备互连"),
          h("span", { style: { fontSize: 10, color: "var(--text-dim)", fontWeight: 400 } }, "连同一桥即互发"),
          h("button", {
            onClick: () => setPanelOpen(false), "aria-label": "关闭",
            style: { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px" },
          }, "✕"),
        ),
        h("div", {
          ref: (el) => {
            hostRef = el;
            if (open && el && !mounted && !mountPromise) {
              ensureWidget(el).then(() => setReady(true)).catch((e) => setErr(String((e && e.message) || e)));
            } else if (open && mounted) setReady(true);
          },
          style: { position: "absolute", top: 41, bottom: 0, left: 0, right: 0, display: ready ? "block" : "none" },
        }),
        !ready && h("div", { style: { position: "absolute", top: 41, bottom: 0, left: 0, right: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center", fontSize: 12, color: "var(--text-muted)", whiteSpace: "pre-wrap" } },
          err || "加载 pair 组件…"),
      ),
    );
  }

  let hostRef = null;
  const hostEl = () => hostRef;

  /* ── toolbar 按钮（lucide message-circle，36×36 同系统内建） ── */
  function PairToolbarButton() {
    const [n, setN] = useState(unread);
    useEffect(() => {
      const l = () => setN(unread);
      unreadListeners.add(l);
      return () => unreadListeners.delete(l);
    }, []);
    return h("button", {
      title: "设备互连：临时聊天 / 互传文件（连同一桥的设备）",
      onClick: () => setPanelOpen(true),
      onMouseEnter: (e) => { e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { e.currentTarget.style.color = "var(--text-muted)"; },
      style: {
        display: "flex", alignItems: "center", justifyContent: "center",
        position: "relative",
        width: 36, height: 36, padding: 0,
        background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      },
    },
      h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { d: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z" })),
      n > 0 && h("span", {
        style: {
          position: "absolute", top: 6, right: 5, width: 8, height: 8, borderRadius: "50%",
          background: "#ef4444", border: "1.5px solid var(--bg-panel, #fff)", pointerEvents: "none",
        },
      }));
  }

  ctx.registerItems?.("toolbar", [{ id: "pair", render: PairToolbarButton, meta: { label: "设备互连" } }]);
  ctx.registerItems?.("dialogs", [{ id: "pair", render: PairDialog, meta: { label: "设备互连面板" } }]);
}
