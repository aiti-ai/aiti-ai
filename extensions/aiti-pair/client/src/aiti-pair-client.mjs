/**
 * aiti-pair client —— 设备互连面板（零构建，ctx.h hyperscript）
 *
 * Structure (same two-face shape as doc-center; aiti-float present state machine as the single source):
 *   - toolbar button (lucide message-circle line icon) → present("open") dialog
 *   - dialogs floating face (rendered in the floating state): data-ext-float contract + key/dock
 *     declarations; the dock entry is injected by aiti-float into the "position" menu (never
 *     hand-written); the right-panel face header ⇱ "back to float" → present("float")
 *   - rightFileDock right-panel face (rendered in the docked:right-panel state): DockBody tab
 *     contract markers (data-ext-item etc. — orchestrator dependencies) + mini header ⇱
 *     "back to float" → present("float")
 *   - both faces share one widget instance (switching face = remount; SSE reconnects on the same
 *     peerId seamlessly); in the closed state both faces collapse + the instance stops (saves
 *     SSE); the unread red dot lives in the toolbar badge.
 *   - widget = dynamically loads the aiti-devtools extension's pair-client.js (soft dependency;
 *     show onboarding guidance when absent), AitiPair.mount(host, { base: embedded bridge MCP endpoint }).
 *
 * 协议唯一来源：packages/aiti-devtools-core/src/pair-client.js（本文件零协议实现）。
 */
// aiti-float present state machine (zero-build direct API read; always "floating" = plain-dialog fallback when the float enhancement is not installed)
const PAIR_KEY = "aiti-pair:pair";
const PAIR_DOCK_ZONE = "dock:right-panel"; // present action value (→ state docked:right-panel)
function floatApi() { const api = globalThis.__piweFloat; return api && typeof api.present === "function" ? api : null; }
function presentOf() {
  const api = globalThis.__piweFloat;
  try {
    if (api && typeof api.presented === "function") return api.presented(PAIR_KEY) || "closed";
    return "unknown"; // aiti-float not ready / not installed: never guess the face (prevents the panel flashing on refresh); render by the real state once ready
  } catch (e) { return "unknown"; }
}
function presentPair(mode) {
  const api = floatApi();
  if (!api) return; // no aiti-float: always floating; state-machine calls are all no-ops
  if (mode === "open") migrateDockPref(); // a pref left over from the old left-panel dock test routes open to the removed sidebar slot → migrate to the new right-panel slot
  try { api.present(PAIR_KEY, mode); } catch (e) {}
}
// Legacy dockPref migration: sidebar:xxx (old left-panel dock) → right-panel; float / right-side slots are kept
function migrateDockPref() {
  try {
    const K = "pi-web:ext-float:dockpref:v1:" + PAIR_KEY;
    const cur = localStorage.getItem(K);
    if (cur && cur !== "float" && cur !== "right-panel") localStorage.setItem(K, "right-panel");
  } catch (e) {}
}

// Unread badge store (a pair message arriving while the panel is closed (closed state) → toolbar button red dot)
let unread = 0;
const unreadListeners = new Set();
function setUnread(n) {
  unread = n;
  for (const l of unreadListeners) l();
}
function bumpUnread() { setUnread(unread + 1); }

// C1: the closed-state unread data source = a module-level global aiti-pair-msg listener
// (singleton, not tied to the mount lifecycle). After the pair-client B5 fix, stopping the
// instance removes its own listener and there is no more "phantom instance" collecting messages —
// the badge must own its channel.
let pairMsgListenerInstalled = false;
function installGlobalPairMsgListener() {
  if (pairMsgListenerInstalled || typeof globalThis.addEventListener !== "function") return;
  pairMsgListenerInstalled = true;
  globalThis.addEventListener("aiti-pair-msg", (e) => {
    const m = (e && e.detail) || {};
    if (!m || !m.from) return;
    if (presentOf() === "closed") bumpUnread();
  });
}

