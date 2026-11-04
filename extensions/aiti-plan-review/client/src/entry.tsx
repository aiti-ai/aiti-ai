/**
 * aiti-plan-review client entry —— JSX + vite 构建版（自手写 h() 一比一迁移，SOP §三）。
 *
 * 迁移修正（行为变化仅此两处，其余 1:1）：
 *  1. PlanChip：`useState` 移到早退 return 之前——原版 hooks 在 `if (!dir) return null` 之后，
 *     会话在「有 cwd ↔ 无 cwd」间切换时 hook 数量变化，React 直接报错（条件 hook 违规）。
 *  2. ReviewList：恢复 statusLine 的切换按钮——commit c23c759 把 planToggle 合并进 PlanChip
 *     时遗留了悬空调用（未定义标识符），有活跃会话时打开面板必抛 ReferenceError
 *     （历史上即 2026-08-31 层 3 渲染边界接住的那类错误）。实现取自 c23c759^ 历史版本。
 *
 * 规范要点（与手写版一致）：
 * - toolbar 条目 render 返回真按钮；弹窗走 dialogs 插槽 + data-ext-float 契约
 * - 颜色一律 var(--x, 兜底)；fetch 一律 ctx.apiUrl；toolbar/dialogs/composerTools 共享模块级开关 store
 */

import { useEffect, useRef, useState } from "react";
import { __setCtx, apiUrl, sendChatMessage } from "./host-shim";

type PlanStatus = {
  active?: boolean;
  tier?: string;
  status?: string; // active | pending | kept | extracted
  declared?: boolean;
  pending?: boolean;
  sandboxDir?: string;
};
type DeclaredList = { files: string[]; deletions: string[] };
type PendingItem = {
  sandboxDir: string;
  projectDir: string;
  summary?: string;
  tier?: string;
  gate?: string;
  declared: DeclaredList;
  others?: { added?: string[]; modified?: string[]; deleted?: string[] };
};
type HistoryItem = {
  sandboxDir: string;
  projectDir: string;
  tier?: string;
  status: string;
  summary?: string;
  gate?: string;
  declared: DeclaredList;
  delta?: DeltaList;
  updatedAt?: number;
};
type SessionInfo = { id: string; cwd: string; name?: string } | null;

// ── fetch（一律经 ctx.apiUrl，子路径部署安全） ──
const api = (p: string, init?: RequestInit) =>
  fetch(apiUrl("/api/extensions/aiti-plan-review" + p), { cache: "no-store", ...init });
const jpost = (p: string, o: unknown) =>
  api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

// ── 模块级开关：toolbar 按钮与 dialogs 面板共享（aiti-ui-env 同款 store）──
// dock v3（P1 批）：显隐收口 aiti-float 展示状态机——open/close 走 openFloat/closePanel，
// 渲染门控 useGate（红线：gate 是唯一渲染开关）。历史弹窗同款（P3 批，不设 default）。
import { useGate, usePresent, presentState, DockBody, openFloat, closePanel, seedDockDefault } from "../../../_shared/ext-float-dock";

const PANEL_KEY = "aiti-plan-review:panel";
const HISTORY_KEY = "aiti-plan-review:history";
function setPanelOpen(v: boolean) {
  if (v) openFloat(PANEL_KEY);
  else closePanel(PANEL_KEY);
}
function usePanelOpen(): boolean {
  return usePresent(PANEL_KEY) !== "closed";
}

// ── 结算预览对话框 store（“结束并结算”先显示待结算文件，再让用户勾选，绝不自动采认/销毁） ──
type DeltaList = { added?: string[]; modified?: string[]; deleted?: string[] };
type PreviewData = { active?: boolean; tier?: string; sandboxDir?: string; delta: DeltaList };
let settleData: PreviewData | null = null;
let settleOpen = false;
const settleListeners = new Set<() => void>();
function setSettleData(v: PreviewData | null, open = false) {
  settleData = v;
  settleOpen = open;
  for (const l of settleListeners) l();
}
function useSettle(): { open: boolean; data: PreviewData | null } {
  const [s, setS] = useState<{ open: boolean; data: PreviewData | null }>({ open: settleOpen, data: settleData });
  useEffect(() => {
    const l = () => setS({ open: settleOpen, data: settleData });
    settleListeners.add(l);
    return () => {
      settleListeners.delete(l);
    };
  }, []);
  return s;
}

// ── 沙箱历史对话框 store（历史入口 = 结算按钮 + 默认隐藏工具栏图标 共用）──
function setHistoryOpen(v: boolean) {
  if (v) openFloat(HISTORY_KEY);
  else closePanel(HISTORY_KEY);
}
function useHistoryOpen(): boolean {
  return usePresent(HISTORY_KEY) !== "closed";
}

// ── 主题令牌（var(--x, 兜底)：pi-web 内跟随亮暗主题） ──
const C = {
  panel: "var(--bg-panel, #161920)",
  panel2: "var(--bg-hover, rgba(128,128,128,0.08))",
  border: "var(--border, #3a3f4b)",
  text: "var(--text, #e6e9ef)",
  muted: "var(--text-muted, #9aa4b2)",
  dim: "var(--text-dim, #6b7280)",
  accent: "var(--accent, #6aa1ff)",
  warn: "#f59e0b",
  ok: "#22c55e",
  bad: "#ef4444",
};

