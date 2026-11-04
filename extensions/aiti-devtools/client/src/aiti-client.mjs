/**
 * aiti-devtools client bundle — prebuilt ESM（与 demo 同模式：host 传 h/useState/useEffect/apiUrl）
 *
 * UI：
 *   - toolbar：🧰 AITI 按钮 → 打开对话框
 *   - dialogs：mcp-bridge 面板——
 *     ① 桥连接状态（连桥 role=ai / 重连）
 *     ② 当前调试目标（宿主 boot：pageId/targetUrl）
 *     ③ 可操作页面列表（sessions 发现，选择目标）
 *     ④ CDP 命令执行（pageId 定向 → 桥 POST /mcp）
 *     ⑤ 注入端口管理（service-tunnels transformResponse 注入开关）
 */
let dialogOpen = false; // 未装 aiti-float 时的本地降级显隐（装了则状态机是唯一开关）
const dialogListeners = new Set();
// ── aiti-float dock v3（P1 批，position-picker-plan §3.2）：调试面板接停靠状态机 ──
// 手写 h() 免构建 client，无法 import _shared/ext-float-dock.ts——这里内联同语义薄桥：
// present 委托 window.__piweFloat（float 在场），缺席退回本地布尔；face 渲染门控走状态。
const DIALOG_KEY = "aiti-devtools:main";
function floatApi() {
  const api = window.__piweFloat;
  return api && typeof api.present === "function" ? api : null;
}
function presentedState() {
  const api = floatApi();
  if (api) return api.presented(DIALOG_KEY) || "closed";
  return dialogOpen ? "floating" : "closed";
}
function setDialogOpen(v) {
  const api = floatApi();
  if (api) { api.present(DIALOG_KEY, v ? "open" : "close"); return; }
  dialogOpen = v;
  for (const l of dialogListeners) l();
}
// 播种默认落位（seedDockDefault 同款）：用户无偏好时 open 直达右栏「调试」tab
try {
  const pk = "pi-web:ext-float:dockpref:v1:" + DIALOG_KEY;
  if (!localStorage.getItem(pk)) localStorage.setItem(pk, "right-panel");
} catch (e) {}
// AI 窗特征标记（模块顶层即置，早于 React 渲染/host-protocol 动态加载）：
// 仅当本页【以 AI 窗身份启动】（launcher 拼 AI 窗地址的专有参数 _dbg，或 popup 同名窗口）才置——
// 普通 pi-web 页不置（它们也要被 launcher 调试，不能误杀）。
// 供 launcher 防嵌套检测（window.__AITI_AI_WIN__）：AI 窗里 launcher 不启动/自毁，
// 防 AI 窗里再嵌 AI 窗拖死同站 renderer 主线程
try {
  if (/[?&]_dbg=/.test(location.search) || window.name === 'aiti-ai-popup') window.__AITI_AI_WIN__ = true;
} catch (e) {}
// 候选区占位符 [元素N]/[回答N]/[错误N] 独立点击区 hover 反馈（inline style 无 :hover——注入一次性样式，幂等）
try {
  if (!document.getElementById("aiti-picked-tag-style")) {
    const st = document.createElement("style");
    st.id = "aiti-picked-tag-style";
    st.textContent = ".aiti-picked-tag{user-select:none}.aiti-picked-tag:hover{text-decoration:underline;opacity:.85}";
    document.head.appendChild(st);
  }
} catch (e) {}
// 候选详情弹窗状态（点击候选打开）
let detailIdx = -1;
const detailListeners = new Set();
function setDetail(idx) { detailIdx = idx; for (const l of detailListeners) l(); }

// ---------- 宿主协议（公共库 host-protocol.js 统一处理；本处仅桥接 React 渲染） ----------
// 候选状态（元素/错误/异步作答 → [元素N]/[回答N]/[错误N]）与去重/ack/localStorage 由 host-protocol 管理；
// 这里保留 pickedElements/debugTarget 作为 React 可订阅视图（host-protocol 回调同步）。
let hp = null; // AitiHostProtocol 实例（register 内异步加载）
let pickedElements = [];
const pickedListeners = new Set();
let debugTarget = { pageId: null, bridge: null, targetUrl: null, title: null };
const targetListeners = new Set();
// 适配回调（register 内注册；host-protocol 创建时引用——UI 具体实现留适配端）
const hpAdapters = {
  insertPlaceholder: null, // 占位符插入输入框（React textarea setter）
  onUserMsg: null,         // 宿主用户消息（element_instruction 追加输入框）
  onInspect: null,         // 点选模式状态（InspectButton active）
};
function syncPicked(list) { pickedElements = list || []; for (const l of pickedListeners) l(); }
function syncTarget(t) { debugTarget = t || debugTarget; for (const l of targetListeners) l(); }
function setPicked(next) { if (hp) hp.setPicked(next); } // 委托 host-protocol（deriveTags + localStorage + onPicked→syncPicked）
function postToHost(type, payload) { if (hp) hp.postToHost(type, payload); }
function initHostProtocol() {
  if (hp || !window.AitiHostProtocol) return hp;
  hp = window.AitiHostProtocol.create({
    onPicked: syncPicked,
    onBoot: syncTarget,
    insertPlaceholder: (el) => { if (hpAdapters.insertPlaceholder) hpAdapters.insertPlaceholder(el); },
    onUserMessage: (p) => { if (hpAdapters.onUserMsg) hpAdapters.onUserMsg(p); },
    onInspect: (on) => { if (hpAdapters.onInspect) hpAdapters.onInspect(on); },
    // 宿主页面事件（page_log/page_network/open_file…）→ 桥：AI 窗是桥唯一浏览器端点（open_file 桥后台打开编辑器）
    onBridgeEvent: (type, payload, target) => {
      try { if (window.BridgeClient) window.BridgeClient.postEvent(type, payload, (target && target.pageId) || null); } catch (e) {}
    },
  });
  // host-protocol 内部已从 localStorage 恢复候选并回调 onPicked → syncPicked
  return hp;
}

