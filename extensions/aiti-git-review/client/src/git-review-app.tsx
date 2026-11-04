/**
 * aiti-git-review · 顶层组件（自手写版迁移；逻辑一比一）。
 *
 * ToolbarButton：常显入口，点击探测（最近审核任务 repo 兜底）后必开选择器——无未提交变更也能切版本模式审历史。
 * ReviewWork：pages 全页工作区（两层：任务选择器 → 工作区）；
 *   挂载时接管 window.__aitiGitReviewWork / __aitiGitReviewOpen（支持 taskId 直开）。
 */
import { useState, useEffect } from "react";
import { regSvc } from "./host-shim";
import { useGate, DockBody, present } from "../../../_shared/ext-float-dock";
import { api, jsonBody, G, lastSeg } from "./shared";
import { TaskPicker } from "./task-picker";
import { ReviewApp } from "./review-app";

/**
 * 审核之眼 —— 全系统 Git Review 入口统一图标，线稿 = extman 注册的 icon.svg
 * （feather eye：M1 12s4-8… + 瞳孔圆）。聊天窗工具条 / 编辑器 ⋯ 菜单 / 目录各级菜单
 * 共用同一形状，改形状务必四处同步（或收殓回本组件导出）。
 */
export function GrEyeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// ── 顶部 toolbar 入口（常显；点击探测仓库后必开选择器。无轮询） ──
/** 懒加载 v2 M3批②：静态条目点击转发用（探测逻辑原在 ToolbarButton 内，抽为模块函数；
 *  防双击由宿主转发器 in-flight 去重承担，组件级 probing 态退役）。 */
export function openFromToolbar() {
  // 探测只为对准 repo（path 空 → 服务端用最近审核任务的 repo 兜底）；无论有无未提交变更都开选择器——
  // 无变更也能切「两版本/指定基线」模式审历史，不再 alert 拦截
  api("/hasChanges", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: G.probePath || undefined }) }).then((r) => r.json()).then((d: any) => {
    if (d && d.repo) G.probePath = d.repo;
    G.open = d && d.repo ? { scope: { kind: "repo", path: d.repo } } : null;
    try { (window as any).__aitiGitReviewWork(); } catch {}
  }).catch(() => {
    // 探测失败也开选择器（用户可手输仓库路径）
    G.open = null;
    try { (window as any).__aitiGitReviewWork(); } catch {}
  });
}

export function ToolbarButton() {
  const onClick = openFromToolbar;
  return (
    <button
      title={"aiti-git-review：审核变更（未提交 / 指定基线 / 两版本对比）" + (G.probePath ? "（" + lastSeg(G.probePath) + "）" : "")}
      onClick={onClick}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      }}
    >
      {/* 统一图标：GrEyeIcon（= extman 注册的 icon.svg 线稿），与各级菜单入口一致 */}
      <GrEyeIcon size={16} />
    </button>
  );
}