// lucide inbox 图标（与系统内建线条图标同风格）
const Ic = ({ size, paths }: { size: number; paths: string[] }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {paths.map((d, i) => (
      <path key={i} d={d} />
    ))}
  </svg>
);
const ICONS: Record<string, string[]> = {
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  history: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l3 2"],
};

const btnStyle: Record<string, string | number> = {
  padding: "5px 14px",
  borderRadius: 5,
  border: "1px solid " + C.border,
  background: C.panel2,
  color: C.text,
  fontSize: 12.5,
  cursor: "pointer",
  transition: "background 0.13s, border-color 0.13s",
};

// ── 单文件行：checkbox + 路径 + diff ──
function Row({ item, kind, rel, checkedByDefault }: { item: PendingItem; kind: string; rel: string; checkedByDefault: boolean }) {
  return (
    <label
      key={kind + rel}
      style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", margin: "2px 0", fontSize: 12.5, color: C.text }}
    >
      <input type="checkbox" defaultChecked={checkedByDefault} data-sandbox={item.sandboxDir} data-kind={kind} data-target={rel} onChange={() => {}} />
      <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>
        {kind} {rel}
      </span>
      <button
        onClick={() => (window as unknown as { __psbDiff?: (item: PendingItem, rel: string) => void }).__psbDiff?.(item, rel)}
        style={{ border: "none", background: "none", color: C.accent, fontSize: 11, cursor: "pointer", padding: "0 2px" }}
      >
        {"diff"}
      </button>
    </label>
  );
}

// ── plan 状态：/status 拉取（事件驱动刷新：focus + psb:refresh 自定义事件，无轮询） ──
// sessionId 用于服务端 active 归属判定：他人会话开的 plan 不算本会话 active
function usePlanStatus(dir?: string, streaming?: boolean, sessionId?: string | null): PlanStatus | null {
  const [st, setSt] = useState<PlanStatus | null>(null);
  const load = () => {
    if (!dir) return;
    jpost("/status", { cwd: dir, sessionId: sessionId ?? undefined })
      .then((r) => r.json())
      .then((d) => setSt(d))
      .catch(() => {});
  };
  useEffect(() => {
    setSt(null);
    load();
    const onRefresh = () => load();
    window.addEventListener("psb:refresh", onRefresh);
    window.addEventListener("focus", onRefresh);
    return () => {
      window.removeEventListener("psb:refresh", onRefresh);
      window.removeEventListener("focus", onRefresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);
  // turn 结束（streaming true→false）时模型可能刚 plan_start/declare/plan_abort → 刷新
  const prevRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    if (prevRef.current === true && streaming === false) load();
    prevRef.current = streaming;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);
  return st;
}
const fireRefresh = () => window.dispatchEvent(new Event("psb:refresh"));

// ── plan 开启/结束动作（chip 与面板 statusLine 共用逻辑）──
// 未开启 → /start 开沙箱；已开启 → /preview 拉快照增量，弹结算预览对话框【先显示文件】，
// 绝不自动采认/销毁（用户勾选后再 /settle|/discard）。
async function planAction(active: boolean, sessionId?: string, dir?: string): Promise<"settle" | "alerted" | "ok"> {
  try {
    if (active) {
      const r = await jpost("/preview", { sessionId, cwd: dir }).then((x) => x.json());
      if (!r.ok) {
        alert(r.error || "操作失败");
        return "alerted";
      }
      if (!r.active) {
        alert("当前无活跃 plan 沙箱，无法结算。");
        return "alerted";
      }
      setSettleData({ active: true, tier: r.tier, sandboxDir: r.sandboxDir, delta: r.delta }, true);
      return "settle";
    }
    const r = await jpost("/start", { sessionId, cwd: dir }).then((x) => x.json());
    if (!r.ok) {
      alert(r.error || "操作失败");
      return "alerted";
    }
    return "ok";
  } catch (e) {
    alert("操作失败：" + ((e as Error)?.message || e));
    return "alerted";
  }
}

/* ── composerTools：输入框控制行「plan」按钮 —— 单一按钮，按界面分派行为：
 *  - new-session 页（无会话）：点击 = 预建沙箱 + 自动发首条 prompt → 开新会话进 /plan。
 *  - 已有会话：点击 = 原来的 开始 plan / 关闭提交（结算预览）/ 打开沙箱历史。 */
function PlanChip({ currentSession, sessionId, cwd, streaming }: { currentSession: SessionInfo; sessionId?: string; cwd?: string; streaming?: boolean }) {
  const dir = cwd || currentSession?.cwd;
  // 迁移修正 1：原版 useState 在下面的早退之后（条件 hook 违规），提前到这里
  const [busy, setBusy] = useState("");
  const st = usePlanStatus(dir, streaming, sessionId);
  if (!dir) return null;
  const isNew = !sessionId; // new-session 欢迎页：host 传 sessionId=null（ChatInput 的 session?.id ?? null）
  const active = !!st?.active;

  const openPlanSession = async () => {
    setBusy("1");
    try {
      const draftText = (document.querySelector("textarea") as HTMLTextAreaElement | null)?.value?.trim() || "";
      const prompt = draftText
        ? `${draftText}\n（请在 plan 沙箱内先制定方案，未采认前不要写入真实工作区。）`
        : "请先制定计划/方案：分析现状，用 plan-sandbox 探索可行性，最后调用 declare_deliverables。";
      // 1) 预建沙箱落盘（新会话 agentTools.active() 按 cwd 认领 → 自动 in-plan）
      const np = await jpost("/new-plan", { cwd: dir }).then((x) => x.json());
      if (!np.ok) { alert(np.error || "预建沙箱失败"); return; }
      // 2) 自动发首条 prompt（宿主 handleSend 建会话 + 发送；new-session 页空闲直发 onSend）
      sendChatMessage(prompt, "steer");
    } catch (e) {
      alert("开新会话进 plan 失败：" + ((e as Error)?.message || e));
    } finally {
      setBusy("");
    }
  };

  const doAction = async () => {
    if (isNew) { await openPlanSession(); return; }
    // kept/extracted/pending → 非自由写入态，打开沙箱历史（含重用/提取/销毁）
    if (st?.status && st.status !== "active") { setHistoryOpen(true); return; }
    setBusy("1");
    const res = await planAction(active, sessionId, dir);
    if (res === "settle") setPanelOpen(false);
    setBusy("");
    fireRefresh();
  };

  const chipStatus: Record<string, string> = { pending: "待采认", kept: "已保留", extracted: "已提取" };
  const chipLabel = !isNew && st?.status && st.status !== "active" ? chipStatus[st.status] || st.status : null;
  const chipColor = chipLabel ? (st?.status === "pending" ? C.warn : st?.status === "kept" ? C.accent : C.muted) : active ? C.ok : C.dim;
  return (
    <button
      onClick={doAction}
      disabled={!!busy}
      title={
        isNew
          ? "开一个新会话并直接进入 plan 沙箱（带当前输入作为首条 prompt）"
          : chipLabel
            ? `plan ${chipLabel}（tier=${st.tier}）\n${st.sandboxDir}\n点击打开沙箱历史：可重新提取文件 / 重用 / 销毁`
            : active
              ? "plan 沙箱进行中。点击结算：先列出快照增量文件供勾选，再采认/保留/丢弃"
              : "plan 未开启。点击开启：此后模型写入与命令都在隔离快照中（/plan <提示词> 同效）"
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 12,
        fontSize: 11.5,
        cursor: busy ? "wait" : "pointer",
        border: "1px solid " + (chipLabel || active ? chipColor :
          C.border),
        background: chipLabel ? `color-mix(in srgb, ${chipColor} 14%, transparent)` : active ? `color-mix(in srgb, ${C.ok} 14%, transparent)` : "transparent",
        color: chipColor,
      }}
    >
      {busy ? (
        "…"
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 7, height: 7, borderRadius: 4, background: chipColor, display: "inline-block" }} />
          {"plan"}
        </span>
      )}
    </button>
  );
}

