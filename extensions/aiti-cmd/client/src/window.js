/**
 * aiti-cmd client · window shell — the shared floating-window chrome for the three apps.
 *
 * One shell, three windows: each app renders <CmdWindow app="…"> and gets the same
 * mask + data-ext-float panel + title bar, plus the app switcher (★ ▶ 🖥) that raises
 * the target window. Geometry persists per dialog via the host's data-ext-item stamp
 * (`aiti-cmd:aiti-cmd-<app>`), so the three windows keep independent positions/sizes.
 *
 * aiti-float neutralizes the backdrop of [data-ext-float] panels (click-through) and
 * raises a panel on pointer-down — coexisting windows therefore behave like desktop
 * windows without any extra work here.
 */

export const APP_ORDER = ["favorites", "running", "terminal"];

/** Per-app chrome defaults: title i18n key, glyph paths, default geometry. */
export function appMeta(kit) {
  const { ICON_PATHS } = kit;
  return {
    favorites: { labelKey: "cmd.app.favorites", titleKey: "cmd.app.favorites.title", icon: ICON_PATHS.star, w: 760, h: 560, z: 321 },
    running: { labelKey: "cmd.app.running", titleKey: "cmd.app.running.title", icon: ICON_PATHS.play, w: 720, h: 560, z: 322 },
    terminal: { labelKey: "cmd.app.terminal", titleKey: "cmd.app.terminal.title", icon: ICON_PATHS.terminal, w: 860, h: 620, z: 323 },
  };
}

/**
 * Narrow-screen title-bar wrap. The window itself goes fullscreen on small screens
 * via data-ext-float-full (aiti-float, ≤640px), but the fixed-width title-bar items
 * (app switcher labels + ai-helper/extman injected buttons + close) can exceed a
 * phone viewport, so the single row overflows and the close button gets clipped off
 * the right edge (the panel has overflow hidden) — nothing to click.
 * Same house pattern as other small-screen dialogs: everything after the subtitle
 * wraps onto a second row, right-aligned. The .cmd-titlebar-break anchor (hidden on
 * desktop, flexBasis:100% under 640px) forces the wrap; margin-left:auto on the
 * switcher right-aligns that second row. The 640px breakpoint matches aiti-float's
 * FULL_MQ and the rest of the codebase's small-screen convention. Labeled switcher
 * buttons don't always share that row with the injected buttons (long English labels
 * overflow again), so under 480px they collapse to icon-only as a second tier.
 */
const WINDOW_STYLE_ID = "aiti-cmd-window-css";
const windowCss = [
  "@media (max-width: 640px) {",
  "  .cmd-titlebar { flex-wrap: wrap; }",
  "  .cmd-titlebar-break { display: block !important; }",
  "  .cmd-switchwrap { margin-left: auto; }",
  "}",
  "@media (max-width: 480px) {",
  "  .cmd-switch-label { display: none; }",
  "  .cmd-switch-btn { padding-left: 5px !important; padding-right: 5px !important; }",
  "}",
].join("\n");
if (typeof document !== "undefined" && !document.getElementById(WINDOW_STYLE_ID)) {
  const style = document.createElement("style");
  style.id = WINDOW_STYLE_ID;
  style.textContent = windowCss;
  document.head.appendChild(style);
}

