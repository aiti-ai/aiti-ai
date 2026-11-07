/**
 * aiti-prompts client —— JSX 版（自手写 h() 版迁移，功能一比一）。
 *
 * UI：
 *   - toolbar：📌 Prompt 按钮 → 打开主面板（唯一入口：搜索/选择/发送/会话提取/手工添加）
 *   - dialogs：主面板 + 保存弹层（收藏输入/手工添加/编辑共用）+ 会话导入弹窗
 *   - userMessageActions：用户消息 hover 操作区 →「📌 收藏」（输入侧收藏，本地留底 + 复制）
 *   - 发送：ctx.sendChatMessage(text, mode) —— 与用户输入同链路（preSend 钩子生效，不旁路）
 *
 * 架构：模块级 state 仓库 + listener 订阅（useStateOf 桥接 React 重渲染）。
 */
import { useState, useEffect, useRef } from "react";
import { apiUrl, t } from "./host-shim";

declare global {
  interface Window {
    __PrmSend?: (text: string, mode: "followUp" | "steer" | "send") => void;
  }
}

const api = (path: string) => apiUrl("/api/extensions/aiti-prompts" + path);

let appCtx: Record<string, any> | null = null; // DI 方案 P2：register 捕获（extSvc 消费用）
export function setAppCtx(c: Record<string, any>): void { appCtx = c; }

// ---------- 模块级状态（跨组件共享；listener 模式） ----------
const state: Record<string, any> = {
  panelOpen: false,
  tab: "library",            // library | extract
  save: null,                // 保存弹层 { mode, id?, name, text, groupId, tags, suggest }
  sessionPicker: false,      // 「从其他会话导入」弹窗
  importOpen: false,         // 「导入 JSON」弹窗
  q: "",
  prompts: [],
  groups: [],
  currentMsgs: null,         // 会话提取：当前视图 { sessionId, name, running, messages }
  selectedEntries: new Set(),
  collapsed: {},             // 分组折叠
  editingGroup: null,        // 分组编辑
  err: null,
  toast: null,
  refreshTick: 0,
};
const stateListeners = new Set<() => void>();
function notify() { for (const l of stateListeners) l(); }
// dock v3（P2 批）：面板显隐收口展示状态机——patch.panelOpen 路由到 openFloat/closePanel，
// state.panelOpen 不再是渲染开关（渲染门控走 useGate）；其余字段照旧合并。
import { useGate, usePresent, DockBody, openFloat, closePanel, seedDockDefault, isSidebarDockState, sidebarZoneOf } from "../../../_shared/ext-float-dock";
// dock 头工具条 v3：face 声明按钮（新建/刷新/分组），内容实现命令（模块级 setState）+ 状态上报
import { useDockCommands, useDockHeaderState, useDockHeaderStateOf, requestDockCommand, writeBlockCollapsed } from "../../../_shared/ext-float-dock";
import type { DockHeaderAction } from "../../../_shared/ext-float-dock";
import { uiConfirm } from "../../../_shared/ui-dialogs";
export const PANEL_KEY = "aiti-prompts:panel";
function setState(patch: Record<string, any>) {
  if ("panelOpen" in patch) {
    const { panelOpen, ...rest } = patch;
    if (panelOpen) openFloat(PANEL_KEY); else closePanel(PANEL_KEY);
    patch = rest;
    if (Object.keys(patch).length === 0) return;
  }
  Object.assign(state, patch); notify();
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string) {
  if (toastTimer) clearTimeout(toastTimer);
  setState({ toast: msg, err: null });
  toastTimer = setTimeout(() => { if (state.toast) setState({ toast: null }); }, 2500);
}
function showErr(msg: string) {
  if (toastTimer) clearTimeout(toastTimer);
  setState({ err: String(msg), toast: null });
}

// 发送出口（register 时绑定 ctx.sendChatMessage）
let sendChat: ((text: string, mode: any) => void) | null = null;
export function __bindSendChat(fn: (text: string, mode: any) => void) {
  sendChat = (text, mode) => {
    try { fn(text, mode); } catch (e: any) { showErr("发送通道不可用：" + String((e && e.message) || e)); }
  };
}

// 小屏判断（模块级缓存；模块首次加载即监听）
let smallScreen = false;
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const mq = window.matchMedia("(max-width: 560px)");
  smallScreen = mq.matches;
  mq.addEventListener("change", () => { smallScreen = mq.matches; notify(); });
}

const btnStyle: any = {
  border: "1px solid var(--border)", background: "var(--bg-elevated)",
  borderRadius: 6, padding: "5px 12px", cursor: "pointer",
  fontSize: 12, color: "var(--text)",
};
const rowStyle: any = { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 };
const inputStyle: any = {
  flex: 1, border: "1px solid var(--border)", borderRadius: 6,
  padding: "4px 8px", fontSize: 12, background: "var(--bg-elevated, var(--bg))", color: "var(--text)",
};
const smallStyle: any = { fontSize: 11, color: "var(--text-muted)", margin: 0, wordBreak: "break-all", lineHeight: 1.5 };
const topbarBtnStyle: any = {
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 36, height: 36, padding: 0,
  background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
  color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
  fontSize: 16, lineHeight: 1, transition: "color 0.12s",
};
const miniBtn: any = { ...btnStyle, padding: "1px 7px", fontSize: 11 };
const miniBtnDanger: any = { ...miniBtn, color: "var(--danger, #ef4444)" };
const SOURCE_LABEL: Record<string, string> = { manual: "手动", input: "收藏输入", session: "会话" };

