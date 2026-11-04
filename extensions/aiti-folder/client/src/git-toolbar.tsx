/**
 * git-toolbar · aiti-folder 的 git 工具面（git-ops 共享引擎方案 M3，docs/aiti-git-ops-shared-plan.md §4）。
 *
 * - useFolderGit(root)：引擎在位探测 + refs（分支/ahead-behind/脏文件）+ 订阅
 *   `aiti-git-ops:changed:*` topic（aiti-event-bus subscribe-topics 服务，帧带 repo 过滤）→
 *   引擎写操作后本目录树徽标/工具条即时刷新（零轮询）。
 * - GitBar：变更区段上方单行工具条——⎇ 分支（共享 BranchPanel）· ↑ahead ↓behind（SyncBar
 *   确认流）· ✎ 手动提交（勾选文件→stage→commit）。引擎缺席/非 git 目录整条隐藏（软依赖降级）。
 * - 全部 git 调用直指引擎 REST `/api/extensions/aiti-git-ops/git/*`（端点即引擎，folder 零服务端新增）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, extSvc, openFile } from "./host-shim";
import { ct } from "./comp-i18n";
import { createGitOpsApi } from "../../../_shared/git-ops-client/api.mjs";
import { BranchPanel, BranchChipBadge } from "../../../_shared/git-ops-client/branch-panel";
import { CommitPlanDialog } from "./git-plan";

export interface FolderGitRefs {
  current: string | null;
  detached: boolean;
  aheadBehind: [number, number] | null;
  dirtyCount: number;
  dirtyFiles: { xy: string; path: string }[];
}

export interface FolderGit {
  /** null=探测中；false=引擎缺席或非 git 目录（工具条隐藏）；true=可用 */
  avail: boolean | null;
  refs: FolderGitRefs | null;
  /** 引擎写操作/topic 到达后的本地刷新序号（追加进 /api/git/status effect 依赖） */
  statusBump: number;
  refresh: () => void;
  /** 行级单文件操作（git-ops M4 补：双列态行钮）；返回 HTTP status */
  op: (kind: "stage" | "unstage" | "discard", path: string) => Promise<number>;
}

export function useFolderGit(root: string): FolderGit {
  const [avail, setAvail] = useState<boolean | null>(null);
  const [refs, setRefs] = useState<FolderGitRefs | null>(null);
  const [statusBump, setStatusBump] = useState(0);
  // ⚠ memo：api 不稳定会让探测 effect 每渲染重跑 → 请求风暴（session-manager M2 实测教训）
  const api = useMemo(() => createGitOpsApi({ apiUrl }), []);

  const probe = useCallback(async (cwd: string) => {
    const r = await api.refs(cwd);
    if (r.status === 200 && r.data?.ok !== false) {
      setAvail(true);
      setRefs({
        current: r.data.current ?? null,
        detached: !!r.data.detached,
        aheadBehind: r.data.aheadBehind ?? null,
        dirtyCount: r.data.dirtyCount ?? 0,
        dirtyFiles: r.data.dirtyFiles ?? [],
      });
    } else {
      // 404=引擎缺席/禁用；400=非 git 目录——同样整条降级隐藏（git-ops 方案 §4 ④）
      setAvail(false);
      setRefs(null);
    }
  }, [api]);

  useEffect(() => {
    if (!root) { setAvail(null); setRefs(null); return; }
    let cancelled = false;
    setAvail(null);
    void probe(root).catch(() => { if (!cancelled) { setAvail(false); setRefs(null); } });
    return () => { cancelled = true; };
  }, [root, probe]);

  // topic 订阅（帧形如 { type: "aiti-git-ops:changed:<hash>", kind, summary, repo }）：
  // repo 命中当前目录才刷新；服务缺席（event-bus 未启用）→ 不订阅，靠打开/操作后刷新。
  useEffect(() => {
    const svc = extSvc<((h: (f: any) => void, types: string[]) => { off: () => void }) | undefined>("aiti-event-bus.subscribe-topics");
    if (!svc) return;
    return svc((f: any) => {
      if (!f || typeof f.repo !== "string") return;
      if (root && (f.repo === root || root.startsWith(f.repo + "/"))) {
        void probe(root);
        setStatusBump((v) => v + 1);
      }
    }, ["aiti-git-ops:changed:*"]).off;
  }, [root, probe]);

  const refresh = useCallback(() => {
    if (root) void probe(root);
    setStatusBump((v) => v + 1);
  }, [root, probe]);

  const op = useCallback(async (kind: "stage" | "unstage" | "discard", path: string): Promise<number> => {
    const r = kind === "stage" ? await api.stage(root, [path])
      : kind === "unstage" ? await api.unstage(root, [path])
        : await api.discard(root, [path]);
    void probe(root);
    setStatusBump((v) => v + 1);
    return r.status;
  }, [api, root, probe]);

  return { avail, refs, statusBump, refresh, op };
}