export function createWindow(kit, store) {
  const { h, t, Ic } = kit;
  const META = appMeta(kit);

  function Switcher({ app }) {
    return h("div", { className: "cmd-switchwrap", style: { display: "flex", gap: 2, alignItems: "center", flexShrink: 0 } },
      ...APP_ORDER.map((id) => {
        const m = META[id];
        const active = id === app;
        return h("button", {
          key: id,
          type: "button",
          title: t(m.labelKey) + (active ? "" : " · " + t("cmd.app.switch")),
          "aria-label": t(m.labelKey),
          "aria-pressed": active ? "true" : "false",
          className: "cmd-switch-btn",
          onClick: (e) => { e.stopPropagation(); if (!active) store.openApp(id); },
          style: {
            display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0,
            height: 20, padding: "0 7px", borderRadius: 5, cursor: active ? "default" : "pointer",
            border: "1px solid " + (active ? "var(--accent)" : "transparent"),
            background: active ? "color-mix(in srgb, var(--accent) 16%, transparent)" : "transparent",
            color: active ? "var(--accent)" : "var(--text-muted)",
            fontSize: 12, lineHeight: 1, fontFamily: "inherit", fontWeight: active ? 700 : 400,
          },
        }, Ic(12, m.icon), h("span", { className: "cmd-switch-label", style: { whiteSpace: "nowrap" } }, t(m.labelKey)));
      }));
  }

  /**
   * @param {object} props
   * @param {"favorites"|"running"|"terminal"} props.app
   * @param {string} [props.subtitle] right-aligned dim text next to the title
   * @param {Array} [props.actions] extra title-bar buttons (before the switcher)
   * @param {boolean} [props.autoh]
   * @param {number} [props.width]
   * @param {number} [props.height]
   */
  function CmdWindow({ app, subtitle, actions, autoh, width, height, children }) {
    const m = META[app];
    const close = () => store.closeApp(app);
    return h("div", {
      style: { position: "fixed", inset: 0, zIndex: m.z, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
      onClick: close,
    },
      h("div", {
        "data-ext-float": "1",
        "data-ext-float-w": width || m.w,
        "data-ext-float-h": height || m.h,
        ...(autoh ? { "data-ext-float-autoh": "1" } : {}),
        "data-ext-float-full": "1",
        style: { width: width || m.w, maxWidth: "96vw", height: autoh ? undefined : "82vh", maxHeight: autoh ? "88vh" : undefined, display: "flex", flexDirection: "column", borderRadius: 12, background: "var(--bg-panel)", border: "1px solid var(--border)", color: "var(--text)", fontFamily: "inherit", boxShadow: "0 20px 60px rgba(0,0,0,0.35)", overflow: "hidden" },
        onClick: (e) => e.stopPropagation(),
      },
        // title bar (compact single row): icon + app name + subtitle + actions + app switcher + close
        h("div", { className: "cmd-titlebar", style: { display: "flex", alignItems: "center", gap: 6, padding: "3px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0, minHeight: 28, lineHeight: 1 } },
          h("span", { style: { width: 18, height: 18, borderRadius: 5, background: "var(--bg-hover)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "var(--accent)" } }, Ic(12, m.icon)),
          // shrinkable title: absorbs overflow after the subtitle collapses, keeping close/max reachable
          h("span", { style: { fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } }, t(m.labelKey)),
          h("span", { title: subtitle || t(m.titleKey), style: { fontSize: 12, color: "var(--text-muted)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, subtitle || t(m.titleKey)),
          // small screens only (CSS media query): 100%-basis anchor pushes the switcher
          // and every injected button (🤖 🔧 ⛶ ✕) onto a second, right-aligned row
          h("div", { className: "cmd-titlebar-break", "aria-hidden": true, style: { display: "none", flexBasis: "100%", height: 0 } }),
          actions || null,
          h(Switcher, { app }),
          // aria-label="close" is the anchor the ai-helper dialog 🤖 injection looks for
          h("button", { onClick: close, title: t("cmd.app.close"), "aria-label": t("cmd.k109"), style: { ...windowBtnStyle, padding: "1px 6px", display: "inline-flex" } }, Ic(12, kit.ICON_PATHS.x)),
        ),
        h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "6px 10px 10px", overflow: "hidden", gap: 6 } }, children),
      ),
    );
  }

  return { CmdWindow, Switcher, META };
}

const windowBtnStyle = {
  borderWidth: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer",
  borderRadius: 5, fontSize: 12, lineHeight: 1, flexShrink: 0, fontFamily: "inherit",
};
