"use client";

/**
 * /viewer — standalone file viewer window (thin composition page, zero business logic).
 *
 * Landing page for "open in a new window": a browser window containing only the
 * file viewer — no sidebar/top bar/chat area. Opening flow: the opener first does
 * window.open("/viewer") on a blank window; once the child is ready it postMessages
 * the target over (the viewer handshake protocol). The target persists in
 * sessionStorage — restorable across refresh, and the path never lands in the URL,
 * browser history, or tunnel proxy access logs.
 *
 * Reuses the same render chain as the main UI: <ExtSlotsProvider> loads extension
 * clients → the editor/folder extensions take over <FileViewer> via the fileViewer
 * slot — the standalone window and the main panel views are 100% the same source.
 *
 * Same file-tab structure as the main panel: reuses the core TabBar plus the
 * file-tab-state pure functions (openFileTab/openFolderTab/saveFileViewerState).
 * Clicking files/subfolders in the folder tree opens tabs (activating existing
 * ones); ‹› depth navigation, per-tab viewer state restoration, and other
 * behaviors match the main panel.
 */

import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExtSlotsProvider, ensureExtSlotMaterialized } from "@/components/ExtSlots";
import { FileViewer } from "@/components/FileViewer";
import { TabBar, type Tab } from "@/components/TabBar";
import { openFileTab, openFolderTab, saveFileViewerState } from "@/components/file-tab-state";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { withBasePath } from "@/lib/base-path";
import { registerHostApi } from "@/lib/ext/host-api";
import { getExtUiItems, subscribeExtUi, hasExtRender } from "@/lib/ext-ui-store";

type ViewerTarget = { path: string; kind: "file" | "folder"; cwd?: string; /** Explicit root switch (e.g. "open folder"): force cwd to the target directory */ setRoot?: boolean };

/** Stable empty snapshot for the pathPicker slot (no takeover during SSR/before registration; getServerSnapshot must return a cached reference). */
const PATH_PICKER_NO_ITEMS: import("@/lib/ext-ui-store").ExtUiItemRegistered[] = [];

// Standalone viewer window flag (set at module level, before ExtSlotsProvider loads
// any extension client's register/sendReady):
//   1) Extension composer actions (@ mentions / @ to new session / selection AI) go
//      back to the opener via postMessage (forwardComposerToOpener) instead of
//      looking for a chat surface inside this window;
//   2) host-protocol exemption: although this window has an opener, it is not an AI
//      popup — it must not send dbg_ai_ready/metadata heartbeats to the opener,
//      otherwise the main panel launcher's orphan-popup cleanup would close this
//      window outright (new window instantly closed).
if (typeof window !== "undefined") {
  (window as unknown as { __aitiViewerStandalone?: boolean }).__aitiViewerStandalone = true;
}

