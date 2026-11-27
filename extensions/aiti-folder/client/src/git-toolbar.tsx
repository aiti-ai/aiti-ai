/**
 * git-toolbar · aiti-folder's git surface (git-ops shared engine, docs/aiti-git-ops-shared-plan.md §4).
 *
 * - useFolderGit(root): engine availability probe + refs (branch / ahead-behind / dirty files) +
 *   subscription to the `aiti-git-ops:changed:*` topic (aiti-event-bus subscribe-topics service,
 *   frames carry a repo filter) → the folder tree's badge and this toolbar refresh as soon as the
 *   engine finishes a write (no polling).
 * - GitBar: one line above the changes section — ⎇ branch (shared BranchPanel) · ↑ahead ↓behind
 *   (SyncBar confirm flow) · ✎ manual commit (pick files → stage → commit). The whole bar hides
 *   when the engine is absent or the folder is not a git repo (soft dependency, degrades).
 * - Every git call goes straight to the engine REST `/api/extensions/aiti-git-ops/git/*`
 *   (the endpoint is the engine, so folder adds no server route).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, extSvc, openFile } from "./host-shim";
import { ct, currentLocale } from "./comp-i18n";
import { createGitOpsApi } from "../../../_shared/git-ops-client/api.mjs";
// ⚠ Create the api instance inside the hook only (never at module level: under the
// folder-browser → git-toolbar cycle a module-level const hits the TDZ "Cannot access before
// initialization", measured 2026-11-24).
import { BranchPanel, BranchChipBadge } from "../../../_shared/git-ops-client/branch-panel";
import { CommitPlanDialog } from "./git-plan";
import { setupCommitActions, useCommitActions, type CommitActionCtx } from "./commit-actions";

export interface FolderGitRefs {
  current: string | null;
  detached: boolean;
  aheadBehind: [number, number] | null;
  dirtyCount: number;
  dirtyFiles: { xy: string; path: string }[];
}

export interface FolderGit {
  /** null = probing; false = engine absent or not a git repo (the bar hides); true = available */
  avail: boolean | null;
  refs: FolderGitRefs | null;
  /** Local refresh counter after an engine write / topic frame (appended to the /api/git/status
   *  effect deps) */
  statusBump: number;
  refresh: () => void;
  /** Per-file row action (git-ops M4: the two-column row buttons); returns the HTTP status */
  op: (kind: "stage" | "unstage" | "discard", path: string) => Promise<number>;
  /** Batch (bucket header "stage all / unstage all"): one engine call, then re-probe + statusBump */
  opPaths: (kind: "stage" | "unstage" | "discard", paths: string[]) => Promise<number>;
  /** Untracked row "add to .gitignore" (engine ignore-add); declared for callers (folder nested-git) */
  ignoreAdd: (rel: string) => Promise<unknown>;
}

export function useFolderGit(root: string): FolderGit {
  const [avail, setAvail] = useState<boolean | null>(null);
  const [refs, setRefs] = useState<FolderGitRefs | null>(null);
  const [statusBump, setStatusBump] = useState(0);
  // ⚠ memo: an unstable api re-runs the probe effect on every render → request storm (measured
  // in session-manager M2)
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
      // 404 = engine absent/disabled; 400 = not a git repo — both hide the whole bar
      // (git-ops plan §4 ④)
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

  // Topic subscription (frames look like { type: "aiti-git-ops:changed:<hash>", kind, summary,
  // repo }): refresh only when repo covers this folder. The service is absent when the event bus
  // is off → no subscription; the bar then refreshes on mount and after each action.
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

  const ignoreAdd = useCallback((rel: string) => api.ignoreAdd(root, [rel]), [api, root]);
  const opPaths = useCallback(async (kind: "stage" | "unstage" | "discard", paths: string[]): Promise<number> => {
    const r = kind === "stage" ? await api.stage(root, paths)
      : kind === "unstage" ? await api.unstage(root, paths)
        : await api.discard(root, paths);
    void probe(root);
    setStatusBump((v) => v + 1);
    return r.status;
  }, [api, root, probe]);
  return { avail, refs, statusBump, refresh, op, opPaths, ignoreAdd };
}

