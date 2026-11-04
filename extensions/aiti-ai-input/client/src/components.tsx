/**
 * AI input · 渲染组件（JSX 版，自手写 h() 版一比一迁移）。
 *
 * 四个 chatInputTop slot 组件：
 *   VoiceTagBar     语音/高速输入感知条（🎤 正在检查修复）
 *   MarksBar        已插 [名称] 占位符 chips（点击编辑 / ✕ 摘除）
 *   AutocompleteHost 行内自动补全宿主（挂全局监听 + 建议条容器 #aiti-sug-bar）
 *   SuggestHost      收藏联想宿主（键盘/输入监听；处理器由 initSuggest 注入）
 */
import { useState, useEffect, useRef } from "react";
import { apiUrl, extSvc } from "./host-shim";
import {
  AC, BARP, isChatInput, anchorMoved,
  acFeatures, acReschedule, acHandleKey, acClearGhost, acClearTimer, acAbort,
  acUpdateCoarse, barRemoveMark, setVoicePending, subscribeVoice, isVoicePending, setAcBar,
} from "./logic";
// L2 录音引擎懒加载（薄壳拆分 §5.2）：首次按住 🎤 才拉 voice-l2 chunk 并安装
import { createLazyModule } from "../../../_shared/ext-lazy";

const voiceL2Ref = createLazyModule(() => import("./voice-l2").then((m) => ({ install: m.installVoiceL2 })));
/** 确保引擎已安装（幂等；安装完成 resolve）。press 手势先行置态，引擎就绪后再 start。 */
function ensureVoiceL2(): Promise<void> {
  return voiceL2Ref.load().then((m) => m.install()).catch(() => {});
}

// 语音感知条（chatInputTop）：识别到语音 → 提示正在检查/修复（无歧义自动消失，有歧义下方给替换建议）
export function VoiceTagBar() {
  const [v, setV] = useState(isVoicePending());
  useEffect(() => subscribeVoice(() => setV(isVoicePending())), []);
  if (!v || !AC.feats.voiceIndicator) return null;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 6, width: "100%",
      padding: "5px 10px", fontSize: 11, borderRadius: 8, marginBottom: 4, lineHeight: 1.45,
      background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.25)", color: "var(--text)",
    }}>
      <span style={{ flexShrink: 0, display: "inline-flex" }}>
        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path key="p1" d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path key="p2" d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <path key="p3" d="M12 19v3" />
        </svg>
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        识别到快速大量输入 · 正在帮你检查修复转写错误（有歧义下方会给出替换建议，无歧义自动忽略）
      </span>
      <button onClick={(e) => { e.stopPropagation(); setVoicePending(false); }}
        title="不再为此条语音/高速输入提示修复"
        style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", color: "inherit", opacity: 0.7, padding: "2px 4px", fontSize: 12, lineHeight: 1, display: "inline-flex" }}>
        <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path key="p1" d="M18 6 6 18" />
          <path key="p2" d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  );
}