// lucide 图标（与系统内建线条图标同风格）
const Ic = ({ size, paths }: { size: number; paths: string[] }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);
const ICONS = {
  bookmark: ["m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"],
  pencil: ["M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z", "m15 5 4 4"],
  plus: ["M5 12h14", "M12 5v14"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  check: ["M20 6 9 17l-5-5"],
  send: ["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"],
  copy: ["M8 8H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2", "M14 2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6l-4-4z", "M14 2v6h6"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  upload: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M17 8l-5-5-5 5", "M12 3v12"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 6v6l4 2"],
  refreshCw: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M3 21v-5h5"],
  listOrdered: ["M10 6h11", "M10 12h11", "M10 18h11", "M4 6h1v4", "M4 10h2", "M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"],
};

// 分组下拉/行尾「＋」hover 样式（模块首次加载即注入，与手写版同名类）
if (typeof document !== "undefined" && !document.getElementById("aiti-pp-style")) {
  const styleTag = document.createElement("style");
  styleTag.id = "aiti-pp-style";
  styleTag.textContent = ".aiti-pp-grprow{transition:background .12s}.aiti-pp-grprow:hover{background:var(--bg-hover)}.aiti-pp-treerow{transition:background .12s}.aiti-pp-treerow:hover{background:var(--bg-hover)}.aiti-pp-grprow .aiti-pp-plus{opacity:0;transition:opacity .12s,color .12s;color:var(--text-dim)}.aiti-pp-grprow:hover .aiti-pp-plus{opacity:1;color:#4f46e5}@media (hover:none){.aiti-pp-grprow .aiti-pp-plus{opacity:.55}}.aiti-pp-prow{cursor:pointer;transition:background .12s}.aiti-pp-prow:hover{background:rgba(79,70,229,0.07)}.aiti-pp-prow:hover .aiti-pp-prow-name{color:var(--accent)}";
  document.head.appendChild(styleTag);
}

// ---------- 订阅模块状态 ----------
function useStateOf(key: string) {
  const [v, setV] = useState(state[key]);
  useEffect(() => { const l = () => setV(state[key]); stateListeners.add(l); return () => { stateListeners.delete(l); }; }, []);
  return v;
}

// ---------- 收藏库数据 ----------
const refresh = () => {
  fetch(api("/prompts")).then((r) => r.json()).then((d) => { if (d && d.ok) setState({ prompts: d.prompts || [], groups: d.groups || [] }); }).catch(() => {});
};

// ---------- 发送（客户端共同通道） ----------
const sendPrompt = async (text: string, mode: any, id?: string) => {
  if (!text || !text.trim()) return;
  sendChat && sendChat(text, mode);
  showToast(mode === "steer" ? "已发送（steer 插队）" : "已发送（followUp 排队）");
  if (id) fetch(api("/prompts/" + id + "/touch"), { method: "POST" }).catch(() => {});
  refresh();
};
// 定时执行：委托 ⏰调度 页预填新建（aiti-ai-schedule 未加载则直接创建待确认计划）
const schedulePrompt = (p: any) => {
  const prefill = { name: p.name || briefOf(p.text), prompt: String(p.text || "") };
  try {
    // DI 方案 P2：services 通道优先，旧全局兜底
    const open = ctx?.getExtService?.("aiti-ai-schedule.open") || (window as any).__aitiAiScheduleOpen;
    if (typeof open === "function") { open(prefill); return; }
  } catch {}
  fetch(apiUrl("/api/extensions/aiti-ai-schedule/plans"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...prefill, schedule: "0 9 * * *", mode: "auto", enabled: false, autoApprove: false }),
  }).then((r) => r.json()).then((d: any) => {
    if (d?.ok) showToast("已创建待确认计划「" + prefill.name + "」（默认每天9点，到 ⏰调度 页修改并批准）");
    else showErr("创建失败：" + (d?.error || "未知错误"));
  }).catch((e) => showErr("创建失败：" + String(e)));
};

const copyPrompt = (text: string) => {
  try { navigator.clipboard.writeText(text); showToast("已复制"); } catch { showErr("复制失败"); }
};

// ---------- 加载会话消息（当前会话 / 导入弹窗共用） ----------
const loadSessionMessages = async (sid: string, name?: string) => {
  const d = await fetch(api("/sessions/" + sid + "/messages")).then((r) => r.json()).catch(() => null);
  if (d && d.ok) {
    setState({ currentMsgs: { sessionId: sid, name: name || "会话", messages: d.messages || [] }, selectedEntries: new Set(), sessionPicker: false });
    return true;
  }
  showErr((d && d.error) || "读取会话失败");
  return false;
};

// ---------- 消息收藏扩展点（user 消息 hover 操作区） ----------
const briefOf = (src: string) => {
  const firstLine = String(src || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) || "";
  return firstLine.length > 30 ? firstLine.slice(0, 30) + "…" : firstLine;
};
function SaveMessageAction({ text }: { text?: string }) {
  const t = text && typeof text === "string" ? text : "";
  if (!t || !t.trim() || t.length > 4000) return null;
  const brief = briefOf(t);
  return (
    <button
      onClick={() => {
        // 收藏的同时执行一个复制操作 + 写 localStorage（本地留底：剪贴板/服务器双保险）
        try {
          if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(t).catch(() => {});
          } else {
            const ta = document.createElement("textarea");
            ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select();
            try { document.execCommand("copy"); } catch {}
            document.body.removeChild(ta);
          }
        } catch {}
        try { localStorage.setItem("aiti-prompts:last-message-fav", JSON.stringify({ ts: Date.now(), text: t })); } catch {}
        setState({ save: { mode: "message", name: brief, text: t, groupId: null, tags: "" } });
      }}
      title="把这条用户输入收藏到 prompt 库（标题取第一行，内容完整）"
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "3px 8px", height: 22,
        background: "none", border: "none", borderRadius: 5,
        color: "var(--text-dim)", cursor: "pointer",
        fontSize: 11, fontWeight: 400, whiteSpace: "nowrap",
        transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; }}
    >
      <Ic size={12} paths={ICONS.bookmark} />收藏
    </button>
  );
}

// ---------- 工具栏按钮 ----------
function ToolbarButton() {
  return (
    <button
      onClick={() => setState({ panelOpen: true, tab: "library" })}
      style={topbarBtnStyle}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      title="aiti-prompts：收藏库 / 会话提取 / 一键插队排队"
    >
      {/* lucide bookmark */}
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  );
}