// widget 挂载去重（React 重渲染/StrictMode ref 双触发不重复 mount；AitiPair 实例模块级保活）
let mounted = null; // { el, instance }
let mountPromise = null; // 在途挂载（异步加载竞态去重：ref 回调可能并发触发多次）
let libPromise = null; // single pair-client.js <script>: the warm-up and the first open share one request
// Whether mounted.el is still attached to the DOM — when the panel closes / the face switches,
// React unmounts the old host while the module-level mounted still holds the old el; reopening
// the panel must remount based on isConnected (otherwise the second toolbar click sets ready=true
// with an empty container → blank panel).
const mountedLive = () => !!(mounted && mounted.el && mounted.el.isConnected);

// The widget's current host face: 'dialog' (float / fallback overlay) | 'dock' (right-panel block) |
// null (unmounted / collapsed). The face marker only drives the polling fallback; face exclusivity
// is guaranteed by the present state machine as the single source (floating/docked, never both).
let face = null;
function setFace(v) {
  if (face === v) return; // idempotent short-circuit: no notification on the same value
  face = v;
  // Device-list polling fallback follows panel visibility (visible face mounted → on; collapsed → off)
  if (mounted && mounted.instance && mounted.instance.setPolling) {
    try { mounted.instance.setPolling(v != null); } catch (e) {}
  }
}