// 自动补全宿主组件（chatInputTop 第二个 item，无 UI）：挂全局监听 + 读 extra props。
// textareaRef/setInputValue 已服务化（宿主 extra 不再喂回调，slot extra 回调解耦方案
// 批次 B 2026-09-16）：经 "pi-web.composer" 服务兜底合并进 AC.extra（props 显式键优先）。
function composerSvcFallback(): Record<string, unknown> {
  try {
    const svc = extSvc<{ get?: (name: string) => unknown }>("pi-web.composer");
    if (!svc?.get) return {};
    const out: Record<string, unknown> = {};
    for (const k of ["textareaRef", "setInputValue", "focusComposer"]) {
      const v = svc.get(k);
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  } catch { return {}; }
}
export function AutocompleteHost(props: Record<string, unknown>) {
  AC.extra = { ...composerSvcFallback(), ...props }; // 每渲染更新（含 cwd/isStreaming/menuOpen/model + 服务兜底回调）
  useEffect(() => {
    setAcBar(document.getElementById("aiti-sug-bar"));
    acUpdateCoarse();
    const onViewChange = () => { acUpdateCoarse(); };
    document.addEventListener("resize", onViewChange);
    document.addEventListener("orientationchange", onViewChange);
    const onInput = (e: Event) => {
      if (!isChatInput(e.target)) return; // 仅目标输入框
      acFeatures(false).then(() => { if (AC.feats.autoComplete) acReschedule(); });
    };
    const onKeyDown = (e: KeyboardEvent) => acHandleKey(e);
    const onComposition = (e: Event) => {
      if (e.type === "compositionstart") AC.composing = true;
      else if (e.type === "compositionend") { AC.composing = false; AC.lastCompEnd = performance.now(); }
    };
    // fixed overlay 锚定 textarea：聊天区流式滚动不改输入框的屏幕位置 → 灰字不失效；
    // 锚点真移动（软键盘弹起/布局变化）才清（否则 AI 一有新输出灰字就被误杀）
    const onScroll = () => { if (anchorMoved(AC.anchor)) acClearGhost(); };
    const onBlur = (e: Event) => { if (isChatInput(e.target)) { acClearTimer(); acClearGhost(); } };
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("compositionstart", onComposition, true);
    document.addEventListener("compositionend", onComposition, true);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("blur", onBlur, true);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("compositionstart", onComposition, true);
      document.removeEventListener("compositionend", onComposition, true);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("blur", onBlur, true);
      document.removeEventListener("resize", onViewChange);
      document.removeEventListener("orientationchange", onViewChange);
      acClearTimer();
      acAbort();
      acClearGhost();
      if (AC.overlay) { AC.overlay.remove(); AC.overlay = null; }
      if (AC.mirror) { AC.mirror.remove(); AC.mirror = null; }
      setAcBar(null);
      AC.extra = null;
    };
  }, []);
  return (
    <div id="aiti-sug-bar" data-ac-bar="1" style={{
      display: "none", width: "100%", boxSizing: "border-box",
      margin: "0 0 6px", padding: 0,
      flexWrap: "wrap", gap: 6, alignItems: "center",
    }} />
  );
}