/* ── GitBar：变更区段上方单行工具条 ── */

export function GitBar(p: {
  root: string;
  git: FolderGit;
  onChanged?: () => void;
  /** 变更区段开合（dock 头的变更开关在部分形态不可达——GitBar 提供保底入口） */
  changesOpen?: boolean;
  onToggleChanges?: () => void;
}) {
  const { git, root } = p;
  const [panelOpen, setPanelOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const api = useMemo(() => createGitOpsApi({ apiUrl }), []);
  const ab = git.refs?.aheadBehind ?? null;

  const runSync = useCallback(async (kind: "push" | "pull", mode?: string) => {
    if (syncBusy) return;
    setSyncBusy(true); setError(null);
    try {
      const r = kind === "push" ? await api.push(root, {}) : await api.pull(root, (mode as any) || "ff-only");
      if (r.status !== 200) {
        setError((r.data?.error ?? "HTTP " + r.status));
        return;
      }
      setToast(kind === "push" ? "push ✓" : "pull ✓" + (r.data?.output ? "\n" + r.data.output : ""));
      git.refresh();
      p.onChanged?.();
    } finally {
      setSyncBusy(false);
    }
  }, [syncBusy, api, root, git, p.onChanged]);

  if (git.avail !== true || !git.refs?.current) return null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 10px 3px", borderBottom: "1px solid var(--border)", fontSize: 11 }}>
      {/* ⎇ 分支 chip（共享 BranchPanel） */}
      <span
        data-folder-git-chip="1"
        title={ct("git.branchPanelTitle")}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setAnchor({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
          setPanelOpen((v) => !v);
        }}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 6px", borderRadius: 5, cursor: "pointer",
          fontFamily: "var(--font-mono)", fontSize: 10.5, color: panelOpen ? "var(--accent)" : "var(--text)",
          border: "1px solid " + (panelOpen ? "var(--accent)" : "var(--border)"), background: "var(--bg-hover)",
          maxWidth: 150, overflow: "hidden", whiteSpace: "nowrap" as const, flexShrink: 1, minWidth: 0 }}
      >
        <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" style={{ flexShrink: 0 }}>
          <circle cx="4" cy="3.5" r="1.8" /><circle cx="4" cy="12.5" r="1.8" /><circle cx="12" cy="3.5" r="1.8" />
          <path d="M4 5.3v5.4M12 5.3c0 3-3 3.6-6 4.1" />
        </svg>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{git.refs.current}</span>
      </span>
      {/* SyncBar：↑ahead ↓behind */}
      {ab && ab[0] > 0 ? (
        <button type="button" disabled={syncBusy} title={ct("git.pushTitle")} onClick={() => { if (window.confirm(ct("git.pushConfirm", { count: ab[0] }))) void runSync("push"); }}
          style={syncBtnStyle()}>{ab[0]}<MiArrowUpSmall /></button>
      ) : null}
      {ab && ab[1] > 0 ? (
        <button type="button" disabled={syncBusy} title={ct("git.pullTitle")} onClick={() => { if (window.confirm(ct("git.pullConfirm", { count: ab[1] }))) void runSync("pull"); }}
          style={syncBtnStyle()}><MiArrowDownSmall />{ab[1]}</button>
      ) : null}
      {ab && ab[0] === 0 && ab[1] === 0 ? <span style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>✓</span> : null}
      <span style={{ flex: 1 }} />
      {/* 分组提交（M4：启发式 + 引擎逐笔执行断点/回滚） */}
      <button type="button" title={ct("git.planTitle")} onClick={() => { git.refresh(); setPlanOpen(true); }}
        style={{ display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 4px", borderRadius: 4 }}>
        {ct("git.planShort")}
      </button>
      {/* 变更区段开关（保底入口） */}
      {p.onToggleChanges ? (
        <button type="button" title={ct("git.changesToggle")} aria-pressed={p.changesOpen}
          onClick={p.onToggleChanges}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "none",
            color: p.changesOpen ? "var(--accent)" : "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 4px", borderRadius: 4 }}>
          ☰
        </button>
      ) : null}
      {/* 手动提交：先重探 refs（用户/agent 可能在挂载后改过文件），再开弹窗——列表不陈旧 */}
      <button type="button" title={ct("git.commitTitle")} onClick={() => { git.refresh(); setCommitOpen(true); }}
        style={{ display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 4px", borderRadius: 4 }}>
        {ct("git.commitShort")}
      </button>
      {toast || error ? (
        <span title={error ?? toast} onClick={() => { setToast(null); setError(null); }}
          style={{ fontSize: 10, color: error ? "var(--text)" : "var(--text-dim)", cursor: "pointer", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const, fontFamily: "var(--font-mono)" }}>
          {error ? "⚠ " + error : toast}
        </span>
      ) : null}

      {/* 共享 BranchPanel（folder 无 worktree 面 → 面板自动隐藏该分区） */}
      <BranchPanel
        apiUrl={apiUrl}
        cwd={root}
        floatKey="folder-branch-panel"
        locale={typeof navigator !== "undefined" ? navigator.language : "en"}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        anchor={anchor}
        extSvc={extSvc}
        openFile={(fp) => openFile(fp, fp.split("/").pop())}
        onChanged={() => { git.refresh(); p.onChanged?.(); }}
      />

      {/* 手动提交弹窗（勾选文件 → stage → commit；原 folder 案 §5.4 手动路径） */}
      {commitOpen ? (
        <CommitDialog
          root={root}
          dirtyFiles={git.refs.dirtyFiles}
          onClose={() => setCommitOpen(false)}
          onDone={() => { setCommitOpen(false); git.refresh(); p.onChanged?.(); }}
        />
      ) : null}
      {planOpen ? (
        <CommitPlanDialog root={root} git={git} onClose={() => setPlanOpen(false)} />
      ) : null}
    </div>
  );
}