function Card({ item, onDone }: { item: PendingItem; onDone: () => void }) {
  const [busy, setBusy] = useState("");
  const apply = async () => {
    const files: string[] = [];
    const deletions: string[] = [];
    for (const cb of document.querySelectorAll(`input[type=checkbox][data-sandbox="${CSS.escape(item.sandboxDir)}"]`)) {
      const target = cb.getAttribute("data-target");
      const kind = cb.getAttribute("data-kind");
      if (cb.checked) (kind === "del" ? deletions : (files as string[])).push(target as string);
    }
    setBusy("apply");
    const r = await jpost("/apply", { sandbox: item.sandboxDir, files, deletions }).then((x) => x.json());
    setBusy("");
    alert(r.text || (r.ok ? "完成" : r.error || "失败"));
    onDone();
    fireRefresh();
  };
  const discard = async () => {
    if (!confirm("丢弃该沙箱？未采认内容全部销毁。")) return;
    setBusy("discard");
    const r = await jpost("/discard", { sandbox: item.sandboxDir }).then((x) => x.json());
    setBusy("");
    alert(r.text || "已丢弃");
    onDone();
    fireRefresh();
  };
  return (
    <div style={{ border: "1px solid " + C.border, borderRadius: 8, padding: 10, margin: "10px 0", background: C.panel }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: C.text }}>{item.projectDir}</div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>
        {item.summary || "(无说明)"} · tier={item.tier}
        {item.gate ? " · gate=" + item.gate : ""}
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 6, color: C.text }}>{"声明交付物（默认选中）"}</div>
      {item.declared.files.map((f) => (
        <Row key={"add|mod" + f} item={item} kind="add|mod" rel={f} checkedByDefault />
      ))}
      {item.declared.deletions.map((f) => (
        <Row key={"del" + f} item={item} kind="del" rel={f} checkedByDefault />
      ))}
      <div style={{ fontSize: 12, fontWeight: 600, marginTop: 8, color: C.warn }}>{"其他（沙箱自动检测，未选中）"}</div>
      {(item.others?.added || []).map((f) => (
        <Row key={"add" + f} item={item} kind="add" rel={f} checkedByDefault={false} />
      ))}
      {(item.others?.modified || []).map((f) => (
        <Row key={"mod" + f} item={item} kind="mod" rel={f} checkedByDefault={false} />
      ))}
      {(item.others?.deleted || []).map((f) => (
        <Row key={"del" + f} item={item} kind="del" rel={f} checkedByDefault={false} />
      ))}
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <button onClick={apply} disabled={!!busy} style={{ ...btnStyle, borderColor: C.accent, color: C.accent }}>
          {busy === "apply" ? "…" : "✓ 采认选中"}
        </button>
        <button onClick={discard} disabled={!!busy} style={btnStyle}>
          {busy === "discard" ? "…" : "✗ 全部丢弃"}
        </button>
      </div>
    </div>
  );
}