// 待选区（已插占位符 chips）：显示 [名称]、✕ 摘除、点击打开编辑/查看（收藏可存回 provider）
export function MarksBar() {
  const [marks, setMarks] = useState<Array<Record<string, any>>>([]);
  const [edit, setEdit] = useState<Record<string, any> | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const notif = () => setMarks(BARP.marks.filter((m: any) => {
    const ta = document.querySelector("textarea[data-chat-input]");
    return ta ? ta.value.includes(m.mark) : false;
  }));
  useEffect(() => {
    const onInput = () => notif();
    document.addEventListener("input", onInput, true);
    // 程序化写值（发送清空/草稿还原/composer 契约写值）刻意不经 input 事件——
    // 宿主 writeTextareaValue 统一广播 pi-web:composer-value-written 扩展点，订阅即可，零轮询
    const onProgrammatic = () => notif();
    window.addEventListener("pi-web:composer-value-written", onProgrammatic);
    notif();
    return () => {
      document.removeEventListener("input", onInput, true);
      window.removeEventListener("pi-web:composer-value-written", onProgrammatic);
    };
  }, []);
  if (edit) {
    return (
      <div style={{
        position: "fixed", left: 0, top: 0, right: 0, bottom: 0, zIndex: 2147483001,
        background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center",
      }} onClick={() => { if (!saving) setEdit(null); }}>
        <div style={{
          width: "min(86vw, 480px)", boxSizing: "border-box", padding: 14, borderRadius: 12,
          background: "var(--bg-panel, #f5f5f5)", border: "1px solid var(--border, #e0e0e0)",
          color: "var(--text, #1a1a1a)", fontSize: 13,
        }} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{(edit.type === "cmd" ? "命令：" : "收藏：") + edit.name}</div>
          {edit.type === "prompt"
            ? <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6}
                style={{ width: "100%", boxSizing: "border-box", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", border: "1px solid var(--border)", borderRadius: 8, padding: 8, fontSize: 13, lineHeight: 1.5 }} />
            : <div style={{ whiteSpace: "pre-wrap", opacity: .85, lineHeight: 1.5 }}>{edit.text}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
            <button onClick={() => setEdit(null)} style={{ padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg,#fff)", cursor: "pointer" }}>取消</button>
            {edit.type === "prompt" ? (
              <button onClick={async () => {
                setSaving(true);
                try {
                  const r = await fetch(AC.apiUrl("/api/extensions/aiti-prompts/prompts/" + edit.id), {
                    method: "PUT", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text: draft }),
                  });
                  if (r.ok) {
                    const m = BARP.marks;
                    const idx = m.findIndex((x: any) => x.mark === edit.mark);
                    if (idx >= 0) { m[idx].text = draft; BARP.markMap[edit.mark] = draft; }
                    setEdit(null); setSaving(false);
                  }
                } catch {}
                setSaving(false);
              }} style={{ padding: "6px 12px", border: "none", borderRadius: 8, background: "var(--accent,#2563eb)", color: "#fff", cursor: "pointer" }}>{saving ? "保存中…" : "保存"}</button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
  if (!marks.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, width: "100%", marginBottom: 4 }}>
      {marks.map((m) => (
        <span key={m.mark} style={{
          display: "inline-flex", alignItems: "center", gap: 4,
          background: "var(--bg,#fff)", border: "1px solid var(--accent,#2563eb)", color: "var(--text,#1a1a1a)",
          borderRadius: 999, padding: "3px 8px 3px 10px", fontSize: 12, lineHeight: 1.4, whiteSpace: "nowrap",
        }}>
          <span style={{ fontSize: 10, color: "var(--accent,#2563eb)", marginRight: 2 }}>{m.type === "cmd" ? "命令" : "收藏"}</span>
          <button onClick={(e) => { e.stopPropagation(); setEdit(m); setDraft(m.text); setSaving(false); }}
            style={{ border: "none", background: "none", color: "var(--text,#1a1a1a)", cursor: "pointer", fontSize: 12, padding: 0, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {m.name}
          </button>
          {/* 摘除后 chip 重渲染移出 DOM，合成 click 会穿透到下方元素 —— 同 acBarRow 拦冒泡 */}
          <button onClick={(e) => { e.stopPropagation(); barRemoveMark(m); notif(); }}
            style={{ border: "none", background: "none", color: "var(--text-dim,#9ca3af)", cursor: "pointer", fontSize: 12, padding: "0 2px", lineHeight: 1 }}>✕</button>
        </span>
      ))}
    </div>
  );
}

// 收藏联想宿主：sug 处理器由 initSuggest(ctx.apiUrl) 创建、entry 装配时传入
export function SuggestHost({ sug }: { sug: { onInput: (e: Event) => void; onKeyDown: (e: KeyboardEvent) => void; sugClose: () => void; SUG: { timer: any; ta: HTMLTextAreaElement | null; items: any[]; anchor: { ta: HTMLTextAreaElement; left: number; top: number; scrollTop: number } | null } } }) {
  useEffect(() => {
    const onInput = (e: Event) => sug.onInput(e);
    const onKeyDown = (e: KeyboardEvent) => sug.onKeyDown(e);
    // 真实输入法 compositionend 后无 input:N 事件 → 组合上屏靠它补一次联想排程
    // （compositionend 的 isComposing 为 undefined，能通过 sugOnInput 的检查正常排程）
    const onComposition = (e: Event) => { if (e.type === "compositionend") sug.onInput(e); };
    const onBlur = (e: Event) => { if (isChatInput(e.target)) setTimeout(sug.sugClose, 150); };
    // 候选面板/建议条 fixed 锚定 textarea：聊天区流式滚动不改输入框的屏幕位置 →
    // 候选词不消失（AI 一有新输出、聊天区一滚就 sugClose = 正在浏览的候选被误杀）；
    // 锚点真移动（软键盘弹起/布局变化）才关闭
    const onScroll = () => {
      if (sug.SUG.ta && sug.SUG.items.length && !anchorMoved(sug.SUG.anchor)) return;
      sug.sugClose();
    };
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("compositionend", onComposition, true);
    document.addEventListener("blur", onBlur, true);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("compositionend", onComposition, true);
      document.removeEventListener("blur", onBlur, true);
      document.removeEventListener("scroll", onScroll, true);
      if (sug.SUG.timer) clearTimeout(sug.SUG.timer);
      sug.sugClose();
    };
  }, []);
  return null;
}

// ---------------------------------------------------------------- 会话统计下拉 · 其他辅助 AI 用量统计行
// （原宿主 components/AiUsageRows.tsx 整块迁入：宿主只放开 sessionStats 插槽，本扩展自渲染）

interface AuxAiUsageData {
  totals?: { in: number; out: number; cacheRead: number; cacheWrite: number; calls: number };
  byCaller?: Record<string, number>;
  /** ?session= 查询时附带：进程存活期内全部会话累计（区分口径，防误读为当前会话） */
  global?: { in: number; out: number; cacheRead: number; cacheWrite: number; calls: number };
}

/**
 * 其他辅助 AI 用量统计（core invokeAI 集中记账；按场景分：续写 / 语音修正）。
 *
 * 口径：传 sessionId 时明细/合计 = 本会话；另附一行「全部会话累计」（进程级，重启清零）。
 * 不传 sessionId 时退化为全局累计。
 *
 * 刷新时机：仅在面板打开（插槽挂载）时拉取一次，零轮询——统计是回看性数据，
 * 重新打开面板即得最新值。
 */
export function AuxAiUsageRows({ locale, sessionId }: { locale?: string; sessionId?: string | null } & Record<string, unknown>) {
  const loc = typeof locale === "string" ? locale : "en";
  const [aiUsage, setAiUsage] = useState<AuxAiUsageData | null>(null);
  useEffect(() => {
    let alive = true;
    const url = apiUrl(sessionId
      ? `/api/chat/ai-usage?session=${encodeURIComponent(String(sessionId))}`
      : "/api/chat/ai-usage");
    const load = () => fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setAiUsage({ totals: d.totals, byCaller: d.byCaller, global: d.global }); })
      .catch(() => {});
    load(); // 打开面板拉一次，零轮询
  }, [sessionId]);

  const bc = aiUsage?.byCaller || {};
  const rows: string[][] = [];
  const sceneLabel = (k: string) => k.includes("/voice-fix") ? "AI 语音修正" : k.includes("/complete") ? "AI 续写" : k;
  for (const [k, v] of Object.entries(bc)) {
    if (!k.startsWith("aiti-ai-input")) continue; // 只展示本扩展（补全/语音）场景
    rows.push([sceneLabel(k), `${v.toLocaleString(loc)} in`]);
  }
  if (aiUsage?.totals?.calls) {
    const tot = aiUsage.totals;
    rows.push([sessionId ? "本会话合计" : "AI 合计", `${tot.in.toLocaleString(loc)} in / ${tot.out.toLocaleString(loc)} out · ${tot.calls} 次`]);
  } else if (sessionId) {
    rows.push(["本会话合计", "本会话暂无 AI 调用"]);
  }
  if (rows.length === 0) return null;
  const g = aiUsage?.global;
  const fmtCalls = (n: number) => `${n.toLocaleString(loc)} 次`;

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>其他辅助 AI 用量</div>
      <div style={{ display: "grid", gridTemplateColumns: "max-content max-content", columnGap: 14, rowGap: 4, justifyContent: "start" }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
            <div style={{ color: "var(--text-muted)", minWidth: 0, overflowWrap: "normal", textAlign: "right", whiteSpace: "nowrap" }}>{value}</div>
          </div>
        ))}
        {g && g.calls > 0 && (
          <div style={{ display: "contents" }}>
            <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>全部会话累计</div>
            <div style={{ color: "var(--text-dim)", minWidth: 0, textAlign: "right", whiteSpace: "nowrap", fontSize: 10.5 }}>{g.in.toLocaleString(loc)} in · {fmtCalls(g.calls)}（进程级）</div>
          </div>
        )}
      </div>
    </div>
  );
}