const syncBtnStyle = () => ({
  display: "inline-flex", alignItems: "center", gap: 2, border: "none", background: "none",
  color: "var(--text-dim)", cursor: "pointer", fontSize: 10.5, padding: "2px 4px", borderRadius: 4,
  fontFamily: "var(--font-mono)",
} as const);

function MiArrowUpSmall() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 11 12 6 7 11" /><line x1="12" y1="6" x2="12" y2="20" /></svg>;
}
function MiArrowDownSmall() {
  return <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="7 13 12 18 17 13" /><line x1="12" y1="18" x2="12" y2="4" /></svg>;
}

/* ── 手动提交弹窗 ── */

function CommitDialog(p: { root: string; dirtyFiles: { xy: string; path: string }[]; onClose: () => void; onDone: () => void }) {
  const api = useMemo(() => createGitOpsApi({ apiUrl }), []);
  const staged0 = useMemo(() => new Set(p.dirtyFiles.filter((f) => f.xy[0] !== " " && f.xy[0] !== "?").map((f) => f.path)), [p.dirtyFiles]);
  const [checked, setChecked] = useState<Set<string>>(staged0);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // AI 生成提交信息（docs/aiti-folder-commit-ai-message-plan.md）：服务可用性探测 + 生成状态
  const [aiAvail, setAiAvail] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl("/api/extensions/aiti-folder/git-commit-ai-avail"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setAiAvail(!!d?.avail); })
      .catch(() => { if (!cancelled) setAiAvail(false); });
    return () => { cancelled = true; };
  }, []);

  const genMessage = useCallback(async () => {
    if (aiBusy || checked.size === 0) return;
    if (message.trim() && !window.confirm(ct("git.aiMessageOverwrite"))) return;
    setAiBusy(true); setError(null);
    try {
      // basePath 从 apiUrl 推导（host-shim 前缀 /dev 等）；origin 本页已知（同 CommitPlanDialog.aiRefine）
      const p1 = apiUrl("/api/agent/new");
      const basePath = p1.slice(0, Math.max(0, p1.indexOf("/api/")));
      const r = await fetch(apiUrl("/api/extensions/aiti-folder/git-commit-ai-message"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: p.root, origin: location.origin, basePath, files: [...checked], amend }),
      }).then((x) => x.json()).catch(() => null);
      if (!r?.ok) { setError(r?.error || ct("i18n.networkError")); return; }
      setMessage(String(r.message || ""));
    } finally {
      setAiBusy(false);
    }
  }, [aiBusy, checked, message, amend, p.root]);

  const submit = useCallback(async () => {
    if (busy || (!message.trim() && !amend)) return;
    setBusy(true); setError(null);
    try {
      // 勾选且未在暂存区的 → add；取消勾选但已在暂存区的 → restore --staged
      const toStage = [...checked].filter((f) => !staged0.has(f));
      const toUnstage = [...staged0].filter((f) => !checked.has(f));
      if (toStage.length > 0) {
        const r = await api.stage(p.root, toStage);
        if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
      }
      if (toUnstage.length > 0) {
        const r = await api.unstage(p.root, toUnstage);
        if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
      }
      const r = await api.commit(p.root, message.trim() || undefined, amend);
      if (r.status !== 200) { setError(r.data?.error ?? "HTTP " + r.status); return; }
      p.onDone();
    } finally {
      setBusy(false);
    }
  }, [busy, message, amend, checked, staged0, api, p.root, p.onDone]);

  return (
    <div onClick={(e) => { if (e.target === e.currentTarget && !busy) p.onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 900, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {/* data-ext-float：aiti-float 接管拖拽/缩放/持久化；autoh=高度随内容（textarea 可拉、文件列表不定长）；
          full=小屏（≤640px）默认铺满视口（大屏仍浮窗可缩放移动）——契约 docs/aiti-web-ext-float-dialogs.md */}
      <div data-ext-float="1" data-ext-float-full="1" data-ext-float-autoh="1"
        data-ext-float-key="aiti-folder.commit" data-ext-float-w={380}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 380, maxWidth: "92vw", maxHeight: "80vh", display: "flex", flexDirection: "column", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)", boxShadow: "0 14px 36px color-mix(in srgb, var(--text) 16%, transparent)", fontSize: 12 }}>
        <div style={{ display: "flex", alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)", fontWeight: 600 }}>
          {ct("git.commitTitle")}
          <span style={{ flex: 1 }} />
          <button type="button" onClick={p.onClose} aria-label={ct("i18n.close")} title={ct("i18n.close")}
            style={{ border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 12, padding: "2px 4px" }}>✕</button>
        </div>
        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "6px 12px" }}>
          <div style={{ display: "flex", gap: 6, margin: "4px 0" }}>
            <button type="button" onClick={() => setChecked(new Set(p.dirtyFiles.map((f) => f.path)))} style={miniGhost()}>{ct("git.stageAll")}</button>
            <button type="button" onClick={() => setChecked(new Set(staged0))} style={miniGhost()}>{ct("git.stageNone")}</button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10.5, color: "var(--text-dim)", alignSelf: "center", fontFamily: "var(--font-mono)" }}>
              {ct("git.stagedCount", { count: checked.size })}
            </span>
          </div>
          {p.dirtyFiles.map((f) => {
            const on = checked.has(f.path);
            return (
              <label key={f.path} style={{ display: "flex", alignItems: "center", gap: 7, padding: "2.5px 0", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)" }}>
                <input type="checkbox" checked={on} onChange={(e) => setChecked((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(f.path); else next.delete(f.path);
                  return next;
                })} style={{ accentColor: "var(--accent)", margin: 0, flexShrink: 0 }} />
                <span style={{ width: 20, flexShrink: 0, color: "var(--text)" }}>{f.xy}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{f.path}</span>
              </label>
            );
          })}
        </div>
        <div style={{ padding: "8px 12px 10px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 7 }}>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder={ct("git.commitPlaceholder")} rows={2}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}
            style={{ width: "100%", boxSizing: "border-box" as const, resize: "vertical" as const, minHeight: 44, background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 11.5, padding: "6px 8px", outline: "none", fontFamily: "inherit" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}>
              <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} style={{ accentColor: "var(--accent)", margin: 0 }} />
              {ct("git.amend")}
            </label>
            <span style={{ flex: 1 }} />
            {aiAvail ? (
              <button type="button" disabled={aiBusy || checked.size === 0} onClick={() => void genMessage()} title={ct("git.aiMessageTitle")}
                style={{ height: 20, padding: "0 8px", borderRadius: 5, fontSize: 10.5, cursor: aiBusy || checked.size === 0 ? "not-allowed" : "pointer",
                  background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border)", opacity: aiBusy || checked.size === 0 ? 0.6 : 1 }}>
                {aiBusy ? ct("git.aiMessageBusy") : ct("git.aiMessage")}
              </button>
            ) : null}
          </div>
          {error ? <div style={{ fontSize: 10.5, color: "var(--text)", background: "color-mix(in srgb, var(--text) 6%, transparent)", borderRadius: 5, padding: "4px 8px", overflowWrap: "anywhere" as const }}>⚠ {error}</div> : null}
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" disabled={busy || (!message.trim() && !amend) || checked.size === 0} onClick={() => void submit()} style={{
              flex: 1, height: 27, borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: busy ? "not-allowed" : "pointer",
              background: "var(--accent)", color: "var(--bg)", border: "1px solid var(--accent)", opacity: busy || (!message.trim() && !amend) || checked.size === 0 ? 0.6 : 1,
            }}>{busy ? "…" : ct("git.commitBtn")}</button>
            <button type="button" onClick={p.onClose} style={{ border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text-muted)", borderRadius: 7, fontSize: 11, padding: "0 12px", cursor: "pointer" }}>{ct("files.cancel")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const miniGhost = () => ({
  height: 22, padding: "0 8px", borderRadius: 5, fontSize: 10.5, cursor: "pointer",
  background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border)",
} as const);