/* ── 面板 statusLine 的切换按钮（迁移修正 2：恢复 c23c759 误删的 planToggle） ── */
function PlanToggle({ sessionId, dir, st, onBusy }: { sessionId?: string; dir: string; st: PlanStatus | null; onBusy?: () => void }) {
  const active = !!st?.active;
  const nonActive = !!st?.status && st.status !== "active";
  const [busy, setBusy] = useState("");
  const doToggle = async () => {
    if (nonActive) {
      setHistoryOpen(true);
      return;
    }
    setBusy("1");
    onBusy?.();
    const res = await planAction(active, sessionId, dir);
    if (res === "settle") setPanelOpen(false);
    setBusy("");
    fireRefresh();
  };
  const label = nonActive ? (st?.status === "pending" ? "📚 待采认" : st?.status === "kept" ? "📚 已保留" : "📚 已提取") : active ? (busy ? "…" : "⏹ 结束并结算") : busy ? "…" : "▶ 开启 plan";
  return (
    <button
      onClick={doToggle}
      title={nonActive ? "打开沙箱历史：可重新提取文件 / 重用 / 销毁" : active ? "结算 plan：先列出快照增量文件供勾选，再采认/保留/丢弃" : "开启 plan 沙箱：此后模型的写入与命令都在隔离快照中"}
      style={{
        padding: "3px 9px",
        borderRadius: 12,
        fontSize: 11.5,
        cursor: "pointer",
        border: "1px solid " + (nonActive ? C.accent : active ? C.warn : C.accent),
        color: nonActive ? C.accent : active ? C.warn : C.accent,
        background: "transparent",
      }}
    >
      {label}
    </button>
  );
}

// ── 从对话框内的复选框收集用户勾选（新增/修改 → files；删除 → deletions） ──
function collectChecked(container: HTMLElement, sandboxDir: string): { files: string[]; deletions: string[] } {
  const files: string[] = [];
  const deletions: string[] = [];
  for (const cb of container.querySelectorAll(`input[type=checkbox][data-sandbox="${CSS.escape(sandboxDir)}"]`)) {
    const target = cb.getAttribute("data-target");
    const kind = cb.getAttribute("data-kind");
    if (cb.checked) (kind === "del" ? deletions : files).push(target as string);
  }
  return { files, deletions };
}