// ── composerAffix 行内 🎤（小屏右端条件组 + 大屏输入框尾部 affix 组共用，docs/pi-web-mobile-input-wechat-plan.md §3.2）──
// 位置：输入框内右缘 affix 位（core 仅在「空输入」渲染本插槽；有内容时该位是 core 自有
// ×清空——互斥由「空/有内容」派生天然保证）。按住说话：native listeners（passive:false
// 从源头抑制长按选词/滚动）+ window.__aitiVoiceInputL2 引擎（与旧桌面浮层按钮同一引擎：
// WS 流式出字 / 2-pass 精修 / 上滑取消全在引擎层，此处只做触发与视觉）。
// 桌面鼠标通道：mousedown 在钮上起录，mousemove/mouseup 挂 window 捕获——拖出钮外/松在钮外都能收尾，上滑取消同语义。
// 录音中：行内按钮变红脉动作位置锚提示 + body 级原生 DOM 长条 pill（计时/上滑取消，
// 220px，不迁 React——与桌面浮层同款视觉，wave/pulse keyframes 由 entry 注入的样式提供）。
// feature 门控：voice.enabled 关 → null（S29）；AC.onFeatureChange 触发重渲染即时卸载。

export function VoiceAffixButton() {
  const [featOn, setFeatOn] = useState(AC.feats.voiceEnabled === true);
  const [rec, setRec] = useState<{ cancel: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const startRef = useRef(0);
  const stRef = useRef({ active: false, startY: 0, cancel: false, done: false });

  useEffect(() => {
    if (!AC.onFeatureChange) return;
    (AC.onFeatureChange as unknown as (fn: () => void) => void)(() => setFeatOn(AC.feats.voiceEnabled === true));
  }, []);

  useEffect(() => {
    if (!featOn) return;
    const el = btnRef.current;
    if (!el) return;
    const st = stRef.current;
    const pointY = (e: any) => (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY) || 0;
    const notify = () => setRec(st.active && !st.done ? { cancel: st.cancel } : null);
    const press = (e: Event) => {
      if (st.active) return;
      const ce = e as Event & { cancelable: boolean };
      if (ce.cancelable) { try { ce.preventDefault(); } catch {} }
      try { ce.stopPropagation(); } catch {}
      // 薄壳拆分（§5.2）：手势先行置态（move/finish 语义不变），引擎 chunk 就绪后 start——
      // 首次按住有一次 chunk 加载延迟（本地文件，毫秒级）；松手早于就绪的兜底见 ensure 回调。
      st.done = false; st.active = true; st.cancel = false; st.startY = pointY(ce);
      startRef.current = Date.now();
      notify();
      void ensureVoiceL2().then(() => {
        const l2 = (window as any).__aitiVoiceInputL2 as
          { start: () => void; stop: () => void; cleanup?: () => void } | undefined;
        if (!l2) return;
        if (st.active && !st.done) { l2.start(); return; }
        if (st.done && !st.cancel) { try { l2.start(); l2.stop(); } catch { /* 引擎收尾自洽 */ } }
        // done && cancel：取消手势，引擎无需启动
      });
    };
    const move = (e: Event) => {
      if (!st.active || st.done) return;
      const ce = e as Event & { cancelable: boolean };
      if (ce.cancelable) { try { ce.preventDefault(); } catch {} }
      const shouldCancel = pointY(ce) - st.startY < -50;
      if (st.cancel !== shouldCancel) { st.cancel = shouldCancel; notify(); }
    };
    const finish = (e?: Event) => {
      if (!st.active || st.done) return;
      st.done = true; st.active = false;
      if (e) {
        const ce = e as Event & { cancelable: boolean };
        if (ce.cancelable) { try { ce.preventDefault(); } catch {} }
        try { e.stopPropagation(); } catch {}
      }
      const l2 = (window as any).__aitiVoiceInputL2;
      const cancel = st.cancel;
      st.cancel = false;
      if (l2) {
        if (cancel) {
          try { l2.cancel(); } catch {}
          // 取消：立即摘声纹窗口 + 候选面板（与桌面浮层同语义）
          try { l2.cleanup && l2.cleanup(); } catch {}
        } else {
          try { l2.stop(); } catch {}
        }
      }
      notify();
    };
    // ⓘ sheet 打开等宿主互斥信号：录音中 → 先取消（S28）
    const onHostCancel = () => { if (st.active && !st.done) { st.cancel = true; finish(); } };
    const onCtx = (e: Event) => { try { e.preventDefault(); e.stopPropagation(); } catch {} };
    el.addEventListener("touchstart", press, { passive: false } as AddEventListenerOptions);
    el.addEventListener("touchmove", move, { passive: false } as AddEventListenerOptions);
    el.addEventListener("touchend", (e) => finish(e));
    el.addEventListener("touchcancel", (e) => finish(e));
    el.addEventListener("mousedown", press);
    el.addEventListener("contextmenu", onCtx, { passive: false } as AddEventListenerOptions);
    // 桌面鼠标通道：move/up 挂 window 捕获（与小屏 touch 通道同语义：上滑取消、松手发送）
    const onWinMove = (e: MouseEvent) => { if (st.active && !st.done) move(e); };
    const onWinUp = (e: MouseEvent) => { if (st.active && !st.done) finish(e); };
    window.addEventListener("mousemove", onWinMove, true);
    window.addEventListener("mouseup", onWinUp, true);
    window.addEventListener("pi-web:composer-affix-cancel", onHostCancel);
    return () => {
      // 卸载（feature 关/插槽消失）：在途录音先收尾，防麦克风常开
      if (st.active && !st.done) { st.cancel = true; finish(); }
      el.removeEventListener("touchstart", press);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("mousedown", press);
      el.removeEventListener("contextmenu", onCtx);
      window.removeEventListener("mousemove", onWinMove, true);
      window.removeEventListener("mouseup", onWinUp, true);
      window.removeEventListener("pi-web:composer-affix-cancel", onHostCancel);
    };
  }, [featOn]);

  // 录音 pill：body 级原生 DOM（原生创建/销毁，不进宿主 React 容器）；rAF 每秒直写计时
  useEffect(() => {
    if (!rec) return;
    const cancel = rec.cancel;
    const pill = document.createElement("div");
    pill.id = "aiti-voice-affix-pill";
    pill.setAttribute("role", "status");
    Object.assign(pill.style, {
      position: "fixed", zIndex: "2147483000", left: "50%", top: "calc(100vh - 170px)",
      transform: "translateX(-50%)", width: cancel ? "240px" : "220px", height: "52px",
      borderRadius: "26px", background: cancel ? "#f59e0b" : "#ef4444", color: "#fff",
      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "8px",
      fontSize: "14px", lineHeight: "52px", whiteSpace: "nowrap", textAlign: "center",
      boxShadow: "0 6px 24px rgba(0,0,0,0.25)",
      animation: cancel ? "" : "aiti-voice-pulse 1.2s infinite",
    } as Partial<CSSStyleDeclaration>);
    pill.innerHTML = (cancel
      ? '<span style="font-size:18px">👆</span> 松手取消'
      : '<span class="aiti-voice-wave"><span></span><span></span><span></span><span></span><span></span></span> <span id="aiti-voice-affix-timer">录音中 00:00</span> 上移取消');
    document.body.appendChild(pill);
    let raf = 0;
    let lastSec = -1;
    const tick = () => {
      const span = document.getElementById("aiti-voice-affix-timer");
      if (span) {
        const sec = Math.floor((Date.now() - startRef.current) / 1000);
        if (sec !== lastSec) {
          lastSec = sec;
          span.textContent = `录音中 ${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { try { cancelAnimationFrame(raf); } catch {} try { pill.remove(); } catch {} };
  }, [rec]);

  if (!featOn) return null;
  return (
    <button
      ref={btnRef}
      type="button"
      id="aiti-voice-affix"
      data-composer-affix="1"
      aria-label="按住说话"
      title="🎤 按住说话"
      style={{
        width: 32,
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        background: "none",
        border: "none",
        borderRadius: 9,
        color: rec ? (rec.cancel ? "#f59e0b" : "#ef4444") : "var(--text-muted)",
        cursor: "pointer",
        touchAction: "none",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        animation: rec && !rec.cancel ? "aiti-voice-pulse 1.2s infinite" : undefined,
        transition: "color 0.12s",
      } as React.CSSProperties}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="22" />
      </svg>
    </button>
  );
}
