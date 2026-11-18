/**
 * aiti-cmd client bundle — entry point (three dialog apps + entry points + bridges).
 *
 * Layout of this bundle:
 *   kit.js                    ctx-bound runtime (t/h/api/icons/terminal tables/alive keepalive)
 *   state.js                  app store (which window is open, which session is shown)
 *   window.js                 shared floating-window chrome + app switcher
 *   apps/favorites.js         ★ 命令收藏 (aiti-cmd-favorites)
 *   apps/running.js           ▶ 运行中   (aiti-cmd-running)
 *   apps/terminal.js          🖥 终端     (aiti-cmd-terminal)
 *   views/terminal-view.js    xterm PTY view (also used by the workspace tab)
 *   views/pi-command-view.js  agent bash live output
 *   views/command-detail.js   message-recognition command card (aiti-cmd-detail)
 *   views/workspace-terminal.js  terminalDock takeover + tab/dialog ownership state machine
 *   entry.js                  composerTools run-status entry
 *   sinks.js                  share-sink provider (commands as a favourite share target)
 *
 * Cross-extension surface kept unchanged: window.__aitiCmd (openCommand/openShell/openSession),
 * client services aiti-cmd.open-session / aiti-cmd.open-shell (+ new aiti-cmd.open-app),
 * the aiti-cmd:open-shell window event and the postMessage bridge for detached viewers.
 */
import { createKit } from "./kit.js";
import { createStore, createUseStore } from "./state.js";
import { createWindow } from "./window.js";
import { createTerminalView } from "./views/terminal-view.js";
import { createPiCommandView } from "./views/pi-command-view.js";
import { createCommandDetail } from "./views/command-detail.js";
import { createTabs } from "./views/workspace-terminal.js";
import { createFavoritesApp } from "./apps/favorites.js";
import { createRunningApp } from "./apps/running.js";
import { createTerminalApp } from "./apps/terminal.js";
import { createRunningEntry } from "./entry.js";
import { registerShareSink } from "./sinks.js";