// ── pages 全页审核工作区（两层：任务选择器 → 工作区） ──
// 宿主经 pages 槽传入 extra：activeCwd（workspace 切换器当前目录）/ sessionCwd——作为默认仓库
export function ReviewWork(props?: any) {
  // aiti-float dock v0.5.0（§1.1 审查 tab）：dock 态本 face 让位（rightFileDock 的 DockBody
  // 渲染独立实例）；本实例保持挂载（React 保留 state），⇲ 回页面态时工作区原样恢复
  const docked = useGate("aiti-git-review:workspace", { dock: "right-panel" });
  const [open, setOpen] = useState(Boolean(props?.open ?? false));
  const [session, setSession] = useState<any>(null); // null=选择器；task 对象=工作区
  const [traceBusy, setTraceBusy] = useState(false);
  const [traceErr, setTraceErr] = useState("");
  const activeCwd = String((props && (props.activeCwd || props.sessionCwd)) || "");

  // trace 任务源直开（docs/aiti-git-trace-plan.md §6.2）：POST /open {source:"trace",…} → 工作区
  function openTrace(o: any) {
    setSession(null);
    setTraceErr("");
    setOpen(true);
    setTraceBusy(true);
    api("/open", { method: "POST", ...jsonBody({ ...o }) }).then((r) => r.json()).then((d) => {
      setTraceBusy(false);
      if (d && d.ok && d.task) setSession({ id: d.task.id });
      else setTraceErr((d && d.error) || "trace 任务打开失败");
    }).catch((e) => { setTraceBusy(false); setTraceErr("trace 任务打开失败：" + String(e)); });
  }

  // 两版本对比直开（git-ops commit 卡接线路径）：POST /open {path, base, ref2, files?} → 工作区。
  // 与 trace 同管道；服务端 base/ref2 语义（branch/tag/commitid）见 index.ts validateRefs。
  function openDirect(o: any) {
    setSession(null);
    setTraceErr("");
    setOpen(true);
    setTraceBusy(true);
    const body: any = {
      path: o.path || (o.scope && o.scope.path) || "",
      base: o.base,
      ref2: o.ref2,
    };
    if (Array.isArray(o.files) && o.files.length) body.files = o.files;
    if (o.label) body.label = o.label;
    api("/open", { method: "POST", ...jsonBody(body) }).then((r) => r.json()).then((d) => {
      setTraceBusy(false);
      if (d && d.ok && d.task) setSession({ id: d.task.id });
      else setTraceErr((d && d.error) || "审核任务打开失败");
    }).catch((e) => { setTraceBusy(false); setTraceErr("审核任务打开失败：" + String(e)); });
  }

  useEffect(() => {
    const applyOpen = (o: any) => {
      G.open = o;
      if (o && o.source === "trace" && o.storeRoot && o.sessionId) { openTrace(o); return; }
      if (o && o.base && o.ref2) { openDirect(o); return; } // 两版本直开（commit 卡 / 外部深链）
      if (o && o.taskId) {
        setSession({ id: o.taskId }); // 直接指定任务（现有会话继续看）
      } else {
        setSession(null);
        G.presetRepo = (o && o.scope && o.scope.path) || (o && o.path) || "";
      }
      setOpen(true);
    };
    // URL 深链：?source=trace&storeRoot=…&sessionId=…&base=…&target=…（aiti-git-trace 徽标跳转用；files=JSON 数组可选，文件视图深链）
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.get("source") === "trace" && q.get("storeRoot") && q.get("sessionId") && q.get("base") && q.get("target")) {
        let fl: string[] = [];
        try { const parsed = JSON.parse(q.get("files") || "[]"); if (Array.isArray(parsed)) fl = parsed.map(String); } catch { /* files 非法则忽略过滤 */ }
        applyOpen({ source: "trace", storeRoot: q.get("storeRoot"), sessionId: q.get("sessionId"), base: q.get("base"), target: q.get("target"), ...(fl.length ? { files: fl } : {}) });
      }
    } catch {}
    (window as any).__aitiGitReviewWork = () => applyOpen(G.open || null);
    (window as any).__aitiGitReviewOpen = (opts: any) => applyOpen(opts || {});
    // DI 方案 P2：services 通道双轨注册（旧全局保留；旧宿主 no-op）
    regSvc?.("aiti-git-review.work", (window as any).__aitiGitReviewWork);
    regSvc?.("aiti-git-review.open", (window as any).__aitiGitReviewOpen);
    return () => { delete (window as any).__aitiGitReviewWork; delete (window as any).__aitiGitReviewOpen; };
  }, []);
  if (!open) return null;
  if (docked) return null; // dock 态：pages face 让位（结构性防双开）
  if (traceBusy) return <div style={{ position: "fixed", inset: 0, background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", display: "flex", alignItems: "center", justifyContent: "center", font: "13px system-ui", zIndex: 2147483000 }}>正在打开审核任务…</div>;
  if (traceErr) return (
    <div style={{ position: "fixed", inset: 0, background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", display: "flex", alignItems: "center", justifyContent: "center", font: "13px system-ui", zIndex: 2147483000 }}>
      <div style={{ maxWidth: 460, padding: 16, border: "1px solid var(--border,#ddd)", borderRadius: 10 }}>
        <div style={{ color: "#f87171", marginBottom: 8 }}>❌ {traceErr}</div>
        <button onClick={() => { setTraceErr(""); setOpen(false); }} style={{ padding: "5px 12px", border: "1px solid var(--border,#d0d0d0)", borderRadius: 6, cursor: "pointer", background: "var(--bg,#fff)", color: "var(--text,#333)" }}>关闭</button>
      </div>
    </div>
  );
  if (session) return <ReviewApp onClose={() => setOpen(false)} init={{ taskId: session.id }} onExitToList={() => setSession(null)} />;
  return (
    <TaskPicker
      onClose={() => setOpen(false)}
      onOpenTask={(taskId) => setSession({ id: taskId })}
      onDock={props?.onDock ?? (() => present("aiti-git-review:workspace", "dock:right-panel"))}
      presetRepo={G.presetRepo || ""}
      fallbackRepo={activeCwd}
    />
  );
}

/** aiti-float dock v0.5.0（§1.1 审查 tab）：rightFileDock face——ReviewWork 独立实例
 *  （初始=选择器，选任务后工作区在 tab 内展开）；gate 门控，非 docked 不挂载实例。 */
export function DockReviewWork() {
  const docked = useGate("aiti-git-review:workspace", { dock: "right-panel" });
  if (!docked) return null;
  return (
    <DockBody itemKey="aiti-git-review:workspace" zone="right-panel" title="👁️ 审查" chrome="tab">
      <ReviewWork open onDock={() => present("aiti-git-review:workspace", "dock:right-panel")} />
    </DockBody>
  );
}
