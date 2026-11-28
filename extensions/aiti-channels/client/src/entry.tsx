/**
 * aiti-channels · client entry (JSX + TypeScript + vite build).
 *
 * register(ctx) wiring (v3 F1/F2):
 *   - toolbar 💬 button — the single entry, forced floating panel (no dock faces)
 *   - one dialogs item (the panel itself); Remote/Bots are in-panel tabs now —
 *     their dialog slots are retired (the buried-dialog class of bugs goes with them)
 *
 * Build: npm run build:client · Deploy: node tools/deploy.mjs
 */
import { __setCtx } from "./host-shim";
import { CHANNELS_KEY, ChannelsPanelSlot, setupNavMediaQuery, openFromToolbar } from "./channels-app";

export default function register(ctx: Record<string, unknown>) {
  // Must run before any JSX component renders (host-shim holds ctx at module level)
  __setCtx(ctx);

  setupNavMediaQuery();
  // F1: no declareDockZones — the panel no longer docks anywhere; open = float.

  // Declarative toolbar item (no render; the host owns the button chrome)
  ctx.registerItems?.("toolbar", [{
    id: "aiti-channels-open",
    meta: {
      label: "i18n:channels.open",
      title: "i18n:channels.app.title",
      icon: "icons/message-circle.svg",
      onClick: () => openFromToolbar(),
    },
  }]);
  // F2: single dialogs item; currentSession flows in as host slot props (F6 deep link)
  ctx.registerItems?.("dialogs", [
    { id: "aiti-channels-panel", render: ChannelsPanelSlot },
  ]);
}