export default function register(ctx) {
  const kit = createKit(ctx);
  const { t, h, Ic, ICONS, api } = kit;
  const store = createStore();
  const useStore = createUseStore(kit, store);
  const { CmdWindow } = createWindow(kit, store);

  const TerminalView = createTerminalView(kit);
  const PiCommandView = createPiCommandView(kit);
  const tabs = createTabs(kit, store, { TerminalView });
  const CommandDetailPanel = createCommandDetail(kit, store, { useStore });

  const FavoritesApp = createFavoritesApp(kit, store, { CmdWindow, useStore, SANDBOX: kit.SANDBOX });
  const RunningApp = createRunningApp(kit, store, { CmdWindow, PiCommandView, tabs, useStore, SOURCE_LABEL: kit.SOURCE_LABEL });
  const TerminalApp = createTerminalApp(kit, store, { CmdWindow, TerminalView, tabs, useStore });
  const RunningEntry = createRunningEntry(kit, store);

  // ---------- 打开交互 shell（§3.3 前端「打开终端」下沉后端）----------
  // POST /shell creates the session server-side (the command text never leaves the backend);
  // the front end only renders the sid. → terminal app; resolves { ok, sessionId?, error? }
  const createShell = (cwd, name) => {
    return fetch(api("/shell"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cwd || undefined, name: name || t("cmd.k325") }) })
      .then((x) => x.json()).catch(() => ({ ok: false, error: t("cmd.k336") }))
      .then((r) => {
        if (!r || !r.ok || !r.sessionId) return { ok: false, error: (r && r.error) || t("cmd.k122") };
        store.openApp("terminal", { sessionId: r.sessionId, title: r.name || name || t("cmd.k325") });
        return { ok: true, sessionId: r.sessionId };
      });
  };
  // render an existing session (the sid was created by the backend — ai-input suggest ⚡ / codebuddy …)
  const openSession = (sessionId, title) => {
    if (!sessionId) return;
    store.openApp("terminal", { sessionId: String(sessionId), title: title || (t("cmd.k82") + String(sessionId)) });
  };
  const openCommand = (cmd, cwd) => { store.set({ detail: { cmd: String(cmd || ""), cwd: cwd || null }, detailBusy: false }); };

  // ---------- global bridge (kept for backward compatibility) ----------
  if (typeof window !== "undefined" && !window.__aitiCmd) {
    window.__aitiCmd = { openCommand, openShell: createShell, openSession };
    // cross-extension client services (new consumers use ctx.getExtService, never the global)
    try { ctx?.registerExtService?.("aiti-cmd.open-session", openSession); } catch { /* old core */ }
    try { ctx?.registerExtService?.("aiti-cmd.open-shell", createShell); } catch { /* old core */ }
    // single cross-app entry: open-app("favorites"|"running"|"terminal", payload)
    try { ctx?.registerExtService?.("aiti-cmd.open-app", (app, payload) => store.openApp(String(app), payload || {})); } catch { /* old core */ }
    // detached viewers (/viewer for aiti-folder / aiti-editor) ask the main window to open a shell
    window.addEventListener("message", (ev) => {
      if (ev.origin !== location.origin) return;
      const m = ev.data;
      if (!m || m.source !== "aiti-ext" || m.type !== "open-shell") return;
      createShell(m.cwd, m.name).then((result) => {
        try { if (ev.source) ev.source.postMessage({ source: "aiti-cmd", type: "open-shell-result", reqId: m.reqId, ...result }, location.origin); } catch (e) { /* noop */ }
      });
    });
    // host main-window event channel (AppShell sidebar terminal button / TerminalPanelBridge)
    window.addEventListener("aiti-cmd:open-shell", (ev) => {
      const cwd = ev.detail && typeof ev.detail.cwd === "string" ? ev.detail.cwd : undefined;
      if (cwd === undefined) return;
      try { createShell(cwd, ev.detail.name || t("cmd.k325"))?.catch?.(() => {}); } catch (e) { /* noop */ }
    });
  }

  // ---------- message paragraph recognition: command provider (msg-popover-action) ----------
  if (typeof ctx.registerTopicItem === "function") {
    ctx.registerTopicItem("msg-popover-action", {
      id: "aiti-cmd-command",
      recognize: async (text, { cwd }) => {
        const j = await fetch(api("/commands/check"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, cwd: cwd || undefined }) })
          .then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!j || !Array.isArray(j.commands) || !j.commands.length) return [];
        return j.commands.map((c) => {
          // cd xxx && … → workdir becomes the run cwd, action is the command body (more accurate)
          const wd = c.workdir ? `${t("cmd.k195")}${c.workdir}\n` : "";
          return {
            type: "command",
            id: c.cmd,
            match: c.cmd, // exact source text (hover highlighting in aiti-msg-smart)
            label: c.cmd.length > 40 ? c.cmd.slice(0, 40) + "…" : c.cmd,
            danger: !!(c.danger && c.danger.length),
            unavailable: c.exists === false,
            title: wd + (c.exists === false
              ? t("cmd.k379")
              : (c.danger && c.danger.length ? `${t("cmd.k147")}${c.danger.join("/")}${t("cmd.k62")}` : t("cmd.k304"))),
            onClick: () => { store.set({ detail: { cmd: c.action || c.cmd, cwd: c.workdir || cwd || null }, detailBusy: false }); },
          };
        });
      },
    });

    // ---------- inline code recognition (inline-code-action) ----------
    ctx.registerTopicItem("inline-code-action", {
      id: "aiti-cmd-inline",
      recognize: async (text) => {
        if (!text || text.length > 200) return [];
        const j = await fetch(api("/commands/check"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
          .then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (!j || !Array.isArray(j.commands) || !j.commands.length) return [];
        const c = j.commands[0];
        const wd = c.workdir ? `${t("cmd.k195")}${c.workdir}\n` : "";
        return [{
          type: "command",
          id: "inline:" + c.cmd,
          label: c.cmd.length > 40 ? c.cmd.slice(0, 40) + "…" : c.cmd,
          danger: !!(c.danger && c.danger.length),
          title: wd + (c.exists === false
            ? t("cmd.k379")
            : (c.danger && c.danger.length ? `${t("cmd.k147")}${c.danger.join("/")}${t("cmd.k62")}` : t("cmd.k304"))),
          onClick: () => { store.set({ detail: { cmd: c.action || c.cmd, cwd: c.workdir || null }, detailBusy: false }); },
        }];
      },
    });
  }

  // ---------- share center: commands as a fixed favourite sink ----------
  registerShareSink(ctx, kit, store);

  // ---------- slots ----------
  // toolbar ⚡ always opens the running app (D2)
  ctx.registerItems("toolbar", [{
    id: "aiti-cmd-open",
    meta: {
      label: t("cmd.k208"),
      title: t("cmd.k41"),
      icon: { svg: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' },
      onClick: () => store.openApp("running"),
    },
  }]);
  // command catalog: three app cards in the app center / ⌘K palette / input hints
  ctx.registerItems("commands", [
    { id: "aiti-cmd-app-favorites", render: () => null, meta: { label: t("cmd.app.favorites"), title: t("cmd.app.favorites.title"), icon: { svg: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>' }, onClick: () => store.openApp("favorites") } },
    { id: "aiti-cmd-app-running", render: () => null, meta: { label: t("cmd.app.running"), title: t("cmd.app.running.title"), icon: { svg: '<path d="m6 3 14 9-14 9V3z"/>' }, onClick: () => store.openApp("running") } },
    { id: "aiti-cmd-app-terminal", render: () => null, meta: { label: t("cmd.app.terminal"), title: t("cmd.app.terminal.title"), icon: { svg: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>' }, onClick: () => store.openApp("terminal") } },
  ]);
  // dialogs: three app windows + the message-recognition card
  ctx.registerItems("dialogs", [
    { id: "aiti-cmd-favorites", render: FavoritesApp },
    { id: "aiti-cmd-running", render: RunningApp },
    { id: "aiti-cmd-terminal", render: TerminalApp },
    { id: "aiti-cmd-detail", render: CommandDetailPanel },
  ]);
  // workspace terminal tab takeover (terminalDock): renders the terminal inline; single instance
  // with the terminal window via the ownership state machine (views/workspace-terminal.js)
  ctx.registerItems("terminalDock", [{ id: "workspace-terminal", render: tabs.WorkspaceTerminalHost }]);
  // composerTools: always-visible run-status entry (desktop icon row / mobile ＋ sheet bottom)
  try {
    ctx.registerItems("composerTools", [{ id: "aiti-cmd-running-entry", render: RunningEntry, meta: { label: t("cmd.app.entry.title") } }]);
  } catch (e) { /* old host without the slot */ }
}