// 结算预览对话框：先列出快照增量文件供用户勾选，绝不自动采认/销毁。
function SettleDialog(_props: { currentSession?: SessionInfo }) {
  const { open, data } = useSettle();
  const [busy, setBusy] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettleData(null, false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open || !data) return null;
  const d = data.delta || {};
  const added = d.added || [];
  const modified = d.modified || [];
  const deleted = d.deleted || [];
  const total = added.length + modified.length + deleted.length;
  const doSettle = async (mode: "apply" | "keep") => {
    if (!data.sandboxDir) return;
    const sel = boxRef.current ? collectChecked(boxRef.current, data.sandboxDir) : { files: [...added, ...modified], deletions: [] };
    const files = sel.files;
    const deletions = sel.deletions;
    if (mode === "apply" && files.length === 0 && deletions.length === 0) {
      // 空增量 → 只保留/丢弃；采认无内容视为保留
      if (total === 0) { setSettleData(null, false); return; }
      alert("请至少勾选一个文件，或选择「仅保存（保留沙箱）」");
      return;
    }
    setBusy(mode);
    const r = await jpost("/settle", { sandbox: data.sandboxDir, files, deletions, mode, summary: "结算预览" }).then((x) => x.json());
    setBusy("");
    setSettleData(null, false);
    alert(r.text || (r.ok ? "完成" : r.error || "失败"));
    fireRefresh();
  };
  const doDiscard = async () => {
    if (!data.sandboxDir) return;
    if (!confirm("全部丢弃？该沙箱及其未采认内容将销毁。")) return;
    setBusy("discard");
    const r = await jpost("/discard", { sandbox: data.sandboxDir }).then((x) => x.json());
    setBusy("");
    setSettleData(null, false);
    alert(r.text || "已丢弃");
    fireRefresh();
  };
  const FileRow = ({ rel, kind, def }: { rel: string; kind: string; def: boolean }) => (
    <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", margin: "2px 0", fontSize: 12.5, color: C.text }}>
      <input type="checkbox" data-sandbox={data.sandboxDir} data-kind={kind} data-target={rel} defaultChecked={def} />
      <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>{kind} {rel}</span>
      <button
        onClick={(e) => {
          e.preventDefault();
          Promise.all([
            jpost("/file", { sandbox: data.sandboxDir, rel, side: "rev" }).then((r) => r.json()),
            jpost("/file", { sandbox: data.sandboxDir, rel, side: "base" }).then((r) => r.json()),
          ]).then(([rev, base]) => alert("快照（新）：\n" + (rev.content ?? "(不存在)") + "\n\n——\n项目（现）：\n" + (base.content ?? "(不存在)")));
        }}
        style={{ border: "none", background: "none", color: C.accent, fontSize: 11, cursor: "pointer", padding: "0 2px" }}
      >
        {"diff"}
      </button>
    </label>
  );
  return (
    <div onClick={() => setSettleData(null, false)} style={{ position: "fixed", inset: 0, zIndex: 312, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        onClick={(e) => e.stopPropagation()}
        data-ext-float="1"
        data-ext-float-full="1"
        data-ext-float-w={720}
        data-ext-float-h={520}
        style={{ width: 720, maxWidth: "calc(100vw - 16px)", height: "min(520px, 80vh)", borderRadius: 8, background: C.panel, border: "1px solid " + C.border, color: C.text, display: "flex", flexDirection: "column", overflow: "hidden", fontSize: 13, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid " + C.border, flexShrink: 0, cursor: "grab" }}>
          <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic size={15} paths={ICONS.inbox} />
            {`plan 结算 · 快照增量 +${added.length}/~${modified.length}/-${deleted.length}${data.tier ? " · tier=" + data.tier : ""}`}
          </div>
          <button onClick={() => setSettleData(null, false)} title="关闭" aria-label="关闭" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4, fontSize: 14, lineHeight: 1, flexShrink: 0 }}>
            <Ic size={12} paths={ICONS.x} />
          </button>
        </div>
        <div ref={boxRef} style={{ flex: 1, overflowY: "auto", padding: "12px 16px 16px", minHeight: 0 }}>
          {total === 0 ? (
            <div style={{ padding: 12, color: C.muted, fontSize: 13 }}>{"快照无增量。可保留沙箱（留待后续提取/重用/销毁），或全部丢弃。"}</div>
          ) : (
            <>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: C.text }}>{"待结算文件（勾选要采认的；删除项需显式勾选）"}</div>
              {added.map((f) => <FileRow key={"add" + f} rel={f} kind="add" def />)}
              {modified.map((f) => <FileRow key={"mod" + f} rel={f} kind="mod" def />)}
              {deleted.map((f) => <FileRow key={"del" + f} rel={f} kind="del" def={false} />)}
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderTop: "1px solid " + C.border, flexShrink: 0 }}>
          {total > 0 ? (
            <button onClick={() => doSettle("apply")} disabled={!!busy} style={{ ...btnStyle, borderColor: C.accent, color: C.accent }}>{busy === "apply" ? "…" : "✓ 采认选中并关闭沙箱"}</button>
          ) : null}
          <button onClick={() => doSettle("keep")} disabled={!!busy} style={{ ...btnStyle, borderColor: C.warn, color: C.warn }}>{busy === "keep" ? "…" : "💾 仅保存（保留沙箱）"}</button>
          <button onClick={doDiscard} disabled={!!busy} style={btnStyle}>{busy === "discard" ? "…" : "✗ 全部丢弃"}</button>
          <button onClick={() => setHistoryOpen(true)} style={{ ...btnStyle, marginLeft: "auto" }}>{"📚 沙箱历史"}</button>
        </div>
      </div>
    </div>
  );
}

function ReviewList({ currentSession }: { currentSession: SessionInfo }) {
  const dir = currentSession?.cwd;
  const st = usePlanStatus(dir, undefined, currentSession?.id);
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const load = () =>
    api("/list")
      .then((r) => r.json())
      .then((d) => setItems(d.pending || []));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // diff 查看器：挂到 window 供行内 diff 链接使用（幂等赋值，非条目注册）
  (window as unknown as { __psbDiff: (item: PendingItem, rel: string) => void }).__psbDiff = (item, rel) => {
    Promise.all([
      jpost("/file", { sandbox: item.sandboxDir, rel, side: "rev" }).then((r) => r.json()),
      jpost("/file", { sandbox: item.sandboxDir, rel, side: "base" }).then((r) => r.json()),
    ]).then(([rev, base]) => {
      alert("快照（新）：\n" + (rev.content ?? "(不存在)") + "\n\n——\n项目（现）：\n" + (base.content ?? "(不存在)"));
    });
  };
  if (items === null) return <div style={{ padding: 12, color: C.muted }}>{"加载中…"}</div>;
  const statusLine = !dir ? null : (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 12 }}>
      {st?.status === "pending" ? (
        <span style={{ color: C.warn }}>{`🟡 plan 待采认 · tier=${st.tier} · ${st.sandboxDir}`}</span>
      ) : st?.status === "kept" ? (
        <span style={{ color: C.accent }}>{`🔵 plan 已保留（可提取/重用/销毁） · tier=${st.tier} · ${st.sandboxDir}`}</span>
      ) : st?.status === "extracted" ? (
        <span style={{ color: C.muted }}>{`⚪ plan 已提取部分文件（沙箱保留） · tier=${st.tier} · ${st.sandboxDir}`}</span>
      ) : st?.active ? (
        <span style={{ color: C.ok }}>{`🟢 plan 沙箱进行中 · tier=${st.tier}${st.declared ? " · 已声明交付物" : " · 未声明"} · ${st.sandboxDir}`}</span>
      ) : (
        <span style={{ color: C.dim }}>{"⚪ 当前会话未开启 plan（/plan <提示词> 或 plan_start 开启） · " + dir}</span>
      )}
      <PlanToggle sessionId={currentSession?.id} dir={dir} st={st} onBusy={load} />
    </div>
  );
  if (items.length === 0)
    return (
      <div style={{ padding: 12, color: C.muted, fontSize: 13 }}>
        {"没有待采认的 plan 交付。AI 调用 declare_deliverables 声明后，这里会出现收尾条目。"}
      </div>
    );
  return (
    <div style={{ maxWidth: 900 }}>
      {statusLine}
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
        {items.length + " 个待收尾。声明项默认选中；\"其他\"为沙箱自动检测的未声明变更，按需点选。"}
      </div>
      {items.map((item) => (
        <Card key={item.sandboxDir} item={item} onDone={load} />
      ))}
    </div>
  );
}

