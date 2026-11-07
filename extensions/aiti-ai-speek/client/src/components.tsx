/**
 * aiti-ai-speek · 渲染组件（JSX）
 *   FollowToggle   toolbar 插槽：🔊 跟读开关（全局）
 *   PlaybackBar    sessionTopbar 插槽：常驻播放条（⏮⏯⏭⏹ + 语速 + 音色 + 队列）
 *   SettingsDialog dialogs 插槽：设置面板（音色/语速/内容/引擎/阈值）
 *
 * 样式：自持样式层（前缀 aisp-），颜色 var(--x, 兜底)；不依赖宿主 class。
 */
import { useState, useEffect, useRef } from "react";
import { createPortal, t } from "./host-shim";
import { getRootSessionId } from "./session-svc";
import {
  getState, subscribe, setSettings, toggleFollow, setBarVisible,
  pause, resume, skip, prev, stop, subscribeSession, unsubscribeSession,
  steerSession, fetchEdgeInfo, setVoices, setEdgeInfo, speakMessage, currentSourceId,
  sortBrowserVoices,
  fetchFeatures, toggleProcess, consumeReadOnFollow, replayCurrentPage, startFollowFromPageTop, resumeSessionFromLastPos, resumeFromCurrentPos, readMessageFrom,
  setCurrentSession, setFollow, resolvedEngine, previewVoice, setEdgeBinPath, jumpToMessage, ensureTexts,
} from "./speaker";
import { highlightSegment, clearHighlight, noteUserScroll, scrollProgrammatic, smartScrollToRow, jumpToPlayRow, isUserDrifted, resolveDrift } from "./highlight";

// ── 自持样式层（幂等注入）──────────────────────────────────────────────────
let styleInjected = false;
function ensureStyles() {
  if (styleInjected) return;
  styleInjected = true;
  const el = document.createElement("style");
  el.setAttribute("data-aiti-speek", "1");
  el.textContent = `
  .aisp-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;width:28px;height:28px;border:none;border-radius:5px;background:transparent;color:var(--text-muted,#777);cursor:pointer;transition:background .12s,color .12s;position:relative;outline:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;}
  .aisp-btn:focus{outline:none;background:transparent;}
  .aisp-btn:focus-visible{outline:2px solid var(--accent,#3b82f6);outline-offset:1px;}
  /* toolbar 专用：宿主容器 36px 高 + align-items:stretch，按钮需填满并内容居中，才不偏顶 */
  .aisp-btn-tb{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border:none;background:transparent;color:var(--text-muted,#777);cursor:pointer;transition:background .12s,color .12s;position:relative;flex-shrink:0;padding:0;border-radius:8px;}
  .aisp-btn-tb:hover{color:var(--text,#222);background:var(--bg-hover,#eee);}
  .aisp-btn-tb.on{color:var(--accent,#3b82f6);background:color-mix(in srgb,var(--accent,#3b82f6) 14%,transparent);}
  .aisp-btn-tb.on.muted{color:var(--text-dim,#999);background:transparent;}
  .aisp-btn:hover{background:var(--bg-hover,#eee);color:var(--text,#222);}
  .aisp-btn.on{color:var(--accent,#3b82f6);}
  .aisp-btn.on.muted{color:var(--text-dim,#999);}
  .aisp-dot{position:absolute;right:4px;top:4px;width:7px;height:7px;border-radius:50%;background:var(--accent,#3b82f6);}
  .aisp-msgcount{position:absolute;right:0;bottom:0;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--accent,#3b82f6);color:#fff;font-size:9px;line-height:14px;text-align:center;pointer-events:none;}
  .aisp-bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483101;display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:10px;border:1px solid var(--border,#ddd);background:var(--bg-panel,#fff);box-shadow:0 8px 28px rgba(0,0,0,.16);font-size:12px;color:var(--text,#222);max-width:calc(100vw - 16px);}
  /* 小屏（移动/模拟窄窗）：默认全宽铺底、可换行；拖拽后仍跟手（clampBarPos 保证不出屏） */
  @media (max-width:640px), (max-height:700px){
    .aisp-bar{left:auto;right:8px;bottom:0;transform:none;width:max-content;max-width:calc(100vw - 16px);border-radius:10px;border:1px solid var(--border,#ddd);padding:5px 7px calc(5px + env(safe-area-inset-bottom,0px));gap:3px;flex-wrap:wrap;justify-content:flex-start;row-gap:2px;}
    .aisp-ctl{width:28px;height:28px;flex-shrink:0;}
    .aisp-grip{flex-shrink:0;}
    /* 进度区同行（按钮行 flex-start 排满无两端空白） */
    .aisp-queue{font-size:10px;min-width:0;}
    /* drift 按钮紧凑：388+读本页也能一行放下（✕不换行） */
    .aisp-drift button{padding:2px 5px;font-size:9px;}
  }
  /* 小屏一行放不下时依次牺牲（越窄隐藏越多）：⏮prev → ⏭next → ⏸/⏵ 播放暂停；
     保留 ⏹stop/进度/设置/隐藏。nth-child：grip=1, prev=2, play=3, next=4
     全按钮需求约 300px（含进度），388 主流手机全显；340 以下开始牺牲 */
  @media (max-width:340px){
    .aisp-bar > :nth-child(2){display:none;}
  }
  @media (max-width:310px){
    .aisp-bar > :nth-child(2), .aisp-bar > :nth-child(4){display:none;}
  }
  @media (max-width:280px){
    .aisp-bar > :nth-child(2), .aisp-bar > :nth-child(4), .aisp-bar > :nth-child(3){display:none;}
  }
  .aisp-grip{display:inline-flex;align-items:center;color:var(--text-dim,#999);cursor:grab;font-size:13px;user-select:none;touch-action:none;padding:0 2px;}
  .aisp-grip:active{cursor:grabbing;}
  .aisp-ctl{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:none;border-radius:6px;background:transparent;color:var(--text,#222);cursor:pointer;transition:background .12s;outline:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none;}
  .aisp-ctl:hover{background:var(--bg-hover,#eee);}
  .aisp-ctl:active{background:var(--bg-hover,#aaa);}
  /* 无状态按钮：点击后不残留 focus 外观；仅键盘 Tab 可达时显示焦点环 */
  .aisp-ctl:focus{outline:none;background:transparent;}
  .aisp-ctl:focus-visible{outline:2px solid var(--accent,#3b82f6);outline-offset:1px;background:var(--bg-hover,#eee);}
  .aisp-ctl:disabled{opacity:.4;cursor:default;}
  .aisp-ctl.stop{color:var(--danger, #ef4444);}
  .aisp-sel{font-size:12px;padding:3px 6px;border:1px solid var(--border,#ddd);border-radius:6px;background:var(--bg,#fff);color:var(--text,#222);max-width:150px;}
  .aisp-queue{color:var(--text-dim,#999);white-space:nowrap;font-size:11px;}
  .aisp-badge{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:99px;background:color-mix(in srgb,var(--accent,#3b82f6) 14%,transparent);color:var(--accent,#3b82f6);font-size:11px;white-space:nowrap;}
  .aisp-dlg-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;}
  .aisp-dlg{width:min(560px,calc(100vw - 24px));max-height:86vh;background:var(--bg-panel,#fff);border:1px solid var(--border,#ddd);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.2);display:flex;flex-direction:column;}
  .aisp-dlg-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border,#ddd);font-weight:600;font-size:13px;color:var(--text,#222);}
  .aisp-dlg-bd{padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:12px;}
  .aisp-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;font-size:12px;color:var(--text,#222);}
  .aisp-row > label{flex:1;min-width:0;color:var(--text-muted,#666);line-height:1.4;}
  .aisp-row > label + *{flex-shrink:0;margin-top:1px;}
  .aisp-seg{display:inline-flex;border:1px solid var(--border,#ddd);border-radius:6px;overflow:hidden;}
  .aisp-seg button{font-size:11px;padding:3px 8px;border:none;background:transparent;color:var(--text-muted,#777);cursor:pointer;}
  .aisp-seg button.on{background:var(--accent,#3b82f6);color:#fff;}

  /* 消息跳转选择器 */
  .aisp-pk-overlay{position:fixed;inset:0;z-index:2147483050;background:rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;}
  /* fallback（未装/禁用 aiti-float）：居中；接管后 left/top/width/height 由 float 的 inline 样式覆盖 */
  .aisp-pk{width:min(360px,calc(100vw - 20px));max-height:min(70vh,520px);background:var(--bg-panel,#fff);border:1px solid var(--border,#ddd);border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.22);display:flex;flex-direction:column;}
  .aisp-pk-hd{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--border,#ddd);font-weight:600;font-size:12px;}
  .aisp-pk-bd{overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:4px;}
  /* 叶节点（消息行）：白底 + 引导线 + 跳转箭头——与组块（灰底）区分 */
  .aisp-pk-item{display:flex;align-items:center;gap:6px;padding:4px 8px;border:none;border-radius:6px;background:transparent;cursor:pointer;font-size:12px;color:var(--text,#222);text-align:left;white-space:nowrap;border-left:2px dotted var(--border,#ddd);}
  .aisp-pk-item:hover{background:var(--bg-hover,#f4f4f5);}
  .aisp-pk-item.on{background:color-mix(in srgb,var(--accent,#3b82f6) 14%,transparent);color:var(--accent,#3b82f6);font-weight:600;}
  .aisp-pk-sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-dim,#888);font-size:10px;text-align:left;}
  .aisp-pk-go{margin-left:auto;color:var(--text-dim,#bbb);font-size:10px;opacity:.7;}
  .aisp-pk-item.on .aisp-pk-go{color:var(--accent,#3b82f6);opacity:1;}
  .aisp-pk-n{min-width:34px;color:var(--text-dim,#999);font-variant-numeric:tabular-nums;}
  .aisp-pk-n2{color:var(--text,#333);}
  .aisp-pk-item.on .aisp-pk-n{color:var(--accent,#3b82f6);}
  .aisp-pk-star{color:var(--warn, #eab308);}
  .aisp-pk-cur{margin-left:auto;font-size:10px;opacity:.8;}
  .aisp-pk-group{display:flex;flex-direction:column;gap:2px;}
  .aisp-pk-grpbtn{display:flex;align-items:center;gap:6px;padding:5px 8px;border:none;border-radius:6px;background:var(--bg-hover,#f4f4f5);cursor:pointer;font-size:12px;color:var(--text,#222);width:100%;text-align:left;}
  .aisp-pk-grpbtn:hover{background:var(--bg-hover,#e8e8ea);}
  .aisp-pk-caret{width:12px;color:var(--text-dim,#999);}
  .aisp-pk-cnt{margin-left:auto;font-size:10px;color:var(--text-dim,#999);}
  .aisp-pk-sub{padding-left:10px;border-left:2px solid var(--border,#ddd);margin-left:4px;}
  .aisp-drift{display:inline-flex;gap:3px;}
  .aisp-drift button{font-size:10px;padding:2px 6px;border:1px solid var(--accent,#3b82f6);border-radius:99px;background:color-mix(in srgb,var(--accent,#3b82f6) 10%,transparent);color:var(--accent,#3b82f6);cursor:pointer;white-space:nowrap;}
  .aisp-drift button:hover{background:color-mix(in srgb,var(--accent,#3b82f6) 22%,transparent);}
  .aisp-queue .aisp-ab-jump{color:var(--accent,#3b82f6);border-bottom:1px dotted var(--accent,#3b82f6);cursor:pointer;}
  .aisp-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483200;max-width:min(540px,calc(100vw - 24px));padding:8px 14px;border-radius:8px;background:color-mix(in srgb, var(--danger, #ef4444) 95%, transparent);color:#fff;font-size:12px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer;}

  `;
  document.head.appendChild(el);
}