/* ── GitBar: the single-line toolbar above the changes section ── */

export function GitBar(p: {
  root: string;
  git: FolderGit;
  onChanged?: () => void;
  /** Changes-section toggle (the dock header's switch is unreachable in some layouts — GitBar
   *  offers a guaranteed entry point) */
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
      {/* ⎇ branch chip (shared BranchPanel) */}
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
      {/* SyncBar: ↑ahead ↓behind */}
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
      {/* Grouped commit (M4: heuristic plan + engine per-commit checkpoints/rollback) */}
      <button type="button" title={ct("git.planTitle")} onClick={() => { git.refresh(); setPlanOpen(true); }}
        style={{ display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "none", color: "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 4px", borderRadius: 4 }}>
        {ct("git.planShort")}
      </button>
      {/* Changes-section toggle (guaranteed entry point) */}
      {p.onToggleChanges ? (
        <button type="button" title={ct("git.changesToggle")} aria-pressed={p.changesOpen}
          onClick={p.onToggleChanges}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, border: "none", background: "none",
            color: p.changesOpen ? "var(--accent)" : "var(--text-dim)", cursor: "pointer", fontSize: 11, padding: "2px 4px", borderRadius: 4 }}>
          ☰
        </button>
      ) : null}
      {/* Manual commit: re-probe refs first (a user or agent may have touched files after mount),
          then open the dialog — the file list is never stale */}
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

      {/* Shared BranchPanel (folder has no worktree surface → the panel hides that section) */}
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

      {/* Manual commit dialog (pick files → stage → commit; the folder plan §5.4 manual path) */}
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

/* ── manual commit dialog ── */