/* ── dialogs 面板：data-ext-float 契约（拖拽/缩放/持久化/小屏全屏交给 aiti-float）──
 * 遮罩 z=310（demo 同款）：低于宿主自身段（≈1000–1100，不抢）与 aiti-float 置前带（3000 起，不拦）
 * dock v3：浮窗 face 走 useGate 门控；停靠 face（ReviewDockFace）进 DockBody，内容共用 ReviewList */
function ReviewDialog({ currentSession }: { currentSession: SessionInfo }) {
  const open = useGate(PANEL_KEY, "float");
  // Esc 关闭
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div
      onClick={() => setPanelOpen(false)}
      style={{ position: "fixed", inset: 0, zIndex: 310, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-ext-float="1"
        data-ext-float-full="1"
        data-ext-float-w={920}
        data-ext-float-h={640}
        data-ext-float-key={PANEL_KEY}
        data-ext-float-dock="right-panel"
        data-ext-float-dock-default="right-panel"
        style={{
          width: 920,
          maxWidth: "calc(100vw - 16px)",
          height: "min(640px, 86vh)",
          borderRadius: 8,
          background: C.panel,
          border: "1px solid " + C.border,
          color: C.text,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          fontSize: 13,
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        }}
      >
        {/* 标题栏：首子元素自动成为 aiti-float 拖拽把手；右上角 🤖 由宿主 dialogs 渲染层自动注入（关闭键左侧） */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 16px",
            borderBottom: "1px solid " + C.border,
            flexShrink: 0,
            cursor: "grab",
          }}
        >
          <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic size={15} paths={ICONS.inbox} />
            {"Plan-Sandbox 采认"}
          </div>
          <button
            onClick={() => setPanelOpen(false)}
            title="关闭"
            aria-label="关闭"
            style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4, fontSize: 14, lineHeight: 1, flexShrink: 0 }}
          >
            <Ic size={12} paths={ICONS.x} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px 16px", minHeight: 0 }}>
          <ReviewList currentSession={currentSession} />
        </div>
      </div>
    </div>
  );
}

/** 停靠 face（rightFileDock item "panel" → 复合 id = PANEL_KEY）：仅 docked:right-panel 渲染 */
function ReviewDockFace({ currentSession }: { currentSession: SessionInfo }) {
  const docked = useGate(PANEL_KEY, { dock: "right-panel" });
  if (!docked) return null;
  return (
    <DockBody itemKey={PANEL_KEY} zone="right-panel" title="Plan-Sandbox 采认" chrome="tab"
      zones={["right-panel"]} defaultZone="right-panel">
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px 16px", minHeight: 0, color: C.text, fontSize: 13 }}>
        <ReviewList currentSession={currentSession} />
      </div>
    </DockBody>
  );
}

/* ── 沙箱历史对话框：当前 workspace（cwd）遗留沙箱（含 active/pending/kept/extracted），
 *   每个沙箱可 重新提取文件 / 重用 / 销毁。数据源：POST /history { cwd }。
 *   dock v3（P3 批）：右栏可选（不设 default，低频）；内容组件 HistoryBody 两面共用。 ── */