export default function register(ctx) {
  const { h, useState, useEffect, apiUrl } = ctx;
  // i18n: host ctx.t with bare-key fallback (index.ts ui.i18n entries)
  const t = (k) => (typeof ctx.t === "function" ? ctx.t(k) : k);
  installGlobalPairMsgListener(); // C1: closed-state unread badge channel (B8 ordering: before any mount)
  warmPairLib(); // preload the widget bundle so opening the panel never flashes a loading shell

  /* ── 深链：?pair=1 打开工作台即弹出本面板（QR/复制链接指向工作台 URL，与桌面「先开 pi-web → 点设备互连」同体验） ──
     一次性消费：开面板后从地址栏去掉参数（刷新不再自动弹；配对态在 localStorage，重开点工具条即可）。
     兜底：移动端无会话时 shell 不挂 dialogs 槽（面板组件不渲染）——800ms 内没看到 .apair 就用独立
     全屏浮层直挂 widget（自带关闭；点遮罩同关），保证扫码场景必达。 */
  try {
    const u = new URL(globalThis.location.href);
    if (u.searchParams.get("pair") === "1") {
      presentPair("open");
      u.searchParams.delete("pair");
      globalThis.history?.replaceState?.(null, "", u.pathname + (u.searchParams.toString() ? "?" + u.searchParams : "") + u.hash);
      setTimeout(() => {
        try {
          // The dialog face renders at once (it only needs the present state); the widget itself mounts
          // asynchronously, so "no .apair yet" does NOT mean "the shell has no dialogs slot". Check the
          // dialog container too — otherwise the fallback stacked a second full-screen panel on top of the
          // floating one and the deep link opened with a flash of two panels.
          if (document.querySelector(".apair") || document.querySelector('[data-ext-float-key="aiti-pair:pair"]')) return;
          const sz = pairWindowSize();
          const host = document.createElement("div");
          host.style.cssText = "position:fixed;inset:0;z-index:310;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center";
          const box = document.createElement("div");
          box.style.cssText = `position:relative;width:min(${sz.w}px,94vw);height:min(${sz.h}px,86vh);border-radius:12px;overflow:hidden;background:var(--bg-panel);border:1px solid var(--border);color:var(--text);box-shadow:0 10px 40px rgba(0,0,0,0.35)`;
          const bar = document.createElement("div");
          bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border);font-size:13px;font-weight:600;flex-shrink:0";
          bar.innerHTML = '<span style="flex:1">✉ 设备互连</span>'
            + '<button title="停靠到右侧" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:12px;padding:2px 6px">⇱</button>';
          bar.querySelector('button').onclick = () => { presentPair(PAIR_DOCK_ZONE); host.remove(); };
          const closeBtn = document.createElement("button");
          closeBtn.textContent = "✕";
          closeBtn.setAttribute("aria-label", "关闭");
          closeBtn.style.cssText = "background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:2px 6px";
          closeBtn.onclick = () => { presentPair("close"); host.remove(); };
          bar.appendChild(closeBtn);
          box.appendChild(bar);
          const inner = document.createElement("div");
          inner.style.cssText = "position:absolute;top:41px;bottom:0;left:0;right:0";
          box.appendChild(inner);
          host.appendChild(box);
          host.addEventListener("click", (e) => { if (e.target === host) { presentPair("close"); host.remove(); } });
          document.body.appendChild(host);
          ensureWidget(inner, "dialog").catch(() => {});
        } catch {}
      }, 800);
    }
  } catch {}

  const ASSET_BASE = "/api/extensions/aiti-devtools";
  const LIB_URL = () => apiUrl(ASSET_BASE + "/pair-client.js");
  const BRIDGE_BASE = () => apiUrl(ASSET_BASE + "/mcp"); // 内嵌桥端点（bridge-client 同款）

  function loadPairLib() {
    if (globalThis.AitiPair) return Promise.resolve(globalThis.AitiPair);
    if (libPromise) return libPromise; // one <script> per page: every reopen reused the in-flight/completed load
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = LIB_URL(); // asset endpoint negotiation cache (ETag/304): assets invalidate automatically on update; unchanged returns 304 instantly
      s.onload = () => (globalThis.AitiPair ? resolve(globalThis.AitiPair) : reject(new Error("pair-client.js 加载后未暴露 AitiPair")));
      s.onerror = () => { libPromise = null; reject(new Error("pair-client.js 加载失败（aiti-devtools 扩展未部署？）")); }; // a failed load stays retryable
      document.head.appendChild(s);
    });
    return libPromise;
  }

  /* Warm the widget bundle as soon as the extension registers (one cached request, async — never blocks
     the page). Without it the first open of the panel painted its shell and only then swapped in the
     widget: a visible flash after every page refresh (dev: seconds). Starting immediately (not on idle)
     matters — the extension materializes early, while an idle callback may not run for seconds on a busy
     first load, which is exactly when the user clicks the entry. */
  function warmPairLib() {
    setTimeout(() => { loadPairLib().catch(() => {}); }, 0);
  }

  function ensureWidget(host, faceTag) {
    // Strict validation: reuse only if mounted, alive, and on the current host (face switch / panel reopen = new host → must remount)
    if (mounted && mounted.el && mounted.el.isConnected && mounted.el === host) { setFace(faceTag); return Promise.resolve(mounted); }
    if (mountPromise) return mountPromise;
    // 重开面板 = React 重建 host DOM（旧 el 已摘除）→ 先停旧实例再重挂（AitiPair 实例同 peerId 幂等，SSE 重连无感）
    if (mounted) { try { mounted.instance.stop(); } catch (e) {} mounted = null; }
    mountPromise = loadPairLib().then((AitiPair) => {
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;inset:0;display:flex;min-height:0";
      host.innerHTML = ""; // 防御：同 host 重复挂载时清旧（幂等）
      host.appendChild(el);
      const instance = AitiPair.mount(el, {
        base: BRIDGE_BASE(),
        // B8: the 📱 phone entry generates the QR with params via the service-tunnels "mobile access"
        // client service (soft dependency; when absent the widget degrades itself to link + copy).
        // Service shape: registerExtService("service-tunnels.mobile", openMobileWith({url|query|title}))
        // — {url} renders the QR for that link directly.
        // ⚠ service-tunnels is a lazy extension (clientImmediately:false): resident slots like the
        // toolbar do not materialize it, and the service only registers after its own entry is first
        // clicked — so here we ensureMaterialized deterministically, then re-fetch (same pattern as
        // agent-manager → aiti-cmd.open-session), avoiding "never clicked the entry → 📱 forever degraded".
        openOnPhone: (url) => {
          const lookup = () => (typeof ctx.getExtService === "function" ? ctx.getExtService("service-tunnels.mobile") : null);
          const direct = lookup();
          if (typeof direct === "function") { direct({ url, title: "设备互连 · 手机接入" }); return Promise.resolve(); }
          if (typeof ctx.ensureMaterialized !== "function") return Promise.reject(new Error("openOnPhone 服务未就绪"));
          return Promise.resolve(ctx.ensureMaterialized("service-tunnels")).then(() => {
            const svc = lookup();
            if (typeof svc !== "function") throw new Error("openOnPhone 服务未就绪（物化后仍缺席——service-tunnels 未部署/停用？）");
            svc({ url, title: "设备互连 · 手机接入" });
          });
        },
      });
      mounted = { el, instance };
      setFace(faceTag);
      mountPromise = null; // 成功即清：下次面板重开（DOM 已换）必须重新挂载，不能返回旧 promise
      return mounted;
    }).catch((e) => { mountPromise = null; throw e; }); // 失败也允许重试
    setFace(null); // remount means the panel is absent: notify after mountPromise assignment so a re-entering ensureWidget sees the in-flight promise and returns
    return mountPromise;
  }

  // Subscription to present state changes (shared by both faces; stops the instance on closed to save SSE). ⚠ must be called inside the component (React hook rules)
  function usePresentPair() {
    const [, force] = useState(0);
    useEffect(() => {
      const l = () => force((n) => n + 1);
      let off;
      const onPresent = (d) => {
        if (d && d.key !== PAIR_KEY) return;
        if (presentOf() === "closed") {
          setFace(null);
          if (mounted) { try { mounted.instance.stop(); } catch (e) {} }
        }
        l();
      };
      const api = globalThis.__piweFloat;
      if (api && typeof api.onPresentChange === "function") {
        off = api.onPresentChange(onPresent);
      } else {
        // aiti-float becomes ready later than this component: install broadcasts piwe-float-installed; re-check the real state once ready
        globalThis.addEventListener('piwe-float-installed', l, { once: true });
      }
      return () => { try { off && off(); } catch (e) {} globalThis.removeEventListener('piwe-float-installed', l); };
    }, []);
    return presentOf();
  }

  /* ── Floating panel (dialogs slot; rendered in the floating state) ── */
  function PairDialog() {
    const state = usePresentPair();
    const [err, setErr] = useState("");
    const [ready, setReady] = useState(false);
    const open = state === "floating";
    useEffect(() => {
      if (!open || ready || mountedLive()) { if (open && mountedLive()) setReady(true); return; }
      let dead = false;
      ensureWidget(hostEl(), "dialog").then(() => { if (!dead) setReady(true); }).catch((e) => { if (!dead) setErr(String((e && e.message) || e)); });
      return () => { dead = true; };
    }, [open]);

    if (!open) return null;
    const sz = pairWindowSize();
    return h("div", {
      style: {
        position: "fixed", inset: 0, zIndex: 310, background: "rgba(0,0,0,0.35)",
        display: "flex", alignItems: "center", justifyContent: "center",
      },
      onClick: () => presentPair("close"),
    },
      h("div", {
        "data-ext-float": "1",      // aiti-float 接管：拖拽/缩放/持久化/置前
        "data-ext-float-key": PAIR_KEY, // state-machine key (read by the ✕ interceptor / dock preference / position menu)
        "data-ext-float-full": "1", // 小屏（≤640px）铺满视口
        "data-ext-float-dock": "right-panel",
        "data-ext-float-dock-default": "right-panel",
        "data-ext-float-w": String(sz.w),
        "data-ext-float-h": String(sz.h),
        style: {
          width: `min(${sz.w}px, 94vw)`, height: `min(${sz.h}px, 86vh)`, padding: 0, overflow: "hidden",
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
          // the dock entry is auto-injected by aiti-float into the "position" menu per the data-ext-float-dock declaration (never hand-written — avoids a double ⇱)
          h("span", { style: { fontSize: 10, color: "var(--text-dim)", fontWeight: 400 } }, "连同一桥即互发"),
          h("button", {
            onClick: () => presentPair("close"), "aria-label": "关闭",
            style: { background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, padding: "2px 6px" },
          }, "✕"),
        ),
        h("div", {
          ref: (el) => {
            hostRef = el;
            if (open && el && !mountedLive() && !mountPromise) {
              ensureWidget(el, "dialog").then(() => setReady(true)).catch((e) => setErr(String((e && e.message) || e)));
            } else if (open && mountedLive()) setReady(true);
          },
          style: { position: "absolute", top: 41, bottom: 0, left: 0, right: 0, display: ready ? "block" : "none" },
        }),
        !ready && err && h("div", { style: { position: "absolute", top: 41, bottom: 0, left: 0, right: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, textAlign: "center", fontSize: 12, color: "var(--text-muted)", whiteSpace: "pre-wrap" } },
          err),
      ),
    );
  }

let hostRef = null;
const hostEl = () => hostRef;

/* ── 面板尺寸（响应式）：大屏给对话更多空间 ──
   ≥1536px 900×740 · ≥1024px 720×680 · 其余 460×560（aiti-float 持久化优先——
   拖/缩过的用户保留自调尺寸，双击标题复位到这组新默认） */
function pairWindowSize() {
  const mq = (q) => { try { return globalThis.matchMedia(q).matches; } catch { return false; } };
  if (mq("(min-width:1536px)")) return { w: 900, h: 740 };
  if (mq("(min-width:1024px)")) return { w: 720, h: 680 };
  return { w: 460, h: 560 };
}

  /* ── toolbar 按钮（lucide message-circle，36×36 同系统内建） ── */
  function PairToolbarButton() {
    const [n, setN] = useState(unread);
    useEffect(() => {
      const l = () => setN(unread);
      unreadListeners.add(l);
      return () => unreadListeners.delete(l);
    }, []);
    return h("button", {
      title: t("it.pair.title"),
      onClick: () => {
        setUnread(0);
        presentPair("open"); // idempotent open in the docked state (aiti-float flashes to point at the panel); closed/floating → dialog
      },
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

  /* ── Right-panel dock face (rightFileDock slot; rendered in the docked:right-panel state) — same as doc-center ──
     根节点带 DockBody（chrome:"tab"）契约标注；无自绘头行（页签控件在宿主 TabBar）。 */
  function DockPair() {
    const state = usePresentPair();
    if (state !== "docked:right-panel") return null; // contract gate: render nothing outside the right-panel docked state
    return h("div", {
      "data-ext-float-dock-body": PAIR_KEY, // DockBody(tab) contract marker: depended on by the orchestrator / ⇱ menu / flash positioning
      "data-ext-item": PAIR_KEY,
      "data-ext-dock-block": PAIR_KEY,
      "data-ext-float-dock": "right-panel",
      "data-ext-float-dock-default": "right-panel",
      style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", position: "relative" },
    },
      h("div", {
        ref: (el) => {
          if (!el) return;
          hostRef = el;
          if (mountedLive() && mounted.el === el) return; // already mounted on this host: idempotent skip
          ensureWidget(el, "dock").catch(() => {});
        },
        style: { position: "relative", flex: 1, minHeight: 0, overflow: "hidden", background: "var(--bg-panel)" },
      }));
  }

  ctx.registerItems?.("toolbar", [{ id: "pair", render: PairToolbarButton, meta: { label: "i18n:it.pair.label" } }]);
  ctx.registerItems?.("dialogs", [{ id: "pair", render: PairDialog, meta: { label: "i18n:it.pair.label.2" } }]);
  ctx.registerItems?.("rightFileDock", [{ id: "pair", render: DockPair, meta: { label: "i18n:it.pair.label", title: "i18n:it.pair.title" } }]);
}
