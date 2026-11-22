/**
 * sidebar/use-worktree —— worktree 状态/handler（原 SidebarList 内持有，分支 chip 方案
 * §2 上提到 dock 层：独立 worktree 行删除，UI 由共享 BranchPanel 接管，宿主
 * /api/worktrees* 数据与操作仍是唯一来源）。
 *
 * 惰性加载（2026-09-17 lazy 化）：不再随 cwd 自动拉（页面加载/切会话零 worktrees/query
 * 请求）——消费方（分支 chip 打开面板）点击时经 ensure() 触发；cwd 变化仅作废旧数据。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../host-shim";
import { normalizeWorkspaceKey } from "./pure";

export interface WorktreeEntry {
  path: string;
  branch?: string;
  isMain?: boolean;
}

export interface WorktreeStateInfo {
  forCwd: string;
  projectRoot: string;
  projectKey: string;
  isGit: boolean;
  isTopLevel: boolean;
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

export interface WorktreeRuntime {
  state: WorktreeStateInfo | null;
  loading: boolean;
  currentWorktree: WorktreeEntry | undefined;
  currentWorktreePath: string | null;
  /** 惰性加载（点击/打开面板时调用）：幂等——同 cwd 已有数据/加载中则跳过；force=true 强制重拉。 */
  ensure: (force?: boolean) => void;
  refresh: () => void;
  /** 切到某 worktree 路径（走宿主 onCwdChange 链） */
  select: (path: string) => void;
  /** 宿主新建 worktree（成功即自动切到新路径） */
  create: (branch: string) => Promise<{ path?: string; error?: string }>;
  /** 宿主移除（dirty 且未 force → 返回 {dirty:true} 交面板确认流） */
  remove: (path: string, force: boolean) => Promise<{ dirty?: boolean; error?: string }>;
}

export function useWorktree(cwd: string | null, onCwdChange?: (cwd: string) => void, _extraRefreshKey?: unknown): WorktreeRuntime {
  const [state, setState] = useState<WorktreeStateInfo | null>(null);
  const [loadingCwd, setLoadingCwd] = useState<string | null>(null);
  // 请求代号：cwd 变更/新请求发起时递增，过期回调丢弃（原 effect cancel 语义的手动化）
  const reqSeq = useRef(0);
  // ensure 幂等判定用的最新值镜像（见 ensure 注释）
  const stateRef = useRef(state);
  const loadingRef = useRef(loadingCwd);
  stateRef.current = state;
  loadingRef.current = loadingCwd;

  const fetchFor = useCallback((target: string) => {
    const seq = ++reqSeq.current;
    setLoadingCwd(target);
    fetch(apiUrl("/api/worktrees/query"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: target }),
    })
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (seq !== reqSeq.current) return;
        setLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setState(null);
          return;
        }
        setState({
          forCwd: target,
          projectRoot: d.projectRoot,
          projectKey: normalizeWorkspaceKey(d.projectKey ?? d.projectRoot),
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (seq !== reqSeq.current) return;
        setLoadingCwd(null);
        setState(null);
      });
  }, []);

  // 惰性：cwd 变化不再触发请求——仅作废当前数据与在途请求（下次 ensure() 按需重拉）
  useEffect(() => {
    reqSeq.current += 1;
    setState(null);
    setLoadingCwd(null);
  }, [cwd]);

  const ensure = useCallback((force = false) => {
    if (!cwd) return;
    // ref 读最新值（保持 ensure 引用稳定：消费方 effect 依赖它时不会因 state 变化重跑→失败重拉循环）
    if (!force && (stateRef.current?.forCwd === cwd || loadingRef.current === cwd)) return;
    fetchFor(cwd);
  }, [cwd, fetchFor]);

  const refresh = useCallback(() => { if (cwd) fetchFor(cwd); }, [cwd, fetchFor]);

  const select = useCallback((path: string) => {
    onCwdChange?.(path);
  }, [onCwdChange]);

  const create = useCallback(async (branch: string): Promise<{ path?: string; error?: string }> => {
    const name = branch.trim();
    if (!name || !state) return { error: state ? "branch required" : "no project" };
    try {
      const res = await fetch(apiUrl("/api/worktrees"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.projectRoot, branch: name }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) return { error: data.error ?? `HTTP ${res.status}` };
      setState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch: name, isMain: false }],
      } : prev);
      onCwdChange?.(data.path);
      return { path: data.path };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [state, onCwdChange]);

  const remove = useCallback(async (path: string, force: boolean): Promise<{ dirty?: boolean; error?: string }> => {
    if (!state) return { error: "no project" };
    try {
      const res = await fetch(apiUrl("/api/worktrees"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) return { dirty: true };
        return { error: data.error ?? `HTTP ${res.status}` };
      }
      // 移除的是当前 worktree → 回项目根（原 SidebarList handler 同语义）
      const currentPath = state.worktrees.find((w) => w.path === state.currentWorktreePath)?.path
        ?? (state.forCwd === cwd && state.currentWorktreePath ? state.currentWorktreePath : undefined)
        ?? undefined;
      if (currentPath === path) onCwdChange?.(state.projectRoot);
      return {};
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [state, cwd, onCwdChange]);

  const currentWorktree = state
    ? state.worktrees.find((w) => w.path === cwd)
      ?? (state.forCwd === cwd && state.currentWorktreePath
        ? state.worktrees.find((w) => w.path === state.currentWorktreePath)
        : undefined)
      ?? state.worktrees.find((w) => w.isMain)
    : undefined;

  return {
    state,
    loading: Boolean(cwd && loadingCwd === cwd),
    currentWorktree,
    currentWorktreePath: currentWorktree?.path ?? null,
    ensure,
    refresh,
    select,
    create,
    remove,
  };
}
