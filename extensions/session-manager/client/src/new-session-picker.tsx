/**
 * new-session-picker —— 新建会话「分支 / Worktree」选择器（方案
 * docs/pi-web-new-session-branch-worktree-plan.md §2/§4，M2）。
 *
 * 渲染：宿主 newSessionSelectors 插槽（欢迎页 Workspace×Backend 之间）——触发器外观
 * 对齐相邻 select，展开为自绘弹层（BranchPanel 同款样式语言/点外关闭/CSS vars）。
 * 执行：newSessionPreparers 注册面（meta.prepare）——发送首条消息时统一执行写操作
 * （建/复用 worktree → 改写目标 cwd；checkout → 409 三选一卡，绝不丢未提交文件）。
 * 选择阶段零副作用（统一意图模型 P1-1）：任何选择只暂存意图 + 显示意图条。
 *
 * 降级（§2.3）：非 git 目录整器不渲染；aiti-git-ops 缺席（refs 404）→ 分支分区与
 * 「管理分支…」隐藏、worktree 模式强制按开；数据零轮询（cwd 变更拉一次 + git-ops
 * changed topic 订阅刷新，branch-chip 同款）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { apiUrl, getLocale, getExtService, onExtServiceChange } from "./host-shim";
import { BranchPanel } from "../../../_shared/git-ops-client/branch-panel";
import { createGitOpsApi } from "../../../_shared/git-ops-client/api.mjs";
import { makeT } from "../../../_shared/git-ops-client/i18n.mjs";
import { clampToViewport } from "../../../_shared/popup-anchor";
import { useWorktree, type WorktreeEntry } from "./sidebar/use-worktree";
import { resolvePickerAction, effectiveMode, shortBranchName } from "./new-session-picker.pure";
import type { PickerIntent, PickerSelection } from "./new-session-picker.pure";

/* ── 模块级意图/冲突 store（picker 写、preparer 读；选择阶段零副作用）── */

const intentListeners = new Set<() => void>();
let intentState: PickerIntent | null = null;
export function getIntent(): PickerIntent | null {
  return intentState;
}
export function setIntent(next: PickerIntent | null): void {
  intentState = next;
  for (const l of [...intentListeners]) { try { l(); } catch { /* 订阅方错误不阻断 */ } }
}
function subscribeIntent(cb: () => void): () => void {
  intentListeners.add(cb);
  return () => { intentListeners.delete(cb); };
}

export type ConflictChoice = "worktree" | "stash" | "cancel";
interface ConflictRequest {
  ref: string;
  files: string[];
  resolve: (choice: ConflictChoice) => void;
}
const conflictListeners = new Set<() => void>();
let conflictState: ConflictRequest | null = null;
function setConflictReq(next: ConflictRequest | null): void {
  conflictState = next;
  for (const l of [...conflictListeners]) { try { l(); } catch { /* ignore */ } }
}
/** 409 冲突三选一（BranchPanel conflict 卡同 UI）：preparer await 用户决议。 */
export function requestConflictChoice(ref: string, files: string[]): Promise<ConflictChoice> {
  return new Promise((resolve) => { setConflictReq({ ref, files, resolve }); });
}

/* ── 数据面 ── */

interface WtQuery {
  projectRoot: string;
  isGit: boolean;
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}
async function queryWorktreeState(cwd: string): Promise<WtQuery | null> {
  try {
    const res = await fetch(apiUrl("/api/worktrees/query"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const d = await res.json().catch(() => null) as (WtQuery & { error?: string }) | null;
    if (!d || d.error || !d.projectRoot || d.isGit === false) return null;
    return { projectRoot: d.projectRoot, isGit: d.isGit !== false, currentWorktreePath: d.currentWorktreePath ?? null, worktrees: d.worktrees ?? [] };
  } catch {
    return null;
  }
}

/* ── preparer：发送首条消息时的单一执行路径 ── */

async function ensureWorktreeFor(root: string, branch: string, t: (k: string, ...a: unknown[]) => string): Promise<string> {
  const res = await fetch(apiUrl("/api/worktrees"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: root, branch }),
  });
  const d = await res.json().catch(() => ({})) as { path?: string; error?: string };
  if (!res.ok || !d.path) throw new Error(d.error ?? `HTTP ${res.status} · ${t("pickerQueryFail")}`);
  return d.path;
}

