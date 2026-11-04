/**
 * git-ops-client · 共享分支面板（方案 §2：mockup ② 六分区）+ chip 徽标。
 *
 * 消费方（session-manager 折叠头 chip / aiti-folder 工具条）以 bundle 源引内联；
 * react hooks 经宿主 alias 委托（_shared 惯例）；apiUrl 由消费方注入（basePath 感知）。
 *
 * 主题硬条款（§2 v2 升格）：全部颜色走宿主 CSS vars
 * （--bg/--bg-hover/--border/--text/--text-muted/--text-dim/--accent/--font-mono），
 * 半透明派生一律 color-mix 且基色取自 var——零硬编码色值；验收=深/浅两主题截图比对。
 *
 * 数据：打开拉一次（refs/log/stash），写操作后本地刷新——零轮询。
 * worktree 分区数据与操作由消费方注入（宿主 /api/worktrees* 例外不进引擎，§2）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clampToViewport, fixedOrigin } from "../popup-anchor";
import { buildAtText, openNewSessionWithExtSvc } from "../new-session-cwd";
import { createGitOpsApi } from "./api.mjs";
import { makeT } from "./i18n.mjs";

/* ── chip 徽标（折叠头右端；非 git / 引擎缺席由消费方门控不渲染）── */

export function BranchChipBadge(p: {
  branch: string;
  dirtyCount?: number;
  open?: boolean;
  compact?: boolean;   // 小屏：仅 ⎇ 图标（title 保全文）
  title?: string;
}) {
  const label = p.compact ? "" : p.branch;
  return (
    <span
      data-branch-chip="1"
      title={p.title ?? `${p.branch}${p.dirtyCount ? ` · ${p.dirtyCount}` : ""}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontFamily: "var(--font-mono)", fontSize: 10.5,
        color: p.open ? "var(--accent)" : "var(--text)",
        background: "var(--bg-hover)",
        border: "1px solid " + (p.open ? "var(--accent)" : "var(--border)"),
        borderRadius: 6, padding: "2.5px 8px", cursor: "pointer",
        maxWidth: p.compact ? 26 : 150, lineHeight: 1.3, flexShrink: 0,
      }}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ flexShrink: 0 }}>
        <circle cx="4" cy="3.5" r="1.8" /><circle cx="4" cy="12.5" r="1.8" /><circle cx="12" cy="3.5" r="1.8" />
        <path d="M4 5.3v5.4M12 5.3c0 3-3 3.6-6 4.1" />
      </svg>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {typeof p.dirtyCount === "number" && p.dirtyCount > 0 && !p.compact ? (
        <span style={{ color: "var(--text-dim)", fontSize: 9.5, flexShrink: 0 }}>{p.dirtyCount}</span>
      ) : null}
    </span>
  );
}

/* ── 面板 ── */

export interface BranchPanelProps {
  apiUrl: (p: string) => string;
  cwd: string;
  homeDir?: string;
  locale?: string;
  open: boolean;
  onClose: () => void;
  /** chip 按钮视口矩形（getBoundingClientRect；面板右对齐其右缘、展开其下） */
  anchor: { left: number; top: number; right: number; bottom: number } | null;
  /** worktree 例外（宿主 /api/worktrees* 数据与操作，消费方注入） */
  projectRoot?: string | null;
  worktrees?: { path: string; branch?: string; isMain?: boolean }[];
  currentWorktreePath?: string | null;
  onSelectWorktree?: (path: string) => void;
  onCreateWorktree?: (branch: string) => Promise<{ path?: string; error?: string } | void>;
  onRemoveWorktree?: (path: string, force: boolean) => Promise<{ dirty?: boolean; error?: string } | void>;
  onWorktreeChanged?: () => void;
  /** 块级 -p（aiti-cmd PTY；缺席不渲染按钮） */
  pty?: {
    available: boolean;
    stashInteractive: (mode: "push" | "apply", index?: number) => Promise<{ ok: boolean; error?: string }>;
  };
  /** 写操作成功后通知消费方（刷新其他 git 面板） */
  onChanged?: () => void;
  /** 客户端服务解析（getExtService 封装）：Git Review 直开 / @ 到新会话所需；缺席隐藏对应按钮 */
  extSvc?: <T>(key: string) => T | undefined;
  /** 打开工作区文件（folder 注入；缺席隐藏「打开」按钮——commit 时点内容≠工作区，按钮文案已标注） */
  openFile?: (absPath: string) => void;
  /** aiti-float 持久化键（面板 portal 到 body 无 data-ext-item 祖先，须显式；两消费方各自传） */
  floatKey?: string;
}

const PANEL_W = 330;

export function BranchPanel(p: BranchPanelProps) {
  const t = useMemo(() => makeT(p.locale), [p.locale]);
  const api = useMemo(() => createGitOpsApi({ apiUrl: p.apiUrl }), [p.apiUrl]);
  const [refsData, setRefsData] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [wtMode, setWtMode] = useState<boolean>(() => {
    try { return localStorage.getItem("gitops.panel.wtMode") === "1"; } catch { return false; }
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [log, setLog] = useState<{ lines: string[]; nextCursor: number | null }>({ lines: [], nextCursor: null });
  const [logCursor, setLogCursor] = useState(0);
  const [stash, setStash] = useState<any[]>([]);
  const [stashFiles, setStashFiles] = useState<Record<number, { tracked: string[]; untracked: string[] }>>({});
  const [expandedStash, setExpandedStash] = useState<number | null>(null);
  const [checkedExtract, setCheckedExtract] = useState<Set<string>>(() => new Set());
  const [partOpen, setPartOpen] = useState(false);
  const [partChecked, setPartChecked] = useState<Set<string> | null>(null);
  const [dropConfirm, setDropConfirm] = useState<number | null>(null);
  const [conflict, setConflict] = useState<{ ref: string; files: string[] } | null>(null);
  const [createAt, setCreateAt] = useState<{ from: string; suggested?: string } | null>(null);
  const [createName, setCreateName] = useState("");
  // ── commit 详情卡（图谱点行；docs/aiti-git-ops-commit-card-plan.md）──
  const [commitSha, setCommitSha] = useState<string | null>(null);
  const [commitInfo, setCommitInfo] = useState<any>(null);
  const [commitLoadErr, setCommitLoadErr] = useState<string | null>(null);
  const [commitDiff, setCommitDiff] = useState<{ path: string; oldPath?: string; patch: string; truncated: boolean } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [tagInput, setTagInput] = useState(false);
  const [tagName, setTagName] = useState("");
  const [pickConflict, setPickConflict] = useState<string[] | null>(null);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewName, setWtNewName] = useState("");
  const [wtForceRemove, setWtForceRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const toggleSection = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const refreshData = useCallback(async () => {
    if (!p.cwd) return;
    setLoadError(null);
    const [r, g, s] = await Promise.all([
      api.refs(p.cwd),
      api.log(p.cwd, 0),
      api.stashList(p.cwd),
    ]);
    if (r.status === 404 || r.status === 0) { setLoadError(r.data?.error || "HTTP " + r.status); return; }
    if (r.status !== 200) { setLoadError(r.data?.error || "HTTP " + r.status); setRefsData(null); return; }
    setRefsData(r.data);
    setLog({ lines: g.data?.lines ?? [], nextCursor: g.data?.nextCursor ?? null });
    setLogCursor(0);
    setStash(s.data?.items ?? []);
  }, [api, p.cwd]);

  // 打开拉一次（cwd 变了重拉）
  useEffect(() => {
    if (!p.open || !p.cwd) return;
    void refreshData();
  }, [p.open, p.cwd, refreshData]);

  const loadMoreLog = useCallback(async () => {
    if (!p.cwd || log.nextCursor == null) return;
    const g = await api.log(p.cwd, log.nextCursor);
    if (g.status === 200) {
      setLog((prev) => ({ lines: [...prev.lines, ...(g.data?.lines ?? [])], nextCursor: g.data?.nextCursor ?? null }));
      setLogCursor(log.nextCursor);
    }
  }, [api, p.cwd, log.nextCursor]);

  // 定位：右对齐 chip、展开其下；下方装不下则压缩高度（面板内滚，不上翻——mockup 形态）
  useLayoutEffect(() => {
    if (!p.open || !p.anchor) return;
    const el = boxRef.current;
    const width = Math.min(PANEL_W, window.innerWidth - 16);
    let left = p.anchor.right - width;
    let top = (p.anchor.bottom ?? 0) + 6;
    const maxH = window.innerHeight - top - 8;
    if (el) {
      const c = clampToViewport(left, top, width, Math.min(el.offsetHeight, Math.max(maxH, 120)), 8);
      left = c.left; top = c.top;
    }
    const o = fixedOrigin(el);
    setPos((cur) => (cur && cur.left === left - o.x && cur.top === top - o.y ? cur : { left: left - o.x, top: top - o.y }));
  });

  // 点外关闭（chip 本体除外——由 chip onClick 单一开关）+ Escape
  useEffect(() => {
    if (!p.open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (boxRef.current?.contains(target)) return;
      if (target && typeof (target as Element).closest === "function" && (target as Element).closest("[data-branch-chip]")) return;
      p.onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [p.open, p.onClose]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); } finally { setBusy(false); }
  }, [busy]);

  const afterWrite = useCallback(() => {
    void refreshData();
    p.onChanged?.();
  }, [refreshData, p.onChanged]);

  /** checkout 家族统一管道：409 → 冲突三选一卡 */
  const switchTo = useCallback((ref: string) => run(async () => {
    if (wtMode) { await openAsWorktree(ref); return; }
    const r = await api.checkout(p.cwd, ref);
    if (r.status === 409 && r.data?.conflict) { setConflict({ ref, files: r.data.files ?? [] }); return; }
    if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
    afterWrite();
  }), [run, wtMode, api, p.cwd, afterWrite]);

  /** worktree 形态打开：已有同名 worktree 直接切；否则宿主建（会自动切项目） */
  const openAsWorktree = useCallback(async (branchName: string) => {
    if (!p.onCreateWorktree) { setError("worktree unavailable"); return; }
    const existing = (p.worktrees ?? []).find((w) => w.branch === branchName);
    if (existing) { p.onSelectWorktree?.(existing.path); p.onClose(); return; }
    const r = await p.onCreateWorktree(branchName);
    if (r && typeof r === "object" && r.error) { setError(r.error); return; }
    p.onClose();
  }, [p.onCreateWorktree, p.worktrees, p.onSelectWorktree, p.onClose]);

  /** 远程分支 → 先确保同名本地分支（无 tracking 语义，MVP），再走 worktree/checkout */
  const ensureLocalBranch = useCallback(async (remoteRef: string): Promise<string | null> => {
    const short = remoteRef.replace(/^[^/]+\//, "");
    if ((refsData?.branches ?? []).includes(short)) return short;
    const r = await api.branchCreate(p.cwd, short, remoteRef, false);
    if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return null; }
    return short;
  }, [refsData, api, p.cwd]);

  const onBranchRow = useCallback((branch: string, isRemote = false) => run(async () => {
    const target = isRemote ? await ensureLocalBranch(branch) : branch;
    if (!target) return;
    if (wtMode) await openAsWorktree(target);
    else await switchTo(target);
  }), [run, ensureLocalBranch, wtMode, openAsWorktree, switchTo]);

  const submitCreate = useCallback((from?: string) => run(async () => {
    const name = createName.trim();
    if (!name) return;
    if (wtMode) {
      const cr = await api.branchCreate(p.cwd, name, from, false);
      if (cr.status !== 200) { setError(cr.data?.error ?? "HTTP " + cr.status); return; }
      setCreateAt(null); setCreateName("");
      await openAsWorktree(name);
      return;
    }
    const r = await api.branchCreate(p.cwd, name, from, true);
    if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
    setCreateAt(null); setCreateName("");
    afterWrite();
  }), [run, createName, wtMode, api, p.cwd, openAsWorktree, afterWrite]);

  const submitWtNew = useCallback(() => run(async () => {
    const name = wtNewName.trim();
    if (!name) return;
    const r = await p.onCreateWorktree?.(name);
    if (r && typeof r === "object" && r.error) { setError(r.error); return; }
    setWtNewOpen(false); setWtNewName("");
    p.onWorktreeChanged?.();
    p.onClose();
  }), [run, wtNewName, p.onCreateWorktree, p.onWorktreeChanged, p.onClose]);

  const submitWtRemove = useCallback((path: string, force: boolean) => run(async () => {
    const r = await p.onRemoveWorktree?.(path, force);
    if (r && typeof r === "object" && r.dirty && !force) { setWtForceRemove(path); return; }
    if (r && typeof r === "object" && r.error) { setError(r.error); return; }
    setWtForceRemove(null);
    p.onWorktreeChanged?.();
  }), [run, p.onRemoveWorktree, p.onWorktreeChanged]);

  const expandStash = useCallback((index: number) => run(async () => {
    if (expandedStash === index) { setExpandedStash(null); return; }
    const f = await api.stashFiles(p.cwd, index);
    if (f.status !== 200) { setError(f.data?.error ?? "HTTP " + f.status); return; }
    setStashFiles((prev) => ({ ...prev, [index]: { tracked: f.data.tracked ?? [], untracked: f.data.untracked ?? [] } }));
    setCheckedExtract(new Set([...(f.data.tracked ?? []), ...(f.data.untracked ?? [])]));
    setExpandedStash(index);
  }), [run, expandedStash, api, p.cwd]);

  const extractChecked = useCallback((index: number) => run(async () => {
    const paths = [...checkedExtract];
    if (paths.length === 0) return;
    const r = await api.stashApply(p.cwd, index, { paths });
    if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
    setExpandedStash(null);
    afterWrite();
  }), [run, checkedExtract, api, p.cwd, afterWrite]);

  const stashAct = useCallback((index: number, opts: { pop?: boolean } = {}) => run(async () => {
    const r = await api.stashApply(p.cwd, index, opts);
    if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
    afterWrite();
  }), [run, api, p.cwd, afterWrite]);

  const dropStash = useCallback((index: number) => run(async () => {
    const r = await api.stashDrop(p.cwd, index);
    if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
    setDropConfirm(null);
    afterWrite();
  }), [run, api, p.cwd, afterWrite]);

  const submitPartialStash = useCallback(() => run(async () => {
    const checked = [...(partChecked ?? [])];
    if (checked.length === 0) return;
    const dirtyFiles = refsData?.dirtyFiles ?? [];
    const includeUntracked = checked.some((s) => dirtyFiles.find((f: any) => f.path === s)?.xy === "??");
    const r = await api.stashPush(p.cwd, { message: "aiti-git-ops partial", includeUntracked, paths: checked });
    if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
    setPartOpen(false);
    afterWrite();
  }), [run, partChecked, refsData, api, p.cwd, afterWrite]);

  const stashInteractive = useCallback((mode: "push" | "apply", index?: number) => run(async () => {
    const r = await p.pty?.stashInteractive(mode, index);
    if (r?.ok) setToast(t("stashInteractiveDone"));
    else setError((r?.error) || t("stashInteractiveFail"));
  }), [run, p.pty, t]);

  // ── commit 详情卡 ──
  const openCommit = useCallback((shaShort: string) => run(async () => {
    setCommitSha(shaShort);
    setCommitInfo(null);
    setCommitLoadErr(null);
    setCommitDiff(null);
    setPickConflict(null);
    setTagInput(false);
    setTagName("");
    const r = await api.commitShow(p.cwd, shaShort);
    if (r.status !== 200) { setCommitLoadErr(r.data?.error ?? "HTTP " + r.status); return; }
    setCommitInfo(r.data);
  }), [run, api, p.cwd]);

  const commitRef = () => String(commitInfo?.sha || commitSha || "");
  const repoDir = () => String(refsData?.repo || p.cwd || "");

  const openInReview = (opts?: { files?: string[] }) => {
    const openSvc = p.extSvc?.("aiti-git-review.open") as ((o: any) => void) | undefined;
    const workSvc = p.extSvc?.("aiti-git-review.work") as (() => void) | undefined;
    if (!openSvc || !workSvc) return false;
    const full = commitRef();
    if (!full || commitInfo?.parents?.length === 0) return false; // root commit 无 base，交由选择器手选
    openSvc({
      path: repoDir(),
      base: full + "^",
      ref2: full,
      ...(opts?.files?.length ? { files: opts.files } : {}),
    });
    try { workSvc(); } catch { /* work 缺席时 open 已把状态置好，宿主打开工作区后生效 */ }
    return true;
  };

  const atNewSession = async (text: string, targetDir: string) => {
    await openNewSessionWithExtSvc({
      text,
      targetDir,
      targetPath: targetDir,
      currentCwd: p.cwd,
      apiUrl: p.apiUrl,
      extSvc: p.extSvc,
    });
  };

  const copyText = useCallback(async (s: string, okMsg?: string) => {
    try {
      await navigator.clipboard.writeText(s);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* 剪贴板不可用静默 */ }
      ta.remove();
    }
    if (okMsg) setToast(okMsg);
  }, []);

  const submitTag = useCallback(() => run(async () => {
    const name = tagName.trim();
    if (!name || !commitRef()) return;
    const r = await api.tagCreate(p.cwd, name, commitRef());
    if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
    setTagInput(false);
    setTagName("");
    setToast(t("commitTagDone", name));
    afterWrite();
  }), [run, tagName, api, p.cwd, afterWrite, t]);

  const pickCommit = useCallback(() => run(async () => {
    const r = await api.cherryPick(p.cwd, commitRef());
    if (r.status === 409 && r.data?.conflict) { setPickConflict(r.data.files ?? []); return; }
    if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
    setToast(t("commitPickDone"));
    afterWrite();
  }), [run, api, p.cwd, afterWrite, t]);

  const abortPick = useCallback(() => run(async () => {
    const r = await api.cherryPick(p.cwd, "", { abort: true });
    if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
    setPickConflict(null);
    afterWrite();
  }), [run, api, p.cwd, afterWrite]);

  const showCommitDiff = useCallback((path: string, oldPath?: string) => run(async () => {
    setDiffLoading(true);
    try {
      const r = await api.commitDiff(p.cwd, commitRef(), oldPath ? [path, oldPath] : [path]);
      if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
      setCommitDiff({ path, oldPath, patch: r.data?.patch ?? "", truncated: !!r.data?.truncated });
    } finally {
      setDiffLoading(false);
    }
  }), [run, api, p.cwd]);

  const absFile = (rel: string) => repoDir().replace(/\/+$/, "") + "/" + rel;

  if (!p.open) return null;

  const sectionHead = (key: string, label: React.ReactNode) => (
    <div
      onClick={() => toggleSection(key)}
      style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as const,
        color: "var(--text-dim)", padding: "9px 12px 3px", cursor: "pointer", userSelect: "none" as const, display: "flex", alignItems: "center", gap: 4 }}
    >
      <span style={{ fontSize: 8, transform: collapsed.has(key) ? "none" : "rotate(90deg)", transition: "transform 0.15s" }}>▶</span>
      {label}
    </div>
  );

  const rowStyle = { display: "flex", alignItems: "center", gap: 7, padding: "4px 12px", fontSize: 12, cursor: "pointer", color: "var(--text)" } as const;

  const filtered = (list: string[]) => {
    const q = filter.trim().toLowerCase();
    return q ? list.filter((x) => x.toLowerCase().includes(q)) : list;
  };
  const branches = filtered(refsData?.branches ?? []);
  const tags = filtered(refsData?.tags ?? []);
  const remotes = filtered(refsData?.remotes ?? []);
  const showFilter = (refsData?.branches?.length ?? 0) + (refsData?.tags?.length ?? 0) >= 8;
  const dirtyCount = refsData?.dirtyCount ?? 0;

  return (
    <div
      ref={boxRef}
      // aiti-float 浮窗契约（docs/aiti-web-ext-float-dialogs.md）：大屏拖拽/缩放/移动/持久化 +
      // 自动 ⛶ 最大化钮；小屏（≤640px）铺满视口。pos="asis" 首次在 chip 下出现；持久化后恢复。
      data-ext-float="1"
      data-ext-float-full="1"
      data-ext-float-pos="asis"
      data-ext-float-w={Math.min(PANEL_W, window.innerWidth - 16)}
      data-ext-float-h={Math.round(Math.min(window.innerHeight * 0.62, 620))}
      {...(p.floatKey ? { "data-ext-float-key": p.floatKey } : {})}
      style={{
        position: "fixed", zIndex: 1000,
        left: pos ? pos.left : -99999, top: pos ? pos.top : -99999, width: Math.min(PANEL_W, window.innerWidth - 16),
        height: "min(62vh, 620px)",
        display: "flex", flexDirection: "column",
        background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
        boxShadow: "0 14px 36px color-mix(in srgb, var(--text) 14%, transparent)",
        overflow: "hidden",
        fontFamily: "inherit", textAlign: "left",
      }}
    >
      {/* 当前态：分支 + 脏文件徽标（点击开部分暂存卡） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          ⎇ {refsData?.current ?? (loadError ? t("noRepo") : t("loading"))}
        </span>
        {refsData?.aheadBehind ? (
          <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>↑{refsData.aheadBehind[0]} ↓{refsData.aheadBehind[1]}</span>
        ) : null}
        <span style={{ flex: 1 }} />
        {typeof dirtyCount === "number" && dirtyCount > 0 ? (
          <button
            type="button"
            title={t("stashPartTitle")}
            onClick={() => {
              setPartOpen((v) => !v);
              setPartChecked(new Set((refsData?.dirtyFiles ?? []).map((f: any) => f.path)));
            }}
            style={{ fontSize: 10, color: "var(--text)", background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 35%, transparent)", borderRadius: 5, padding: "1px 6px", cursor: "pointer", whiteSpace: "nowrap" as const, flexShrink: 0 }}
          >
            {t("dirty", dirtyCount)}
          </button>
        ) : null}
        <button type="button" title={t("close")} onClick={p.onClose}
          style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 12, padding: "0 2px", flexShrink: 0 }}>✕</button>
      </div>

      {loadError ? (
        <div style={{ padding: "14px 12px", fontSize: 11.5, color: "var(--text-muted)" }}>{loadError}</div>
      ) : !refsData ? (
        <div style={{ padding: "14px 12px", fontSize: 11.5, color: "var(--text-muted)" }}>{t("loading")}</div>
      ) : (
        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" as const }}>
          {/* worktree 模式开关 */}
          <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", fontSize: 11.5, color: "var(--text-muted)", borderBottom: "1px solid var(--border)", cursor: "pointer" }}
            title={wtMode ? t("wtModeOn") : t("wtMode")}>
            <input type="checkbox" checked={wtMode} onChange={(e) => {
              setWtMode(e.target.checked);
              try { localStorage.setItem("gitops.panel.wtMode", e.target.checked ? "1" : "0"); } catch { /* ignore */ }
            }}
              style={{ accentColor: "var(--accent)", margin: 0, flexShrink: 0 }} />
            {t("wtMode")}
          </label>

          {/* 冲突三选一卡（覆盖正文，mockup ③） */}
          {conflict ? (
            <div style={{ padding: "10px 12px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, display: "flex", gap: 7, alignItems: "center" }}>
                <span title="">⚠</span>{t("conflictTitle")} <span style={{ fontFamily: "var(--font-mono)" }}>{conflict.ref}</span>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "5px 0 7px" }}>{t("conflictDesc", conflict.files.length)}</div>
              <div style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 9px",
                fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 3, maxHeight: 96, overflowY: "auto" }}>
                {conflict.files.map((f) => (
                  <span key={f} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{f}</span>
                ))}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 9 }}>
                {p.onCreateWorktree ? (
                  <button type="button" disabled={busy} onClick={() => run(async () => { await openAsWorktree(conflict.ref); setConflict(null); })}
                    style={priBtn(busy)}>{t("conflictWt")}</button>
                ) : null}
                <button type="button" disabled={busy} onClick={() => run(async () => {
                  const r = await api.checkout(p.cwd, conflict.ref, "stash-then-switch");
                  if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
                  setConflict(null); afterWrite();
                })} style={secBtn()}>{t("conflictStash")}</button>
                <button type="button" onClick={() => setConflict(null)} style={ghostBtn()}>{t("cancel")}</button>
              </div>
            </div>
          ) : partOpen ? (
            /* 部分暂存卡（mockup ③ 下） */
            <div style={{ padding: "10px 12px" }}>
              <div style={{ fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 7 }}>
                {t("stashPartTitle")}
                <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, fontWeight: 400, fontFamily: "var(--font-mono)" }}>{t("stashPartHint")}</span>
              </div>
              <div style={{ marginTop: 7, display: "flex", flexDirection: "column", maxHeight: 180, overflowY: "auto" }}>
                {(refsData?.dirtyFiles ?? []).map((f: any) => {
                  const on = partChecked?.has(f.path) ?? false;
                  return (
                    <label key={f.path} style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", padding: "2.5px 0", cursor: "pointer" }}>
                      <input type="checkbox" checked={on} onChange={(e) => {
                        setPartChecked((prev) => {
                          const next = new Set(prev ?? []);
                          if (e.target.checked) next.add(f.path); else next.delete(f.path);
                          return next;
                        });
                      }} style={{ accentColor: "var(--accent)", margin: 0, flexShrink: 0 }} />
                      <span style={{ color: f.xy === "??" ? "var(--text-dim)" : "var(--text)", width: 20, flexShrink: 0 }}>{f.xy}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{f.path}</span>
                    </label>
                  );
                })}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
                <button type="button" disabled={busy || !partChecked?.size} onClick={submitPartialStash} style={miniBtn(busy || !partChecked?.size)}>{t("stashPartBtn")}</button>
                {p.pty?.available ? (
                  <button type="button" disabled={busy} onClick={() => stashInteractive("push")}
                    style={{ fontSize: 10.5, color: "var(--text-dim)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>{t("stashInteractive")}</button>
                ) : null}
              </div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 7 }}>{t("stashPartNote")}；{t("stashExtractNote")}</div>
              <button type="button" onClick={() => setPartOpen(false)} style={{ ...ghostBtn(), marginTop: 9, width: "100%" }}>{t("cancel")}</button>
            </div>
          ) : (
            <>
              {showFilter && (
                <div style={{ padding: "8px 12px 0", flexShrink: 0 }}>
                  <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("filter")}
                    onKeyDown={(e) => { if (e.key === "Escape") { setFilter(""); } }}
                    style={{ width: "100%", height: 26, boxSizing: "border-box" as const, background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6,
                      color: "var(--text)", fontSize: 11, padding: "0 9px", outline: "none" }} />
                </div>
              )}

              {/* 分支 */}
              {sectionHead("branches", t("branches"))}
              {!collapsed.has("branches") && (
                <div style={{ paddingBottom: 2 }}>
                  {branches.map((b) => {
                    const isCur = !refsData.detached && b === refsData.current;
                    return (
                      <div key={b} className="gitops-row" onClick={() => void onBranchRow(b)} style={rowStyle}>
                        {isCur
                          ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                          : <span style={{ width: 10, flexShrink: 0 }} />}
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{b}</span>
                        {isCur && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{t("current")}</span>}
                      </div>
                    );
                  })}
                  {(refsData?.remotes?.length ?? 0) > 0 && (
                    <div onClick={() => setRemotesOpen((v) => !v)} style={{ ...rowStyle, color: "var(--text-muted)", fontSize: 11 }}>
                      <span style={{ width: 10, flexShrink: 0 }} />
                      {t("remotes", refsData.remotes.length)}
                    </div>
                  )}
                  {remotesOpen && remotes.map((b) => (
                    <div key={b} className="gitops-row" onClick={() => void onBranchRow(b, true)} style={{ ...rowStyle, paddingLeft: 28 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{b}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Tag */}
              {sectionHead("tags", t("tags"))}
              {!collapsed.has("tags") && tags.map((tag) => (
                <div key={tag} style={{ display: "flex", alignItems: "center" }}>
                  <div className="gitops-row" onClick={() => void onBranchRow(tag)} style={{ ...rowStyle, flex: 1, minWidth: 0 }}>
                    <span style={{ width: 10, flexShrink: 0 }} />
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{tag}</span>
                    <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, flexShrink: 0, paddingLeft: 8 }}>{t("tagCheckoutHint")}</span>
                  </div>
                  <button type="button" title={t("createFromRef")} onClick={(e) => { e.stopPropagation(); setCreateAt({ from: tag, suggested: "tag/" + tag.replace(/[^\w.-]+/g, "-") }); setCreateName("tag/" + tag.replace(/[^\w.-]+/g, "-")); }}
                    style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "4px 8px", flexShrink: 0 }}>⎘</button>
                </div>
              ))}

              {/* 新建分支 */}
              {sectionHead("new", t("newBranch"))}
              {!collapsed.has("new") && (
                <div style={{ display: "flex", gap: 6, margin: "4px 12px 0" }}>
                  <input value={createAt?.from && createAt.from !== "HEAD" ? createName : createName} onChange={(e) => { setCreateName(e.target.value); setCreateAt((prev) => (prev ? { ...prev } : null)); }}
                    placeholder={t("newBranchPlaceholder")}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitCreate(createAt?.from); } }}
                    style={{ flex: 1, minWidth: 0, height: 25, boxSizing: "border-box" as const, background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)", padding: "0 8px", outline: "none" }} />
                  <button type="button" disabled={busy || !createName.trim()} onClick={() => void submitCreate(createAt?.from)} style={miniBtn(busy || !createName.trim())}>
                    {wtMode ? t("createWt") : t("createCheckout")}
                  </button>
                </div>
              )}
              {!collapsed.has("new") && createAt?.from && createAt.from !== "HEAD" ? (
                <div style={{ fontSize: 10, color: "var(--text-dim)", margin: "3px 12px 0" }}>{t("from")}: <span style={{ fontFamily: "var(--font-mono)" }}>{createAt.from}</span>
                  <button type="button" onClick={() => { setCreateAt(null); setCreateName(""); }} style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 10, padding: "0 4px" }}>✕</button>
                </div>
              ) : null}

              {/* worktree */}
              {/* worktree 分区：消费方提供宿主 worktree 回调才渲染（folder 无此面 → 整区隐藏） */}
              {p.onCreateWorktree ? sectionHead("worktree", t("worktree")) : null}
              {!collapsed.has("worktree") && p.onCreateWorktree ? (
                <div style={{ paddingBottom: 2 }}>
                  {(p.worktrees ?? []).map((w) => {
                    const isCur = w.path === p.currentWorktreePath;
                    if (wtForceRemove === w.path) {
                      return (
                        <div key={w.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "color-mix(in srgb, var(--text) 6%, transparent)", fontSize: 11 }}>
                          <span style={{ flex: 1, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{t("worktreeForceConfirm")}</span>
                          <button type="button" disabled={busy} onClick={() => void submitWtRemove(w.path, true)} style={miniBtn(busy)}>Force</button>
                          <button type="button" onClick={() => setWtForceRemove(null)} style={{ border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text-muted)", borderRadius: 5, fontSize: 11, padding: "3px 9px", cursor: "pointer" }}>{t("cancel")}</button>
                        </div>
                      );
                    }
                    return (
                      <div key={w.path} style={{ display: "flex", alignItems: "center" }}>
                        <div className="gitops-row" onClick={() => { p.onSelectWorktree?.(w.path); p.onClose(); }} title={w.path} style={{ ...rowStyle, flex: 1, minWidth: 0 }}>
                          <span style={{ color: isCur ? "var(--accent)" : "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>●</span>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                            {w.branch ?? w.path}{w.isMain ? ` · ${t("worktreeMain")}` : ""}
                          </span>
                        </div>
                        {!w.isMain && (
                          <button type="button" title={t("worktreeRemoveTitle")} onClick={() => void submitWtRemove(w.path, false)}
                            style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "4px 8px", flexShrink: 0 }}>✕</button>
                        )}
                      </div>
                    );
                  })}
                  {wtNewOpen ? (
                    <div style={{ display: "flex", gap: 6, margin: "4px 12px 6px" }}>
                      <input value={wtNewName} onChange={(e) => setWtNewName(e.target.value)} placeholder={t("worktreeBranchPlaceholder")} autoFocus
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitWtNew(); } if (e.key === "Escape") setWtNewOpen(false); }}
                        style={{ flex: 1, minWidth: 0, height: 25, boxSizing: "border-box" as const, background: "var(--bg-hover)", border: "1px solid var(--accent)", borderRadius: 6, color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)", padding: "0 8px", outline: "none" }} />
                      <button type="button" disabled={busy || !wtNewName.trim()} onClick={() => void submitWtNew()} style={miniBtn(busy || !wtNewName.trim())}>{t("createWt")}</button>
                    </div>
                  ) : (
                    <div className="gitops-row" onClick={() => setWtNewOpen(true)} style={{ ...rowStyle, color: "var(--text-muted)", fontSize: 11 }}>{t("newWorktree")}</div>
                  )}
                </div>
              ) : null}

              {/* stash */}
              {sectionHead("stash", `${t("stash")}${stash.length ? ` (${stash.length})` : ""}`)}
              {!collapsed.has("stash") && (
                <div style={{ paddingBottom: 6 }}>
                  {stash.length === 0 && <div style={{ padding: "2px 12px 4px", fontSize: 11, color: "var(--text-dim)" }}>{t("stashEmpty")}</div>}
                  {stash.map((it: any, idxFromEnd: number) => {
                    const index = stash.length - 1 - idxFromEnd; // stash@{0} = 最新（列表首行）
                    const no = stash.length - 1 - idxFromEnd;
                    const files = stashFiles[index];
                    return (
                      <div key={it.sha + String(index)}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 12px" }}>
                          <span className="gitops-row" onClick={() => void expandStash(index)} title={t("stashExpand")}
                            style={{ display: "flex", alignItems: "center", gap: 7, flex: 1, minWidth: 0, cursor: "pointer", fontSize: 12 }}>
                            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", flexShrink: 0 }}>{`stash@{${no}}`}</span>
                            <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, fontSize: 11 }}>{it.message}</span>
                          </span>
                          <button type="button" title={t("stashApply")} onClick={() => void stashAct(index)} style={iconBtn()}>↧</button>
                          <button type="button" title={t("stashPop")} onClick={() => void stashAct(index, { pop: true })} style={iconBtn()}>⤓</button>
                          <button type="button" title={t("stashDrop")} onClick={() => setDropConfirm(index)} style={iconBtn()}>✕</button>
                        </div>
                        {expandedStash === index && files ? (
                          <div style={{ margin: "2px 12px 6px", padding: "6px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6 }}>
                            <div style={{ maxHeight: 110, overflowY: "auto" }}>
                              {[...files.tracked.map((f) => ({ f, u: false })), ...files.untracked.map((f) => ({ f, u: true }))].map(({ f, u }) => {
                                const on = checkedExtract.has(f);
                                return (
                                  <label key={f} style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", padding: "2px 0", cursor: "pointer" }}>
                                    <input type="checkbox" checked={on} onChange={(e) => {
                                      setCheckedExtract((prev) => {
                                        const next = new Set(prev);
                                        if (e.target.checked) next.add(f); else next.delete(f);
                                        return next;
                                      });
                                    }} style={{ accentColor: "var(--accent)", margin: 0, flexShrink: 0 }} />
                                    <span style={{ color: u ? "var(--text-dim)" : "var(--text)", flexShrink: 0 }}>{u ? "??" : "M "}</span>
                                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{f}</span>
                                  </label>
                                );
                              })}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                              <button type="button" disabled={busy || checkedExtract.size === 0} onClick={() => void extractChecked(index)} style={miniBtn(busy || checkedExtract.size === 0)}>{t("stashExtract")}</button>
                              {p.pty?.available ? (
                                <button type="button" disabled={busy} onClick={() => stashInteractive("apply", index)} style={{ fontSize: 10.5, color: "var(--text-dim)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>{t("stashInteractive")}</button>
                              ) : null}
                            </div>
                            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 5 }}>{t("stashExtractNote")}</div>
                          </div>
                        ) : null}
                        {dropConfirm === index ? (
                          <div style={{ margin: "2px 12px 6px", padding: "8px 10px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6 }}>
                            <div style={{ fontSize: 11.5, fontWeight: 600 }}>⚠ {t("dropConfirmTitle")}</div>
                            <div style={{ fontSize: 10.5, color: "var(--text-muted)", margin: "4px 0 8px", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                              stash@{`{${index}}`} {it.sha} · {it.message}
                            </div>
                            <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 8 }}>{t("dropConfirmNote")}</div>
                            <div style={{ display: "flex", gap: 6 }}>
                              <button type="button" disabled={busy} onClick={() => void dropStash(index)} style={miniBtn(busy)}>{t("stashDrop")}</button>
                              <button type="button" onClick={() => setDropConfirm(null)} style={{ border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text-muted)", borderRadius: 5, fontSize: 11, padding: "3px 9px", cursor: "pointer" }}>{t("cancel")}</button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 图谱 */}
              {sectionHead("graph", t("graph"))}
              {!collapsed.has("graph") && (
                <div style={{ paddingBottom: 2 }}>
                  {log.lines.length === 0 && <div style={{ padding: "2px 12px 4px", fontSize: 11, color: "var(--text-dim)" }}>{t("graphEmpty")}</div>}
                  {log.lines.map((line, i) => {
                    const m = line.match(/^([*|\\/ ]+\s*)([0-9a-f]{7,})( .*)?$/);
                    if (!m) return <div key={i} style={{ ...graphLineStyle, opacity: 0.7 }}>{line}</div>;
                    const sha = m[2].slice(0, 7);
                    return (
                      <div key={i} className="gitops-row" onClick={() => void openCommit(sha)} title={t("commitView")}
                        style={{ ...graphLineStyle, cursor: "pointer" }}>
                        <span style={{ color: "var(--text-dim)" }}>{m[1]}</span>
                        <span style={{ color: "var(--accent)" }}>{sha}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{m[3] ?? ""}</span>
                      </div>
                    );
                  })}
                  {log.nextCursor != null && (
                    <button type="button" disabled={busy} onClick={() => void loadMoreLog()} style={{ display: "block", width: "100%", textAlign: "center" as const, padding: "5px 0", fontSize: 10, color: "var(--text-dim)", background: "none", border: "none", cursor: "pointer" }}>
                      {t("graphMore")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* commit 详情卡（图谱点行；查看/操作面，docs/aiti-git-ops-commit-card-plan.md；覆盖正文） */}
      {commitSha && !conflict && !partOpen ? (
        <div style={{ position: "absolute" as const, inset: 0, background: "var(--bg)", display: "flex", flexDirection: "column" }}>
          {/* 头：返回 + sha/subject + 元信息 + 操作行 */}
          <div style={{ padding: "8px 12px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button type="button" title={t("commitBack")} onClick={() => setCommitSha(null)} style={iconBtn()}>←</button>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--accent)", cursor: "pointer", flexShrink: 0 }}
                title={t("commitCopySha")} onClick={() => void copyText(commitRef(), t("commitCopySha"))}>
                {commitRef().slice(0, 9)}
              </span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, fontSize: 11.5, color: "var(--text)" }}
                title={commitInfo?.subject || undefined}>
                {commitInfo?.subject ?? (commitLoadErr ? "" : "…")}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", flexWrap: "wrap" as const }}>
              {commitLoadErr ? <span style={{ color: "var(--text-muted)" }}>{t("commitLoadFail")}：{commitLoadErr}</span> : null}
              {commitInfo ? <span>{commitInfo.author} · {String(commitInfo.date || "").slice(0, 10)}</span> : null}
              {commitInfo?.merge ? <span>{t("commitMergeNote", String(commitInfo.parents?.[0] || "").slice(0, 8))}</span> : null}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 5 }}>
              <button type="button" disabled={busy} title={t("createAt")} onClick={() => { setCreateAt({ from: commitRef() }); setCreateName(""); }} style={chipBtn()}>{t("commitBranch")}</button>
              <button type="button" disabled={busy} onClick={() => { setTagInput((v) => !v); setTagName(""); }} style={chipBtn()}>{t("commitTag")}</button>
              {!wtMode ? (
                <button type="button" disabled={busy} title={t("commitCheckoutTitle")} onClick={() => void switchTo(commitRef())} style={chipBtn()}>{t("commitCheckout")}</button>
              ) : null}
              <button type="button" disabled={busy} title={t("commitPickTitle")} onClick={() => void pickCommit()} style={chipBtn()}>{t("commitPick")}</button>
              {p.extSvc ? (
                <button type="button" disabled={busy} title={t("commitReviewTitle")} onClick={() => { openInReview(); }} style={chipBtn()}>{t("commitReview")}</button>
              ) : null}
              <button type="button" disabled={busy} title={t("commitAtNewTitle")} onClick={() => {
                const s = commitInfo?.subject ? `（${commitInfo.subject}）` : "";
                void atNewSession(`请解读 commit ${commitRef()}${s} 的改动`, repoDir());
              }} style={chipBtn()}>{t("commitAtNew")}</button>
            </div>
            {tagInput ? (
              <div style={{ display: "flex", gap: 6 }}>
                <input autoFocus value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder={t("commitTagPlaceholder")}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitTag(); } if (e.key === "Escape") setTagInput(false); }}
                  style={{ flex: 1, minWidth: 0, height: 25, boxSizing: "border-box" as const, background: "var(--bg-hover)", border: "1px solid var(--accent)", borderRadius: 6, color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)", padding: "0 8px", outline: "none" }} />
                <button type="button" disabled={busy || !tagName.trim()} onClick={() => void submitTag()} style={miniBtn(busy || !tagName.trim())}>✓</button>
              </div>
            ) : null}
            {pickConflict ? (
              <div style={{ padding: "6px 8px", background: "color-mix(in srgb, var(--text) 6%, transparent)", border: "1px solid var(--border)", borderRadius: 6 }}>
                <div style={{ fontSize: 10.5, color: "var(--text)" }}>{t("commitPickConflict")}</div>
                <div style={{ margin: "4px 0 6px", display: "flex", flexDirection: "column", maxHeight: 72, overflowY: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>
                  {pickConflict.map((f) => <span key={f} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{f}</span>)}
                </div>
                <button type="button" disabled={busy} title={t("commitPickAbortTitle")} onClick={() => void abortPick()} style={miniBtn(busy)}>{t("commitPickAbort")}</button>
              </div>
            ) : null}
          </div>
          {/* 正文：单文件 diff 视图 / 变更文件清单 */}
          {commitDiff ? (
            <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                <button type="button" title={t("commitBack")} onClick={() => setCommitDiff(null)} style={iconBtn()}>←</button>
                <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }} title={commitDiff.oldPath ? `${commitDiff.oldPath} → ${commitDiff.path}` : commitDiff.path}>
                  {commitDiff.oldPath ? `${commitDiff.oldPath} → ${commitDiff.path}` : commitDiff.path}
                </span>
                <button type="button" title={t("commitCopyPath")} onClick={() => void copyText(absFile(commitDiff.path))} style={iconBtn()}>⎘</button>
                {p.openFile ? (
                  <button type="button" title={t("commitOpenFile")} onClick={() => p.openFile?.(absFile(commitDiff.path))} style={iconBtn()}>↗</button>
                ) : null}
                <button type="button" title={t("commitAtFile")} onClick={() => {
                  const abs = absFile(commitDiff.path);
                  void atNewSession(buildAtText(abs), abs);
                }} style={iconBtn()}>@</button>
                {p.extSvc ? (
                  <button type="button" title={t("commitReviewFile")} onClick={() => { openInReview({ files: commitDiff.oldPath ? [commitDiff.path, commitDiff.oldPath] : [commitDiff.path] }); }} style={iconBtn()}>👁</button>
                ) : null}
              </div>
              <pre style={{ flex: "1 1 auto", minHeight: 0, overflow: "auto", margin: 0, padding: "6px 0 10px", fontFamily: "var(--font-mono)", fontSize: 10, lineHeight: 1.45, whiteSpace: "pre" as const }}>
                {commitDiff.patch.split("\n").map((ln, i) => (
                  <div key={i} style={{
                    padding: "0 12px",
                    color: ln.startsWith("+") && !ln.startsWith("+++") ? "var(--ok, var(--accent))"
                      : ln.startsWith("-") && !ln.startsWith("---") ? "var(--danger, var(--text-muted))"
                      : ln.startsWith("@@") || ln.startsWith("diff ") || ln.startsWith("index ") ? "var(--text-dim)"
                      : "var(--text-muted)",
                    background: ln.startsWith("+") && !ln.startsWith("+++") ? "color-mix(in srgb, var(--ok, var(--accent)) 10%, transparent)"
                      : ln.startsWith("-") && !ln.startsWith("---") ? "color-mix(in srgb, var(--danger, var(--text-muted)) 10%, transparent)"
                      : undefined,
                  }}>{ln || " "}</div>
                ))}
              </pre>
              {commitDiff.truncated ? (
                <div style={{ padding: "4px 12px 8px", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{t("commitDiffTruncated")}</div>
              ) : null}
            </div>
          ) : (
            <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" as const }}>
              <div style={{ padding: "7px 12px 3px", fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "var(--text-dim)", display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ flexShrink: 0 }}>{commitInfo ? t("commitFiles", commitInfo.files?.length ?? 0) : "…"}</span>
                {commitInfo ? (
                  <span style={{ fontWeight: 400, textTransform: "none" as const, letterSpacing: 0, fontFamily: "var(--font-mono)" }}>
                    +{commitInfo.additions ?? 0} / −{commitInfo.deletions ?? 0}
                  </span>
                ) : null}
              </div>
              {(commitInfo?.files ?? []).map((f: any) => (
                <div key={f.path} className="gitops-row" onClick={() => void showCommitDiff(f.path, f.oldPath)} title={t("commitFileDiffTitle")}
                  style={{ display: "flex", alignItems: "center", gap: 7, padding: "3.5px 12px", fontSize: 11, cursor: "pointer" }}>
                  <span style={{ width: 12, flexShrink: 0, fontFamily: "var(--font-mono)", color: f.status === "A" ? "var(--ok, var(--accent))" : f.status === "D" ? "var(--danger, var(--text-muted))" : "var(--text-dim)" }}>{f.status}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, fontFamily: "var(--font-mono)", color: "var(--text)" }} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                    {f.oldPath ? `${f.path} ← ${f.oldPath}` : f.path}
                  </span>
                  <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
                    {f.additions ? `+${f.additions}` : ""}{f.deletions ? ` −${f.deletions}` : ""}
                  </span>
                </div>
              ))}
              {commitInfo && (commitInfo.files?.length ?? 0) === 0 ? (
                <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--text-dim)" }}>—</div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {/* commit 建分支卡（图谱/tag 入口；覆盖正文；渲染在详情卡之后 = 叠其上，取消回到详情卡） */}
      {createAt && !conflict && !partOpen ? (
        <div style={{ position: "absolute" as const, inset: 0, background: "var(--bg)", padding: "12px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>{t("createAt")}</div>
          <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{t("from")}: <span style={{ fontFamily: "var(--font-mono)" }}>{createAt.from}</span></div>
          <input value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder={t("newBranchPlaceholder")} autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submitCreate(createAt.from); } if (e.key === "Escape") setCreateAt(null); }}
            style={{ height: 27, boxSizing: "border-box" as const, background: "var(--bg-hover)", border: "1px solid var(--accent)", borderRadius: 6, color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)", padding: "0 8px", outline: "none" }} />
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" disabled={busy || !createName.trim()} onClick={() => void submitCreate(createAt.from)} style={{ ...miniBtn(busy || !createName.trim()), flex: 1 }}>
              {wtMode ? t("createWt") : t("createCheckout")}
            </button>
            <button type="button" onClick={() => setCreateAt(null)} style={{ border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text-muted)", borderRadius: 5, fontSize: 11, padding: "3px 9px", cursor: "pointer" }}>{t("cancel")}</button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div style={{ padding: "6px 12px 8px", fontSize: 11, color: "var(--text)", background: "color-mix(in srgb, var(--text) 6%, transparent)", borderTop: "1px solid var(--border)", overflowWrap: "anywhere" as const, flexShrink: 0 }}>
          {t("errPrefix")}：{error}
          <button type="button" onClick={() => setError(null)} style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "0 4px" }}>✕</button>
        </div>
      ) : null}
      {toast ? (
        <div style={{ padding: "6px 12px 8px", fontSize: 11, color: "var(--text-muted)", borderTop: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ flex: 1 }}>{toast}</span>
          <button type="button" onClick={() => setToast(null)} style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: 0 }}>✕</button>
        </div>
      ) : null}
    </div>
  );
}

/* ── 按钮样式（全部 var 基色）── */
const priBtn = (busy: boolean) => ({
  height: 27, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  fontSize: 11.5, cursor: busy ? "not-allowed" : "pointer", fontWeight: 600,
  background: "var(--accent)", color: "var(--bg)", border: "1px solid var(--accent)", opacity: busy ? 0.6 : 1,
} as const);
const secBtn = () => ({
  height: 27, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
  fontSize: 11.5, cursor: "pointer", background: "var(--bg-hover)", color: "var(--text)", border: "1px solid var(--border)",
} as const);
const ghostBtn = () => ({
  height: 27, borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center",
  fontSize: 11.5, cursor: "pointer", background: "none", color: "var(--text-dim)", border: "none",
} as const);
const miniBtn = (disabled?: boolean) => ({
  height: 25, padding: "0 10px", borderRadius: 6, background: "var(--accent)", color: "var(--bg)",
  fontSize: 10.5, display: "inline-flex", alignItems: "center", whiteSpace: "nowrap" as const,
  border: "1px solid var(--accent)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1,
} as const);
const iconBtn = () => ({
  border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11,
  padding: "2px 3px", flexShrink: 0,
} as const);
/** commit 卡操作行小按钮（轻量 chip：描边 + var 基色，主题硬条款合规） */
const chipBtn = (disabled?: boolean) => ({
  height: 22, padding: "0 8px", borderRadius: 6, display: "inline-flex", alignItems: "center", gap: 4,
  fontSize: 10.5, whiteSpace: "nowrap" as const, flexShrink: 0,
  background: "var(--bg-hover)", color: "var(--text)", border: "1px solid var(--border)",
  cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1,
} as const);
const graphLineStyle = {
  display: "flex", gap: 7, padding: "2.5px 12px", fontFamily: "var(--font-mono)", fontSize: 10.5,
  color: "var(--text-muted)", overflow: "hidden",
} as const;