function lastSeg(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function parentDir(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : s;
}

// Target persistence (sessionStorage, isolated per tab): replaces the old
// "parameters in the address bar" approach — the path never lands in URL/history/
// logs, and refresh still restores it.
const VIEWER_TARGET_KEY = "aiti-viewer-target";

function readStoredTarget(): ViewerTarget | null {
  try {
    const raw = sessionStorage.getItem(VIEWER_TARGET_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as ViewerTarget;
    if (!t || typeof t.path !== "string" || !t.path) return null;
    return { path: t.path, kind: t.kind === "folder" ? "folder" : "file", cwd: t.cwd || undefined };
  } catch { return null; }
}

function persistTarget(target: { path: string; kind?: string; cwd?: string }): void {
  try {
    sessionStorage.setItem(VIEWER_TARGET_KEY, JSON.stringify({
      path: target.path,
      kind: target.kind === "folder" ? "folder" : "file",
      cwd: target.cwd,
    }));
  } catch { /* noop */ }
}

// —— Standalone-window composer request forwarding (reuses the viewer protocol) ——
// This window has no chat surface (composer/session), so extension actions like
// @ mentions / @ to new session / selection AI go back to the opener (main panel)
// via postMessage. Message shape:
//   { source: "aiti-viewer", type: "composer", action: "append" | "newSession" | "steer", text, cwd? }
// The receiver lives in the main panel AppShell (origin check + source/type gate).
// Returns false when there is no opener (link opened fresh); the caller shows its
// own notice.
// Note: must not be exported — Next page files only allow default/specific exports;
// extra exports break the production build's type check.
function forwardComposerToOpener(action: string, text: string, cwd?: string): boolean {
  try {
    const opener = window.opener as Window | null;
    if (!opener || opener.closed) return false;
    opener.postMessage({ source: "aiti-viewer", type: "composer", action, text, cwd }, window.location.origin);
    return true;
  } catch { return false; }
}

export default function ViewerPage() {
  return (
    <Suspense fallback={<div style={{ height: "100dvh" }} />}>
      <I18nProvider>
        <ExtSlotsProvider>
          <ViewerBody />
        </ExtSlotsProvider>
      </I18nProvider>
    </Suspense>
  );
}

function ViewerBody() {
  const { t } = useI18n();

  // Initial tabs are always empty (the hydration first frame must match the server
  // HTML): sessionStorage is client-mutable data; reading it in the useState
  // initializer would make the hydration render grow tabs in the refresh-restore
  // case (the server rendered the empty state) → React hydration mismatch. Restore
  // moves to a post-mount effect with identical semantics.
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // Boot phase: sessionStorage restore / opener handshake redemption not yet
  // settled. SSR and the hydration first frame both render a neutral loading state
  // (identical on both sides, no mismatch); once settled, switch to content or the
  // empty state — avoids flashing a misleading "No file open" empty state during
  // the wait (2026-09-10: the refresh-restore path always passed through it, which
  // looked like the file was lost).
  const [booted, setBooted] = useState(false);
  // Working directory (depth-navigation root / git badge): stored cwd takes
  // priority; backfilled when opening a folder tab
  const [cwd, setCwd] = useState<string | undefined>(undefined);

  // —— sessionStorage restore (refresh case; once after mount, declared before the handshake effect) ——
  // With a stored target present, the handshake effect skips via the readStoredTarget()
  // hit; the two never stack.
  useEffect(() => {
    const init = readStoredTarget();
    if (!init) return;
    const restored = init.kind === "folder"
      ? openFolderTab([], { folderName: lastSeg(init.path), folderPath: init.path, tabId: `folder:${init.path}` })
      : openFileTab([], { fileName: lastSeg(init.path), filePath: init.path, sourceSessionId: null, tabId: `file:${init.path}` });
    setTabs(restored);
    setActiveTabId(restored[0]?.id ?? null);
    if (init.cwd) setCwd(init.cwd);
    setBooted(true);
  }, []);

  const activeTab = tabs.find((tb) => tb.id === activeTabId) ?? null;
  // Fallback navigation root: when the URL carries no cwd, files use their parent
  // directory and folders use themselves (enables ‹ › depth navigation / git badge)
  const effCwd = cwd
    ?? (activeTab ? (activeTab.kind === "folder" ? activeTab.filePath : parentDir(activeTab.filePath)) : undefined);
  // "Open folder" capability (the folder extension's FolderSwitcher, same shape as
  // the main UI's file area): pick any directory to open it as a tab.
  const pathPickerItems = useSyncExternalStore(
    subscribeExtUi,
    () => getExtUiItems("pathPicker"),
    () => PATH_PICKER_NO_ITEMS,
  );
  // After render became optional (declarative toolbar items), narrow uniformly:
  // only consume pathPicker items that carry render
  const pathPicker = pathPickerItems.find(hasExtRender) ?? null;
  // [lazy loading v2] opening the viewer page = the interaction moment — lazily
  // materialize extensions declaring pathPicker (folder) in one shot; until they
  // arrive the fallback button is shown, and after materialization the store bump
  // lets FolderSwitcher take over.
  useEffect(() => {
    void ensureExtSlotMaterialized("pathPicker");
  }, []);

  // —— ref holding the freshest host-primitive state (registerHostApi is a
  // module-level singleton; closures must not go stale) ——
  const stateRef = useRef({ tabs, activeTabId, cwd: effCwd });
  stateRef.current = { tabs, activeTabId, cwd: effCwd };
  const openTargetRef = useRef<(target: ViewerTarget, push: boolean, select?: boolean) => void>(() => {});

  // Register the host public API (same as AppShell): the capabilities extensions
  // call via ctx.openFile/openFolder/getFileTabs/closeFileTabs all wire into this
  // window's tab state — the editor extension's ‹› depth navigation, opening files
  // inside archives, jump-after-rename, etc. all depend on these primitives.
  useEffect(() => {
    registerHostApi({
      openFile: (filePath, _fileName, options) => {
        const select = options?.select !== false;
        // Background open (select:false) does not enter the history stack — the
        // location display always follows the active tab
        openTargetRef.current({ path: filePath, kind: "file", cwd: stateRef.current.cwd }, select, select);
      },
      openFolder: (folderPath, _folderName, options) => {
        const select = options?.select !== false;
        // The third argument must pass select explicitly: openTarget's select
        // parameter defaults to true, and omitting it reverts to "folder restore
        // always activates" — a session-restored workspace folder steals focus
        // (same for openFile)
        openTargetRef.current({ path: folderPath, kind: "folder", cwd: stateRef.current.cwd }, select, select);
      },
      // This window has no chat input: @ mention write actions forward to the
      // opener's (main panel) composer
      appendText: (text) => { forwardComposerToOpener("append", text); },
      getFileTabs: () => stateRef.current.tabs.map((tb) => ({ id: tb.id, filePath: tb.filePath, kind: (tb.kind === "terminal" ? "file" : tb.kind) ?? "file", pinned: tb.pinned })),
      closeFileTabs: (ids) => {
        setTabs((prev) => {
          const next = prev.filter((tb) => !ids.includes(tb.id));
          setActiveTabId((cur) => {
            if (!ids.includes(cur ?? "")) return cur;
            if (next.length === 0) return null;
            // Activation re-shuffle: pick the surviving neighbor with the smallest
            // index among the closed set (same semantics as the main panel)
            const firstClosed = Math.min(...ids.map((id) => prev.findIndex((tb) => tb.id === id)).filter((i) => i >= 0));
            return next[Math.min(firstClosed, next.length - 1)].id;
          });
          return next;
        });
      },
    });
  }, []);

  // —— Navigation primitives: open file/folder tabs; push = write to history;
  // select=false adds the tab without activating it —— //
  const openTarget = useCallback((target: ViewerTarget, push: boolean, select = true) => {
    const navCwd = target.cwd ?? (target.kind === "folder" ? target.path : undefined);
    if (navCwd && (!target.cwd || target.setRoot)) setCwd(navCwd);
    const tabId = target.kind === "folder" ? `folder:${target.path}` : `file:${target.path}`;
    setTabs((prev) => (
      target.kind === "folder"
        ? openFolderTab(prev, { folderName: lastSeg(target.path), folderPath: target.path, tabId })
        : openFileTab(prev, { fileName: lastSeg(target.path), filePath: target.path, sourceSessionId: null, tabId })
    ));
    if (select) setActiveTabId(tabId);
    // Persist to sessionStorage (replaces the old pushState/replaceState address-bar
    // sync) — restorable across refresh, path stays out of the URL
    if (push || select) persistTarget({ ...target, cwd: navCwd });
  }, []);
  openTargetRef.current = openTarget;

  // —— viewer handshake (child-window pull style): after load, send ready to the
  // opener to get a ticket, then redeem the target itself ——
  // Only the ticket carries the path; postMessage passes an opaque token. Refresh
  // restore goes through sessionStorage and never re-pulls from the opener.
  useEffect(() => {
    if (readStoredTarget()) return; // refresh-restore case: target already present, skip the handshake (booting settles via the restore effect)
    const opener = window.opener as Window | null;
    if (!opener || opener.closed) { setBooted(true); return; } // opened directly with no context: go straight to the empty state
    let dead = false;
    const finish = () => { if (!dead) setBooted(true); };
    const onMsg = async (ev: MessageEvent) => {
      if (ev.origin !== location.origin || ev.source !== window.opener) return;
      const d = ev.data as { source?: string; type?: string; ticket?: string } | null;
      if (!d || d.source !== "aiti-viewer" || d.type !== "init" || typeof d.ticket !== "string" || !d.ticket) return;
      window.removeEventListener("message", onMsg);
      try {
        const r = await fetch(withBasePath("/api/files/ticket"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket: d.ticket }),
        });
        const data = await r.json() as { path?: string; kind?: string; cwd?: string | null };
        if (!dead && r.ok && data?.path) {
          openTargetRef.current({ path: data.path, kind: data.kind === "folder" ? "folder" : "file", cwd: data.cwd || undefined }, true);
        }
      } catch { /* opener closed / network failure */ }
      finish(); // whether redemption succeeds or not, the boot phase ends (failure lands on the empty state)
    };
    window.addEventListener("message", onMsg);
    try { opener.postMessage({ source: "aiti-viewer", type: "ready" }, location.origin); } catch { finish(); }
    // Fallback deadline: if the opener exists but never replies (stale tab/abnormal
    // state), don't stay on loading forever — a one-shot timer (not polling) settles
    // to the empty state after 3s; a late reply still opens the file normally.
    const deadline = window.setTimeout(finish, 3000);
    return () => { dead = true; window.clearTimeout(deadline); window.removeEventListener("message", onMsg); };
  }, []);

  // Window title follows the active tab
  useEffect(() => {
    document.title = activeTab ? `${activeTab.label} · Pi Web` : "Pi Web";
  }, [activeTab]);

  const handleSelectTab = useCallback((id: string) => {
    setActiveTabId(id);
    const tb = tabs.find((x) => x.id === id);
    if (tb) persistTarget({ path: tb.filePath, kind: tb.kind, cwd });
  }, [tabs, cwd]);

  const handleClose = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      const next = prev.filter((x) => x.id !== id);
      setActiveTabId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        return next[Math.min(idx, next.length - 1)].id;
      });
      return next;
    });
  }, []);

  if (!booted) {
    // Boot phase: neutral loading placeholder (same shape as SSR; switches to content or the empty state once restore/redemption settles)
    return (
      <div
        role="status"
        aria-label={t("sidebar.loading")}
        style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}
      >
        <span
          style={{
            width: 18, height: 18, borderRadius: "50%",
            border: "2px solid var(--border)", borderTopColor: "var(--accent)",
            animation: "spin 0.8s linear infinite",
          }}
        />
      </div>
    );
  }

  if (!tabs.length || !activeTab) {
    // All tabs closed (or genuinely no context): centered empty state + "open folder" entry (reuses the pathPicker slot)
    return (
      <div style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
          <span style={{ color: "var(--text-dim)", fontSize: 13 }}>{t("files.noneOpen")}</span>
          {pathPicker ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {pathPicker.render({
                path: "",
                compact: true,
                onSelect: (p: string) => openTarget({ path: p, kind: "folder", setRoot: true }, true),
              })}
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                {t("viewer.openFolderHint")}
              </span>
            </div>
          ) : null}
          <a href={withBasePath("/")} style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
            {t("viewer.backToApp")}
          </a>
        </div>
      </div>
    );
  }

  const iconBtn = {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 26, height: 24, padding: 0,
    background: "transparent", border: "none", borderRadius: 4,
    color: "var(--text-dim)", cursor: "pointer", fontSize: 14,
    textDecoration: "none", flexShrink: 0,
  } as const;

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }}>
      {/* File tab row: back · reload · tabs · open folder */}
      <div style={{ display: "flex", alignItems: "stretch", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", padding: "0 2px 0 6px" }}>
          <a href={withBasePath("/")} title={t("viewer.backToApp")} aria-label={t("viewer.backToApp")} style={iconBtn}>←</a>
          <button type="button" onClick={() => window.location.reload()} title={t("viewer.reload")} aria-label={t("viewer.reload")} style={iconBtn}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
            </svg>
          </button>
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <TabBar
            tabs={tabs}
            activeTabId={activeTab.id}
            onSelectTab={handleSelectTab}
            onCloseTab={handleClose}
          />
        </div>
        {pathPicker
          ? pathPicker.render({
              path: effCwd ?? "",
              compact: true,
              onSelect: (p: string) => openTarget({ path: p, kind: "folder", setRoot: true }, true),
            })
          : null}
      </div>

      {/* Viewer for the active tab (same shape as the main panel: only the active item mounts; state restores per revision) */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {activeTab.kind === "folder" ? (
          <FileViewer
            key={activeTab.id}
            kind="folder"
            filePath={activeTab.filePath}
            cwd={effCwd}
            watchEnabled
            onOpenFile={(p) => openTarget({ path: p, kind: "file", cwd: effCwd }, true)}
            onOpenFolder={(p) => openTarget({ path: p, kind: "folder", cwd: effCwd }, true)}
          />
        ) : (
          <FileViewer
            key={`${activeTab.id}:${activeTab.viewerRevision ?? 0}`}
            filePath={activeTab.filePath}
            cwd={effCwd}
            sourceSessionId={activeTab.sourceSessionId ?? null}
            initialDisplayMode={activeTab.initialDisplayMode}
            initialState={activeTab.viewerState}
            watchEnabled
            onStateChange={(vs) => setTabs((prev) => saveFileViewerState(prev, activeTab.id, activeTab.viewerRevision ?? 0, vs))}
            onOpenFile={(p) => openTarget({ path: p, kind: "file", cwd: effCwd }, true)}
            onOpenFolder={(p) => openTarget({ path: p, kind: "folder", cwd: effCwd }, true)}
          />
        )}
      </div>
      {/* Bottom status bar: current path */}
      <div style={{ display: "flex", alignItems: "center", height: 22, padding: "0 10px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--text-dim)" }} title={activeTab.filePath}>
          {activeTab.filePath}
        </span>
      </div>
    </div>
  );
}