export function CommitDialog(p: { root: string; dirtyFiles: { xy: string; path: string }[]; onClose: () => void; onDone: () => void; initialMessage?: string }) {
  const api = useMemo(() => createGitOpsApi({ apiUrl }), []);
  const staged0 = useMemo(() => new Set(p.dirtyFiles.filter((f) => f.xy[0] !== " " && f.xy[0] !== "?").map((f) => f.path)), [p.dirtyFiles]);
  const [checked, setChecked] = useState<Set<string>>(staged0);
  const [message, setMessage] = useState(p.initialMessage || "");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cross-extension action slot (docs: commit-actions.ts) — other extensions
  // register buttons into the message action row (first consumer: aiti-codehub
  // "Work item"); the built-in AI Generate stays the last button.
  const extActions = useCommitActions();
  const actionCtx = useMemo<CommitActionCtx>(() => ({
    root: p.root,
    getMessage: () => message,
    setMessage: (updater) => setMessage((m: string) => updater(m)),
    getFiles: () => [...checked],
  }), [message, checked, p.root]);
  // AI commit message (docs/aiti-folder-commit-ai-message-plan.md): availability probe +
  // generation state
  const [aiAvail, setAiAvail] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  // Single delayed flag (no polling): once a generation passes ~25s the button says so,
  // so a slow run reads as "still working" instead of a stuck button.
  const [aiSlow, setAiSlow] = useState(false);
  // The server answered "past the deadline, still running": keep the busy state and pull the
  // same session instead of dropping the work.
  const [aiPending, setAiPending] = useState(false);

  useEffect(() => {
    if (!aiBusy) { setAiSlow(false); return; }
    const t = setTimeout(() => setAiSlow(true), 25_000);
    return () => clearTimeout(t);
  }, [aiBusy]);

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
    setAiBusy(true); setAiPending(false); setError(null);
    try {
      // basePath is derived from apiUrl (the host-shim may prefix /dev etc.); origin is this
      // page's own (same as CommitPlanDialog.aiRefine)
      const p1 = apiUrl("/api/agent/new");
      const basePath = p1.slice(0, Math.max(0, p1.indexOf("/api/")));
      const r = await fetch(apiUrl("/api/extensions/aiti-folder/git-commit-ai-message"), {
        method: "POST", headers: { "content-type": "application/json" },
        // locale: the prompt template follows the caller's UI language (zh → Chinese
        // instructions). The generated message still follows the project's own language rule.
        body: JSON.stringify({ cwd: p.root, origin: location.origin, basePath, files: [...checked], amend, locale: currentLocale() }),
      }).then((x) => x.json()).catch(() => null);
      if (r?.ok) { setMessage(String(r.message || "")); return; }
      const pendingId = r?.pending && r?.sessionId ? String(r.sessionId) : "";
      if (pendingId) {
        // The session keeps generating server-side: keep pulling it. Each pull is one long
        // request parked on the settle event — no timers, no polling.
        setAiPending(true);
        for (let attempt = 0; attempt < 3; attempt++) {
          const pr = await fetch(apiUrl("/api/extensions/aiti-folder/git-commit-ai-pull"), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: pendingId, waitMs: 180_000 }),
          }).then((x) => x.json()).catch(() => null);
          if (pr?.ok && pr.message) { setMessage(String(pr.message)); return; }
          if (!pr?.ok) break;
          if (!pr.pending) { setError(pr.error || ct("git.aiMessageEmpty")); return; } // settled without a usable answer
        }
        setError(ct("git.aiMessageStillPending"));
        return;
      }
      setError(r?.error || ct("i18n.networkError"));
    } finally {
      setAiBusy(false);
      setAiPending(false);
    }
  }, [aiBusy, checked, message, amend, p.root]);

  const submit = useCallback(async () => {
    if (busy || (!message.trim() && !amend)) return;
    setBusy(true); setError(null);
    try {
      // Checked but not yet staged → add; unchecked but already staged → restore --staged
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
      {/* data-ext-float: aiti-float owns drag / resize / persistence; full = small screens
          (≤640px) fill the viewport, large screens keep the floating window — contract
          docs/aiti-web-ext-float-dialogs.md.
          No autoh here: the dialog's initial content (file list + message box + buttons) has a
          stable height, so a fixed initial height with vertical resizing is what users expect —
          autoh removes the bottom resize handle and never persists the height.
          Key suffix v2: an instance persisted under the old (autoh) key would carry its small
          height over the new default, so the bump lets the initial height apply once. */}
      <div data-ext-float="1" data-ext-float-full="1"
        data-ext-float-key="aiti-folder.commit.v2" data-ext-float-w={380} data-ext-float-h={560} data-ext-float-min-h={360}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 380, height: 560, maxWidth: "92vw", maxHeight: "80vh", display: "flex", flexDirection: "column", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--border)", boxShadow: "0 14px 36px color-mix(in srgb, var(--text) 16%, transparent)", fontSize: 12 }}>
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
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder={ct("git.commitPlaceholder")} rows={4}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}
            style={{ width: "100%", boxSizing: "border-box" as const, resize: "vertical" as const, minHeight: 96, maxHeight: 220, background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)", fontSize: 11.5, padding: "6px 8px", outline: "none", fontFamily: "inherit" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-muted)", cursor: "pointer" }}>
              <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} style={{ accentColor: "var(--accent)", margin: 0 }} />
              {ct("git.amend")}
            </label>
            <span style={{ flex: 1 }} />
            {extActions.map((a) => {
              const act = a.factory(actionCtx);
              if (!act) return null;
              return (
                <button key={a.id} type="button" title={act.title} onClick={() => void act.onClick(actionCtx)}
                  style={{ height: 20, padding: "0 8px", borderRadius: 5, fontSize: 10.5, cursor: "pointer",
                    background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
                  {act.label}
                </button>
              );
            })}
            {aiAvail ? (
              <button type="button" disabled={aiBusy || checked.size === 0} onClick={() => void genMessage()} title={ct("git.aiMessageTitle")}
                style={{ height: 20, padding: "0 8px", borderRadius: 5, fontSize: 10.5, cursor: aiBusy || checked.size === 0 ? "not-allowed" : "pointer",
                  background: "var(--bg-hover)", color: "var(--text-muted)", border: "1px solid var(--border)", opacity: aiBusy || checked.size === 0 ? 0.6 : 1 }}>
                {aiBusy
                  ? (aiPending ? ct("git.aiMessagePending") : aiSlow ? ct("git.aiMessageBusyLong") : ct("git.aiMessageBusy"))
                  : ct("git.aiMessage")}
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