/** newSessionPreparers 注册面执行体：意图 → 动作矩阵 → 写操作 → {cwd} 改写/abort。 */
export async function newSessionPrepare({ cwd }: { cwd: string }): Promise<{ cwd?: string } | { abort?: string }> {
  const it = getIntent();
  if (!it || !it.selection || it.selection.kind === "follow") return;
  const t = makeT(getLocale());
  const q = await queryWorktreeState(cwd);
  if (!q) throw new Error(t("pickerQueryFail"));
  const api = createGitOpsApi({ apiUrl });
  const rr = await api.refs(cwd);
  const refsOk = rr.status === 200 && rr.data?.ok !== false;
  const engineAbsent = !refsOk;
  const mode = effectiveMode(it.mode, engineAbsent);
  const ctx = {
    currentBranch: refsOk ? (rr.data.current ?? null) : null,
    worktrees: q.worktrees,
  };
  let action = resolvePickerAction(it, ctx);
  if (action.type === "none") { setIntent(null); return; }
  // 远程分支：先建同名本地分支（ensureLocalBranch 同款，不 checkout），再按模式分流
  if (it.selection.kind === "branch" && it.selection.remote) {
    const cr = await api.branchCreate(cwd, shortBranchName(it.selection.remote), it.selection.remote, false);
    if (cr.status !== 200) throw new Error(cr.data?.error ?? `HTTP ${cr.status}`);
    action = resolvePickerAction({ mode, selection: { kind: "branch", name: shortBranchName(it.selection.remote) } }, ctx);
  }
  switch (action.type) {
    case "none":
      setIntent(null);
      return;
    case "useWorktree":
      return { cwd: action.path };
    case "ensureWorktree": {
      const existing = q.worktrees.find((w) => w.branch === action.branch);
      return { cwd: existing ? existing.path : await ensureWorktreeFor(q.projectRoot, action.branch, t) };
    }
    case "checkout": {
      const r = await api.checkout(cwd, action.branch);
      if (r.status === 409 && r.data?.conflict) {
        const choice = await requestConflictChoice(action.branch, r.data.files ?? []);
        if (choice === "cancel") throw new Error(t("pickerAbortCheckout"));
        if (choice === "worktree") {
          const existing = q.worktrees.find((w) => w.branch === action.branch);
          return { cwd: existing ? existing.path : await ensureWorktreeFor(q.projectRoot, action.branch, t) };
        }
        const r2 = await api.checkout(cwd, action.branch, "stash-then-switch");
        if (r2.status !== 200) throw new Error(r2.data?.error ?? `HTTP ${r2.status}`);
        return;
      }
      if (r.status !== 200) throw new Error(r.data?.error ?? `HTTP ${r.status}`);
      return;
    }
  }
}

/* ── 组件 ── */

interface PickerProps {
  cwd?: string | null;
  isMobile?: boolean;
}

interface RefsData {
  current: string | null;
  detached?: boolean;
  branches?: string[];
  remotes?: string[];
}

