/**
 * session-manager · 各 slot 入口组件（sidebar/toolbar/pages 触发器）。
 * 自手写版迁移，样式与交互一比一。
 */
import { useState, useEffect, useRef, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { t } from "./host-shim";
import {
  store, useStore, panelOpen, kanbanOpen,
  refreshRunning, refreshSessions, emit, setPendingSearch, displayCwd,
  applyRunningFrame, subscribeRunningFrames, isRunningSseHealthy,
} from "./store";
import { sessionTitle, agentBadge, fmtRelative } from "./helpers";

export function SidebarEntry() {
  const s = useStore();
  // [通道拆分] 启动宽限基准：本组件挂载 ≈ 扩展 materialize 时刻；2500ms 内的运行帧
  // 不联动全量列表刷新（首帧快照交给延后全量定时器，避免抢占快通道）。
  const bootAtRef = useRef(Date.now());
  // 运行徽标只需 running 集合。主通道走宿主页面级共享 broker（/api/agent/running/events
  // 单例连接，pi-web agent-running-events.ts）——不再各开一条 EventSource；15s 慢轮询仅作
  // broker 断连/静默超时兜底。后台隐藏时退订、暂停兜底，回前台立即对齐一次。
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsub: (() => void) | null = null;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

    // 共享 broker 订阅（宿主页面级单例连接，broker 不投递 heartbeat 帧——健康时钟靠运行帧驱动）；
    // 旧宿主无 broker 时回退原生 EventSource（该回退分支内部自带 heartbeat→markRunningHeartbeat + CLOSED 重建）。
    const subscribe = () => {
      if (stopped || unsub) return;
      unsub = subscribeRunningFrames((frame) => {
        if (stopped) return;
        if (frame?.type === "running" && Array.isArray(frame.runningSessionIds)) {
          // SSE 权威帧：总是落地；变化时触发列表刷新（行元数据多半已变）。
          // 新 id 出现（新会话开始跑，如子代理 fork 启动）→ 升级 refresh=1 绕服务端
          // 5s 扫描缓存——此刻 jsonl 刚落盘/正要落盘，普通刷新命中缓存拿不到新行。
          // [通道拆分] 启动宽限：首个快照帧（订阅建立即拉）在快通道（workspaces/scoped）
          // 落地前不联动全量 refresh=1——否则注册后 1s 内就把 1MB 全量装配压上事件循环、
          // 拖慢项目 picker 首屏（workspaces 被并发全量阻塞 0.75s+，实测）。
          // 启动全量由 dock/entry 的延后定时器负责，运行帧只管增量。
          const bootGrace = Date.now() - bootAtRef.current < 2500;
          if (!bootGrace) {
            const hasNewId = (frame.runningSessionIds as string[]).some((id) => !store.running.has(id));
            const changed = applyRunningFrame(frame.runningSessionIds as string[]);
            if (changed) void refreshSessions({ refresh: hasNewId });
          } else {
            // 宽限内只落地运行集（running 转圈/蓝点需要），不联动列表刷新
            applyRunningFrame(frame.runningSessionIds as string[]);
          }
          emit();
        }
      });
    };

    // 兜底轮询：SSE 静默/断连 → 30s 快拍恢复；SSE 健康 → 60s 慢对账（同宿主
    // SessionSidebar RUNNING_RECONCILE_POLL_MS 既有拍子）。对账不是无脑覆盖：快照走
    // 捕获时间门控（store.applyRunningSnapshot）+ 内容差异写入，稳态零请求落地零渲染——
    // 它兑的是「变更帧在传输层被丢一帧且永不重放」的窗口（如总线白名单竞态）：心跳
    // 只能证明传输活着，内容对账才能纠偏陈旧运行集（2026-11-06「结束后运行状态
    // 很久不刷新」修复，丢帧场景 ≤60s 自愈）。
    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const healthy = isRunningSseHealthy();
      await refreshRunning();
      if (stopped) return;
      clearTimer();
      timer = setTimeout(() => void poll(), healthy ? 60000 : 30000);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        subscribe();
        void poll(); // 回前台立即对齐一次快照（SSE 事件可能在后台丢帧）
      } else {
        if (unsub) { unsub(); unsub = null; }
        clearTimer();
      }
    };

    void refreshRunning(); // 首帧快照
    subscribe();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      if (unsub) { unsub(); unsub = null; }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  // 运行徽标计数只统计「列表可见的运行中会话」。store.running 可能含不可见 id
  //（如 TUI 桥在跑的嵌套 fork 子代理：有独立 jsonl 文件、bridge 计为 running，
  // 但列表扫描不扫 /forks/ 嵌套路径 → 无对应会话行）。若直接取 s.running.size，
  // 会比下拉/列表多计（实测：按钮报 6、下拉只有 5）。口径统一为 running ∩ 会话列表。
  const runningSessionById = new Map<string, unknown>((Array.isArray(s.sessions) ? s.sessions : []).map((x: any) => [String(x.id), x]));
  const runningCount = [...s.running].filter((id) => runningSessionById.has(String(id))).length;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const toggle = () => {
    if (!open) {
      // 下拉需要会话元数据（标题/cwd），打开时拉一次合并列表；运行集合由上方
      // SSE + 首帧快照持续对齐。refreshSessions 带并发合流 + 最小间隔节流。
      setAnchor(btnRef.current ? btnRef.current.getBoundingClientRect() : null);
      void refreshSessions();
    }
    setOpen(!open);
  };

  return (
    <>
      <button
        ref={btnRef}
        data-sidebar-sessions-trigger="1"
        title={t("sm.runningSessions")}
        onClick={toggle}
        style={{
          display: "flex", alignItems: "center", gap: 5,
          height: 30, padding: "0 10px", marginRight: 6,
          background: open ? "var(--bg-selected)" : "var(--bg-hover)",
          border: "1px solid var(--border)",
          borderRadius: 7, color: open ? "var(--accent)" : "var(--text-muted)", cursor: "pointer",
          fontSize: 11, flexShrink: 0,
        }}
      >
        <svg key="ico" width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path key="p1" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path key="p2" d="M13 8H7" />
          <path key="p3" d="M17 12H7" />
        </svg>
        {runningCount > 0 && (
          <span
            key="cnt"
            style={{
              minWidth: 16, padding: "0 4px", borderRadius: 8, textAlign: "center",
              background: "rgba(37,99,235,0.18)", color: "var(--accent)", fontSize: 10,
            }}
          >{String(runningCount)}</span>
        )}
      </button>
      {open && anchor && (
        <SidebarSessionsMenu anchor={anchor} onClose={close} />
      )}
    </>
  );
}