// ── 订阅 hooks ────────────────────────────────────────────────────────────
function useSpeekState() {
  const [, setV] = useState(0);
  useEffect(() => subscribe(() => setV((x) => x + 1)), []);
  return getState();
}

// 样式幂等注入：任意组件首次渲染时确保（模块级 guard）
ensureStyles();

// ── 图标（lucide 线条风格）───────────────────────────────────────────────
function Icon({ d, size = 14, filled = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}
const ICON = {
  volume: "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z M16 9a5 5 0 0 1 0 6 M19.364 18.364a9 9 0 0 0 0-12.728",
  play: "m6 3 14 9-14 9V3z",
  pause: "M7 4h4v16H7z M13 4h4v16h-4z",
  prev: "M11 17l-5-5 5-5 M18 17l-5-5 5-5",
  next: "M4 17l5-5-5-5 M13 17l5-5-5-5",
  stop: "M6 6h12v12H6z",
  gear: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
};

// ── toolbar 🔊 跟读开关（三态）──────────────────────────────────────────────
// [D2 拆包] 重 chunk 侧的真实 FollowToggle（原实现；薄壳点击加载本模块后由
// initHeavySlots 注册为 "follow" 条目的新 render，接管开关状态机）
export function HeavyFollowToggle(props) {
  const st = useSpeekState();
  const on = st.followOn;
  // 会话订阅跟随 followOn：跟读关闭时不订阅 SSE、不拉消息列表（0 请求/0 带宽），
  // 喇叭上也不显示消息数；开启跟读时才建订阅（settled → force 刷新 msgList）并自动入播。
  // currentSession 来自 host 插槽 props（toolbar 也传，2026-09-04 起）；
  // ⚠ 双 id（2026-09-04 实锤）：props.currentSession.id 可能是「agent 侧 id」（SSE 广播桶/steer 均按它工作），
  //   而消息列表/文本在「root uuid」（URL ?session=，readSession 按它可读）——列表键必须用 root，订阅键用 agent。
  // 统一会话服务（pi-web.session）：root id 仅在会话 active 时取用（URL 未验证 id 不再直读——
  // 已删除会话会产生幻影读取）；服务缺席/resolving/none → null，listId 自然降级到 agentId。
  const rootId = getRootSessionId();
  const agentId = props?.currentSession?.id || null;
  const listId = rootId || agentId;        // 列表/文本/播放键（root 优先）
  const sseId = agentId || rootId;         // SSE 订阅/steer 键（agent 优先——广播桶在 agent 侧）
  // 页面级「加载即恢复」只执行一次（ref；同 session 的 sseId 抖动不重复 resume）
  const resumedRef = useRef(false);
  const prevListIdRef = useRef(null);
  useEffect(() => {
    if (listId && st.followOn) {
      setCurrentSession(listId);
      subscribeSession(sseId, listId);
      // 页面加载/刷新：跟读已开 → 确定性自动恢复（不依赖 PlaybackBar effect 时序）；
      // 首次 resumedRef 防双启动；【切 session（listId 变化）每次都要 resume 到新 session】——
      // 否则 setCurrentSession 只停旧播放，新会话的朗读/列表接不上（用户反馈仍在读旧会话）
      if (!resumedRef.current) {
        resumedRef.current = true;
        resumeSessionFromLastPos(listId);
      } else if (prevListIdRef.current !== listId) {
        // 切 session：立即把朗读/列表切到新 session（新会话上次读到哪就从哪续读）
        resumeSessionFromLastPos(listId);
      }
      prevListIdRef.current = listId;
    } else {
      unsubscribeSession();
    }
  }, [listId, sseId, st.followOn]);
  // 三态：关 / 开（普通开启）/ 读中·播放条藏（条被隐藏时的恢复态，点按打开条）。
  // 中间态只由「跟读开着 + 条没显示」决定（不依赖 playing：停止后条藏也显示——否则一点就误关跟读）。
  const readingHidden = on && !st.barVisible;
  const stateCls = !on ? "" : (readingHidden ? " on muted" : " on");
  // 当前会话消息总数徽标（仅跟读开启时显示：关闭跟读不订阅不拉列表，数字恒无意义）
  const totalMsgs = (on && listId && st.msgList?.[listId]) ? st.msgList[listId].length : 0;
  const title = !on
    ? t("speek.followOff") + (totalMsgs ? `（会话 ${totalMsgs} 条消息）` : "")
    : (readingHidden
      ? t("speek.followHidden") + "（点按恢复播放条）"
      : t("speek.followOn") + "（点按关闭跟读）");
  return (
    <button
      className={"aisp-btn-tb" + stateCls}
      title={title}
      aria-pressed={on}
      onClick={() => toggleFollow()}
    >
      <Icon d={ICON.volume} size={16} filled={on} />
      {totalMsgs > 0 && <span className="aisp-msgcount">{totalMsgs > 999 ? "999+" : totalMsgs}</span>}
      {readingHidden && <span className="aisp-dot" />}
    </button>
  );
}

// ── assistant 消息底部 hover 操作区：🔊 朗读这条 / ⏹ 停止朗读 ──────────────
export function AssistantMessageAction(props) {
  const st = useSpeekState();
  const text = props?.text || "";
  const sourceId = props?.entryId || props?.messageId || null;
  // 双 id 容错：host 可能传 root 或 agent 侧 id——以统一服务 root（active 后）为准，缺失才用 props（gate 内已按 activeSessionId 校验）
  const sessionId = getRootSessionId() || props?.sessionId || null;
  // 当前正在读的是不是这一条（sourceId 匹配）
  const readingThis = !!sourceId && currentSourceId() === sourceId && st.playing;
  if (!text || !text.trim()) return null;
  return (
    <button
      onClick={() => { if (readingThis) stop(); else speakMessage(text, sourceId, sessionId); }}
      title={readingThis ? t("speek.stopReading") : t("speek.readThis")}
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: "3px 8px", height: 22,
        background: "none", border: "none", borderRadius: 5,
        color: readingThis ? "var(--accent,#3b82f6)" : "var(--text-dim,#999)",
        cursor: "pointer", fontSize: 11, fontWeight: 400, whiteSpace: "nowrap",
        transition: "color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent,#3b82f6)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = readingThis ? "var(--accent,#3b82f6)" : "var(--text-dim,#999)"; }}
    >
      {readingThis
        ? <Icon d={ICON.stop} size={11} filled />
        : <Icon d={ICON.volume} size={11} filled={false} />}
      {readingThis ? t("speek.stopReading") : t("speek.readThis")}
    </button>
  );
}

// ── sessionTopbar 播放条（常驻浮动；懒加载会话订阅）────────────────────────
// ── 播放条拖拽（自实现；Aiti-float 的 applyStatic 强制 flex-direction:column + 固定宽高，
//    会破坏横向播放条，故不直接套 data-ext-float，改轻量拖拽：把手 pointer + left/top 持久化）──
const BAR_POS_KEY = "aiti-ai-speek:bar-pos";
/** 位置铉制：任何来源的 left/top 都夹回视口内（坏值/旧值/视口变化 → 不出屏） */
function clampBarPos(p) {
  if (!p) return null;
  let vw = 1280, vh = 720;
  try { vw = window.innerWidth; vh = window.innerHeight; } catch { /* noop */ }
  const w = Math.min(430, Math.max(80, vw - 16));
  const h = 56;
  const x = Math.min(Math.max(8, p.x), Math.max(8, vw - w - 8));
  const y = Math.min(Math.max(8, p.y), Math.max(8, vh - h - 8));
  return (x === p.x && y === p.y) ? p : { x, y };
}
function loadBarPos() {
  try {
    const v = JSON.parse(localStorage.getItem(BAR_POS_KEY) || "null");
    if (v && typeof v.x === "number" && typeof v.y === "number") return clampBarPos({ x: v.x, y: v.y });
  } catch { /* 损坏回落默认 */ }
  return null;
}
function saveBarPos(p) {
  try { localStorage.setItem(BAR_POS_KEY, JSON.stringify(p)); } catch { /* 存储不可用 */ }
}

let settingsOpen = false;
const settingsListeners = new Set();
export function openSettings(v) {
  settingsOpen = !!v;
  for (const l of settingsListeners) l();
}

function useSettingsOpen() {
  const [open, setOpen] = useState(settingsOpen);
  useEffect(() => {
    const l = () => setOpen(settingsOpen);
    settingsListeners.add(l);
    return () => settingsListeners.delete(l);
  }, []);
  return open;
}

// 单例抢占：PlaybackBar 因顶栏 entryNode+strip 有两个渲染点，两者 createPortal 会叠加出两个工具条。
// 这里用模块级标志 + useRef 让第一个挂载的实例渲染，其余返回 null。
let barSlotTaken = false;

export function PlaybackBar(props) {
  const st = useSpeekState();
  // 双 id：列表/播放/高亮键 = root（统一服务 active 后取用，readSession 可读）；steer 键 = agent（props，广播/注入桶）
  const rootId = getRootSessionId();
  const agentId = props?.currentSession?.id || null;
  const sessionId = rootId || agentId;
  const steerId = agentId || rootId;
  // 抢占单例：首个实例 primary=true，其余 false（useRef 初始化只在首次渲染执行，稳定）
  const primaryRef = useRef(null);
  if (primaryRef.current === null) {
    primaryRef.current = !barSlotTaken;
    barSlotTaken = true;
  }
  const primary = primaryRef.current;
  const barRef = useRef(null);
  // 无已存位置 → 默认底部居中（CSS）；拖拽后存 left/top
  const [pos, setPos] = useState(loadBarPos);
  const posRef = useRef(pos);
  posRef.current = pos;
  const prevFollowOnRef = useRef(st.followOn);
  // 订阅生命周期由 FollowToggle 常驻管理（不依赖 followOn：消息列表随时随 AI 更新）。
  // 本 effect 只负责「切session 时从上次位置续读」：首次开启跟读的自动开播由 setFollow(true)
  // 内部同步完成（不依赖 effect 时序）；effect 用 consumeReadOnFollow 防与其双启动。
  // 启动权威已移至 FollowToggle（resumedRef 一次）；本 effect 仅同步 ref 痕迹，不再启动/续读（防双启动 supersede）
  useEffect(() => {
    if (!primary) return;
    const justTurnedOn = !prevFollowOnRef.current && st.followOn;
    prevFollowOnRef.current = st.followOn;
    if (st.followOn && sessionId && !justTurnedOn && steerId) {
      steerSession(steerId); // 提示词注入仍由唯一权威侧发起（幂等：每会话一次）
    }
  }, [st.followOn, sessionId]);

  // 跟读高亮：当前朗读句子在消息流中圈选 + 自动滚动（听书式）；优先用 match（DOM 原文）
  // [fix 20260903] 旧 shape: st.queue/st.itemId/st.segIdx — 已被 speaker.js 迁移到 msgList+curIndex/curSegs+curSeg,统一改用新 shape。
  //   - curItem = msgList[sessionId][curIndex]（即当前播放消息的 {id,key}）
  //   - curSeg  = curSegs[curSeg]（已合并跨消息的 seg 流，含 _id=text 所属消息 id）
  //   - raw     = textCache[sessionId][curItem.id]（按需取，未命中传空串 → highlight 走文本匹配兜底）
  const curItem = (sessionId && st.msgList && st.msgList[sessionId]) ? (st.msgList[sessionId][st.curIndex] || null) : null;
  const curSeg = (st.curSegs && st.curSegs.length) ? (st.curSegs[st.curSeg] || null) : null;
  useEffect(() => {
    if (!primary) return;
    if (!st.followOn || !st.playing || !curSeg) { clearHighlight(); return; }
    // match=原文（无前缀/无口播）优先；无 match（概要段）回退 text，找不到则不打扰
    // sourceId=消息 entryId → 按 data-entry-id 精确定位消息，比文本匹配可靠
    const sourceId = curItem?.id || curSeg._id || null;
    const raw = (sessionId && curItem?.id && st.textCache?.[sessionId]?.[curItem.id]) || '';
    try {
      window.__speekScrollMode = st.settings.followScroll || "smart";
      window.__speekListForHighlight = (sessionId && st.msgList?.[sessionId]) ? st.msgList[sessionId] : null;
    } catch { /* noop */ }
    const ok = highlightSegment(curSeg.match ?? curSeg.text, sourceId, raw);
    if (!ok) clearHighlight();
  }, [st.followOn, st.playing, curItem?.id, st.curSeg]);
  // 停止/关闭跟读时确保清除
  useEffect(() => {
    if (!primary) return;
    if (!st.followOn || !st.playing) clearHighlight();
  }, [st.followOn, st.playing]);

  // ⚠ hooks 必须全部位于条件 return 之前（否则渲染路径不同 → hooks 数不一致崩溃）
  const [smallScreen, setSmallScreen] = useState(() => {
    try { return typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches; } catch { return false; }
  });
  useEffect(() => {
    const clampOnResize = () => {
      if (!posRef.current) return;
      const c = clampBarPos(posRef.current);
      if (c !== posRef.current) { setPos(c); try { localStorage.setItem(BAR_POS_KEY, JSON.stringify(c)); } catch { /* noop */ } }
    };
    window.addEventListener("resize", clampOnResize);
    return () => window.removeEventListener("resize", clampOnResize);
  }, []);
  useEffect(() => {
    let mq = null;
    try {
      mq = window.matchMedia("(max-width: 640px)");
      const fn = () => setSmallScreen(mq.matches);
      mq.addEventListener ? mq.addEventListener("change", fn) : mq.addListener(fn);
      window.addEventListener("resize", fn);
      return () => { mq.removeEventListener ? mq.removeEventListener("change", fn) : mq.removeListener(fn); window.removeEventListener("resize", fn); };
    } catch { /* noop */ }
  }, []);

  // 跟随滚动监听：用户手动滚屏上报。capture 捕获内部滚动容器（pi-web 消息列表在 overflow-y-auto 容器里滚，
  // window 不产生 scroll 事件；scroll 不冒泡但会走捕获阶段）——程序滚动由 highlight 内部自动忽略。
  // 滚动后强制重渲染一次：drift（跳回/读本页）判定在渲染期计算——否则用户滚远后要等下一句才显示。
  const [, setScrollTick] = useState(0);
  useEffect(() => {
    const onScroll = () => { noteUserScroll(); try { setScrollTick((t) => t + 1); } catch { /* noop */ } };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  // 单例：非首要实例不渲染（防止顶栏 entryNode+strip 双渲染点叠加出两个工具条）
  if (!primary) return null;
  if (!st.followOn || !st.barVisible) return null;

  // [fix 20260903] 同上：旧 st.queue/st.itemId/st.segIdx → 新 msgList+curIndex/curSegs+curSeg
  const item = curItem; // 复用上面算的 curItem，避免重复计算
  // 消息总数（仅跟读开启时展示：列表由跟随 followOn 的 SSE 订阅维护，关闭时无刷新）
  const totalMsgs = (sessionId && st.msgList?.[sessionId]) ? st.msgList[sessionId].length : 0;
  // 进度显示（2026-09 优化）：x/y = 会话消息列表中当前第几条；a/b = 当前消息内第几句
  //   curIndex 已由 speaker.js 逐句同步为真实消息索引（不再停留在批次起点）
  let segPos = 0, segTotal = 0;
  const curSeg0 = (st.curSegs && st.curSegs.length) ? (st.curSegs[st.curSeg] || null) : null;
  if (curSeg0 && curSeg0._id) {
    let first = -1, count = 0;
    for (let i = 0; i < st.curSegs.length; i++) {
      if (st.curSegs[i]._id === curSeg0._id) { if (first < 0) first = i; count++; }
    }
    if (first >= 0) { segPos = st.curSeg - first + 1; segTotal = count; }
  }
  // 进度 x/y = msgList 序号（用户确认：恢复之前的 300 形态；服务端 r/rt 字段保留但不用于显示）
  // x = 1-based（当前第几条，最后一条 x=y 一致）；y/b = 实际数量（不加 1；b 为当前消息句数）
  const msgPos = st.curIndex >= 0 ? st.curIndex + 1 : 0;
  const msgTotal = totalMsgs;
  const queueInfo = st.starting
    ? "启动中…"
    : item
      ? `${msgPos}/${msgTotal} · ${segPos}/${segTotal}`
      : (totalMsgs ? `0/${totalMsgs}` : "等待");
  const extra = st.backlog > 0 ? ` +${st.backlog}` : "";

  const ctl = (title, fn, d, cls, disabled) => (
    <button className={"aisp-ctl" + (cls ? " " + cls : "")} title={title} disabled={disabled !== undefined ? disabled : !st.playing} onClick={(e) => { e.currentTarget.blur(); fn(); }}>
      <Icon d={d} size={14} filled={title === "pause" || title === "stop"} />
    </button>
  );

  // 拖拽：grip（⠿）为把手；pointer 移动只写 transform（顺滑），结束提交 left/top 并持久化
  const onGripDown = (e) => {
    if (e.button !== 0) return;
    const bar = barRef.current;
    if (!bar) return;
    e.preventDefault();
    const rect = bar.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const base = posRef.current || { x: rect.left, y: rect.top };
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      bar.style.transform = "translate3d(" + dx + "px," + dy + "px,0)";
    };
    const up = (ev) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      bar.style.transform = "";
      if (!moved) return;
      const next = {
        x: base.x + (ev.clientX - startX),
        y: base.y + (ev.clientY - startY),
      };
      // 夹回视口（留边距）
      if (next.x < 8) next.x = 8;
      if (next.y < 8) next.y = 8;
      if (next.x > window.innerWidth - rect.width - 8) next.x = window.innerWidth - rect.width - 8;
      if (next.y > window.innerHeight - rect.height - 8) next.y = window.innerHeight - rect.height - 8;
      setPos(next);
      saveBarPos(next);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };
  // 双击把手复位：清持久化回默认居中
  const onGripDbl = () => {
    setPos(null);
    try { localStorage.removeItem(BAR_POS_KEY); } catch { /* noop */ }
  };

  // 定位：有已存且非小屏 → left/top；无 → 默认底部居中（CSS）；小屏一律铺底（覆盖也可）
  const clamped = pos ? clampBarPos(pos) : null;
  // 用户滚远判定：播放行不在视口 + 用户最近 5s 手动滚过 → 不自动拉回，改双按钮（跳回读位 / 从本页读）
  const driftingRow = (() => { if (!st.playing && !st.paused) return null; try { const id = curItem?.id || (st.curSegs && st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id) || null; return id ? document.querySelector('[data-entry-id="' + id + '"]') : null; } catch { return null; } })();
  const drifted = isUserDrifted(driftingRow);
  // 漂移态 a/b 点击：滚回当前朗读行并解除漂移（只影响跟随，不影响朗读/高亮）
  const jumpBack = () => {
    try {
      const id = curItem?.id || (st.curSegs && st.curSegs[st.curSeg] && st.curSegs[st.curSeg]._id) || null;
      const el = id ? document.querySelector('[data-entry-id="' + id + '"]') : null;
      if (el) jumpToPlayRow(el, "always");
      else resolveDrift();
    } catch { /* noop */ }
  };
  // 拖过就跟随位置（含小屏）；未拖过 → 默认（大屏居中 / 小屏铺底）。小屏拖后变紧凑宽度可自由放置。
  const barStyle = clamped
    ? { left: clamped.x, top: clamped.y, bottom: "auto", transform: "none", width: (smallScreen ? "max-content" : undefined), maxWidth: "calc(100vw - 16px)" }
    : undefined;

  const body = (
    <div ref={barRef} className="aisp-bar" style={barStyle}>
      <span className="aisp-grip" title="拖动移动 · 双击复位" aria-hidden onPointerDown={onGripDown} onDoubleClick={onGripDbl}>⠿</span>
      {/* ⏮ 上一条：只要该会话有消息列表（哪怕读完/停止）都可导航，不受 playing 限制 */}
      {ctl(t("speek.prev"), prev, ICON.prev, "", !(st.msgList[sessionId] && st.msgList[sessionId].length))}
      {st.paused
        ? ctl(t("speek.play"), resume, ICON.play)
        : st.playing
          ? ctl(t("speek.pause"), pause, ICON.pause)
          : ctl(t("speek.replay"), () => { if (sessionId) resumeFromCurrentPos(sessionId); }, ICON.play, "", false)}
      {ctl(t("speek.next"), skip, ICON.next, "", !(st.msgList[sessionId] && st.msgList[sessionId].length))}
      {ctl(t("speek.stop"), () => setFollow(false), ICON.stop, "stop", false)}
      {st.starting
        ? (
          <span className="aisp-queue" role="status" title="启动中…">{queueInfo}{extra}</span>
        )
        : (
          <span className="aisp-queue">
            <span
              className="aisp-xy"
              title="点按弹出：跳转到任意消息（树形分组）"
              role="button"
              style={{ cursor: "pointer", borderBottom: "1px dotted var(--text-dim,#999)" }}
              onClick={(e) => { e.currentTarget.blur(); openMessagePicker(true); }}
            >{msgPos}/{msgTotal}</span>
            {item && <span aria-hidden> · </span>}
            {item && (
              drifted
                ? (
                  <span
                    className="aisp-ab aisp-ab-jump"
                    title="跳回当前朗读位置（不影响朗读）"
                    role="button"
                    onClick={(e) => { e.currentTarget.blur(); jumpBack(); }}
                  >{segPos}/{segTotal}</span>
                )
                : (
                  <span
                    className="aisp-ab"
                    title="点按弹出：跳转到任意消息"
                    role="button"
                    style={{ cursor: "pointer", borderBottom: "1px dotted var(--text-dim,#999)" }}
                    onClick={(e) => { e.currentTarget.blur(); openMessagePicker(true); }}
                  >{segPos}/{segTotal}</span>
                )
            )}
            {extra}
          </span>
        )}
      {drifted && (
        <span className="aisp-drift">
          <button
            title="从当前页第一条可见消息开始读"
            onClick={(e) => { e.currentTarget.blur(); if (sessionId) { try { resolveDrift(); startFollowFromPageTop(sessionId); } catch { /* noop */ } } }}
          >读本页</button>
        </span>
      )}
      <button className="aisp-btn" title={t("speek.settings")} onClick={(e) => { e.currentTarget.blur(); openSettings(true); }}>
        <Icon d={ICON.gear} size={14} />
      </button>
      <button className="aisp-btn" title="隐藏播放条（跟读继续）" onClick={(e) => { e.currentTarget.blur(); setBarVisible(false); }}>
        <Icon d="M18 6 6 18 M6 6l12 12" size={14} />
      </button>
    </div>
  );
  return (
    <>
      {createPortal(body, document.body)}
      <MessagePicker sessionId={sessionId} />
      <FailToast />
    </>
  );
}

// ── dialogs 设置面板 ─────────────────────────────────────────────────────

const PICKER_GROUP = 10; // 每组最多 10 个（叶子=消息，上层=子组）
/** 自底向上构建层级：先 10 个消息一组（叶子组）；组数 >10 → 把组列表再 10 个一组叠一层；类推。
 *  每节点 { start, end, children? }：start/end 为消息 1-based 区间；children 存在=组节点，不存在=叶子组。 */
/** 自底向上构建层级（组与叶同构：{ start, end, nodes }；叶 nodes=[]，组 nodes=子节点数组）。
 *  先 10 个消息一组；组数 >10 → 组列表再 10 个一组叠一层；类推。start/end = 消息 0-based 区间。 */
function buildLevels(len) {
  const levels = [];
  let cur = [];
  for (let i = 0; i < len; i += PICKER_GROUP) cur.push({ start: i, end: Math.min(i + PICKER_GROUP, len), nodes: [] });
  levels.push(cur);
  while (cur.length > PICKER_GROUP) {
    const nxt = [];
    for (let i = 0; i < cur.length; i += PICKER_GROUP) {
      const slice = cur.slice(i, i + PICKER_GROUP);
      nxt.push({ start: slice[0].start, end: slice[slice.length - 1].end, nodes: slice });
    }
    levels.push(nxt);
    cur = nxt;
  }
  return levels;
}
/** 递归渲染（同构）：node.nodes 非空=组（展开其 nodes）；nodes 空=叶（渲染消息行 start..end） */
function PickerNodes({ nodes, path, setPath, level, curIdx, onPick, summaries, loadGroup }) {
  return nodes.map((node) => {
    const isGroup = node.nodes && node.nodes.length > 0;
    const opened = path[level] === node.start;
    return (
      <div key={node.start} className="aisp-pk-group">
        <button
          className="aisp-pk-grpbtn"
          onClick={() => setPath((p) => { const np = p.slice(0, level); if (np[level] === node.start) np[level] = undefined; else np[level] = node.start; return np; })}
        >
          <span className="aisp-pk-caret">{opened ? "▾" : "▸"}</span>
          <span>消息 {node.start}–{node.end - 1} ·</span>
          <span className="aisp-pk-cnt">{isGroup ? node.nodes.length + " 组" : (node.end - node.start) + " 条"}</span>
        </button>
        {opened ? (
          <div className="aisp-pk-sub">
            {isGroup ? (
              <PickerNodes nodes={node.nodes} path={path} setPath={setPath} level={level + 1} curIdx={curIdx} onPick={onPick} summaries={summaries} loadGroup={loadGroup} />
            ) : (
              Array.from({ length: node.end - node.start }, (_, k) => {
                const j = node.start + k;
                const s = summaries[j];
                const short = s ? (s.replace(/\s+/g, " ").slice(0, 30) + (s.replace(/\s+/g, " ").length > 30 ? "…" : "")) : "";
                return (
                  <button
                    key={j}
                    className={"aisp-pk-item" + (j === curIdx ? " on" : "")}
                    onClick={() => onPick(j)}
                    onMouseEnter={() => loadGroup(node)}
                    title={s ? s.replace(/\s+/g, " ").slice(0, 120) : "（划过加载概要…）"}
                  >
                    <span className="aisp-pk-n2">消息 {j}</span>
                    {short ? <span className="aisp-pk-sum">{short}</span> : null}
                    {j === curIdx ? <span className="aisp-pk-cur">当前</span> : null}
                    <span className="aisp-pk-go">▸</span>
                  </button>
                );
              })
            )}
          </div>
        ) : null}
      </div>
    );
  });
}
// 模块级弹层开关（与 SettingsDialog 同模式）
let pickerOpen = false;
const pickerListeners = new Set();
function openMessagePicker(v) { pickerOpen = !!v; for (const l of pickerListeners) l(); }
function useMessagePicker() {
  const [open, setOpen] = useState(pickerOpen);
  useEffect(() => { const l = () => setOpen(pickerOpen); pickerListeners.add(l); return () => pickerListeners.delete(l); }, []);
  return open;
}

// ── 朗读失败提示 toast（播放条上方，5s 自动消失）───────────────────────────
function FailToast() {
  const st = useSpeekState();
  const ft = st.failToast;
  const [seen, setSeen] = useState(null);
  useEffect(() => { if (ft && ft.ts !== seen?.ts) setSeen(ft); }, [ft?.ts]);
  useEffect(() => {
    if (!seen || !seen.ts) return;
    const t = setTimeout(() => setSeen(null), 6000);
    return () => clearTimeout(t);
  }, [seen?.ts]);
  if (!seen) return null;
  return createPortal(
    <div className="aisp-toast" role="alert" onClick={() => setSeen(null)}>
      ⚠ {seen.text}
    </div>,
    document.body,
  );
}

function MessagePicker({ sessionId }) {
  const open = useMessagePicker();
  const st = useSpeekState();
  const list = (sessionId && st.msgList?.[sessionId]) ? st.msgList[sessionId] : [];
  const [path, setPath] = useState([]); // 已展开节点路径（每层节点的 start）
  const [summaries, setSummaries] = useState({}); // { [msgIdx]: text }——hover 按组补拉
  // hover 补拉：按叶组（node.start..end，≤10 条）一次请求；textCache 命中的直接取；后续组内 hover 零请求
  const loadGroup = (node) => {
    if (!sessionId || !node) return;
    const ids = [];
    const need = [];
    for (let j = node.start; j < node.end; j++) {
      const m = list[j];
      if (!m) continue;
      ids.push(m.id);
      const cached = st.textCache?.[sessionId]?.[m.id];
      if (cached) need.push(null); // 已有缓存（占位对齐）
      else need.push(m.id);
    }
    if (!ids.length) return;
    const toFetch = need.filter(Boolean);
    if (toFetch.length) {
      ensureTexts(sessionId, toFetch).then((tm) => {
        const up = {};
        ids.forEach((id, k) => {
          if (tm[id]) up[node.start + k] = st.textCache?.[sessionId]?.[id] || tm[id];
        });
        setSummaries((s) => ({ ...s, ...up }));
      }).catch(() => { /* 静默 */ });
    }
    // 已缓存的直接放进 summaries（立即显示）
    const fromCache = {};
    ids.forEach((id, k) => { if (st.textCache?.[sessionId]?.[id] != null) fromCache[node.start + k] = st.textCache[sessionId][id]; });
    if (Object.keys(fromCache).length) setSummaries((s) => ({ ...s, ...fromCache }));
  };
  const len = list.length;
  const levels = len ? buildLevels(len) : [];
  const top = levels.length - 1;
  // 打开时自动展开当前所在路径（自底向上定位：每层找含 curIndex 的节点）
  useEffect(() => {
    if (!open) { setPath([]); return; }
    if (st.curIndex < 0 || !levels.length) { setPath([]); return; }
    const p = [];
    let nodes = levels[top];
    for (let lv = top; lv >= 0; lv--) {
      const node = nodes.find((n) => st.curIndex >= n.start && st.curIndex < n.end);
      if (!node) break;
      p.push(node.start);
      if (!node.nodes || !node.nodes.length) break; // 到达末级（叶）→ 停止
      nodes = node.nodes;
    }
    setPath(p);
  }, [open]);
  if (!open || !list.length) return null;
  const onPick = (j) => {
    const m = list[j];
    try { jumpToMessage(j); } catch { /* noop */ }
    openMessagePicker(false);
    // 点击即跳转：强制滚动定位到该消息（无视 smart 5s 窗口；等 DOM 渲染后重试）
    if (m) {
      let tries = 0;
      const tick = () => {
        const el = document.querySelector('[data-entry-id="' + m.id + '"]');
        if (el) { try { jumpToPlayRow(el, "always"); } catch { /* noop */ } return; }
        if (++tries < 10) setTimeout(tick, 200);
      };
      tick();
    }
  };
  return createPortal(
    <div className="aisp-pk-overlay" onClick={() => openMessagePicker(false)}>
      <div
        className="aisp-pk"
        data-ext-float="1"
        data-ext-float-w={Math.min(360, (typeof window !== "undefined" ? window.innerWidth : 600) - 24)}
        data-ext-float-h={420}
        data-ext-float-full="1"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aisp-pk-hd">
          <span>跳转到消息（共 {len} 条 · 每组 {PICKER_GROUP}）</span>
          <button className="aisp-btn" onClick={() => openMessagePicker(false)} title="关闭">
            <Icon d="M18 6 6 18 M6 6l12 12" size={14} />
          </button>
        </div>
        <div className="aisp-pk-bd">
          {st.curIndex >= 0 && (
            <button className="aisp-pk-item on" onClick={() => onPick(st.curIndex)}>
              <span className="aisp-pk-n2">消息 {st.curIndex} · 当前播放位置</span>
            </button>
          )}
          <PickerNodes nodes={levels[top]} path={path} setPath={setPath} level={0} curIdx={st.curIndex} onPick={onPick} summaries={summaries} loadGroup={loadGroup} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SettingsDialog() {
  const open = useSettingsOpen();
  const st = useSpeekState();
  const s = st.settings;

  // 浏览器音色：异步 getVoices + voiceschanged
  useEffect(() => {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      const load = () => setVoices(sortBrowserVoices(synth.getVoices().filter((v) => /zh/i.test(v.lang || ""))));
      load();
      synth.addEventListener?.("voiceschanged", load);
      return () => synth.removeEventListener?.("voiceschanged", load);
    } catch { /* noop */ }
  }, []);
  // 打开设置面板即拉取 edge-tts 富状态（安装/版本/路径/提示）+ 朗读过程 feature 状态
  useEffect(() => { if (open) { fetchEdgeInfo(); } }, [open]);
  useEffect(() => { if (!st.processLoaded) fetchFeatures(); }, [st.processLoaded]);

  const useEdgeNow = resolvedEngine() === "edge";
  const browserVoices = st.voices || [];
  const edgeVoices = st.edgeVoices || [];
  const voices = useEdgeNow ? edgeVoices.map((v) => ({ name: v.id, label: v.label })) : browserVoices.map((v) => ({ name: v.name, label: v.name }));
  const edgeOk = !!(st.edgeStatus?.installed ?? st.edgeAvailable);
  // 切引擎：当前音色不在目标引擎列表时清空（避免跨引擎残留 / select 显示空白）
  const setEngine = (engine) => {
    const patch = { engine };
    const target = engine === "auto" ? (st.edgeAvailable ? edgeVoices : browserVoices) : (engine === "edge" ? edgeVoices : browserVoices);
    const cur = s.voice || "";
    if (cur) {
      const inList = target.some((v) => (v.id || v.name) === cur);
      if (!inList) patch.voice = "";
    }
    setSettings(patch);
  };

  if (!open) return null;
  const close = () => openSettings(false);

  return createPortal(
    <div className="aisp-dlg-overlay" onClick={close}>
      <div className="aisp-dlg aisp-dialog" role="dialog" aria-modal="true" data-ext-float="1" data-ext-float-w={560} data-ext-float-autoh="1" data-ext-float-full="1" onClick={(e) => e.stopPropagation()}>
        <div className="aisp-dlg-hd">
          <span>🔊 {t("speek.settings")}</span>
          <button className="aisp-btn" onClick={close} title="关闭">
            <Icon d="M18 6 6 18 M6 6l12 12" size={14} />
          </button>
        </div>
        <div className="aisp-dlg-bd">
          <div className="aisp-row">
            <label title="edge-tts 是微软 Edge 的服务端语音合成，音质比浏览器 Web Speech 更自然；已安装时默认优先使用">后端引擎（edge-tts）</label>
            <span className="aisp-badge" style={{ background: edgeOk ? "color-mix(in srgb,#16a34a 14%,transparent)" : "color-mix(in srgb,var(--danger, #ef4444) 16%,transparent)", color: edgeOk ? "#16a34a" : "var(--danger, #ef4444)" }}>
              {edgeOk ? "● 已安装" : "○ 未安装"}
            </span>
          </div>
          {st.edgeStatus?.installHint && (
            <div className="aisp-row" style={{ fontSize: 11, color: edgeOk ? "var(--text-dim,#888)" : "var(--danger, #ef4444)", marginTop: -4 }}>
              <span style={{ wordBreak: "break-all" }}>{st.edgeStatus.installHint}</span>
            </div>
          )}
          {edgeOk && st.edgeStatus?.featureOn === false && (
            <div className="aisp-row" style={{ color: "var(--danger, #ef4444)", fontSize: 11, marginTop: -4 }}>
              ⚠ tts.edge feature 未开启（可在扩展管理器开启；已装会自动开）
            </div>
          )}
          {!edgeOk && (
            <div className="aisp-row" style={{ fontSize: 11, color: "var(--text-dim,#888)", marginTop: -4 }}>
              点右上角 🤖，让 AI 按你的平台（Linux/macOS/Windows）帮我安装 edge-tts。
            </div>
          )}
          <div className="aisp-row" style={{ alignItems: "center" }}>
            <label title="留空自动探测 ~/.local/bin、PATH、pipx；Windows 可填 pip install 后的 Scripts 路径" style={{ flex: "0 0 auto" }}>edge-tts 路径（可空）</label>
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flex: "1 1 auto", minWidth: 0 }}>
              <input
                className="aisp-sel"
                type="text"
                style={{ flex: "1 1 auto", minWidth: 0, width: 260, maxWidth: "none" }}
                placeholder="自动探测"
                defaultValue={st.edgeStatus?.edgeBin ?? ""}
                key={st.edgeStatus?.edgeBin ?? ""}
                onBlur={(e) => setEdgeBinPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              />
              <button className="aisp-btn" style={{ flexShrink: 0, width: "auto", minWidth: 0, padding: "0 8px", whiteSpace: "nowrap", height: 28 }} title="绕过缓存重新探测 edge-tts（AI 刚帮你装好时点这个）" onClick={async () => { await setEdgeBinPath((st.edgeStatus?.edgeBin ?? "")); fetchEdgeInfo(true); }}>重新探测</button>
            </span>
          </div>
          <div className="aisp-row">
            <label title="自动：edge-tts 已装则优先用它（效果好），否则浏览器">引擎（切换音色即试听）</label>
            <span className="aisp-seg">
              <button className={s.engine === "auto" ? "on" : ""} onClick={() => setEngine("auto")}>自动</button>
              <button className={s.engine === "browser" ? "on" : ""} disabled={st.browserUnsupported} onClick={() => setEngine("browser")}>浏览器</button>
              <button className={s.engine === "edge" ? "on" : ""} disabled={!st.edgeAvailable} onClick={() => setEngine("edge")}>edge-tts</button>
            </span>
          </div>
          {st.browserUnsupported && (
            <div className="aisp-row" style={{ color: "var(--danger, #ef4444)", fontSize: 11 }}>
              ⚠ 当前浏览器不支持本地朗读（Web Speech），已自动切换到服务端语音生成（edge-tts）。
            </div>
          )}
          <div className="aisp-row">
            <label>音色</label>
            <select className="aisp-sel" value={s.voice || ""} onChange={(e) => { const v = e.target.value; setSettings({ voice: v }); if (v) previewVoice(v); }}>
              <option value="">{useEdgeNow ? (edgeVoices[0] ? "默认（" + String(edgeVoices[0].label).split("·")[0].trim() + "）" : "默认") : "浏览器默认中文"}</option>
              {voices.map((v) => (
                <option key={v.name} value={v.name}>{v.label}</option>
              ))}
            </select>
          </div>
          <div className="aisp-row">
            <label title="把 AI 的中间叙述也读出来（如「让我看一下…」「我先确认…」）；跳过思考与工具执行">朗读过程</label>
            <input type="checkbox" checked={!!st.processOn} onChange={() => toggleProcess()} />
          </div>
          <div className="aisp-row">
            <label>朗读内容</label>
            <span className="aisp-seg">
              <button className={s.mode === "full" ? "on" : ""} onClick={() => setSettings({ mode: "full" })}>全文概要化</button>
              <button className={s.mode === "essentials" ? "on" : ""} onClick={() => setSettings({ mode: "essentials" })}>仅要点</button>
            </span>
          </div>
          <div className="aisp-row">
            <label>语速</label>
            <span className="aisp-seg">
              {[0.75, 1, 1.25, 1.5, 2].map((r) => (
                <button key={r} className={s.rate === r ? "on" : ""} onClick={() => setSettings({ rate: r })}>{r}x</button>
              ))}
            </span>
          </div>
          {s.engine === "edge" && !st.edgeAvailable && (
            <div className="aisp-row" style={{ color: "var(--danger, #ef4444)", fontSize: 11 }}>
              ⚠ edge-tts 后端未就绪（未装或 feature 未开启），将自动回落浏览器朗读。
            </div>
          )}
          <div className="aisp-row">
            <label>忽略短回复（少于 N 字不读）</label>
            <input
              className="aisp-sel"
              type="number"
              min={0}
              max={200}
              value={String(s.minChars ?? 8)}
              onChange={(e) => setSettings({ minChars: Math.max(0, parseInt(e.target.value, 10) || 0) })}
            />
          </div>
          <div className="aisp-row">
            <label>开启跟读时注入「朗读模式」提示词（让 AI 输出自带朗读优化）</label>
            <input type="checkbox" checked={!!s.steer} onChange={(e) => setSettings({ steer: e.target.checked })} />
          </div>
          <div className="aisp-row">
            <label title="浏览器标签页切换到后台时，是否允许继续朗读（默认会暂停）">允许后台继续朗读</label>
            <input type="checkbox" checked={!!s.backgroundContinue} onChange={(e) => setSettings({ backgroundContinue: e.target.checked })} />
          </div>
          <div className="aisp-row" style={{ fontSize: 11, color: "var(--text-dim,#999)" }}>
            队列语义：新回复进队尾不打断当前朗读；⏹ 停止清队列；关闭 🔊 即恢复纯阅读。
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export { SettingsDialog };

// ═══ [D2 拆包] 重 chunk 自注册（薄壳首载本模块时调用一次）═══
// pages/sessionTopbar/dialogs/assistantMessageActions 全量重注册——PlaybackBar/
// SettingsDialog/AssistantMessageAction 只在跟读开启后有意义，延迟注册零体验损失；
// HeavyFollowToggle 接管薄壳按钮（点击后的状态机/订阅/恢复全走真实实现）。
export function initHeavySlots(ctx) {
  ctx.registerItems?.("toolbar", [
    { id: "follow", render: HeavyFollowToggle, meta: { label: "跟读模式", title: "跟读模式：AI 回复自动朗读", icon: "icons/volume-2.svg" } },
  ]);
  ctx.registerItems?.("assistantMessageActions", [
    { id: "read", render: AssistantMessageAction, meta: { label: "开始朗读" } },
  ]);
  ctx.registerItems?.("sessionTopbar", [
    { id: "bar", render: PlaybackBar, meta: { label: "跟读播放条" } },
  ]);
  ctx.registerItems?.("dialogs", [
    { id: "settings", render: SettingsDialog, meta: { label: "跟读设置" } },
  ]);
}