function HistoryBody({ currentSession }: { currentSession: SessionInfo }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const dir = currentSession?.cwd;
  const load = () => {
    if (!dir) { setItems([]); return; }
    jpost("/history", { cwd: dir })
      .then((r) => r.json())
      .then((d) => setItems(d.sandboxes || []))
      .catch(() => setItems([]));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const STATUS_COLOR: Record<string, string> = { active: C.ok, pending: C.warn, kept: C.accent, extracted: C.muted };
  const STATUS_LABEL: Record<string, string> = { active: "进行中", pending: "待采认", kept: "已保留", extracted: "已提取" };
  const doExtract = async (item: HistoryItem) => {
    const box = document.getElementById("psb-history-files");
    const { files, deletions } = box ? collectChecked(box, item.sandboxDir) : { files: [], deletions: [] };
    if (files.length === 0 && deletions.length === 0) return alert("请勾选要提取的文件。");
    // P2-2（lineage-closure）：提取前明示降级语义——部分提取不走门禁/整体校验
    if (!confirm(`部分提取 ${files.length} 文件、${deletions.length} 删除到真实工作区？\n（不跑采认门禁、不做整体校验，出问题不自动回滚）`)) return;
    const r = await jpost("/extract", { sandbox: item.sandboxDir, files, deletions }).then((x) => x.json());
    alert(r.text || r.error || "完成");
    setExpanded(null);
    load();
    fireRefresh();
  };
  const doReuse = async (item: HistoryItem) => {
    if (!confirm("在该沙箱内继续工作？后续模型读写将进入此沙箱快照。")) return;
    const r = await jpost("/reuse", { sandbox: item.sandboxDir, sessionId: currentSession?.id }).then((x) => x.json());
    alert(r.text || r.error || "完成");
    fireRefresh();
  };
  const doDiscard = async (item: HistoryItem) => {
    if (!confirm("销毁该沙箱？未采认内容将全部丢失。")) return;
    const r = await jpost("/discard", { sandbox: item.sandboxDir }).then((x) => x.json());
    alert(r.text || "已丢弃");
    load();
    fireRefresh();
  };
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px 16px", minHeight: 0 }}>
      {items === null ? (
        <div style={{ padding: 12, color: C.muted }}>{"加载中…"}</div>
      ) : items.length === 0 ? (
        <div style={{ padding: 12, color: C.muted, fontSize: 13 }}>{"当前 workspace 没有遗留沙箱。"}</div>
      ) : (
        items.map((item) => {
          const d = item.delta || {};
          const tot = (d.added?.length || 0) + (d.modified?.length || 0) + (d.deleted?.length || 0);
          const isOpen = expanded === item.sandboxDir;
          return (
            <div key={item.sandboxDir} style={{ border: "1px solid " + C.border, borderRadius: 8, padding: 10, margin: "10px 0", background: C.panel }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: STATUS_COLOR[item.status] || C.muted }}>{"● " + (STATUS_LABEL[item.status] || item.status)}</span>
                <span style={{ fontSize: 12, color: C.muted }}>{"tier=" + item.tier}</span>
                <span style={{ fontSize: 11.5, color: C.muted }}>{"+" + (d.added?.length || 0) + "/~" + (d.modified?.length || 0) + "/-" + (d.deleted?.length || 0)}</span>
                <button onClick={() => setExpanded(isOpen ? null : item.sandboxDir)} style={{ ...btnStyle, marginLeft: "auto", padding: "2px 8px" }}>{isOpen ? "收起" : "📂 提取文件"}</button>
              </div>
              <div style={{ fontSize: 12, color: C.text, marginTop: 4 }}>{item.summary || "(无说明)"}</div>
              {isOpen ? (
                <div id="psb-history-files" style={{ marginTop: 8, paddingLeft: 4, borderLeft: "2px solid " + C.border }}>
                  {(d.added || []).map((f) => <label key={"add" + f} style={{ display: "flex", gap: 6, alignItems: "center", margin: "2px 0", fontSize: 12.5, color: C.text }}><input type="checkbox" data-sandbox={item.sandboxDir} data-kind="add" data-target={f} /><span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>add {f}</span></label>)}
                  {(d.modified || []).map((f) => <label key={"mod" + f} style={{ display: "flex", gap: 6, alignItems: "center", margin: "2px 0", fontSize: 12.5, color: C.text }}><input type="checkbox" data-sandbox={item.sandboxDir} data-kind="mod" data-target={f} /><span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>mod {f}</span></label>)}
                  {(d.deleted || []).map((f) => <label key={"del" + f} style={{ display: "flex", gap: 6, alignItems: "center", margin: "2px 0", fontSize: 12.5, color: C.text }}><input type="checkbox" data-sandbox={item.sandboxDir} data-kind="del" data-target={f} /><span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>del {f}</span></label>)}
                  {tot === 0 ? <div style={{ fontSize: 12, color: C.muted }}>{"（无文件变更，可直接重用或销毁）"}</div> : null}
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button onClick={() => doExtract(item)} style={{ ...btnStyle, borderColor: C.accent, color: C.accent, padding: "3px 10px" }}>{"提取选中"}</button>
                  </div>
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button onClick={() => doReuse(item)} style={{ ...btnStyle, padding: "3px 10px" }}>{"♻ 重用"}</button>
                <button onClick={() => doDiscard(item)} style={{ ...btnStyle, padding: "3px 10px" }}>{"✗ 销毁"}</button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

function HistoryDialog({ currentSession }: { currentSession: SessionInfo }) {
  const open = useGate(HISTORY_KEY, "float");
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div onClick={() => setHistoryOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 314, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        onClick={(e) => e.stopPropagation()}
        data-ext-float="1"
        data-ext-float-full="1"
        data-ext-float-w={880}
        data-ext-float-h={620}
        data-ext-float-key={HISTORY_KEY}
        data-ext-float-dock="right-panel"
        style={{ width: 880, maxWidth: "calc(100vw - 16px)", height: "min(620px, 86vh)", borderRadius: 8, background: C.panel, border: "1px solid " + C.border, color: C.text, display: "flex", flexDirection: "column", overflow: "hidden", fontSize: 13, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid " + C.border, flexShrink: 0, cursor: "grab" }}>
          <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
            <Ic size={15} paths={ICONS.inbox} />
            {"Plan-Sandbox 沙箱历史"}
          </div>
          <button onClick={() => setHistoryOpen(false)} title="关闭" aria-label="关闭" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4, fontSize: 14, lineHeight: 1, flexShrink: 0 }}>
            <Ic size={12} paths={ICONS.x} />
          </button>
        </div>
        <HistoryBody currentSession={currentSession} />
      </div>
    </div>
  );
}

/** 停靠 face（rightFileDock item "history"）：仅 docked:right-panel 渲染（P3 批，无 default） */
function HistoryDockFace({ currentSession }: { currentSession: SessionInfo }) {
  const docked = useGate(HISTORY_KEY, { dock: "right-panel" });
  if (!docked) return null;
  return (
    <DockBody itemKey={HISTORY_KEY} zone="right-panel" title="Plan-Sandbox 沙箱历史" chrome="tab" zones={["right-panel"]}>
      <HistoryBody currentSession={currentSession} />
    </DockBody>
  );
}

/* ── toolbar 按钮：系统标准 36×36（AppShell topbarRowBtnStyle 同款）+ pending 徽标 ── */
const TOOLBAR_BTN_BASE: Record<string, string | number> = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 36,
  height: 36,
  padding: 0,
  background: "none",
  borderTop: "none",
  borderBottom: "none",
  borderLeft: "none",
  borderRight: "1px solid var(--border)",
  cursor: "pointer",
  flexShrink: 0,
  transition: "color 0.12s",
};
function ToolbarButton(_props: Record<string, unknown>) {
  const open = usePanelOpen();
  const [count, setCount] = useState(0);
  // 挂载时拉一次 pending 数（无轮询）；面板每次打开后由列表自刷新
  useEffect(() => {
    api("/list")
      .then((r) => r.json())
      .then((d) => setCount((d.pending || []).length))
      .catch(() => {});
  }, [open]);
  // ⋯ 菜单已由宿主按 meta.icon 渲染图标槽（onClick 走注册处的 meta.onClick），
  // render 只负责工具条本体按钮：pending 数徽标 + 待收尾高亮
  return (
    <button
      title={"Plan-Sandbox 采认（" + count + " 待收尾）"}
      onClick={() => setPanelOpen(!open)}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = count > 0 ? C.accent : "var(--text-muted)";
      }}
      style={{ ...TOOLBAR_BTN_BASE, position: "relative", color: count > 0 ? C.accent : "var(--text-muted)" }}
    >
      <Ic size={16} paths={ICONS.inbox} />
      {count > 0 ? (
        <span
          style={{
            position: "absolute",
            top: 4,
            right: 3,
            minWidth: 14,
            height: 14,
            borderRadius: 7,
            background: C.accent,
            color: "var(--bg-panel, #161920)",
            fontSize: 10,
            lineHeight: "14px",
            textAlign: "center",
            fontWeight: 700,
            padding: "0 3px",
          }}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/* ── 默认隐藏的「沙箱历史」工具栏按钮：feature=ui.toolbar.sandboxHistory 门控（默认关），
 *   extman 打开后才渲染。点开弹窗当前 workspace 的遗留沙箱。 ── */
function HistoryToolbarButton(_props: Record<string, unknown>) {
  const open = useHistoryOpen();
  return (
    <button
      title={"Plan-Sandbox 沙箱历史（当前 workspace 遗留沙箱）"}
      onClick={() => setHistoryOpen(!open)}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--text-muted)";
      }}
      style={{ ...TOOLBAR_BTN_BASE, color: "var(--text-muted)" }}
    >
      <Ic size={16} paths={ICONS.history} />
    </button>
  );
}

export default function register(ctx: Record<string, unknown>) {
  try {
    if (typeof ctx?.h !== "function") {
      console.warn("[aiti-plan-review] 宿主 ctx.h 不可用，client 跳过挂载");
      return;
    }
    __setCtx(ctx);
    const reg = ctx.registerItems as ((slot: string, items: unknown[]) => void) | undefined;
    // 声明式图标（{ svg } 内部标记，24×24 lucide 线条风格）+ 点击回调：
    // ⋯ 菜单图标槽与点击归宿主；render 仅承担工具条本体（pending 徽标/高亮）
    reg?.("toolbar", [
      {
        id: "aiti-plan-review-open",
        render: ToolbarButton,
        meta: {
          label: "Plan 采认",
          icon: { svg: ICONS.inbox.map((d) => `<path d="${d}"/>`).join("") },
          onClick: () => setPanelOpen(true),
        },
      },
      {
        id: "aiti-plan-review-history",
        render: HistoryToolbarButton,
        feature: "ui.toolbar.sandboxHistory",
        meta: {
          label: "沙箱历史",
          icon: { svg: ICONS.history.map((d) => `<path d="${d}"/>`).join("") },
          onClick: () => setHistoryOpen(true),
        },
      },
    ]);
    reg?.("composerTools", [{ id: "aiti-plan-review-chip", render: PlanChip, meta: { label: "plan" } }]);
    reg?.("dialogs", [
      { id: "aiti-plan-review-panel", render: ReviewDialog, meta: { label: "Plan 采认" } },
      { id: "aiti-plan-review-settle", render: SettleDialog, meta: { label: "plan 结算预览" } },
      { id: "aiti-plan-review-history-dialog", render: HistoryDialog, meta: { label: "沙箱历史" } },
    ]);
    // aiti-float dock v3：主面板默认右栏（P1）；沙箱历史低频不设 default（P3，仅给右栏可选）
    seedDockDefault(PANEL_KEY, "right-panel");
    reg?.("rightFileDock", [
      { id: "panel", render: ReviewDockFace, meta: { title: "Plan 采认" } },
      { id: "history", render: HistoryDockFace, meta: { title: "沙箱历史" } },
    ]);
    console.log("[aiti-plan-review] client 已挂载（toolbar 📥 + 沙箱历史🗂 按钮，dialogs 面板，dock v3 双面，JSX 构建版）");
  } catch (e) {
    console.warn("[aiti-plan-review] client 挂载失败（不影响页面）：", (e as Error)?.message || e);
  }
}