/**
 * 侧栏「Sessions」按钮的下拉菜单（快速切换 running 会话）。
 * 默认只列运行中的会话；底部「打开全部会话」回到完整 All Sessions 面板。
 * portal 到 body（侧栏容器 overflow:hidden，fixed 弹层原地渲染会被裁切）。
 */
function SidebarSessionsMenu(props: { anchor: DOMRect; onClose: () => void }) {
  const s = useStore();
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 外部点击/Esc 关闭；触发按钮自身用 data-attr 豁免（否则 mousedown 先关、
  // onClick 再 toggle 会把刚关掉的下拉又打开）。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (boxRef.current && boxRef.current.contains(target)) return;
      if (target instanceof Element && target.closest("[data-sidebar-sessions-trigger]")) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); props.onClose(); }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [props.onClose]);

  // 渲染后测量：左缘对齐按钮，底部放不下向上翻，视口钳位（宽 300）。
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    const w = Math.min(300, vw - pad * 2);
    let top = props.anchor.bottom + 4;
    if (top + r.height > vh - pad) top = Math.max(pad, props.anchor.top - r.height - 4);
    const left = Math.max(pad, Math.min(props.anchor.left, vw - pad - w));
    setPos({ left, top });
  }, [props.anchor]);

  // 下拉列表：运行中优先 + 最近完成补齐，最多 8 条。运行中按最近活跃倒序；
  // 已结束按结束时间（modified）倒序。外部 agent 会话/归档不参与（pi-web:open-session 只认 pi）。
  const sessionsAll = s.sessions as any[];
  const byRecent = (a: any, b: any) => String(b.modified ?? "").localeCompare(String(a.modified ?? ""));
  const running = sessionsAll.filter((x) => s.running.has(x.id)).sort(byRecent);
  const completed = sessionsAll
    .filter((x) => !s.running.has(x.id) && !x.archived && (!x.agent || x.agent === "pi"))
    .sort(byRecent);
  const runningShown = running.slice(0, 8);
  const completedShown = completed.slice(0, Math.max(0, 8 - runningShown.length));
  const list = [...runningShown, ...completedShown];

  const pick = (id: string) => {
    props.onClose();
    // 复用宿主 pi-web:open-session 通道：AppShell 按 id 从 /api/sessions 解析并
    // 走 handleSelectSession（SPA 内切换，无整页跳转）。
    try { window.dispatchEvent(new CustomEvent("pi-web:open-session", { detail: { id } })); } catch { /* 非 DOM 环境 */ }
  };

  const rowStyle: React.CSSProperties = {
    display: "flex", gap: 8, alignItems: "center", width: "100%",
    padding: "7px 10px", border: "none", background: "none", cursor: "pointer",
    borderRadius: 7, color: "var(--text)", textAlign: "left", fontSize: 12,
  };
  const runDot = (isRunning: boolean) => ({
    width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
    background: isRunning ? "var(--ok, #22c55e)" : "var(--text-dim)", opacity: isRunning ? 1 : 0.5,
  });

  return createPortal(
    <div
      ref={boxRef}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed", left: pos?.left ?? props.anchor.left, top: pos?.top ?? props.anchor.bottom + 4,
        width: 300, maxHeight: "min(70vh, 520px)", display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 9,
        boxShadow: "0 8px 30px rgba(0,0,0,0.35)", zIndex: 2147483000,
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 10px 6px", fontSize: 11, color: "var(--text-muted)" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ok, #22c55e)", flexShrink: 0 }} />
        <span style={{ fontWeight: 600, letterSpacing: "0.02em" }}>{t("sm.runningSessions")}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>{runningShown.length}{completedShown.length > 0 ? ` +${completedShown.length}` : ""}</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "2px 4px 4px", minHeight: 0 }}>
        {list.length === 0 ? (
          <div style={{ padding: "16px 10px", fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>{t("sm.noRunning")}</div>
        ) : list.map((x, i) => {
          const isRunning = s.running.has(x.id);
          return (
            <div key={x.id}>
              {/* 运行中 → 最近完成的分段标签（首个已结束项前显示一次） */}
              {!isRunning && i === runningShown.length && (
                <div style={{ padding: "6px 10px 3px", fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.03em" }}>{t("sm.recent")}</div>
              )}
              <button
                onClick={() => pick(x.id)}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                style={rowStyle}
                title={`${sessionTitle(x)}${x.cwd ? " · " + x.cwd : ""}`}
              >
                <span style={runDot(isRunning)} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                    {agentBadge(x.agent)}
                    <span style={{ fontSize: 12, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sessionTitle(x)}</span>
                  </div>
                  {x.cwd && (
                    <div style={{ marginTop: 1, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {displayCwd(x.cwd)} · {fmtRelative(x.modified)}
                    </div>
                  )}
                </div>
              </button>
            </div>
          );
        })}
      </div>
      <div style={{ borderTop: "1px solid var(--border)", padding: 4 }}>
        <button
          onClick={() => { props.onClose(); panelOpen.onOpen(); }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            width: "100%", padding: "7px 10px", border: "none", background: "none",
            borderRadius: 7, color: "var(--accent)", cursor: "pointer", fontSize: 11,
          }}
        >
          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M13 8H7" />
            <path d="M17 12H7" />
          </svg>
          {t("sm.openAll")}
        </button>
      </div>
    </div>,
    document.body,
  );
}


/* 顶栏会话搜索框：输入 + 点搜索/回车 → 打开全部会话面板并执行搜索（面板内已有搜索能力）。
 * menu（⋯ 下拉）= true：渲染真实输入框（窄版）——行内放不下被挤进 ⋯ 时，用户仍可直接输入；
 * 输入框内点击不关菜单（宿主菜单已对 input/textarea 放行），回车/点搜索 → 打开面板并搜索。 */
export function ToolbarSearch(props: any) {
  const { menu } = props || {};
  const [val, setVal] = useState("");
  const submit = () => {
    const q = val.trim();
    setPendingSearch(q);
    panelOpen.onOpen();
  };
  if (menu) {
    // 菜单布局与其他条目一致：图标 36px 槽 + 右竖线（borderRight），输入框在竖线右边；
    // 已自带图标+输入+按钮，宿主不再补 label（meta.noMenuLabel）。输入框内点击不关菜单。
    return (
      <div style={{ display: "flex", alignItems: "center", height: 36, flexShrink: 0 }}>
        <div
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: 36, height: 36, flexShrink: 0,
            borderRight: "1px solid var(--border)", borderBottom: "none", borderLeft: "none", color: "var(--text-muted)",
          }}
          title={t("sm.search")}
        >
          <svg
            width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          >
            <circle cx={11} cy={11} r={8} />
            <line x1={21} y1={21} x2={16.65} y2={16.65} />
          </svg>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "0 8px", height: 36, flexShrink: 0 }}>
          <input
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder={t("sm.searchPlaceholder")}
            title={t("sm.searchPlaceholder")}
            style={{
              width: 140, height: 28, padding: "0 8px", boxSizing: "border-box",
              border: "1px solid var(--border)", borderRadius: 6,
              background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
            }}
          />
          <button
            type="button"
            onClick={submit}
            title={t("sm.search")}
            style={{
              height: 28, padding: "0 10px", flexShrink: 0,
              background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
              color: "var(--text-muted)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap",
            }}
          >{t("sm.search")}</button>
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "0 8px", height: 36, flexShrink: 0 }}>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <svg
          width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ position: "absolute", left: 8, pointerEvents: "none", color: "var(--text-dim)" }}
        >
          <circle cx={11} cy={11} r={8} />
          <line x1={21} y1={21} x2={16.65} y2={16.65} />
        </svg>
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder={t("sm.searchPlaceholder")}
          title={t("sm.searchPlaceholder")}
          style={{
            width: 160, height: 28, padding: "0 8px 0 24px", boxSizing: "border-box",
            border: "1px solid var(--border)", borderRadius: 6,
            background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
          }}
        />
      </div>
      <button
        type="button"
        onClick={submit}
        title={t("sm.search")}
        style={{
          height: 28, padding: "0 10px", flexShrink: 0,
          background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
          color: "var(--text-muted)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap",
        }}
      >{t("sm.search")}</button>
    </div>
  );
}
