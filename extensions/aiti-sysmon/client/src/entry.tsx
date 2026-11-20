/**
 * aiti-sysmon · client entry (JSX + TypeScript, vite lib build).
 *
 * register(ctx) wiring:
 *   - sidebar dock face (item id "panel") taking over the manifest static slot;
 *   - auto-dock once the aiti-float present state machine is live, so the block
 *     shows up like the built-in Tasks block (present, collapsed by default).
 *     ui.clientImmediately=true makes this bundle eager precisely for this — a
 *     lazy dock-only extension would have no first-entry point at all.
 *
 * Build: node tools/build-client.mjs   Deploy: node tools/deploy.mjs
 */
import { __setCtx } from "./host-shim";
import {
  declareDockZones, sidebarZoneOf, seedDockDefault, seedBlockCollapsedDefault,
  present, FLOAT_INSTALLED_EVENT,
} from "../../../_shared/ext-float-dock";
import { SysmonDockFace, SY_KEY, gaugeIconUrl } from "./sysmon-app";

const DOCK_STACK_SERVICE = "aiti-float.dockstack";

export default function register(ctx: Record<string, any>) {
  // Must run before any JSX component renders (host-shim holds ctx module-level).
  __setCtx(ctx);

  // Dock identity: zones + default dock position + collapsed-by-default seed
  // (single-expand accordion must not auto-open the panel on every page load).
  const zone = sidebarZoneOf(SY_KEY);
  declareDockZones(SY_KEY, [zone], zone);
  seedDockDefault(SY_KEY, zone);
  seedBlockCollapsedDefault(SY_KEY, true);

  // Restore-default-presence dock (Tasks-block semantics): once per mount, and
  // only after the aiti-float state machine is live — an early present would
  // land in the degraded store and never reach the real machine (§10.3 pitfall).
  // Live detection = dockstack client service; late install = installed event
  // (+ service change callback as belt and braces). No polling anywhere.
  let docked = false;
  const dockNow = () => {
    if (docked) return;
    docked = true;
    try { present(SY_KEY, `dock:${zone}`, { auto: true }); } catch { /* ignore */ }
  };
  if (ctx.getExtService?.(DOCK_STACK_SERVICE)) dockNow();
  else {
    window.addEventListener(FLOAT_INSTALLED_EVENT, dockNow, { once: true });
    if (typeof ctx.onExtServiceChange === "function") {
      ctx.onExtServiceChange((key: string, phase: string) => {
        if (key === DOCK_STACK_SERVICE && phase === "up") dockNow();
      });
    }
  }

  // Real face takes over the manifest static slot (same item id "panel").
  ctx.registerItems?.("sidebarExplorerDock", [{
    id: "panel",
    render: SysmonDockFace,
    meta: { title: "i18n:sy.panel.label", icon: { url: gaugeIconUrl() }, priority: 4 },
  }]);

  try { console.log("[aiti-sysmon] client mounted (sidebar dock panel, auto-docked)"); } catch { /* noop */ }
}
