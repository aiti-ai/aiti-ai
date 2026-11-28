/**
 * sidebar/branch-chip —— 折叠头右端分支 chip + 共享 BranchPanel 挂载（git-ops 方案 §3）。
 *
 * 门控（防御性降级）：refs 探测失败（引擎缺席 404 / 非 git 目录 400）→ chip 不渲染；
 * worktree 查询失败同样只影响面板 worktree 分区（空表）。
 * 数据（2026-09-17 lazy 化）：页面加载/切会话**零请求**——chip 先以「⎇」瘦形态常驻，
 * 点击（open）才探测 refs + 按需拉 worktree；面板内部数据自拉（零轮询），写操作经 onChanged 回拉。
 * 模块级 refs 缓存让切回已探测过的 cwd 立即恢复显示（零请求）。
 *
 * 消费方：SidebarContentDock（接管态 DockBody headerActions）与 SidebarDock（回退态头行）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiUrl, getExtService, onExtServiceChange, getLocale, createPortal } from "../host-shim";
import { BranchPanel } from "../../../../_shared/git-ops-client/branch-panel";
import { createGitOpsApi } from "../../../../_shared/git-ops-client/api.mjs";
import type { WorktreeRuntime } from "./use-worktree";

/** refs 快照缓存（模块级，页面生命周期内）：切回已探测过的 cwd 立即显示、零请求。 */
interface RefsSnapshot { current: string | null; detached: boolean; dirtyCount: number; }
const refsCache = new Map<string, RefsSnapshot>();

export interface BranchChipApi {
  /** chip 徽标元素（消费方挂项目选择行右端；badge 为 null 时整体缺席） */
  badge: unknown;
  /** chip 点击开关（消费方负责 stopPropagation） */
  onChipClick: (ev?: unknown) => void;
  /** 面板弹层（portal 到 body；消费方渲染在任意位置） */
  overlay: unknown;
  /** 面板是否开着 */
  open: boolean;
}