export function NewSessionPicker(props: PickerProps) {
  const cwd = props.cwd ?? null;
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState<RefsData | null>(null);
  const [engineAbsent, setEngineAbsent] = useState(false);
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const [wtModeRaw, setWtModeRaw] = useState<boolean>(() => {
    try { return localStorage.getItem("gitops.panel.wtMode") === "1"; } catch { return false; }
  });
  const intent = useSyncExternalStore(subscribeIntent, getIntent, () => null);
  const conflict = useSyncExternalStore(subscribeIntent2, getConflict, () => null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const api = useMemo(() => createGitOpsApi({ apiUrl }), []);
  const t = makeT(getLocale());
  // 引擎缺席 → worktree 模式强制按开（§2.3）；开关读写 BranchPanel 同一 localStorage key
  const wtMode = effectiveMode(wtModeRaw, engineAbsent);

  // worktree 数据（宿主 /api/worktrees/query；cwd 变更重拉，零轮询）——useWorktree 惰性，
  // 选择器必须首帧可见性判定（非 git 整器不渲染），挂载即 ensure。
  const worktree = useWorktree(cwd);
  const ensureWorktree = worktree.ensure;
  useEffect(() => { ensureWorktree(); }, [cwd, ensureWorktree]);

  // 分支数据（aiti-git-ops refs）：404=引擎缺席（worktree-only 降级），其余失败同降级
  // （isGit 权威在 worktrees/query——query 已过滤非 git 目录，整器不渲染）。
  const refsFor = worktree.state?.forCwd ?? null;
  const isGit = worktree.state?.isGit ?? false;
  useEffect(() => {
    if (!cwd || refsFor !== cwd || !isGit) return;
    let cancelled = false;
    api.refs(cwd).then((r) => {
      if (cancelled) return;
      if (r.status === 200 && r.data?.ok !== false) {
        setRefs({ current: r.data.current ?? null, detached: !!r.data.detached, branches: r.data.branches ?? [], remotes: r.data.remotes ?? [] });
        setEngineAbsent(false);
      } else {
        setRefs(null);
        setEngineAbsent(true);
      }
    }).catch(() => { if (!cancelled) { setRefs(null); setEngineAbsent(true); } });
    return () => { cancelled = true; };
  }, [cwd, refsFor, isGit, api]);

  // 事件刷新（git-ops §1.5 topic 订阅，branch-chip 同款零轮询）：本仓写操作后重拉 refs。
  // ⚠ 依赖只取稳定引用（root/refresh，useWorktree 内 useCallback）——worktree 对象本体
  // 每渲染换引用，直接依赖会造成反复重订。
  const projectRoot = worktree.state?.projectRoot ?? null;
  const wtRefresh = worktree.refresh;
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
      if (f.repo === cwd || f.repo === projectRoot || cwd.startsWith(f.repo + "/")) {
        api.refs(cwd).then((r) => {
          if (r.status === 200 && r.data?.ok !== false) {
            setRefs({ current: r.data.current ?? null, detached: !!r.data.detached, branches: r.data.branches ?? [], remotes: r.data.remotes ?? [] });
          }
        }).catch(() => {});
        wtRefresh();
      }
    }, ["aiti-git-ops:changed:*"]).off;
  }, [cwd, api, projectRoot, wtRefresh]);

  // 意图生命周期：cwd 变更即重置意图与数据（意图条随之消失）；卸载（会话创建成功 /
  // 离开欢迎页）同样清意图——「创建成功即清意图」。
  const cwdRef = useRef<string | null>(cwd);
  useEffect(() => {
    if (cwdRef.current !== cwd) {
      cwdRef.current = cwd;
      setIntent(null);
      setConflictReq(null);
      setOpen(false);
    }
  }, [cwd]);
  useEffect(() => () => { setIntent(null); setConflictReq(null); }, []);

  // 弹层定位：触发器左对齐、展开其下，视口钳位
  useLayoutEffect(() => {
    if (!open) return;
    const el = popRef.current;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    const width = Math.min(320, window.innerWidth - 16);
    const { left, top } = clampToViewport(rect.left, rect.bottom + 6, width, el?.offsetHeight ?? 200, 8);
    setPos((cur) => (cur && cur.left === left && cur.top === top ? cur : { left, top }));
  }, [open, intent, wtMode]);

  // 点外关闭（触发器豁免）+ Escape（冲突卡在场时 Escape 先取消冲突）
  useEffect(() => {
    if (!open && !conflict) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (popRef.current?.contains(target)) return;
      if (target && typeof (target as Element).closest === "function" && (target as Element).closest("[data-nsp-trigger]")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (conflictState) { conflictState.resolve("cancel"); setConflictReq(null); return; }
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, conflict]);

  // 块级 -p 能力（BranchPanel pty；面板打开才探测一次）
  const [ptyOk, setPtyOk] = useState(false);
  useEffect(() => {
    if (!panelOpen) return;
    let cancelled = false;
    fetch(apiUrl("/api/extensions/session-manager/git-ops-capabilities"))
      .then((r) => r.json())
      .then((d: { stashInteractive?: boolean }) => { if (!cancelled) setPtyOk(!!d.stashInteractive); })
      .catch(() => { /* 缺席即不可用 */ });
    return () => { cancelled = true; };
  }, [panelOpen]);
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
  }, [cwd]);

  if (!cwd || !worktree.state || refsFor !== cwd || !isGit) return null;

  const pick = (selection: PickerSelection) => {
    setIntent(selection === null ? null : { mode: wtMode, selection });
    setOpen(false);
  };
  const current = refs?.current ?? null;
  const intentLabel = !intent || !intent.selection || intent.selection.kind === "follow"
    ? t("pickerFollow")
    : intent.selection.kind === "worktree"
      ? intent.selection.path
      : (intent.selection.remote ?? intent.selection.name);

  const rowStyle = { display: "flex", alignItems: "center", gap: 7, padding: "5px 12px", fontSize: 12, cursor: "pointer", color: "var(--text)", fontFamily: "var(--font-mono)" } as const;
  const sectionHead = (label: string) => (
    <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" as const, color: "var(--text-dim)", padding: "8px 12px 2px" }}>{label}</div>
  );
  const check = (on: boolean) => on ? (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
  ) : <span style={{ width: 10, flexShrink: 0 }} />;

  const branches = (refs?.branches ?? []).filter((b) => b !== current);
  const remotes = refs?.remotes ?? [];
  const worktrees = worktree.state?.worktrees ?? [];

  const trigger = (
    <button
      type="button"
      data-nsp-trigger="1"
      ref={triggerRef}
      onClick={() => setOpen((v) => !v)}
      title={`${t("pickerLabel")} · ${intentLabel}`}
      style={{
        display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0, maxWidth: "min(52vw, 360px)",
        padding: "4px 8px", background: "var(--bg-hover)", border: "1px solid " + (intent ? "var(--accent)" : "var(--border)"),
        borderRadius: 8, color: intent ? "var(--accent)" : "var(--text)", fontFamily: "inherit", fontSize: 12, cursor: "pointer",
      }}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ flexShrink: 0 }}>
        <circle cx="4" cy="3.5" r="1.8" /><circle cx="4" cy="12.5" r="1.8" /><circle cx="12" cy="3.5" r="1.8" />
        <path d="M4 5.3v5.4M12 5.3c0 3-3 3.6-6 4.1" />
      </svg>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("pickerLabel")}</span>
      <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>{intentLabel}</span>
      <span style={{ fontSize: 9, flexShrink: 0 }}>▾</span>
    </button>
  );

  const intentBar = intent && intent.selection && intent.selection.kind !== "follow" ? (
    <div style={{ flexBasis: "100%", display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0, fontSize: 11, color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        ⎇ {intentLabel} · {t("pickerSendExec")} · {wtMode ? t("pickerWtOn") : t("pickerWtOff")}
      </span>
      <button type="button" title={t("pickerClear")} onClick={() => setIntent(null)}
        style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "0 2px", flexShrink: 0 }}>✕</button>
    </div>
  ) : null;

  const popup = (
    <div
      ref={popRef}
      style={{
        position: "fixed", zIndex: 1000, left: pos ? pos.left : -99999, top: pos ? pos.top : -99999,
        width: Math.min(320, window.innerWidth - 16), maxHeight: "min(60vh, 460px)", overflowY: "auto",
        background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
        boxShadow: "0 14px 36px color-mix(in srgb, var(--text) 14%, transparent)",
        fontFamily: "inherit", textAlign: "left", overscrollBehavior: "contain" as const,
      }}
    >
      {/* worktree 模式开关：与 BranchPanel 同一 localStorage key（gitops.panel.wtMode） */}
      <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", fontSize: 11.5, color: "var(--text-muted)", borderBottom: "1px solid var(--border)", cursor: "pointer", position: "sticky" as const, top: 0, background: "var(--bg)", zIndex: 1 }}
        title={wtMode ? t("pickerBranchWtHint") : t("pickerBranchCheckoutHint")}>
        <input type="checkbox" checked={wtMode} onChange={(e) => {
          setWtModeRaw(e.target.checked);
          try { localStorage.setItem("gitops.panel.wtMode", e.target.checked ? "1" : "0"); } catch { /* ignore */ }
        }} style={{ accentColor: "var(--accent)", margin: 0, flexShrink: 0 }} />
        {wtMode ? t("pickerWtOn") : t("pickerWtOff")}
      </label>

      <div onClick={() => pick(null)} style={rowStyle}>
        {check(!intent || !intent.selection || intent.selection.kind === "follow")}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("pickerFollow")}</span>
      </div>

      {sectionHead("Worktrees")}
      {worktrees.map((w) => {
        const on = intent?.selection?.kind === "worktree" && intent.selection.path === w.path;
        return (
          <div key={w.path} onClick={() => pick({ kind: "worktree", path: w.path })} title={w.path} style={rowStyle}>
            {check(on)}
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {w.branch ?? w.path}{w.isMain ? ` · ${t("worktreeMain")}` : ""}
            </span>
            {worktree.state?.currentWorktreePath === w.path && (
              <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{t("current")}</span>
            )}
          </div>
        );
      })}

      {engineAbsent ? (
        <div style={{ padding: "7px 12px 9px", fontSize: 10.5, color: "var(--text-dim)" }}>{t("pickerEngineAbsent")}</div>
      ) : !refs ? (
        <div style={{ padding: "7px 12px 9px", fontSize: 10.5, color: "var(--text-dim)" }}>{t("loading")}</div>
      ) : (
        <>
          {sectionHead(t("branches"))}
          <div style={{ padding: "0 12px 3px", fontSize: 10, color: "var(--text-dim)" }}>
            {wtMode ? t("pickerBranchWtHint") : t("pickerBranchCheckoutHint")}
          </div>
          {current && (
            <div onClick={() => pick(null)} style={rowStyle} title={t("pickerClear")}>
              {check(true)}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current}</span>
              <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{t("current")}</span>
            </div>
          )}
          {branches.map((b) => {
            const on = intent?.selection?.kind === "branch" && intent.selection.name === b;
            return (
              <div key={b} onClick={() => pick({ kind: "branch", name: b })} style={rowStyle}>
                {check(on)}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b}</span>
              </div>
            );
          })}
          {remotes.length > 0 && (
            <div onClick={() => setRemotesOpen((v) => !v)} style={{ ...rowStyle, color: "var(--text-muted)", fontSize: 11 }}>
              <span style={{ width: 10, flexShrink: 0 }} />
              {t("remotes", remotes.length)}
            </div>
          )}
          {remotesOpen && remotes.map((b) => {
            const on = intent?.selection?.kind === "branch" && intent.selection.remote === b;
            return (
              <div key={b} onClick={() => pick({ kind: "branch", name: shortBranchName(b), remote: b })} title={t("pickerRemoteHint")} style={{ ...rowStyle, paddingLeft: 29 }}>
                {check(on)}
                <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b}</span>
              </div>
            );
          })}
        </>
      )}

      {!engineAbsent && (
        <div onClick={() => { setOpen(false); setPanelOpen(true); }} style={{ ...rowStyle, color: "var(--text-muted)", borderTop: "1px solid var(--border)", marginTop: 5 }}>
          <span style={{ width: 10, flexShrink: 0 }} />
          {t("pickerManage")}
        </div>
      )}
    </div>
  );

  const conflictCard = conflict ? (
    <div style={{
      position: "fixed", zIndex: 1001, left: "50%", top: 90, transform: "translateX(-50%)",
      width: "min(400px, calc(100vw - 24px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
      boxShadow: "0 14px 36px color-mix(in srgb, var(--text) 14%, transparent)", padding: "12px 14px",
      fontFamily: "inherit", textAlign: "left",
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, display: "flex", gap: 7, alignItems: "center", fontFamily: "var(--font-mono)" }}>
        ⚠ {t("conflictTitle")} <span style={{ fontFamily: "var(--font-mono)" }}>{conflict.ref}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", margin: "5px 0 7px" }}>{t("conflictDesc", conflict.files.length)}</div>
      <div style={{ background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 9px",
        fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)", display: "flex", flexDirection: "column", gap: 3, maxHeight: 96, overflowY: "auto" }}>
        {conflict.files.map((f) => (
          <span key={f} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f}</span>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 9 }}>
        <button type="button" onClick={() => { conflict.resolve("worktree"); setConflictReq(null); }}
          style={{ height: 27, borderRadius: 7, fontSize: 11.5, cursor: "pointer", fontWeight: 600, background: "var(--accent)", color: "var(--bg)", border: "1px solid var(--accent)" }}>
          {t("conflictWt")}
        </button>
        <button type="button" onClick={() => { conflict.resolve("stash"); setConflictReq(null); }}
          style={{ height: 27, borderRadius: 7, fontSize: 11.5, cursor: "pointer", background: "var(--bg-hover)", color: "var(--text)", border: "1px solid var(--border)" }}>
          {t("conflictStash")}
        </button>
        <button type="button" onClick={() => { conflict.resolve("cancel"); setConflictReq(null); }}
          style={{ height: 27, borderRadius: 7, fontSize: 11.5, cursor: "pointer", background: "none", color: "var(--text-dim)", border: "none" }}>
          {t("cancel")}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <>
      {trigger}
      {intentBar}
      {open && createPortal(popup, document.body)}
      {createPortal(conflictCard, document.body)}
      {createPortal(
        <BranchPanel
          apiUrl={apiUrl}
          cwd={cwd}
          locale={getLocale()}
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          anchor={anchor}
          projectRoot={worktree.state?.projectRoot ?? null}
          worktrees={worktrees}
          currentWorktreePath={worktree.currentWorktreePath}
          onSelectWorktree={(path) => { setIntent({ mode: wtMode, selection: { kind: "worktree", path } }); setPanelOpen(false); }}
          onCreateWorktree={async (b) => {
            const r = await worktree.create(b);
            if (r.path) setIntent({ mode: wtMode, selection: { kind: "worktree", path: r.path } });
            return r;
          }}
          onRemoveWorktree={(path, force) => worktree.remove(path, force)}
          onWorktreeChanged={() => worktree.refresh()}
          onChanged={() => {
            api.refs(cwd).then((r) => {
              if (r.status === 200 && r.data?.ok !== false) {
                setRefs({ current: r.data.current ?? null, detached: !!r.data.detached, branches: r.data.branches ?? [], remotes: r.data.remotes ?? [] });
              }
            }).catch(() => {});
          }}
          floatKey="sm-new-session-branch-panel"
          extSvc={getExtService}
          pty={ptyOk ? { available: true, stashInteractive } : { available: false, stashInteractive }}
        />,
        document.body,
      )}
    </>
  );
}

// conflict store 的第二个订阅口（与 intent 分键：共用 listeners 亦可，独立更清晰）
function subscribeIntent2(cb: () => void): () => void {
  conflictListeners.add(cb);
  return () => { conflictListeners.delete(cb); };
}
function getConflict(): ConflictRequest | null {
  return conflictState;
}
