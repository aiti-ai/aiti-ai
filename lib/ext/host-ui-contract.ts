/**
 * host-ui-contract — host capability client service contract (slot extra callback
 * decoupling, 2026-09-16).
 *
 * The host (AppShell/ChatInput) registers two read-only services via
 * registerExtClientService, exposing reference-stable host capabilities
 * (callbacks/refs/factories) to all extensions. Extension consumption chain =
 * slot render props first, service fallback (see the folder extension's
 * resolveHostFace for the pattern).
 *
 * Hard rule: services only expose reference-stable members (useCallback
 * callbacks / refs / component factories). Data that changes per render
 * (sessionId/cwd/isStreaming/inputValue/context...) must go through slot extra
 * props — service getters are imperative snapshots, and routing data through a
 * service causes "frozen value" bugs.
 */

/** "pi-web.ui" — AppShell-side host capabilities (same set as sidebarContent extra + onLineMention). */
export const HOST_UI_SERVICE = { provider: "pi-web", name: "pi-web.ui" } as const;

/** "pi-web.composer" — ChatInput-side composer capabilities (callback/ref set, no data). */
export const HOST_COMPOSER_SERVICE = { provider: "pi-web", name: "pi-web.composer" } as const;

/** HOST_UI_SERVICE field classification (contract doc; runtime set is hostUiRef). */
export const HOST_UI_FIELDS = {
  /** Callback: file viewer line-reference insertion (@ file:line; same source as host TabBodyCtx.onLineMention). */
  onLineMention: "callback",
  /** Callback: collapse all top-bar dropdown panels (session info/tools/branches..., setActiveTopPanel(null)) —
   *  extension entries inside a top-bar panel call this before opening another fullscreen surface, so on small
   *  screens the old panel doesn't cover the new surface. */
  closeTopPanels: "callback",
  /** Callbacks: remaining navigation/mention callbacks, same set as sidebarContent extra (onSelectSession/onOpenFile/onAtMention...; classification in AppShell sidebarContentExtra). */
  sidebarContentExtra: "callback-or-factory",
} as const;

/** HOST_COMPOSER_SERVICE field list (all reference-stable; actual set in ChatInput composerUiRef). */
export const HOST_COMPOSER_FIELDS = [
  /** Callback: controlled write of the composer text (ChatInput setInputValue). */
  "setInputValue",
  /** Callback: focus the composer (refocusInput). */
  "focusComposer",
  /** Ref: composer textarea (RefObject<HTMLTextAreaElement>). */
  "textareaRef",
  /** Callback: open the session stats panel (also collapses InfoSheet on small screens). */
  "openSessionInfo",
  /** Callback set: queue panel action primitives (same set as queuePanel extra.actions). */
  "queueActions",
] as const;