// ---------- 保存弹层（手工添加 / 编辑 共用） ----------
function SaveDialog() {
  const save = useStateOf("save");
  const groups = useStateOf("groups");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [groupId, setGroupId] = useState("");
  const [tags, setTags] = useState("");
  const [suggest, setSuggest] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [quickNew, setQuickNew] = useState(false);
  const [quickParent, setQuickParent] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);
  const [grpOpen, setGrpOpen] = useState(false);
  const [grpPos, setGrpPos] = useState<any>(null);
  const grpBtnRef = useRef<any>(null);
  useEffect(() => {
    if (!save) return;
    refresh();   // 主动加载分组/收藏（消息上直接收藏时主面板未加载过）
    setName(save.name || "");
    setText(save.text || "");
    setGroupId(save.groupId || "");
    setTags(save.tags || "");
    setSuggest(save.suggest !== false);
    setErr(null); setSaved(false); setQuickNew(false); setQuickParent(null); setGrpOpen(false);
  }, [save]);
  if (!save) return null;
  const groupPathOf = (id?: string) => {
    if (!id) return "（未分组）";
    const parts: string[] = []; let cur = groups.find((g: any) => g.id === id); let guard = 0;
    while (cur && guard++ < 20) { parts.unshift(cur.name); cur = cur.parentId ? groups.find((g: any) => g.id === cur.parentId) : undefined; }
    return parts.join(" / ") || "未分组";
  };
  const doSave = async () => {
    const body = { name: name.trim() || undefined, text, groupId: groupId || null, tags: tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean), suggest: suggest !== false };
    if (!text.trim()) { setErr("内容不能为空"); return; }
    let r: any;
    if (save.mode === "edit" && save.id) {
      r = await fetch(api("/prompts/" + save.id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }));
    } else {
      r = await fetch(api("/prompts"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, source: save.mode === "input" ? "input" : save.mode === "message" ? "session" : "manual" }) }).then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }));
    }
    if (r.ok) { setSaved(true); setTimeout(() => setState({ save: null }), 600); refresh(); }
    else setErr(r.error || "保存失败");
  };
  const openQuickNew = (parentId: string | null) => { setGrpOpen(false); setErr(null); setNewGroupName(""); setQuickParent(parentId); setQuickNew(true); };
  const openGrp = () => {
    if (!grpOpen && grpBtnRef.current) {
      const r = grpBtnRef.current.getBoundingClientRect();
      const vh = window.innerHeight;
      const below = vh - r.bottom - 8;
      const above = r.top - 8;
      const up = above > below;
      setGrpPos({ up, top: up ? undefined : r.bottom + 4, bottom: up ? vh - r.top + 4 : undefined, left: r.left, width: r.width, maxH: Math.max(120, Math.min(230, (up ? above : below) - 4)) });
    }
    setGrpOpen(!grpOpen);
  };
  const doQuickNew = async () => {
    if (!newGroupName.trim()) { setErr("请输入分组名"); return; }
    if (groupSaving) return;
    setGroupSaving(true);
    const r = await fetch(api("/groups"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newGroupName.trim(), parentId: quickParent || null }) }).then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }));
    setGroupSaving(false);
    if (r && r.ok) {
      refresh();
      setGroupId(r.group.id);
      setQuickNew(false); setQuickParent(null); setNewGroupName("");
    } else { setErr((r && r.error) || "新建分组失败"); }
  };
  const fieldLabel: any = { display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 4, fontWeight: 500 };
  const titleTxt = save.mode === "edit"
    ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={13} paths={ICONS.pencil} />编辑 prompt</span>
    : (save.mode === "input" || save.mode === "message")
      ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={13} paths={ICONS.bookmark} />收藏 prompt</span>
      : <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={13} paths={ICONS.plus} />新建 prompt</span>;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 335, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setState({ save: null })}>
      <div
        data-ext-float="1" data-ext-float-w="520" data-ext-float-autoh="1" data-ext-float-full="1"
        style={{ width: "min(520px, 94vw)", maxHeight: "80vh", overflow: "auto", padding: 16, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <b style={{ fontSize: 14 }}>{titleTxt}</b>
            {save.mode === "message" && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>来自会话消息 · 可编辑后保存</span>}
          </div>
          <button onClick={() => setState({ save: null })} style={{ ...btnStyle, padding: "2px 8px", display: "inline-flex" }} aria-label="关闭"><Ic size={12} paths={ICONS.x} /></button>
        </div>
        <label style={fieldLabel}>名称</label>
        <input style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 10 }} value={name} placeholder="留空 = 内容首行" onChange={(e) => setName(e.target.value)} />
        <label style={fieldLabel}>内容</label>
        <textarea style={{ ...inputStyle, width: "100%", boxSizing: "border-box", height: Math.min(260, Math.max(88, String(text).split("\n").length * 20 + 24)), minHeight: 88, maxHeight: 260, fontFamily: "var(--font-mono)", marginBottom: 10, resize: "vertical", overflow: "auto" }} value={text} placeholder="prompt 内容" onChange={(e) => setText(e.target.value)} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 200px", minWidth: 160, position: "relative" }}>
            <label style={fieldLabel}>分组</label>
            <button type="button" ref={grpBtnRef} onClick={openGrp} style={{ ...inputStyle, width: "100%", boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, textAlign: "left", cursor: "pointer" }} title="选择分组；行尾 ＋ 可新建（子）分组">
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{groupId ? (groups.find((g: any) => g.id === groupId) ? groupPathOf(groupId) : "（未分组）") : "（未分组）"}</span>
              <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>{grpOpen ? "▲" : "▼"}</span>
            </button>
            {grpOpen && <div style={{ position: "fixed", inset: 0, zIndex: 395 }} onClick={() => setGrpOpen(false)} />}
            {grpOpen && (
              <div style={{ position: "fixed", top: grpPos && grpPos.top != null ? grpPos.top : undefined, bottom: grpPos && grpPos.bottom != null ? grpPos.bottom : undefined, left: grpPos ? grpPos.left : 0, width: grpPos ? grpPos.width : 200, maxHeight: grpPos ? grpPos.maxH : 230, zIndex: 400, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.18)", overflow: "auto", padding: 4, fontFamily: "inherit" }}>
                <div className="aiti-pp-grprow" onClick={() => { setGroupId(""); setGrpOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12, background: !groupId ? "rgba(79,70,229,0.12)" : "transparent", color: "var(--text)", fontWeight: !groupId ? 600 : 400 }}>
                  <span style={{ flex: 1, minWidth: 0 }}>（未分组）</span>
                  <span className="aiti-pp-plus" onClick={(e) => { e.stopPropagation(); openQuickNew(null); }} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 5, flexShrink: 0, fontWeight: 600, fontSize: 13, cursor: "pointer", lineHeight: 1, marginLeft: 2 }} title="新建顶层分组"><Ic size={13} paths={ICONS.plus} /></span>
                </div>
                {groups.map((g: any) => (
                  <div key={g.id} className="aiti-pp-grprow" onClick={() => { setGroupId(g.id); setGrpOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12, background: groupId === g.id ? "rgba(79,70,229,0.12)" : "transparent", color: "var(--text)", fontWeight: groupId === g.id ? 600 : 400 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{groupPathOf(g.id)}</span>
                    <span className="aiti-pp-plus" onClick={(e) => { e.stopPropagation(); openQuickNew(g.id); }} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 5, flexShrink: 0, fontWeight: 600, fontSize: 13, cursor: "pointer", lineHeight: 1, marginLeft: 2 }} title="在此分组下新建子分组"><Ic size={13} paths={ICONS.plus} /></span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ flex: "1 1 140px", minWidth: 120 }}>
            <label style={fieldLabel}>标签</label>
            <input style={{ ...inputStyle, width: "100%" }} value={tags} placeholder="逗号分隔" onChange={(e) => setTags(e.target.value)} />
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, cursor: "pointer" }} onClick={() => setSuggest(!suggest)} title="作为 aiti-ai-input 智能提示（输入联想/补全）的来源；关掉后输入时不再提示此 prompt">
          <span style={{ position: "relative", width: 32, height: 18, borderRadius: 999, background: suggest ? "#4f46e5" : "var(--border)", flexShrink: 0, transition: "background .15s" }}>
            <span style={{ position: "absolute", top: 2, left: suggest ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.25)", transition: "left .15s" }} />
          </span>
          <span style={{ fontSize: 12, color: "var(--text)" }}>{suggest ? "参与智能提示（aiti-ai-input 联想/补全）" : "不参与智能提示"}</span>
        </div>
        {err && <p style={{ ...smallStyle, color: "var(--danger, #ef4444)", margin: "8px 0 0" }}>{String(err)}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button onClick={doSave} style={{ ...btnStyle, background: "#4f46e5", color: "#fff", border: "none", flex: 1, padding: "7px 12px", fontWeight: 500 }}>{saved ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={13} paths={ICONS.check} />已保存</span> : "保存"}</button>
          <button onClick={() => setState({ save: null })} style={{ ...btnStyle, padding: "7px 16px" }}>取消</button>
        </div>
        {quickNew && (
          <div style={{ position: "fixed", inset: 0, zIndex: 360, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setQuickNew(false)}>
            <div style={{ width: "min(320px, 90vw)", padding: 14, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit" }} onClick={(e) => e.stopPropagation()}>
              <b style={{ fontSize: 13, display: "block", marginBottom: 8 }}>{quickParent ? "＋ 新建子分组（在「" + groupPathOf(quickParent) + "」下）" : "＋ 新建分组"}</b>
              <input style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} value={newGroupName} placeholder="分组名（回车确认）" autoFocus onChange={(e) => setNewGroupName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doQuickNew(); }} />
              {err && <p style={{ ...smallStyle, color: "var(--danger, #ef4444)", margin: "6px 0 0" }}>{String(err)}</p>}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button onClick={doQuickNew} style={{ ...btnStyle, background: "#4f46e5", color: "#fff", border: "none", flex: 1 }} disabled={groupSaving}>{groupSaving ? "…" : "确认"}</button>
                <button onClick={() => setQuickNew(false)} style={{ ...btnStyle }}>取消</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- 「从其他会话导入」弹窗 ----------
function SessionPicker() {
  const [sq, setSq] = useState("");
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    fetch(api("/sessions")).then((r) => r.json()).then((d) => { if (d && d.ok) setSessions(d.sessions || []); }).catch(() => {}).finally(() => setLoading(false));
  }, []);
  const filtered = sessions.filter((s) => !sq || (s.name || s.firstMessage || "").toLowerCase().includes(sq.toLowerCase()));
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 340, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setState({ sessionPicker: false })}>
      <div style={{ width: "min(520px, 94vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", padding: 14, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <b style={{ fontSize: 13 }}>从其他会话导入</b>
          <button onClick={() => setState({ sessionPicker: false })} style={{ ...btnStyle, padding: "2px 8px", display: "inline-flex" }} aria-label="关闭"><Ic size={12} paths={ICONS.x} /></button>
        </div>
        <input style={{ ...inputStyle, marginBottom: 6 }} value={sq} placeholder="搜索会话（名称/首条消息）…" onChange={(e) => setSq(e.target.value)} />
        <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 2, minHeight: 120 }}>
          {loading ? <p style={smallStyle}>加载中…</p>
            : filtered.length === 0 ? <p style={smallStyle}>（无匹配会话）</p>
            : filtered.slice(0, 60).map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg-hover)", border: "1px solid var(--border)", cursor: "pointer" }} onClick={() => loadSessionMessages(s.id, s.name || s.firstMessage || s.id)} title="点击加载该会话的 user 消息">
                <span style={{ fontSize: 10, color: s.running ? "var(--ok, #4ade80)" : "var(--text-dim)" }}>{s.running ? "●" : "○"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name || s.firstMessage || s.id}</div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {(s.modified ? new Date(s.modified).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "") + " · " + s.messageCount + " 条" + (s.running ? " · 运行中" : "")}
                  </div>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// ---------- 「导入 JSON」弹窗（备份/迁移闭环） ----------
function ImportDialog() {
  const [json, setJson] = useState("");
  const [mode, setMode] = useState("merge");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => setState({ importOpen: false });
  const doImport = async () => {
    setErr(null);
    let data: any;
    try { data = JSON.parse(json); } catch { setErr("JSON 解析失败，请检查格式"); return; }
    if (!data || typeof data !== "object") { setErr("内容不是对象"); return; }
    if (!Array.isArray(data.groups) && !Array.isArray(data.prompts)) { setErr("缺少 groups/prompts 数组——请粘贴「📤 导出」的 JSON"); return; }
    if (mode === "replace" && !(await uiConfirm({ message: "替换模式将清空现有全部 prompt 与分组，确定？", danger: true }))) return;
    setBusy(true);
    const r = await fetch(api("/import"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: { groups: data.groups || [], prompts: data.prompts || [] }, mode }) }).then((x) => x.json()).catch(() => ({ ok: false, error: "网络错误" }));
    setBusy(false);
    if (r && r.ok) {
      showToast("导入完成：分组 +" + r.groups + " · prompt +" + r.prompts + (r.skippedPrompts ? "（跳过重复 " + r.skippedPrompts + "）" : ""));
      setJson("");
      refresh();
      close();
    } else { setErr((r && r.error) || "导入失败"); }
  };
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 340, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={close}>
      <div style={{ width: "min(520px, 94vw)", maxHeight: "80vh", display: "flex", flexDirection: "column", padding: 14, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <b style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.download} />导入 JSON</b>
          <button onClick={close} style={{ ...btnStyle, padding: "2px 8px", display: "inline-flex" }} aria-label="关闭"><Ic size={12} paths={ICONS.x} /></button>
        </div>
        <p style={{ ...smallStyle, marginBottom: 6 }}>粘贴「📤 导出」的 JSON（结构 {"{ groups, prompts }"}）；按 id 去重合并，重复项自动跳过。</p>
        <textarea style={{ ...inputStyle, minHeight: 160, fontFamily: "var(--font-mono)", marginBottom: 8 }} value={json} placeholder='{ "groups": [...], "prompts": [...] }' onChange={(e) => setJson(e.target.value)} />
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
          <label style={{ fontSize: 11, color: "var(--text-muted)", display: "inline-flex", alignItems: "center", gap: 4 }}><input type="radio" checked={mode === "merge"} onChange={() => setMode("merge")} />合并（去重追加）</label>
          <label style={{ fontSize: 11, color: "var(--danger, #ef4444)", display: "inline-flex", alignItems: "center", gap: 4 }}><input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} />替换（清空现有）</label>
        </div>
        {err && <p style={{ ...smallStyle, color: "var(--danger, #ef4444)", marginBottom: 6 }}>{String(err)}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={doImport} style={{ ...btnStyle, background: "#4f46e5", color: "#fff", border: "none", flex: 1 }} disabled={!json.trim() || busy}>{busy ? "导入中…" : "导入"}</button>
          <button onClick={close} style={btnStyle}>取消</button>
        </div>
      </div>
    </div>
  );
}

// ---------- 主面板 ----------
function PromptsPanel(props: Record<string, any>) {
  // dock v3：face 参数（dialogs=float 浮窗 / sidebarExplorerDock=left 左栏）——只有激活面渲染+轮询
  const st = usePresent(PANEL_KEY);
  const face = (props && (props as any).face) || "float";
  // 三面（本批 P3）：float=浮窗 / right=右栏 tab / left=左栏区块（sidebar 族任意落位）
  const open = face === "float" ? st === "floating"
    : face === "right" ? st === "docked:right-panel"
    : isSidebarDockState(st);
  const floating = face === "float";
  const tab = useStateOf("tab");
  const prompts = useStateOf("prompts");
  const groups = useStateOf("groups");
  const q = useStateOf("q");
  const currentMsgs = useStateOf("currentMsgs");
  const selectedEntries: Set<any> = useStateOf("selectedEntries");
  const collapsed = useStateOf("collapsed");
  const editingGroup = useStateOf("editingGroup");
  const err = useStateOf("err");
  const toast = useStateOf("toast");
  const refreshTick = useStateOf("refreshTick");
  const sessionPicker = useStateOf("sessionPicker");
  const importOpen = useStateOf("importOpen");
  const [extractGroup, setExtractGroup] = useState("");

  const currentSession = props && props.currentSession;

  // dock 头工具条 v3：按钮由 face（下方 DockBody）声明，命令/状态由本面板实现。
  // 模块级 setState 使命令在折叠保挂/重挂场景同样即时生效；新建类命令先展开区块。
  // 只有左栏区块面把按钮上提 dock 头（右栏 tab 无头行 → 内容保留自己的按钮）
  const isDock = face === "left";
  useDockCommands(isDock ? PANEL_KEY : undefined, isDock ? {
    new: () => {
      try { writeBlockCollapsed(PANEL_KEY, false); } catch { /* ignore */ }
      setState({ tab: "library", save: { mode: "manual", name: "", text: "", groupId: null, tags: "" } });
    },
    group: () => {
      try { writeBlockCollapsed(PANEL_KEY, false); } catch { /* ignore */ }
      setState({ tab: "library", editingGroup: { name: "", parentId: null } });
    },
    refresh: () => setState({ refreshTick: state.refreshTick + 1 }),
  } : null);
  useDockHeaderState(isDock ? PANEL_KEY : undefined, isDock ? { tab, count: prompts.length } : null);

  useEffect(() => {
    if (!open) return;
    refresh();
    const iv = setInterval(refresh, 10000);
    return () => clearInterval(iv);
  }, [open, refreshTick]);
  useEffect(() => {
    if (open && tab === "extract" && !state.currentMsgs) {
      if (currentSession && currentSession.id) {
        loadSessionMessages(currentSession.id, currentSession.name || "当前会话");
      }
    }
  }, [open, tab, currentSession && currentSession.id]);

  if (!open) return null;

  const doExtract = async () => {
    const entries = Array.from(state.selectedEntries);
    if (!state.currentMsgs || !entries.length) return;
    const d = await fetch(api("/extract"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: state.currentMsgs.sessionId, entryIds: entries, groupId: extractGroup || null }) }).then((r) => r.json()).catch(() => null);
    if (d && d.ok) {
      showToast("已收藏 " + d.added.length + " 条" + (d.skipped ? "（跳过 " + d.skipped + " 条重复/空）" : ""));
      setState({ selectedEntries: new Set(), currentMsgs: null, tab: "library" });
      refresh();
    } else { showErr((d && d.error) || "提取失败"); }
  };
  const saveGroupEditing = async () => {
    if (!editingGroup || !editingGroup.name.trim()) return;
    if (editingGroup.id) {
      await fetch(api("/groups/" + editingGroup.id), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: editingGroup.name, parentId: editingGroup.parentId }) }).catch(() => {});
    } else {
      await fetch(api("/groups"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: editingGroup.name, parentId: editingGroup.parentId }) }).catch(() => {});
    }
    setState({ editingGroup: null, refreshTick: state.refreshTick + 1 });
  };

  const childrenOf = (pid?: string | null) => groups.filter((g: any) => g.parentId === pid).sort((a: any, b: any) => a.name.localeCompare(b.name));
  const groupPathOf = (id?: string) => {
    if (!id) return "未分组";
    const parts: string[] = []; let cur = groups.find((g: any) => g.id === id); let guard = 0;
    while (cur && guard++ < 20) { parts.unshift(cur.name); cur = cur.parentId ? groups.find((g: any) => g.id === cur.parentId) : undefined; }
    return parts.join(" / ") || "未分组";
  };
  const filtered = prompts.filter((p: any) => !q || (p.name + " " + p.text + " " + (p.tags || []).join(" ") + " " + groupPathOf(p.groupId)).toLowerCase().includes(q.toLowerCase()));
  const commandsOf = (gid?: string) => filtered.filter((p: any) => p.groupId === gid);
  const ungrouped = filtered.filter((p: any) => !p.groupId);

  const renderPromptRow = (p: any, depth: number) => (
    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: smallScreen ? 4 : 8, padding: "5px 8px", borderRadius: 6, background: "var(--bg-hover)", border: "1px solid var(--border)", marginLeft: smallScreen ? Math.min(depth * 10, 40) : depth * 18, flexWrap: smallScreen ? "wrap" : undefined }}>
      <div className="aiti-pp-prow" style={{ flex: 1, minWidth: 0, borderRadius: 4 }} title="点击发送（⏳ 排队，等同「⏳ 排队」按钮）" onClick={() => sendPrompt(p.text, "followUp", p.id)}>
        <div className="aiti-pp-prow-name" style={{ fontSize: 12, fontWeight: 600 }}>{p.name + " "}</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(p.text).replace(/\s+/g, " ").slice(0, 70)}</div>
        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
          {(SOURCE_LABEL[p.source] || "") + (p.useCount ? " · ×" + p.useCount : "") + (p.tags && p.tags.length ? " · #" + p.tags.join(" #") : "")}
        </div>
      </div>
      <button onClick={() => sendPrompt(p.text, "steer", p.id)} style={{ ...btnStyle, background: "#4f46e5", color: "#fff", border: "none", padding: smallScreen ? "2px 7px" : "5px 10px", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }} title="发送（steer 插队：agent 忙时优先应答）"><Ic size={13} paths={ICONS.send} />插队</button>
      <button onClick={() => sendPrompt(p.text, "followUp", p.id)} style={{ ...btnStyle, background: "#0284c7", color: "#fff", border: "none", padding: smallScreen ? "2px 7px" : "5px 10px", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }} title="发送（followUp 排队：agent 全部收尾后投递）"><Ic size={12} paths={ICONS.listOrdered} />排队</button>
      <button onClick={() => schedulePrompt(p)} style={{ ...miniBtn, flexShrink: 0, display: "inline-flex" }} title="定时执行：创建调度计划（预填本条 prompt）"><Ic size={12} paths={ICONS.clock} /></button>
      <button onClick={() => copyPrompt(p.text)} style={{ ...miniBtn, flexShrink: 0, display: "inline-flex" }} title="复制"><Ic size={12} paths={ICONS.copy} /></button>
      <button onClick={() => setState({ save: { mode: "edit", id: p.id, name: p.name, text: p.text, groupId: p.groupId || "", tags: (p.tags || []).join(","), suggest: p.suggest !== false } })} style={{ ...miniBtn, flexShrink: 0, display: "inline-flex" }} title="编辑"><Ic size={12} paths={ICONS.pencil} /></button>
      <button onClick={async () => { if (await uiConfirm({ message: "删除 prompt「" + p.name + "」？", danger: true })) { fetch(api("/prompts/" + p.id), { method: "DELETE" }).then(() => setState({ refreshTick: state.refreshTick + 1 })); } }} style={{ ...miniBtnDanger, flexShrink: 0, display: "inline-flex" }} title="删除"><Ic size={12} paths={ICONS.trash} /></button>
    </div>
  );

  const renderGroupTree = (parentId: string | null | undefined, depth: number): any[] => {
    const subs = childrenOf(parentId);
    const rows: any[] = [];
    for (const g of subs) {
      const subCount = childrenOf(g.id).length;
      const cmdCount = commandsOf(g.id).length;
      const isCollapsed = !!collapsed[g.id];
      rows.push(
        <div key={"g" + g.id} className="aiti-pp-treerow" style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 6, cursor: "pointer", marginLeft: smallScreen ? Math.min(depth * 10, 40) : depth * 18 }} onClick={() => setState({ collapsed: { ...collapsed, [g.id]: !isCollapsed } })}>
          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: isCollapsed ? "none" : "rotate(90deg)", transition: "transform 0.15s", color: "var(--text-dim)", visibility: (subCount || cmdCount) ? "visible" : "hidden" }}>
            <polyline points="4 2.5 7.5 6 4 9.5" />
          </svg>
          <span style={{ fontSize: 12, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={12} paths={ICONS.folder} />{g.name}</span>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{cmdCount + (subCount ? "+" + subCount + "子" : "")}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 2 }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setState({ save: { mode: "manual", name: "", text: "", groupId: g.id, tags: "" } })} style={{ ...miniBtn, background: "#4f46e5", color: "#fff", border: "none", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 4 }} title="在此分组新建收藏（分组已预选）"><Ic size={12} paths={ICONS.plus} />收藏</button>
            <button onClick={() => setState({ editingGroup: { name: "", parentId: g.id } })} style={{ ...miniBtn, display: "inline-flex", alignItems: "center", gap: 4 }} title="在此分组下新建子分组"><Ic size={12} paths={ICONS.plus} />子组</button>
            <button onClick={() => setState({ editingGroup: { id: g.id, name: g.name, parentId: g.parentId } })} style={{ ...miniBtn, display: "inline-flex" }} title="重命名/移动"><Ic size={11} paths={ICONS.pencil} /></button>
            <button onClick={async () => { if (await uiConfirm({ message: "删除分组「" + g.name + "」及其子分组？组内 prompt 将移入未分组", danger: true })) { fetch(api("/groups/" + g.id), { method: "DELETE" }).then(() => setState({ refreshTick: state.refreshTick + 1 })); } }} style={{ ...miniBtnDanger, display: "inline-flex" }} title="删除分组"><Ic size={11} paths={ICONS.trash} /></button>
          </span>
        </div>,
      );
      if (!isCollapsed) {
        rows.push(...renderGroupTree(g.id, depth + 1));
        for (const c of commandsOf(g.id)) rows.push(renderPromptRow(c, depth + 1));
      }
    }
    return rows;
  };

  const shellStyle = smallScreen
    ? { position: "fixed", inset: 0, zIndex: 320, background: "var(--bg-panel)", display: "flex", flexDirection: "column", padding: 10, color: "var(--text)", fontFamily: "inherit" }
    : { position: "fixed", inset: 0, zIndex: 320, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", padding: 8 } as any;

  const panelStyle = smallScreen
    ? { width: "100%", height: "100%", display: "flex", flexDirection: "column", minHeight: 0, padding: 10, borderRadius: 0, color: "var(--text)", fontFamily: "inherit" }
    : { width: "min(880px, 94vw)", height: "min(80vh, 860px)", display: "flex", flexDirection: "column", minHeight: 0, padding: 14, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit" } as any;

  const panelInner = (
    <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
          {floating && <b style={{ fontSize: 14, display: "inline-flex", alignItems: "center", gap: 6 }}><Ic size={14} paths={ICONS.bookmark} />{t("pp.title")}</b>}
          <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", marginLeft: floating ? undefined : "auto" }}>
            <button onClick={() => setState({ tab: "library" })} style={{ ...btnStyle, padding: "3px 10px", background: tab === "library" ? "#4f46e5" : "transparent", color: tab === "library" ? "#fff" : "var(--text)", border: "1px solid " + (tab === "library" ? "#4f46e5" : "var(--border)") }}>收藏库</button>
            <button onClick={() => setState({ tab: "extract" })} style={{ ...btnStyle, padding: "3px 10px", background: tab === "extract" ? "#4f46e5" : "transparent", color: tab === "extract" ? "#fff" : "var(--text)", border: "1px solid " + (tab === "extract" ? "#4f46e5" : "var(--border)") }}>会话提取</button>
            {/* dock 模式：刷新已上提 dock 头（头工具条 v3），此处不再重复 */}
            {!isDock && <button onClick={() => setState({ refreshTick: state.refreshTick + 1 })} style={{ ...btnStyle, padding: "2px 8px", display: "inline-flex", alignItems: "center" }} title="刷新"><Ic size={12} paths={ICONS.refreshCw} /></button>}
            {floating && <button onClick={() => setState({ panelOpen: false })} style={{ ...btnStyle, padding: "2px 8px", display: "inline-flex" }} aria-label="关闭"><Ic size={12} paths={ICONS.x} /></button>}
          </div>
        </div>
        {toast && <p style={{ ...smallStyle, color: "#16a34a", marginBottom: 6 }}>{toast}</p>}
        {err && <p style={{ ...smallStyle, color: "var(--danger, #ef4444)", marginBottom: 6 }}>{String(err)}</p>}

        {/* 收藏库 */}
        {tab === "library" && (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 2 }}>
              <input style={{ ...inputStyle, maxWidth: smallScreen ? "100%" : 240, minWidth: 120, flex: 1 }} value={q} placeholder="搜索 prompt…" onChange={(e) => setState({ q: e.target.value })} />
              <button onClick={() => setState({ save: { mode: "manual", name: "", text: "", groupId: null, tags: "" } })} style={{ ...btnStyle, padding: "4px 10px", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={12} paths={ICONS.plus} />新建</button>
              <button onClick={() => setState({ editingGroup: { name: "", parentId: null } })} style={{ ...btnStyle, padding: "4px 10px", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={12} paths={ICONS.plus} />分组</button>
            </div>
            <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
              {filtered.length === 0 && groups.length === 0 ? (
                <p style={smallStyle}>（暂无收藏——点「＋ 新建」、输入框「📌 收藏输入」，或「会话提取」）</p>
              ) : (
                [
                  renderGroupTree(null, 0),
                  ungrouped.length > 0 && (
                    <div key="_ungrouped" style={{ marginTop: 4 }}>
                      <div className="aiti-pp-treerow" onClick={() => setState({ collapsed: { ...collapsed, __ungrouped: !collapsed["__ungrouped"] } })} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 6, cursor: "pointer" }} title="未分组 prompt 展开/收起">
                        <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: collapsed["__ungrouped"] ? "none" : "rotate(90deg)", transition: "transform 0.15s", color: "var(--text-dim)" }}>
                          <polyline points="4 2.5 7.5 6 4 9.5" />
                        </svg>
                        <span style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }}>未分组</span>
                        <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>{ungrouped.length + " 条"}</span>
                        <span style={{ display: "flex", gap: 2, marginLeft: 4 }} onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => setState({ save: { mode: "manual", name: "", text: "", groupId: null, tags: "" } })} style={{ ...miniBtn, background: "#4f46e5", color: "#fff", border: "none", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: 4 }} title="新建收藏（未分组）"><Ic size={12} paths={ICONS.plus} />收藏</button>
                        </span>
                      </div>
                      {!collapsed["__ungrouped"] && ungrouped.map((p: any) => renderPromptRow(p, 0))}
                    </div>
                  ),
                ]
              )}
            </div>
          </div>
        )}

        {/* 会话提取 */}
        {tab === "extract" && (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {!currentMsgs && <span style={{ ...smallStyle, flex: 1 }}>{currentSession && currentSession.id ? "正在加载当前会话…" : "未在会话中打开——请选择其他会话"}</span>}
              {currentMsgs && <span style={{ ...smallStyle, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{"📄 " + currentMsgs.name + " · " + currentMsgs.messages.length + " 条 user 消息"}</span>}
              <button onClick={() => setState({ sessionPicker: true })} style={{ ...btnStyle, padding: "3px 10px", flexShrink: 0 }}>从其他会话导入…</button>
              {currentMsgs && <button onClick={() => setState({ currentMsgs: null, selectedEntries: new Set() })} style={{ ...btnStyle, padding: "3px 10px", flexShrink: 0, display: "inline-flex" }} title="清空当前会话消息视图"><Ic size={12} paths={ICONS.x} /></button>}
            </div>
            {currentMsgs && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <select style={{ ...inputStyle, maxWidth: 220, minWidth: 120 }} value={extractGroup} onChange={(e) => setExtractGroup(e.target.value)}>
                  <option key="__none__" value="">（未分组）</option>
                  {groups.map((g: any) => <option key={g.id} value={g.id}>{groupPathOf(g.id)}</option>)}
                </select>
                <span style={{ ...smallStyle, flex: 1 }}>勾选若干条 → 收藏</span>
                <button onClick={doExtract} style={{ ...btnStyle, background: "#4f46e5", color: "#fff", border: "none", padding: "4px 12px", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }} disabled={selectedEntries.size === 0}><Ic size={12} paths={ICONS.plus} />{"收藏选中 " + selectedEntries.size + " 条"}</button>
              </div>
            )}
            <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
              {!currentMsgs ? <p style={smallStyle}>（点击「从其他会话导入…」选择会话）</p>
                : currentMsgs.messages.length === 0 ? <p style={smallStyle}>（该会话无 user 消息）</p>
                : currentMsgs.messages.map((m: any, i: number) => (
                  <label key={m.entryId || i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "6px 8px", borderRadius: 6, background: selectedEntries.has(m.entryId) ? "rgba(79,70,229,0.08)" : "var(--bg-hover)", border: "1px solid " + (selectedEntries.has(m.entryId) ? "#4f46e5" : "var(--border)"), cursor: "pointer" }}>
                    <input type="checkbox" checked={selectedEntries.has(m.entryId)} onChange={() => { const next = new Set(state.selectedEntries); if (next.has(m.entryId)) next.delete(m.entryId); else next.add(m.entryId); setState({ selectedEntries: next }); }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>{"#" + (i + 1) + (m.ts ? " · " + new Date(m.ts).toLocaleString("zh-CN", { hour12: false }) : "")}</div>
                      <div style={{ fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 72, overflow: "hidden" }}>{m.text}</div>
                    </div>
                  </label>
                ))}
            </div>
          </div>
        )}

        {/* 新建/编辑分组弹窗 */}
        {editingGroup && (
          <div style={{ position: "fixed", inset: 0, zIndex: 360, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setState({ editingGroup: null })}>
            <div style={{ width: "min(360px, 92vw)", padding: 14, borderRadius: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit" }} onClick={(e) => e.stopPropagation()}>
              <b style={{ fontSize: 13, display: "block", marginBottom: 8 }}>{editingGroup.id ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={12} paths={ICONS.pencil} />编辑分组</span> : <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={12} paths={ICONS.plus} />新建分组</span>}</b>
              <label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 4, fontWeight: 500 }}>父分组</label>
              <select style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} value={editingGroup.parentId || ""} onChange={(e) => setState({ editingGroup: { ...editingGroup, parentId: e.target.value || null } })}>
                <option key="__top__" value="">（顶层）</option>
                {groups.filter((g: any) => g.id !== editingGroup.id).map((g: any) => <option key={g.id} value={g.id}>{groupPathOf(g.id)}</option>)}
              </select>
              <label style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginBottom: 4, marginTop: 8, fontWeight: 500 }}>名称</label>
              <input style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }} value={editingGroup.name} placeholder="分组名（回车确认）" autoFocus onChange={(e) => setState({ editingGroup: { ...editingGroup, name: e.target.value } })} onKeyDown={(e) => { if (e.key === "Enter") saveGroupEditing(); }} />
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button onClick={saveGroupEditing} style={{ ...btnStyle, background: "#4f46e5", color: "#fff", border: "none", flex: 1 }} disabled={!editingGroup.name.trim()}>保存</button>
                <button onClick={() => setState({ editingGroup: null })} style={{ ...btnStyle }}>取消</button>
              </div>
            </div>
          </div>
        )}

        {/* 底部统计 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 6, flexWrap: "wrap" }}>
          <span style={{ ...smallStyle, flex: 1 }}>{"共 " + prompts.length + " 条 · " + groups.length + " 分组"}</span>
          <button onClick={() => { try { navigator.clipboard.writeText(JSON.stringify({ groups, prompts }, null, 2)); showToast("已导出 JSON（在导入弹窗粘贴即可恢复）"); } catch { showErr("导出失败"); } }} style={miniBtn} title="导出全部为 JSON（备份/迁移）"><Ic size={12} paths={ICONS.upload} />导出</button>
          <button onClick={() => setState({ importOpen: true })} style={miniBtn} title="导入 JSON（合并或替换）"><Ic size={12} paths={ICONS.download} />导入</button>
        </div>
    </>
  );
  // dock v3 分面：floating = 遮罩+浮窗壳（float 契约）；left = 左栏 DockSection
  if (floating) {
    return (
      <div style={shellStyle} onClick={() => { if (!smallScreen) setState({ panelOpen: false }); }}>
        <div style={panelStyle} data-ext-float="1" data-ext-float-key={PANEL_KEY} data-ext-float-dock={`${sidebarZoneOf(PANEL_KEY)} right-panel`} data-ext-float-dock-default={sidebarZoneOf(PANEL_KEY)} data-ext-float-w={880} data-ext-float-h={800} data-ext-float-full="1" onClick={(e) => e.stopPropagation()}>
          {panelInner}
        </div>
        {sessionPicker && <SessionPicker />}
        {importOpen && <ImportDialog />}
      </div>
    );
  }
  // 左栏区块 face：统一头行（标题 + 业务按钮 + ⇱ detach + ⋮）；zone 用规范值 sidebar:<key>
  const hs = useDockHeaderStateOf(PANEL_KEY); // 状态订阅（内容上报）；按钮动作经 store 派发
  const ppCount = typeof hs.count === "number" ? hs.count : 0;
  const actions: DockHeaderAction[] = [
    { id: "new", title: "新建收藏", icon: <Ic size={12} paths={ICONS.plus} />, visibility: "always", onClick: () => { requestDockCommand(PANEL_KEY, "new"); } },
    { id: "refresh", title: "刷新", icon: <Ic size={12} paths={ICONS.refreshCw} />, visibility: "always", onClick: () => { requestDockCommand(PANEL_KEY, "refresh"); } },
    { id: "group", title: "新建分组", icon: <Ic size={12} paths={ICONS.folder} />, visibility: "expanded", onClick: () => { requestDockCommand(PANEL_KEY, "group"); } },
  ];
  const ppInner = (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", color: "var(--text)", fontSize: 12, padding: "8px 10px", boxSizing: "border-box", fontFamily: "inherit", position: "relative" }}>
      {panelInner}
      {sessionPicker && <SessionPicker />}
      {importOpen && <ImportDialog />}
    </div>
  );
  // 右栏 tab face（chrome="tab"：无头行，✕/⇱ 在宿主 TabBar）
  if (face === "right") {
    return (
      <DockBody itemKey={PANEL_KEY} zone="right-panel" title={t("pp.title")} chrome="tab"
        zones={[sidebarZoneOf(PANEL_KEY), "right-panel"]} defaultZone={sidebarZoneOf(PANEL_KEY)}>{ppInner}</DockBody>
    );
  }
  return (
    <DockBody itemKey={PANEL_KEY} title={t("pp.title")} chrome="section" kind="dockable"
      count={ppCount > 0 ? ppCount : undefined}
      zones={[sidebarZoneOf(PANEL_KEY), "right-panel"]} defaultZone={sidebarZoneOf(PANEL_KEY)}
      headerActions={actions}>
      {ppInner}
    </DockBody>
  );
}

// ---------- 注册入口组件 ----------
/** 跨扩展打开入口（plan-first 等经 window 事件 aiti-prompts-open 调用）：
 *  { edit: true, prompt: { id, name, text, groupId?, tags? } } → 直接弹出该 prompt 的编辑弹层；
 *  无参/非编辑 → 打开收藏库主面板。 */
export function __openExternal(opts: { edit?: boolean; prompt?: { id: string; name: string; text: string; groupId?: string | null; tags?: string[] } } = {}) {
  if (opts.edit && opts.prompt) {
    setState({ save: { mode: "edit", id: opts.prompt.id, name: opts.prompt.name, text: opts.prompt.text, groupId: opts.prompt.groupId || "", tags: (opts.prompt.tags || []).join(","), suggest: opts.prompt.suggest !== false } });
  } else {
    setState({ panelOpen: true, tab: "library" });
  }
}

/** 懒加载 v2 两段式：静态条目点击转发用（模块级 setState 直开收藏库） */
export function openFromToolbar() { setState({ panelOpen: true, tab: "library" }); }
export function PromptsToolbarButton() { return <ToolbarButton />; }
export function PromptsPanelSlot(props: Record<string, any>) { return <PromptsPanel {...props} face="float" />; }
export function PromptsDockLeft(props: Record<string, any>) { return <PromptsPanel {...props} face="left" />; }
export function PromptsDockRight(props: Record<string, any>) { return <PromptsPanel {...props} face="right" />; }
export function PromptsSaveSlot() { return <SaveDialog />; }
export function PromptsMessageAction(props: { text?: string }) { return <SaveMessageAction {...props} />; }