export default function register(ctx) {
  const { h, useState, useEffect, apiUrl } = ctx;
  const btnStyle = {
    border: "1px solid var(--border)", background: "var(--bg-elevated)",
    borderRadius: 6, padding: "5px 12px", cursor: "pointer",
    fontSize: 12, color: "var(--text)",
  };
  // topbar 工具栏按钮：与系统内建一致（AppShell topbarRowBtnStyle：flex 居中 + 固定 36×36（=TOP_BAR_ICON_BUTTON_SIZE） + hover 变色）
  // ⚠ 必须固定 height:36，不能 height:"100%"——AppShell 的 itemsRow 高度由内容撑开，% 会退化到 16px（偏小/顶部对齐）；
  //   与系统内建按钮同款：rowBtnStyle 的 height:"100%" 也被 topBarIconButtonSize 覆盖为固定值。
  const topbarBtnStyle = {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 36, height: 36, padding: 0,
    background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
    color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
    fontSize: 16, lineHeight: 1, transition: "color 0.12s",
  };
  const rowStyle = { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 };

  // lucide 图标（与系统内建线条图标同风格）
  const Ic = (size, paths) => {
    const el = h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, paths.map((d, i) => h("path", { key: i, d })));
    if (el._store) el._store.validated = 1;
    return el;
  };
  const ICONS = {
    bug: ["m8 2 1.88 1.88", "M14.12 3.88 16 2", "M9 7.13v-1a3.003 3.003 0 1 1 6 0v1", "M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6", "M12 20v-9", "M6.53 9C4.6 8.8 3 7.1 3 5", "M6 13H2", "M3 21c0-2.1 1.7-3.9 3.8-4", "M20.97 5c0 2.1-1.6 3.8-3.5 4", "M22 13h-4", "M17.2 17c2.1.1 3.8 1.9 3.8 4"],
    x: ["M18 6 6 18", "m6 6 12 12"],
    plug: ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"],
    refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
    crosshair: ["M22 12h-4", "M6 12H2", "M12 6V2", "M12 22v-4", "M12 12"],
    check: ["M20 6 9 17l-5-5"],
    copy: ["M8 8H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2", "M14 2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6l-4-4z", "M14 2v6h6"],
    folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
    monitor: ["M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M8 21h8", "M12 17v4"],
  };

  const inputStyle = {
    flex: 1, border: "1px solid var(--border)", borderRadius: 6,
    padding: "4px 8px", fontSize: 12, background: "var(--bg-elevated)", color: "var(--text)",
  };
  const smallStyle = { fontSize: 11, color: "var(--text-muted)", margin: 0, wordBreak: "break-all", lineHeight: 1.5 };

  // ---------- 宿主协议（host-protocol.js 公共库）加载 + 适配注册 ----------
  // 协议解析/候选/去重/ack 全在公共库；此处只注册 UI 适配（占位符插入/发送描述/消息处理）。
  function loadHostProtocolScript() {
    if (window.AitiHostProtocol) { initHostProtocol(); if (hp) hp.sendReady(); scheduleOrphanStrip(); return; }
    const s = document.createElement("script");
    s.src = apiUrl("/api/extensions/aiti-devtools/host-protocol.js");
    s.onload = () => { initHostProtocol(); registerAdapters(); if (hp) hp.sendReady(); scheduleOrphanStrip(); };
    s.onerror = () => console.error("[aiti] host-protocol.js 加载失败");
    document.head.appendChild(s);
  }
  function registerAdapters() {
    hpAdapters.insertPlaceholder = insertPlaceholder; // React textarea 占位符插入（见下）
    // 候选描述公共库在 host-protocol.js（describe/brief/detailRows/filterPayload/clipUrl）——本处不覆盖，直接 hp.* 调用
    hpAdapters.onUserMsg = (p) => {                    // 宿主指示文本 → 追加输入框
      if (!p || p.kind !== "element_instruction" || !p.text) return;
      try {
        const ta = chatTextarea();
        if (!ta) return;
        setTaValue(ta, (ta.value.trim() ? ta.value.trim() + " " : "") + p.text);
        ta.focus();
      } catch (e) {}
    };
    hpAdapters.onInspect = (on) => { try { setInspectActive(on); } catch (e) {} };
    hpAdapters.onAiOpenFile = (p) => {
      // launcher 预览窗口「🖥 前端」转发：本 AI 窗在 pi-web 页面内 → 经宿主 aiti_open_file 打开文件标签页（openFileFrontend 自做存在性校验）
      try { if (p && p.file) openFileFrontend(p.file); } catch (e) {}
    };
    hpAdapters.onCopy = (p) => {
      // 复制转发协议（dbg_copy）：子窗复制失败 → 宿主执行。本 AI 窗收到（launcher 转发）→ 执行；失败再转发宿主（launcher showCopyFallback 终态）
      try { if (p && p.text) copyText(p.text).then((ok) => { if (!ok) { try { postToHost("dbg_copy", { text: p.text }); } catch (e) {} } }); } catch (e) {}
    };
  }
  // 主聊天输入框定位：pi-web 聊天框有稳定 class（ChatInput.tsx textarea.chat-input-textarea），优先取它。
  // 不能裸用 querySelector("textarea")——aiti-helper 等扩展弹窗打开时，其输入框在 DOM 顺序上更靠前，
  // 裸取会命中弹窗输入框：点选元素后 [元素N] 插进 helper 框（主框看不到），孤儿清理/候选摘除也作用错框；
  // 主框旧占位符清不掉，发送时被 preSend 整体替换成「候选已失效」提示。无匹配时回退裸取（其他载体兜底）。
  function chatTextarea() {
    try { return document.querySelector("textarea.chat-input-textarea") || document.querySelector("textarea"); } catch (e) { return null; }
  }
  // React 受控 textarea 写值：原生 setter + input 事件（insertPlaceholder/ensurePlaceholder/onUserMsg 共用）
  function setTaValue(ta, v) {
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, v);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (e) {}
  }
  // 加载后清理输入框里的孤儿占位符（[元素N] 但对应候选已空/换实例未恢复）：
  //   候选按 AI 实例分 key，刷新/换会话后旧候选不恢复，而 pi-web 输入草稿会把旧 [元素N] 带回来——
  //   残留占位符发送时被替换成「候选已失效」反复打扰。此处把无对应候选的占位符直接摘掉（有候选的保留）。
  function stripOrphanTagsFromInput() {
    try {
      const ta = chatTextarea();
      if (!ta || !ta.value) return;
      const active = new Set();
      try { (hp.getPicked ? hp.getPicked() : []).forEach((el) => { if (el && el.tag) active.add(el.tag); }); } catch (e) {}
      const v = ta.value;
      const cleaned = String(v).replace(/\[(?:元素|回答|错误|选择)\d+\]/g, (tag) => (active.has(tag) ? tag : ""));
      if (cleaned !== v) setTaValue(ta, cleaned);
    } catch (e) {}
  }
  // 输入草稿由 pi-web 恢复时机不定——延迟多轮清理（幂等：候选占位符保留，正常输入不受影响）
  let _orphanStripN = 0;
  function scheduleOrphanStrip() {
    _orphanStripN = 0;
    const tick = () => { stripOrphanTagsFromInput(); if (++_orphanStripN < 6) setTimeout(tick, 800); };
    setTimeout(tick, 1200);
  }
  // InspectButton 的 active 状态（host-protocol onInspect 驱动；组件内也有本地 state）
  let _inspectActive = false;
  const inspectActiveListeners = new Set();
  function setInspectActive(v) { _inspectActive = v; for (const l of inspectActiveListeners) l(v); }

  // ---------- 桥（mcp-bridge）：加载 bridge-client.js + 连桥 role=ai ----------
  // dock v3：面板展示状态订阅（双通道：float 状态机 CHANGE_EVENT + 本地降级 listeners）
  function useDialogState() {
    const [st, setSt] = useState(presentedState());
    useEffect(() => {
      const sync = () => setSt(presentedState());
      const onChg = (e) => { if (e.detail && e.detail.key === DIALOG_KEY) sync(); };
      dialogListeners.add(sync);
      window.addEventListener("piwe-float-present-change", onChg);
      return () => { dialogListeners.delete(sync); window.removeEventListener("piwe-float-present-change", onChg); };
    }, []);
    return st;
  }

  // ---------- 桥（mcp-bridge）：加载 bridge-client.js + 连桥 role=ai ----------
  // 宿主问答面板作答/倒计时控制 → 回桥（launcher postMessage dbg_mcp_result / dbg_mcp_interaction_control；
  // 内嵌形态同窗送达本监听，popup/iframe 形态 AI 窗侧同理——回桥统一走 BridgeClient）
  if (typeof window !== "undefined") {
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (!m || m.__dbg !== 1) return;
      if (m.type === "dbg_mcp_result") {
        // 回环防御：桥广播的结算通知（onResult → postToLauncher 转发，带 _aiBridge 标记）不是
        // launcher 作答回传——同窗内嵌形态下自发自收，若不区分会再 postResult → 桥广播 → 无限回环
        // （实测 ~675 req/s 日志洪水 + dev watch 风暴）。作答方向（interact.js sendInteractionResult）无标记。
        if (m._aiBridge) return;
        const p = m.payload || {};
        if (p.requestId && window.BridgeClient) window.BridgeClient.postResult(p.requestId, p.ok !== false, p.result);
      } else if (m.type === "dbg_mcp_interaction_control") {
        const p = m.payload || {};
        if (p.requestId && window.BridgeClient) window.BridgeClient.postInteraction(p.requestId, p.action);
      }
    });
  }
  function loadBridgeClient() {
    return new Promise((resolve) => {
      if (window.BridgeClient && typeof window.BridgeClient.connect === "function") return resolve(true);
      const s = document.createElement("script");
      s.src = apiUrl("/api/extensions/aiti-devtools/bridge-client.js");
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }
  // M1 self-exec 执行核心：cdp-core.js（提取自注入 client 的 CDP 命令表；加载后 window.__AitiCdpCore）
  // ——AI 主窗口自管理（xxx/ai）无宿主时也能执行 DOM/CSS/Input/Page/Runtime 等命令
  let cdpCoreLoading = null;
  function loadCdpCore() {
    if (window.__AitiCdpCore) return Promise.resolve(true);
    if (cdpCoreLoading) return cdpCoreLoading;
    cdpCoreLoading = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = apiUrl("/api/extensions/aiti-devtools/cdp-core.js");
      s.onload = () => resolve(!!window.__AitiCdpCore);
      s.onerror = () => { cdpCoreLoading = null; resolve(false); };
      document.head.appendChild(s);
    });
    return cdpCoreLoading;
  }
  function bridgeBase() {
    return apiUrl("/api/extensions/aiti-devtools/mcp");
  }
  let bridgeConnecting = false; // connectBridge 并发去重（pi-web 双挂载竞态）
  // launcher 宿主窗口（popup=opener / iframe=parent / 同窗内嵌=self，与 host-protocol aiHost 同规则）——交互/结果统一经此转发
  // 协商门槛（2026-09-08，与 host-protocol aiHost / bridge-client 同规则，约定字符串 '__dbg_aiwin='
  // 三处同步）：opener/parent 仅在 URL hash 带 #__dbg_aiwin=1（宿主打开 AI 窗时附带，aiwin.js
  // withAiWinMark）时才认——普通被 window.open 的 pi-web 会话页（如 aiti-cpu-meter「创建调试会话」）
  // 不误判为 AI 弹窗（否则向 opener 报消息触发宿主孤儿清理被秒关）；无标记回落 window 自身
  // （自管理语义：postMessage 自发自收，pi-web 根页面自身就有 launcher/routing）
  function hasAiwinMark() {
    try { return String(window.location.hash || "").indexOf("__dbg_aiwin=") >= 0; } catch (e) { return false; }
  }
  function launcherHost() {
    // 缓存 __dbgAiHostWin：SPA（Next.js）会剥 URL hash——mark 只在首次判定时存在，后续心跳
    // （postToLauncher 每 5s）若重读 hash 会误退自管理、互通半途断（见 host-protocol aiHost 注释）
    try {
      const cached = window.__dbgAiHostWin;
      if (cached && !cached.closed) return cached;
    } catch (e) {}
    if (hasAiwinMark()) {
      if (window.opener && !window.opener.closed) { window.__dbgAiHostWin = window.opener; return window.opener; }
      if (window.parent !== window) { window.__dbgAiHostWin = window.parent; return window.parent; }
    }
    return window;
  }
  function postToLauncher(msg) {
    try { launcherHost().postMessage(msg, "*"); } catch (e) {}
  }
  function connectBridge() {
    // 幂等：pi-web 工具栏把扩展条目渲染两处（可见行 + 离屏测量 strip），AitiToolbarButton 会双挂载、
    // useEffect 双触发 connectBridge——重复 connect 会先 close 旧 EventSource 再建新连接，竞态下
    // 可能残留双 SSE（桥双投递：交互双面板/pick_element 互拒）。已连接或正在连接则跳过。
    if (window.BridgeClient && window.BridgeClient.isConnected && window.BridgeClient.isConnected()) return Promise.resolve({ ok: true, already: true });
    if (bridgeConnecting) return Promise.resolve({ ok: true, inFlight: true });
    bridgeConnecting = true;
    loadCdpCore(); // M1：预载 self-exec 执行核心（不阻塞连桥；无宿主也能自管理）
    return loadBridgeClient().then((ok) => {
      bridgeConnecting = false;
      if (!ok) return { ok: false, error: "bridge-client 加载失败" };
      // 连接参数公共库出（AI 窗身份 + exec 转发宿主；onStatus/onExec 等回调适配端自己拼）
      const common = (hp && hp.bridgeConnectParams) ? hp.bridgeConnectParams() : { role: "ai", token: "dev", useForward: true };
      window.BridgeClient.connect({
        base: bridgeBase(), ...common,
        onStatus: (text, color) => setBridgeStatus(text + " · " + bridgeBase(), color),
        onReady: () => { if (hp) { hp.resetAiPageReport(); hp.reportAiPage(bridgeBase()); hp.resetSelfPageReport(); hp.reportSelfPage(bridgeBase()); hp.reportActive(bridgeBase()); } }, // 服务端 ready 确认后注册（避免竞态 404）；宿主页 xxx/host + AI 主窗口 xxx/ai 双注册 + 活跃通知
        onExec: (m) => setBridgeLog("→ " + (m.cmd || "") + " " + JSON.stringify(m.args || {}).slice(0, 80)),
        // 桥用户交互（confirm/choose/input/presence/pick_element）→ 宿主问答面板渲染：
        // launcher 在宿主窗口（popup=opener / iframe=parent / 同窗内嵌=self，与 host-protocol aiHost 同规则）——
        // 旧实现固定发自身窗口：pi-web 扩展部署下 AI 窗是 iframe（launcher 在父窗口），自身无 launcher routing → 消息丢失、面板永不弹出。
        // 作答回传：launcher sendInteractionResult → dbg_mcp_result → 下方 window 监听 → postResult 回桥
        onInteraction: (m) => {
          // 桥用户交互（confirm/choose/input/presence/pick_element/notify）→ 页面渲染完整面板（launcher interact.js
          // handleMcpInteraction：notify 通知卡 / pick_element 点选 / 其余问答面板，含倒计时暂停/拒绝区/拖拽）。
          // 有外部宿主（popup/iframe AI 窗）→ 直接转发 launcher；pi-web 自身即 AI 窗（launcherHost 回落自身）且
          // 本页未注入 launcher → 先按需注入（ensureLauncher 已有机制）注入完成再转发——否则 postMessage 发给自己
          // 但无 launcher message 监听，面板永不弹出（历史 bug：confirm/choose/input 等全超时）。
          // 注：注入依赖装载完成（launcher.js:570 挂 window message 监听），故必须等 ensureLauncher resolve 再转发，
          // 不能同步 postToLauncher（launcher 未就绪时消息丢失）。
          const host = launcherHost();
          const it = m.interaction || {};
          if (host !== window) {
            postToLauncher({ __dbg: 1, type: "dbg_mcp_interaction", payload: { requestId: m.requestId, interaction: it } });
            return;
          }
          ensureLauncher().then((ok) => {
            if (!ok) { console.warn('[aiti] launcher 注入失败，interaction ' + m.requestId + ' 无宿主渲染（kind=' + (it.kind || '?') + '）'); return; }
            postToLauncher({ __dbg: 1, type: "dbg_mcp_interaction", payload: { requestId: m.requestId, interaction: it } });
          });
        },
        onResult: (m) => {
          setBridgeLog("← " + m.requestId + " ok=" + m.ok);
          // 服务端结算（超时/取消——agent 停止）→ 通知宿主 launcher 关闭对应问答/点选面板（幂等：已作答则面板已关，无匹配即忽略）
          // _aiBridge 标记：本模块的 dbg_mcp_result 监听据此区分“自己转发的结算通知”与 launcher 真作答，防同窗自发自收回环
          postToLauncher({ __dbg: 1, _aiBridge: 1, type: "dbg_mcp_result", payload: { requestId: m.requestId, ok: m.ok, result: m.result } });
        },
        onEvent: (m) => {
          if (!m || m.type !== "user_answer") return;
          const pv = m.payload || {};
          if (pv.status === "answered") {
            // 异步作答结果 → 候选（与 HUD 一致：[回答N] 点击追加输入框，发送时替换为结果文本）
            const cand = { kind: pv.kind || "answer", answer: String(pv.answer || "").trim() };
            if (!cand.answer) return;
            if (!pickedElements.some((x) => x.answer && x.answer === cand.answer)) {
              setPicked([...pickedElements, cand]);
              insertPlaceholder(cand);
            }
          }
          setBridgeLog("💬 用户" + (pv.status === "rejected" ? "拒绝：" + (pv.reason || "") : (pv.status === "answered" ? "回答：" + (pv.answer || "") : "超时")));
        },
      });
      refreshSessions();
      return { ok: true };
    });
  }

  // ---------- 状态：桥 + sessions + 执行结果 ----------
  let bridgeStatus = "桥未连";
  let bridgeColor = "#f87171";
  const bridgeListeners = new Set();
  let sessionsRows = [];
  const sessionsListeners = new Set();
  let bridgeLog = [];
  const logListeners = new Set();
  function setBridgeStatus(t, c) { bridgeStatus = t; bridgeColor = c || bridgeColor; for (const l of bridgeListeners) l(); }
  function setBridgeLog(t) { bridgeLog = [t, ...bridgeLog].slice(0, 8); for (const l of logListeners) l(); }
  function setSessions(rows) { sessionsRows = rows; for (const l of sessionsListeners) l(); }

  // AI 窗代注册宿主页：公共库 host-protocol.js（urlIdent/reportAiPage/合成记录/连接参数——与 cockpit 同源，勿在此复制）

  function refreshSessions() {
    if (hp) hp.reportAiPage(bridgeBase()); // 宿主页注册自愈（幂等；桥 sessions 经 AI 宿主页可见）
    if (!window.BridgeClient || typeof window.BridgeClient.listSessions !== "function") return;
    window.BridgeClient.listSessions().then((rows) => {
      // 桥里无 session（宿主 SSE 未连是常态——宿主不连桥）→ 用公共库宿主合成记录补一条，面板不再「无页面」
      const list = (rows || []).filter((r) => r.active && r.pageId);
      if (!list.length && hp) {
        const rec = hp.hostPageRecord();
        if (rec) list.push(rec);
      }
      setSessions(list);
      if (debugTarget.pageId) setBridgeStatus("🔗 桥已连 · 目标 " + debugTarget.pageId, "#4ade80");
    }).catch(() => {});
  }

  function useBridgeStatus() {
    const [s, setS] = useState(bridgeStatus);
    useEffect(() => { const l = () => setS(bridgeStatus); bridgeListeners.add(l); return () => bridgeListeners.delete(l); }, []);
    return s;
  }
  function useSessions() {
    const [rows, setRows] = useState(sessionsRows);
    useEffect(() => { const l = () => setRows(sessionsRows); sessionsListeners.add(l); return () => sessionsListeners.delete(l); }, []);
    return rows;
  }
  function useBridgeLog() {
    const [log, setLog] = useState(bridgeLog);
    useEffect(() => { const l = () => setLog(bridgeLog); logListeners.add(l); return () => logListeners.delete(l); }, []);
    return log;
  }
  function useDebugTarget() {
    const [t, setT] = useState(debugTarget);
    useEffect(() => { const l = () => setT(debugTarget); targetListeners.add(l); return () => targetListeners.delete(l); }, []);
    return t;
  }

  // 注：MCP 注册（~/.config/mcp/mcp.json）与注入端口管理面板已随服务端端点一并移除——
  //  - MCP：方案 M 下 agent 工具经 server.agent 进程内注入，无需写配置文件；
  //  - 注入端口：迁移到 service-tunnels 扩展（ServicesDialog · 注入源注册），本面板不再管理。
  // 遗留的 fetch 会打已删除端点 404，故整体删除（原 ⑤⑥ 节）。

  // ---------- 对话框 ----------
  // dock v3：内容体 DialogBody 两面共用；AitiDialog=浮窗 face（gate floating），AitiDockFace=右栏停靠 face
  function DialogBody() {
    const status = useBridgeStatus();
    const rows = useSessions();
    const log = useBridgeLog();
    const target = useDebugTarget();
    const [cmd, setCmd] = useState("");
    const [targetId, setTargetId] = useState("");
    const [execOut, setExecOut] = useState("");
    const [busy, setBusy] = useState(false);

    // 执行 CDP 命令（pageId 定向 → 桥 POST /mcp）
    const exec = async () => {
      if (!cmd.trim() || busy) return;
      const pid = targetId || target.pageId;
      if (!pid) { setExecOut("⚠ 未选目标（boot 自动带 / 从页面列表选）"); return; }
      setBusy(true); setExecOut("执行中…");
      try {
        const parts = cmd.trim().split(/\s+/);
        const m = parts[0].match(/^(\w+)\.(\w+)$/);
        const cmdName = m ? parts[0] : "Runtime.evaluate";
        const args = {};
        if (m) {
          const rest = parts.slice(1);
          if (rest[0]) args.selector = rest[0];
          if (rest[1]) args.expression = rest.slice(1).join(" ");
        } else args.expression = cmd.trim();
        const r = await fetch(bridgeBase() + "/mcp", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: "page_exec", arguments: { cmd: cmdName, args, pageId: pid } } }),
        });
        const j = await r.json();
        const text = (j.result && j.result.content && j.result.content[0] && j.result.content[0].text) || JSON.stringify(j);
        setExecOut(text.slice(0, 300));
      } catch (e) { setExecOut("⚠ " + String((e && e.message) || e)); }
      setBusy(false);
    };

    return h("div", null,
      // ① 桥状态
      h("div", { style: { ...rowStyle, marginBottom: 6 } },
        h("span", { style: { fontSize: 12, color: bridgeColor, flex: 1, wordBreak: "break-all" } }, status),
        h("button", { onClick: () => connectBridge(), style: { ...btnStyle, display: "inline-flex", alignItems: "center", gap: 5 } }, Ic(13, ICONS.plug), "连桥"),
        h("button", { onClick: refreshSessions, style: { ...btnStyle, display: "inline-flex" }, title: "刷新会话列表" }, Ic(13, ICONS.refresh)),
      ),
      // ② 调试目标（boot）
      h("div", { style: { background: "rgba(79,70,229,0.08)", borderRadius: 8, padding: "6px 8px", marginBottom: 8 } },
        h("div", { style: { fontSize: 11, fontWeight: 600, color: "#4f46e5", display: "flex", alignItems: "center", gap: 5 } }, Ic(12, ICONS.crosshair), "当前调试目标"),
        h("p", { style: { ...smallStyle, marginTop: 2 } }, "pageId: " + (target.pageId || "—") + (target.targetUrl ? "\n" + target.targetUrl : "")),
      ),
      // ③ 页面列表（发现）
      h("div", { style: rowStyle },
        h("select", { style: inputStyle, value: targetId || target.pageId || "", onChange: (e) => setTargetId(e.target.value) },
          h("option", { key: "__boot__", value: "" }, "（目标：boot / 选择）"),
          (rows || []).map((r) =>
            h("option", { key: r.pageId, value: r.pageId }, r.pageId + (r.url ? " · " + String(r.url).slice(0, 34) : "") + (r.frameworks ? " [" + r.frameworks + "]" : ""))),
        ),
      ),
      // ④ 命令执行
      h("div", { style: rowStyle },
        h("input", { style: inputStyle, value: cmd, placeholder: "CDP 命令：DOM.getOuterHTML .card / Input.click .btn / 或直接表达式", onChange: (e) => setCmd(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") exec(); } }),
        h("button", { onClick: exec, style: { ...btnStyle, background: "#4f46e5", color: "#fff", border: "none" } }, busy ? "…" : "执行"),
      ),
      execOut && h("pre", { style: { ...smallStyle, background: "#0f172a", color: "#a5f3fc", padding: 6, borderRadius: 6, marginBottom: 8, whiteSpace: "pre-wrap" } }, execOut),
      log.length > 0 && h("div", { style: { marginBottom: 8 } }, log.map((l, i) => h("div", { key: i, style: smallStyle }, l))),
      // ⑤ MCP / 注入端口（已迁移，见上方说明）：MCP 工具进程内注入、注入端口归 service-tunnels
      h("div", { style: { borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 } },
        h("p", { style: { ...smallStyle, color: "#64748b" } },
          "MCP 工具已由服务端进程内注入（方案 M，无需注册）；注入端口管理在 service-tunnels 扩展（ServicesDialog · 注入源）。"),
      ),
    );
  }

  function AitiDialog() {
    const state = useDialogState();
    const open = state === "floating";
    // 打开时加载会话列表（regTick 不再周期拉取）——保持下拉/列表数据新鲜
    useEffect(() => { if (open) refreshSessions(); }, [open]);
    if (!open) return null;
    const close = () => setDialogOpen(false);
    return h("div", {
      style: { position: "fixed", inset: 0, zIndex: 320, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" },
      onClick: close,
    },
      h("div", {
        "data-ext-float": "1",
        "data-ext-float-key": DIALOG_KEY,
        "data-ext-float-full": "1",
        "data-ext-float-w": 420,
        "data-ext-float-h": 520,
        "data-ext-float-dock": "right-panel",
        "data-ext-float-dock-default": "right-panel",
        style: { width: 420, maxWidth: "94vw", maxHeight: "86vh", borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", display: "flex", flexDirection: "column", overflow: "hidden" },
        onClick: (e) => e.stopPropagation(),
      },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px 10px", flexShrink: 0 } },
          h("b", { style: { fontSize: 14, display: "inline-flex", alignItems: "center", gap: 6 } }, Ic(14, ICONS.bug), "AITI · mcp-bridge"),
          h("button", { onClick: close, style: { ...btnStyle, padding: "2px 8px", display: "inline-flex" }, "aria-label": "关闭" }, Ic(12, ICONS.x)),
        ),
        h("div", { style: { padding: "0 16px 16px", flex: "1 1 auto", minHeight: 0, overflow: "auto" } }, h(DialogBody, null)),
      ),
    );
  }

  /** 停靠 face（rightFileDock item "main" → 复合 id = DIALOG_KEY）：仅 docked:right-panel 渲染。
   *  v3.1：不再渲染自绘头行——标题与 TabBar 页签重复，⇲ 由页签 ⇱ 位置菜单/双击/右键取代
   *  （「三层工具条」收敛：TabBar 页签 + DialogBody 工具行两层）。 */
  function AitiDockFace() {
    const state = useDialogState();
    useEffect(() => { if (state.startsWith("docked:")) refreshSessions(); }, [state]);
    if (state !== "docked:right-panel") return null;
    return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", color: "var(--text)", fontSize: 12 } },
      h("div", { style: { padding: "10px 12px", flex: "1 1 auto", minHeight: 0, overflow: "auto" } }, h(DialogBody, null)),
    );
  }

  // 候选详情 hook（组件内使用——useState/useEffect 来自 ctx）
  function useDetail() {
    const [d, setD] = useState(detailIdx);
    useEffect(() => { const l = () => setD(detailIdx); detailListeners.add(l); return () => detailListeners.delete(l); }, []);
    return d;
  }

  // 候选元素 hook（组件内使用——useState/useEffect 来自 ctx）
  function usePicked() {
    const [p, setP] = useState(pickedElements);
    useEffect(() => { const l = () => setP(pickedElements); pickedListeners.add(l); return () => pickedListeners.delete(l); }, []);
    return p;
  }

  // ---------- Inspect 点选（通知宿主 launcher 选取 element） ----------
  function inspectOn() {
    postToHost("dbg_ai_inspect_on", {});
    postToHost("dbg_ai_hide_self", {});
  }
  function inspectOff() {
    postToHost("dbg_ai_inspect_off", {});
    postToHost("dbg_ai_show_self", {});
  }
  // 输入框尾部追加 [元素N]/[回答N]/[错误N]（React 受控 textarea：原生 setter + input 事件）
  function insertPlaceholder(el) {
    try {
      const ta = chatTextarea();
      if (!ta) return;
      const tag = (el && el.tag) || "";
      if (!tag) return;
      // 同元素重复确认（合并回同一候选）→ 占位符已在输入框则不重复插
      if (ta.value.includes(tag)) { ta.focus(); return; }
      setTaValue(ta, (ta.value.trim() ? ta.value.trim() + " " : "") + tag);
      ta.focus();
    } catch (e) {}
  }
  // 点击候选：输入框无对应占位符才加（用户可能手工删了占位符）——有则不重复
  function ensurePlaceholder(el) {
    try {
      const ta = chatTextarea();
      if (!ta) return;
      const tag = (el && el.tag) || "";
      if (!tag || ta.value.includes(tag)) return;
      setTaValue(ta, (ta.value.trim() ? ta.value.trim() + " " : "") + tag);
      ta.focus();
    } catch (e) {}
  }
  // 逐条清除候选：host-protocol 记录指纹（宿主延迟重发不"复活"）+ 输入框同步摘掉该条占位符。
  // 删除中间项后剩余候选会重新编号（deriveTags 原地改 tag）——输入框里其余占位符同步对齐新编号，
  // 防止旧编号（如删 [错误1] 后原 [错误2] 已变 [错误1]）引用失效、发送时原样发给 AI。
  function removeOneCandidate(el) {
    try {
      const before = pickedElements.slice();               // 旧列表快照（对象引用，身份匹配用）
      const beforeTags = pickedElements.map((x) => x.tag); // 旧占位符快照（值拷贝——deriveTags 原地改 tag）
      if (hp) hp.removeCandidate(el);                       // 内部 setPicked → deriveTags 重新编号剩余候选
      const ta = chatTextarea();
      if (!ta || !ta.value) return;
      let v = hp && hp.stripFromText ? hp.stripFromText(ta.value, [el]) : ta.value; // 摘掉该条占位符
      // 剩余候选重新编号：输入框里旧 tag → 新 tag（只改仍存在的旧占位符）
      pickedElements.forEach((x) => {
        const oldIdx = before.indexOf(x);
        if (oldIdx < 0) return;
        const ot = beforeTags[oldIdx];
        if (!ot || ot === x.tag || !v.includes(ot)) return;
        const esc = ot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // 只换占位符本身，不动前后空白（区别于 strip 的删空格行为）
        v = v.replace(new RegExp(esc), x.tag);
      });
      // 摘除后清理残留空白（如占位符在句首）——仅在实际有变化时写回
      if (v !== ta.value) setTaValue(ta, v.trim());
    } catch (e) {}
  }
  // 从输入框摘掉指定占位符列表（旧 tag 值快照——不受 removeCandidate 重编号影响）+ 清理残留空白。
  // 用于整体清空：先快照旧 tag 值，再逐个 removeCandidate（onPicked 同步替换 pickedElements、
  // deriveTags 原地改剩余候选 tag）——快照必须是在清空前的值拷贝，否则摘错/摘不到。
  function stripTagsFromInput(tags) {
    try {
      const ta = chatTextarea();
      if (!ta || !ta.value) return;
      const items = (tags || []).filter(Boolean).map((t) => ({ tag: t }));
      if (!items.length) return;
      let v = hp && hp.stripFromText ? hp.stripFromText(ta.value, items) : ta.value;
      if (v !== ta.value) setTaValue(ta, v.trim());
    } catch (e) {}
  }
  // ---- 候选描述公共库（host-protocol.js 单源）：本处仅薄封装（传来源页 pageId + hp 未就绪兜底），不复制逻辑 ----
  // describe/brief/detailRows/filterPayload/clipUrl 全量实现在 host-protocol.js（独立桥 AI 窗与 pi-web 共用一份）
  const describeText = (el, pid) => (hp && hp.describe ? hp.describe(el, pid) : "<" + (el.tag || "?") + ">" + (el.xpath ? " · " + el.xpath : ""));
  const briefText = (el) => (hp && hp.brief ? hp.brief(el) : (el.kind === "error" ? ("⚠ " + String(el.message || "")) : "<" + (el.tag || "?") + ">"));
  const detailRowsText = (el) => (hp && hp.detailRows ? hp.detailRows(el, (debugTarget && debugTarget.pageId) || null) : []);
  const filterPayloadText = (el) => (hp && hp.filterPayload ? hp.filterPayload(el) : {});
  const clipUrlText = (u, max) => (hp && hp.clipUrl ? hp.clipUrl(u, max) : u);
  // 后台打开（经桥 open_file → 编辑器，AITI_OPEN_CMD 环境变量）
  const openFileBackend = (file, line) => {
    if (!file) return;
    try { if (window.BridgeClient && typeof window.BridgeClient.postEvent === "function") window.BridgeClient.postEvent("open_file", { file, line }); } catch (e) {}
  };
  // 绝对路径判定 + 文件存在性查询：逻辑提取到 core（host-protocol.copyText/checkFileStat），hp 未就绪时本地兑底
  const isAbsFilePath = (f) => (hp && typeof hp.isAbsPath === "function") ? hp.isAbsPath(f) : (!!f && (f.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(f)));
  const fetchFileStat = async (file) => {
    if (hp && typeof hp.checkFileStat === "function") {
      let apiBase = "";
      try { apiBase = apiUrl("/").replace(/\/+$/, ""); } catch {}
      const d = await hp.checkFileStat(file, apiBase);
      // null = 端点不可用/网络失败（如独立桥、demo 无 file-stat 端点）→ 乐观标记（调用端显示按钮，后端打开编辑器自校验）
      if (d === null) return { unknown: true };
      return d;
    }
    return { unknown: true };
  };
  // 复制文本：Clipboard API → execCommand → 转发宿主（dbg_copy 协议）——core（host-protocol.copyText）公共实现
  const copyText = (text) => {
    if (hp && typeof hp.copyText === "function") return hp.copyText(text);
    return Promise.resolve(false);
  };
  // 前端打开（pi-web 文件标签页在线查看）：必须文件是有效路径——绝对路径 + 服务端 stat 存在且为文件，
  // 才向宿主发 aiti_open_file（AppShell 监听 → handleOpenFile 打开文件标签页）；无效/不存在则不打开
  // （宿主 FileViewer 打开不存在的路径会显示错误页，先校验避免）。校验失败静默（不打扰用户）
  const openFileFrontend = async (file) => {
    if (!isAbsFilePath(file)) return;
    const d = await fetchFileStat(file);
    if (!d || d.exists !== true || d.isFile !== true) return;
    try {
      // 宿主公共接口优先（AppShell registerHostApi 注册的原样能力）；无则回退 postMessage 桥
      if (typeof ctx.openFile === "function") {
        await ctx.openFile(file, file.split("/").pop());
        return;
      }
      window.postMessage({ __dbg: 1, type: "aiti_open_file", payload: { filePath: file } }, "*");
    } catch (e) {}
  };

  // 🎯 Inspect 按钮（AITI 旁）：通知宿主点选；接收 dbg_ai_element 累积候选
  function InspectButton() {
    const [active, setActive] = useState(false);
    useEffect(() => {
      // 宿主协议（dbg_ai_element/error/inspect_off/user_message）由 host-protocol.js 公共库处理
      // （候选/去重/ack/占位符插入/指示文本追加）；本组件只同步 inspect 激活状态。
      const l = (v) => setActive(v);
      inspectActiveListeners.add(l);
      return () => inspectActiveListeners.delete(l);
    }, []);
    return h("button", {
      onClick: () => {
        const next = !active;
        setActive(next);
        if (next) {
          // 首次点击：先确保 launcher 就位（没有才注入，装好自动进点选；已有则立即进点选）
          ensureLauncher().then((ok) => { if (!ok) setActive(false); else inspectOn(); });
        } else {
          inspectOff();
        }
      },
      style: { ...topbarBtnStyle, background: active ? "#4f46e5" : "none", color: active ? "#fff" : "var(--text-muted)", borderRadius: active ? 6 : 0, borderRight: active ? "none" : "1px solid var(--border)" },
      onMouseEnter: (e) => { if (!active) e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { if (!active) e.currentTarget.style.color = "var(--text-muted)"; },
      title: "🎯 点选页面元素（通知宿主 inspect；选中元素进候选 [元素N]）",
    },
      // lucide：非 active crosshair（点选准星）· active square（停止）——与系统内建线条图标同风格
      active
        ? h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
            h("rect", { width: 18, height: 18, x: 3, y: 3, rx: 2 }))
        : h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
            h("circle", { key: "c1", cx: 12, cy: 12, r: 10 }),
            h("line", { key: "l1", x1: 22, y1: 12, x2: 18, y2: 12 }),
            h("line", { key: "l2", x1: 6, y1: 12, x2: 2, y2: 12 }),
            h("line", { key: "l3", x1: 12, y1: 6, x2: 12, y2: 2 }),
            h("line", { key: "l4", x1: 12, y1: 22, x2: 12, y2: 18 })));
  }

  // 候选详情弹窗：显示信息 + 字段筛选勾选 + 打开文件（存在性校验后显示 后台编辑器/前端 pi-web 按钮）
  function DetailDialog() {
    const d = useDetail();
    const picked = usePicked(); // 订阅候选变化——toggle 字段后重渲染（checkbox 即时反映）
    const [fileChecks, setFileChecks] = useState({}); // { [file]: "checking" | {exists,isFile} }
    const [hoverRow, setHoverRow] = useState(null);   // 行 hover 显示复制按钮
    const [copiedRow, setCopiedRow] = useState(null); // 复制成功提示（按钮变 ✓）
    // 文件行存在性预检：绝对路径才查（扩展 file-stat）；存在 → 显示 后端/前端 打开按钮，不存在 → 灰字提示
    // （不显示按钮——宿主 FileViewer/编辑器打开无效路径会报错；双通道之一：AI 窗直连扩展 API，另一通道是桥 file_stat 工具）
    useEffect(() => {
      const el2 = d >= 0 && picked[d] ? picked[d] : null;
      if (!el2) return;
      const f2 = el2.framework || {};
      const ua2 = f2.usedAt || el2.usedAt;
      const paths = [];
      if (f2.file || el2.file) paths.push(f2.file || el2.file);
      if (ua2 && ua2.file) paths.push(ua2.file);
      paths.forEach((fp) => {
        if (!fp || !isAbsFilePath(fp)) return;
        setFileChecks((s) => { if (s[fp]) return s; return { ...s, [fp]: "checking" }; });
        fetchFileStat(fp)
          .then((dd) => setFileChecks((s) => ({ ...s, [fp]: dd && dd.exists ? dd : { exists: false } })))
          .catch(() => setFileChecks((s) => ({ ...s, [fp]: { exists: false } })));
      });
    }, [d, picked]);
    if (d < 0) return null;
    const el = picked[d];
    if (!el) return null;
    if (!el.include) el.include = {};
    const FIELD_LABELS = [["tag", "标签"], ["text", "文本"], ["xpath", "xpath"], ["selector", "selector"], ["rect", "尺寸"], ["docRect", "文档位置"], ["attributes", "属性"], ["computed", "样式"], ["framework", "框架"], ["component", "组件"], ["file", "组件源码"], ["usedAt", "调用位置"], ["frame", "页面"]];
    // 初始化 include 显式 true（默认全选）——否则 !undefined=true 首次点击看似无效
    FIELD_LABELS.forEach(([fld]) => { if (el.include[fld] === undefined) el.include[fld] = true; });
    const toggle = (fld) => { el.include[fld] = !el.include[fld]; setPicked([...pickedElements]); };
    return h("div", {
      style: { position: "fixed", inset: 0, zIndex: 330, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" },
      onClick: () => setDetail(-1),
    },
      h("div", {
        style: { width: 360, maxWidth: "92vw", maxHeight: "80vh", overflow: "auto", padding: 14, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit" },
        onClick: (e) => e.stopPropagation(),
      },
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 } },
          h("b", { style: { fontSize: 13 } }, (el.tag || "候选") + " 详情"),
          h("button", { onClick: () => setDetail(-1), style: { ...btnStyle, padding: "2px 8px", display: "inline-flex" }, "aria-label": "关闭" }, Ic(12, ICONS.x)),
        ),
        h("div", { style: { marginBottom: 10 } },
          detailRowsText(el).map(([k, v], i) => {
            const isFile = hp && hp.isFileRow ? hp.isFileRow(k) : (k === "组件源码" || k === "调用处");
            // 文件行提取（core rowFileInfo 公共：组件源码/调用处 → file/line，兼容富载荷与 hover 轻载荷）
            const fi = (hp && hp.rowFileInfo) ? (hp.rowFileInfo(el, k) || {}) : {};
            const file = fi.file || null;
            const line = fi.line || null;
            const chk = file ? fileChecks[file] : null;
            const checking = chk === "checking";
            // unknown（端点不可用）→ 乐观显示按钮；exists:true → 校验 isFile；exists:false → 文件不存在
            const fileOk = !!file && !checking && !!chk && (chk.unknown ? true : (chk.exists === true && chk.isFile !== false));
            const fileMissing = !!file && !checking && !!chk && !chk.unknown && chk.exists !== true;
            const rowHover = hoverRow === i;
            return h("div", {
                key: i,
                style: { display: "flex", gap: 6, fontSize: 11, padding: "2px 0", borderBottom: "1px solid var(--border)", alignItems: "center", borderRadius: 4 },
                onMouseEnter: () => setHoverRow(i),
                onMouseLeave: () => setHoverRow(null),
                title: fileOk ? "文件存在：📂 后台编辑器打开 / 🖥 前端 pi-web 文件标签页查看" : (isFile && file ? "文件不存在（或非文件路径）——不提供打开" : undefined),
              },
              h("span", { style: { color: "var(--text-muted)", minWidth: 64, fontWeight: 600 } }, k),
              h("code", {
                style: { flex: 1, wordBreak: "break-all", color: fileOk ? "#4f46e5" : "inherit" },
              }, v),
              rowHover && h("button", {
                onClick: (e) => {
                  e.stopPropagation();
                  copyText(v).then((ok) => {
                    if (ok) {
                      setCopiedRow(i);
                      setTimeout(() => setCopiedRow((c) => (c === i ? null : c)), 1200);
                    } else {
                      // iframe 内 clipboard 受限 → 转发宿主（launcher/cockpit 宿主窗）：host 执行复制或弹手动复制框
                      try { postToHost("dbg_copy", { text: v }); } catch (err) {}
                    }
                  });
                },
                style: { ...btnStyle, padding: "1px 6px", fontSize: 10, flexShrink: 0, marginLeft: 2, color: copiedRow === i ? "#059669" : "var(--text)" },
                title: copiedRow === i ? "已复制" : "复制此内容",
              }, copiedRow === i ? [Ic(12, ICONS.check), "已复制"] : Ic(13, ICONS.copy)),
              (rowHover && file && fileOk) && h("span", { style: { display: "flex", gap: 4, flexShrink: 0 } },
                h("button", { onClick: (e) => { e.stopPropagation(); openFileBackend(file, line); }, style: { ...btnStyle, padding: "1px 8px", display: "inline-flex", alignItems: "center", gap: 4 } }, Ic(11, ICONS.folder), "后台"),
                h("button", { onClick: (e) => { e.stopPropagation(); openFileFrontend(file); }, style: { ...btnStyle, padding: "1px 8px", display: "inline-flex", alignItems: "center", gap: 4 } }, Ic(11, ICONS.monitor), "前端"),
              ),
              (file && checking) && h("span", { style: { color: "var(--text-muted)", fontSize: 10, flexShrink: 0 } }, "…"),
              (file && fileMissing) && h("span", { style: { color: "var(--text-muted)", fontSize: 10, flexShrink: 0 } }, "（文件不存在）"));
          }),
        ),
        el.kind === "error"
          ? h("p", { style: { ...smallStyle, margin: "8px 0" } }, "发送时 [错误N] 替换为完整错误详情（类型/消息/堆栈/时间）。")
          : h("div", { style: { borderTop: "1px solid var(--border)", padding: "8px 0", marginBottom: 8 } },
              h("p", { style: { ...smallStyle, marginBottom: 6 } }, "发送给 AI 的字段（勾选）："),
              h("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px 12px" } },
                FIELD_LABELS.map(([fld, label]) =>
                  h("label", { key: fld, style: { display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, color: "var(--text)", cursor: "pointer" } },
                    h("input", { type: "checkbox", checked: el.include[fld] !== false, onChange: () => toggle(fld) }), label))),
            ),
        h("p", { style: { ...smallStyle } }, "📂 后台打开经 MCP 桥 open_file（IDE 由 AITI_OPEN_CMD 环境变量指定，无则用系统默认编辑程序）；🖥 前端打开在 pi-web 文件标签页在线查看。文件经存在性校验，存在才显示打开按钮；查询通道：AI 窗直连扩展 file-stat（bridge 通道）/ 桥 file_stat 工具（ai 通道）。"),
      ),
    );
  }

  // 输入框上方候选区（chatInputTop slot）：显示已选元素 [元素N]/[回答N]/[错误N] + 清空
  function ChatInputTop() {
    const picked = usePicked();
    if (!picked.length) return null;
    return h("div", {
      // width:100% → 在输入行（flexWrap:wrap）里独占一行，不挤压 textarea
      style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", width: "100%", padding: "4px 8px", fontSize: 11, background: "rgba(79,70,229,0.06)", borderRadius: 8, marginBottom: 4 },
    },
      picked.map((el, i) =>
        h("span", { key: i, style: { display: "inline-flex", alignItems: "center", gap: 2, background: el.kind === "error" ? "#fee2e2" : "#eef2ff", border: "1px solid " + (el.kind === "error" ? "#fecaca" : "#c7d2fe"), borderRadius: 6, padding: "1px 2px 1px 6px", color: el.kind === "error" ? "#b91c1c" : "#4338ca", whiteSpace: "nowrap" } },
          // 占位符 [元素N]/[回答N]/[错误N] 独立点击区：仅补输入框（不弹详情）——点描述区才弹详情
          h("span", {
            className: "aiti-picked-tag",
            onClick: (e) => { e.stopPropagation(); ensurePlaceholder(el); },
            title: "点击：仅输入框补占位符（不弹详情）",
            style: { padding: "0 6px 0 1px", borderRight: "1px dashed " + (el.kind === "error" ? "#fecaca" : "#c7d2fe"), fontWeight: 600, cursor: "pointer", flexShrink: 0 },
          }, el.tag),
          // 描述区：补占位符（若被删）+ 查看详情/筛选/打开文件（原行为）
          h("span", {
            onClick: (e) => { e.stopPropagation(); ensurePlaceholder(el); setDetail(i); },
            title: "点击：输入框补占位符（若被删）+ 查看详情/筛选/打开文件",
            style: { padding: "0 4px", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220, flexShrink: 1 },
          }, briefText(el)),
          h("button", {
            // 逐条清除：记录指纹（宿主延迟重发不"复活"）+ 输入框同步摘掉该条占位符（编号重排对齐）
            onClick: (e) => { e.stopPropagation(); removeOneCandidate(el); },
            style: { background: "none", border: "none", cursor: "pointer", color: "inherit", opacity: 0.75, padding: "0 2px", fontSize: 11, lineHeight: 1, flexShrink: 0 },
            title: "清除该候选（同步删输入框里的 " + el.tag + "）",
          }, "✕"))),
      h("button", {
        onClick: () => {
          // 清除候选：host-protocol 记录指纹（宿主延迟重发不"复活"）+ 输入框同步摘掉占位符。
          // 注意：removeCandidate 逐个清空时 pickedElements 被 onPicked 同步替换，且剩余候选
          // 会被 deriveTags 原地重新编号——必须在清除前快照旧占位符值（值拷贝），否则
          // 摘除用的 tag 已变/列表已空（此前 bug：stripPlaceholders(pickedElements) 收到空数组）。
          const tags = pickedElements.map((el) => el.tag);
          pickedElements.forEach((el) => { if (hp) hp.removeCandidate(el); });
          stripTagsFromInput(tags);
          setPicked([]);
        },
        style: { ...btnStyle, padding: "1px 8px", marginLeft: "auto", color: "#ef4444" },
      }, "清空"),
    );
  }

  // 发送钩子：[元素N]/[回答N]/[错误N] → 真实候选内容 + 收集元素（agent 经桥操作时知道元素）；错误候选只替换文本不进 elements。
  // 来源标注 [发自: pageId · url]：调试会话中从被调试页面（inject）发出的【每条】消息统一携带——追加在消息末尾（独立一行），
  // 避免占头部干扰用户正文/首句阅读；agent 定位 pageId 不受位置影响（按标签 [发自: 解析）。
  // 当前界面语言（pi-web 存 localStorage pi-locale——权威；为空才 fallback <html lang>；再 fallback 中文）
  const uiIsEn = () => {
    try {
      const stored = localStorage.getItem("pi-locale");
      if (stored && stored.trim()) return String(stored).toLowerCase().startsWith("en");
      const l = (document.documentElement && document.documentElement.lang) || "";
      return l.toLowerCase().startsWith("en");
    } catch { return false; }
  };
  // 来源标注说明（随界面语言中/英）；标签 [发自: 固定——协议标识，工具描述/跨语言一致，AI 识别稳定
  // 注：pi-web 场景工具经 server.agent 扩展点以 aiti_* 内部命令注入（方案 M），非 MCP——提示指向 aiti-* 工具
  const SRC_NOTE = () => (uiIsEn() ? "aiti-* tools: use it as the pageId param" : "aiti-*：pageId 参数用它");
  // URL 裁剪已入 host-protocol 公共库（hp.clipUrl）——来源标注 / 元素描述共用一份

  // 普通发送（Enter）/ steer 插队 / followup 排队都经 preSend（pi-web applyChatHooks 统一入口），
  // agent 据此知道消息来自哪个页面，aiti_* 工具（aiti_page_exec 等）的 pageId 参数才能定位。
  // 仅未嵌入调试页（无 debugTarget.pageId，如独立打开的 AI 窗）时不加前缀。
  ctx.registerChatHook({
    preSend: (text) => {
      // 来源页 pageId：boot/页面列表优先，其次元素自带（宿主 enrichElPayload 补全）
      const pid = debugTarget.pageId || (pickedElements.find(e => e.pageId) || {}).pageId || null;
      const pageUrl = debugTarget.targetUrl || (pickedElements.find(e => e.frame && e.frame.url) || {}).frame?.url || null;
      // 统一来源标注：追加到【消息末尾】（独立一行，与正文分隔）——pid 为空时原样返回
      // 幂等：文本里已有的 [发自: ...]（历史粘贴/多 hook 实例重复注册/Fast Refresh 重复 import 等）一律摘掉，
      // 保证每条消息末尾只有一条来源标注（多 hook 链式执行时后一个会清掉前一个，不重复叠加）。
      const withSource = (t) => {
        if (!pid) return t;
        const tag = "[发自: " + pid + (pageUrl ? " · " + clipUrlText(pageUrl) : "") + "（" + SRC_NOTE() + "）]";
        const cleaned = String(t || "").replace(/\[发自:[^\]]*\]\s*/g, "").replace(/\s+$/, "");
        return (cleaned ? cleaned + "\n" : "") + tag;
      };
      // 可见性：最终发送文本（转换后 + 前缀）打控制台 + AITI 面板日志，便于验证/排查
      const logSent = (t) => {
        try { console.log("[aiti] 发送 →\n" + t); } catch (e) {}
        try { setBridgeLog("✉️ 发送: " + String(t).replace(/\s+/g, " ").slice(0, 140)); } catch (e) {}
      };
      // 无候选：纯文本消息（发送/steer/followup）同样带来源标注——之前仅候选引用时才加，同页消息有的带 pageId 有的不带
      // 孤儿占位符兑底：候选已被清除/失效或跨窗口编号过期时，文本里残留的 [元素N]/[回答N]/[错误N]/[选择N]
      // 匹配不到任何候选——裸发给 AI 无意义（实测 [错误1] 原样发出四连），替换为失效提示。
      const stripOrphanTags = (t) => String(t || "").replace(/\[(?:元素|回答|错误|选择)\d+\]/g, "[⚠ 候选已失效，占位符已移除（重新选元素/刷新页面重采）]");
      if (!pickedElements.length) {
        const t0 = stripOrphanTags(text);
        if (pid) { const t = withSource(t0); logSent(t); return { text: t }; }
        return t0 === text ? null : { text: t0 };
      }
      // 旧版占位符 [选择N]（改名 [元素N]/[回答N] 前的标签，如升级前草稿残留）：现候选已重新编号，
      // 旧标签无法映射到具体候选——直接摘除，避免作为普通文本发给 AI（AI 无从知道指哪个元素）。
      text = String(text || "").replace(/\[选择\d+\]/g, "");
      let finalText = text;
      const elements = [];
      // 替换占位符：若标签后还有用户输入，用换行与描述块分隔——避免元数据末行
      // （url/样式等）与用户原文直接粘连（如 `url: ...f50e1停留在这个状态很久`）。
      const replaceTag = (text2, tag, desc) => {
        const i = text2.indexOf(tag);
        if (i < 0) return text2;
        const rest = text2.slice(i + tag.length);
        return text2.slice(0, i) + desc + (rest.trim() ? "\n" + rest : rest);
      };
      pickedElements.forEach((el) => {
        const tag = el.tag;
        if (!tag || !finalText.includes(tag)) return;
        finalText = replaceTag(finalText, tag, describeText(el, pid));
        if (el.kind !== "error") elements.push(Object.assign({}, filterPayloadText(el), pid ? { pageId: pid } : {}));
      });
      // 替换过任何占位符才算引用（错误候选只替换文本不进 elements——无元素时也要发送）
      const usedAny = elements.length > 0 || pickedElements.some((el) => el.tag && text.includes(el.tag));
      if (usedAny) {
        // 从 inject（被调试页面）发出的消息统一带来源标注（pageId + url）——agent 经 aiti_* 工具（pageId 参数）操作该页面需要
        finalText = stripOrphanTags(withSource(finalText));
        logSent(finalText);
        // 发送即消费：仅错误候选记录 dismissed（防宿主延迟重发"复活"已发送的错误）；
        // 元素/回答不 dismissed——用户后续主动重选同元素不应被拦；同步摘输入框占位符。
        // 注意：removeCandidate 循环会同步更新 pickedElements（onPicked）并重编号剩余候选——
        // 摘除必须用发送前的 tag 值快照（与清空按钮同款 bug 修复）。
        const sentTags = pickedElements.map((el) => el.tag);
        pickedElements.forEach((el) => { try { if (hp && el && el.kind === 'error') hp.removeCandidate(el); } catch (e) {} });
        stripTagsFromInput(sentTags);
        setPicked([]); // 替换过的候选清除（含 localStorage）
        return elements.length ? { text: finalText, elements } : { text: finalText };
      }
      // 有候选但本条未引用（如纯 steer/followup）：也带来源标注；未匹配到候选的孤儿占位符同样兑底（防裸发），
      // 有效占位符（本次未替换但候选存在——实际不会走到这，usedAny=false 意味着文本里没有任何候选 tag）保留给用户看
      if (!pid) { const t0 = stripOrphanTags(text); return t0 === text ? null : { text: t0 }; }
      const t2 = stripOrphanTags(withSource(text));
      logSent(t2);
      return { text: t2 };
    },
  });

  // 元信息上报（title/favicon/URL + 变化轮询 + dbg_ai_get_url 应答）全部在
  // host-protocol.js 公共库（create 自动启动）——适配端不再各自维护，防漂移

  // ---------- 接收宿主 boot + 自动连桥（放工具栏组件内——hook 需组件上下文） ----------
  function AitiToolbarButton() {
    // 页面就绪自动连桥（pi-web 页面即 AI 窗时：零配置）；title/favicon/URL 元信息上报由
    // host-protocol.js 公共库 create 自动启动（初始一次 + 轮询变化），本组件不再重复上报。
    useEffect(() => {
      connectBridge();
      // 就绪握手：host-protocol 公共库统一发（ready + pull_boot + pull_errors）；心跳定时 ready 保持宿主 adopt
      if (hp) hp.sendReady();
      const hb = setInterval(() => postToHost("dbg_ai_ready", { hb: 1 }), 5000);
      // 宿主页代注册自愈：未注册（无身份）时周期重试（指数退避 5s→30s，
      // 避免长期无桥环境下的固定 5s 轮询——实测 15×/38s）。
      let regDelay = 5000;
      let regTimer = null;
      // 注册自愈：直到拿到可注册身份（host boot 或 URL 身份任一，见 hp.hostIdentity()）
      // 才补发一次注册并停止；此后靠桥 onReady/重连事件维持，不再轮询。
      // 注意：旧判断只看 host boot（debugTarget.pageId），漏了 URL 身份注册路径——
      // 无 boot 的嵌入 AI 窗（pi-web 自带 aiti-client）会 30s 退避轮询永不停（实测 120s+）。
      // 同时不再每轮拉 sessions——列表改由会话面板打开时加载（AitiDialog useEffect [open]）。
      const regTick = () => {
        const ident = hp && hp.hostIdentity ? hp.hostIdentity() : null;
        if (ident) { refreshSessions(); return; } // 有身份：补发注册后停（onReady 维持）
        regDelay = Math.min(30000, regDelay * 2);
        regTimer = setTimeout(regTick, regDelay);
      };
      regTimer = setTimeout(regTick, regDelay);
      return () => { clearInterval(hb); if (regTimer) clearTimeout(regTimer); };
    }, []);

    return h("button", {
      onClick: () => setDialogOpen(true),
      style: topbarBtnStyle,
      onMouseEnter: (e) => { e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { e.currentTarget.style.color = "var(--text-muted)"; },
      title: "AITI mcp-bridge：连桥 / 调试目标 / 执行 / 注入",
    },
      // lucide bug：调试器——与系统内建线条图标同风格
      h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { key: "p1", d: "m8 2 1.88 1.88" }),
        h("path", { key: "p2", d: "M14.12 3.88 16 2" }),
        h("path", { key: "p3", d: "M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" }),
        h("path", { key: "p4", d: "M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" }),
        h("path", { key: "p5", d: "M12 20v-9" }),
        h("path", { key: "p6", d: "M6.53 9C4.6 8.8 3 7.1 3 5" }),
        h("path", { key: "p7", d: "M6 13H2" }),
        h("path", { key: "p8", d: "M3 21c0-2.1 1.7-3.9 3.8-4" }),
        h("path", { key: "p9", d: "M20.97 5c0 2.1-1.6 3.8-3.5 4" }),
        h("path", { key: "p10", d: "M22 13h-4" }),
        h("path", { key: "p11", d: "M17.2 17c2.1.1 3.8 1.9 3.8 4" })));
  }

  ctx.registerItems("toolbar", [
    { id: "aiti-inspect", render: InspectButton, meta: { label: "点选元素" } },
    { id: "aiti-open", render: AitiToolbarButton, meta: { label: "AITI 调试器" } },
  ]);
  ctx.registerItems("dialogs", [
    { id: "aiti-dialog", render: AitiDialog },
    { id: "aiti-detail", render: DetailDialog },
  ]);
  // dock v3（P1 批）：右栏「调试」tab——raw itemId "main"（宿主拼 extId:itemId = DIALOG_KEY）
  ctx.registerItems("rightFileDock", [{ id: "main", render: AitiDockFace, meta: { title: "调试" } }]);
  ctx.registerItems("chatInputTop", [{ id: "aiti-picked", render: ChatInputTop }]);

  // ---------- 按需注入 launcher（首次点击 🎯 才装，初始化零注入） ----------
  // pi-web 页面自身既是 AI 窗又是潜在宿主：🎯「点选页面元素」走 host-protocol postToHost →
  // aiHost() 的 self 兜底判定（#__dbg_launcher.__dbgLauncher）——本页没有 launcher 时消息
  // 静默丢弃。不在初始化时注入（dev 等已有其他来源注入的页面不被打扰/抢位），而是：
  //   首次点击 🎯 → 检查 launcher 是否已装（任何来源，含 aiti-inject 跨实例注入的）→
  //   已装直接用；没有才注入本实例的 launcher（同源 apiUrl + 内容哈希 ?v=），装好自动进入点选。
  // launcher standalone 自带 __dbgLauncherInstalled 单例锁，重复 script 无副作用。
  let _launcherReadyP = null;
  function ensureLauncher() {
    const ready = () => !!(document.getElementById('__dbg_launcher') && document.getElementById('__dbg_launcher').__dbgLauncher);
    if (ready()) return Promise.resolve(true);
    if (_launcherReadyP) return _launcherReadyP;
    _launcherReadyP = new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; if (!v) _launcherReadyP = null; resolve(v); } }; // 失败清 memo：下次点击可重试
      try {
        if (window.__dbgLauncherInstalled) { // 已装，等根就绪（boot 可能延迟到 DOMContentLoaded）
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => finish(ready()), { once: true });
          else setTimeout(() => finish(ready()), 50);
          return;
        }
        const launcherUrl = apiUrl("/api/extensions/aiti-devtools/aiti-launcher.js");
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 5000);
        fetch(apiUrl("/api/extensions/aiti-devtools/launcher-version"), { cache: "no-store", signal: ac.signal })
          .then((r) => r.json())
          .then((j) => (j && j.hash ? "?v=" + encodeURIComponent(String(j.hash)) : ""))
          .catch(() => "")
          .then((v) => {
            clearTimeout(timer);
            if (ready() || window.__dbgLauncherInstalled) return finish(ready());
            const s = document.createElement("script");
            s.src = launcherUrl + v;
            s.dataset.bridgeUrl = apiUrl("/api/extensions/aiti-devtools/mcp");
            s.dataset.aitiSelfInject = "1"; // 来源标记（排障用）
            s.onload = () => setTimeout(() => finish(ready()), 50);
            s.onerror = () => finish(false);
            document.head.appendChild(s);
          });
      } catch (e) { finish(false); }
    });
    return _launcherReadyP;
  }

  // 发起宿主协议层加载（host-protocol.js）+ 注册 UI 适配（register 已执行完，describeText 等均已定义）。
  // 元信息上报（title/favicon/URL + 变化轮询）由 host-protocol create 自动启动，此处无需再调。
  loadHostProtocolScript();
  registerAdapters();
}