export function useBranchChip(opts: {
  cwd: string | null;
  homeDir?: string;
  worktree: WorktreeRuntime;
  onCwdChange?: (cwd: string) => void;
}): BranchChipApi {
  const { cwd, worktree } = opts;
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const [refs, setRefs] = useState<RefsSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  // ⚠ memo：api 对象不稳定会让下方 effect 每渲染重跑 → refs 请求风暴（实测）
  const api = useMemo(() => createGitOpsApi({ apiUrl }), [apiUrl]);

  const applyRefs = useCallback((data: { current?: string | null; detached?: boolean; dirtyCount?: number }) => {
    const snap: RefsSnapshot = { current: data.current ?? null, detached: !!data.detached, dirtyCount: data.dirtyCount ?? 0 };
    if (cwd) refsCache.set(cwd, snap);
    setRefs(snap);
    setUnavailable(false);
  }, [cwd]);
  // cwd 变化：切到缓存快照（无则瘦形态），重置不可用标记——不发起请求
  useEffect(() => {
    if (!cwd) { setRefs(null); setUnavailable(false); return; }
    setRefs(refsCache.get(cwd) ?? null);
    setUnavailable(false);
  }, [cwd]);
  // refs 探测：仅面板打开时拉（首次点击；面板开着时 cwd 变化重拉）——页面加载/切会话零请求
  useEffect(() => {
    if (!open || !cwd) return;
    let cancelled = false;
    api.refs(cwd).then((r) => {
      if (cancelled) return;
      if (r.status === 200 && r.data?.ok !== false) {
        applyRefs(r.data);
      } else {
        setRefs(null);
        setUnavailable(true); // 404=引擎缺席 / 400=非 git 目录：chip 隐藏（面板侧显示 loadError）
      }
    }).catch(() => { if (!cancelled) { setRefs(null); setUnavailable(true); } });
    return () => { cancelled = true; };
  }, [open, cwd, api, applyRefs]);
  // worktree 列表按需（面板 worktree 分区数据；幂等，cwd 未变不重拉）
  const ensureWorktree = worktree.ensure;
  useEffect(() => {
    if (open) ensureWorktree();
  }, [open, cwd, ensureWorktree]);

  // topic 订阅（git-ops §1.5）：folder 分组提交/终端经引擎的写操作也即时刷新 chip（零轮询）。
  // subscribe-topics 服务可能晚于本组件注册（event-bus client 懒物化）——经 onExtServiceChange 重挂。
  const [, bumpSvc] = useState(0);
  useEffect(() => onExtServiceChange((key, phase) => {
    if (key === "aiti-event-bus.subscribe-topics" && phase === "up") bumpSvc((v) => v + 1);
  }), []);
  useEffect(() => {
    if (!cwd) return;
    const svc = getExtService<((h: (f: any) => void, types: string[]) => { off: () => void }) | undefined>("aiti-event-bus.subscribe-topics");
    if (!svc) return;
    return svc((f: any) => {
      if (!f || typeof f.repo !== "string") return;
      if (f.repo === cwd || cwd.startsWith(f.repo + "/")) {
        if (!refsCache.has(cwd)) return; // 未探测过：等用户点击；外部写操作不触发首次加载
        api.refs(cwd).then((r) => {
          if (r.status === 200 && r.data?.ok !== false) applyRefs(r.data);
        }).catch(() => {});
      }
    }, ["aiti-git-ops:changed:*"]).off;
  }, [cwd, api, applyRefs]);

  // 块级 -p 能力探测（一次）+ 中继调用（session-manager server → aiti-cmd runner）
  const [ptyOk, setPtyOk] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/extensions/session-manager/git-ops-capabilities"))
      .then((r) => r.json())
      .then((d: { stashInteractive?: boolean }) => { if (!cancelled) setPtyOk(!!d.stashInteractive); })
      .catch(() => { /* 缺席即不可用 */ });
    return () => { cancelled = true; };
  }, [apiUrl]);
  const stashInteractive = useCallback(async (mode: "push" | "apply", index?: number) => {
    try {
      const res = await fetch(apiUrl("/api/extensions/session-manager/git-ops-stash-interactive"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, mode, index }),
      });
      const d = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      return { ok: res.status === 200 && d.ok === true, error: d.error };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [apiUrl, cwd]);

  const toggle = useCallback((ev?: unknown) => {
    const target = (ev as { currentTarget?: Element } | undefined)?.currentTarget;
    const rect = target?.getBoundingClientRect?.();
    if (rect) {
      setAnchor({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
    setOpen((v) => !v);
  }, []);

  if (!cwd || (unavailable && !open)) {
    return { badge: null, overlay: null, open: false, onChipClick: toggle };
  }

  // 与 picker 路径同款的内联样式（无框无底——workspace 左、分支右，一行一个样式）。
  // 未探测（lazy）时瘦形态：仅 ⎇ 图标 + 提示，点击后才出分支名/脏数。
  const badge = unavailable ? null : (
    <span
      data-branch-chip
      title={refs?.current
        ? `${refs.current}${refs.detached ? " (detached)" : ""}${refs.dirtyCount ? ` · ${refs.dirtyCount}` : ""}`
        : "分支 / 工作树"}
      onClick={(e) => { e.stopPropagation(); toggle(e); }}
      style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, minWidth: 0,
        fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.35,
        color: open ? "var(--accent)" : "var(--text)", cursor: "pointer", maxWidth: 110 }}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ flexShrink: 0 }}>
        <circle cx="4" cy="3.5" r="1.8" /><circle cx="4" cy="12.5" r="1.8" /><circle cx="12" cy="3.5" r="1.8" />
        <path d="M4 5.3v5.4M12 5.3c0 3-3 3.6-6 4.1" />
      </svg>
      {refs?.current ? (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{refs.current}</span>
      ) : null}
    </span>
  );

  const overlay = createPortal(
    <BranchPanel
      apiUrl={apiUrl}
      cwd={cwd}
      floatKey="sm-branch-panel"
      homeDir={opts.homeDir}
      locale={getLocale()}
      open={open}
      onClose={() => setOpen(false)}
      anchor={anchor}
      projectRoot={worktree.state?.projectRoot ?? null}
      worktrees={worktree.state?.worktrees ?? []}
      currentWorktreePath={worktree.currentWorktreePath}
      onSelectWorktree={(path) => worktree.select(path)}
      onCreateWorktree={(b) => worktree.create(b)}
      onRemoveWorktree={(path, force) => worktree.remove(path, force)}
      onWorktreeChanged={() => worktree.refresh()}
      onChanged={() => {
        // checkout/stash 后 chip 分支名即时刷新
        api.refs(cwd).then((r) => {
          if (r.status === 200 && r.data?.ok !== false) applyRefs(r.data);
        }).catch(() => {});
      }}
      pty={ptyOk ? { available: true, stashInteractive } : { available: false, stashInteractive }}
    />,
    document.body,
  );

  return {
    /** chip 徽标元素（消费方挂在项目选择行右端） */
    badge,
    /** 面板弹层（portal 到 body） */
    overlay,
    open,
    /** chip 点击（toggle；消费方包 stopPropagation） */
    onChipClick: toggle,
  };
}
