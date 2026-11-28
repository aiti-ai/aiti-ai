/**
 * aiti-sysmon · client entry (JSX + TypeScript, vite lib build).
 *
 * register(ctx) wiring:
 *   - sidebar dock face (item id "panel") taking over the manifest static slot;
 *   - auto-dock once the aiti-float present state machine is live, so the block
 *     shows up like the built-in Tasks block (present, collapsed by default).
 *     A user ⋮-close is recorded (dismissed) and the auto-dock respects it after
 *     refresh — re-open goes through the toolbar gauge button (explicit present).
 *     ui.clientImmediately=true makes this bundle eager precisely for this — a
 *     lazy dock-only extension would have no first-entry point at all.
 *
 * Build: node tools/build-client.mjs   Deploy: node tools/deploy.mjs
 */
import { __setCtx } from "./host-shim";
import {
  declareDockZones, sidebarZoneOf, seedDockDefault, seedBlockCollapsedDefault,
  present, readBlockDismissed, FLOAT_INSTALLED_EVENT,
} from "../../../_shared/ext-float-dock";
import { SysmonDockFace, SY_KEY, gaugeIconUrl } from "./sysmon-app";
import { TopChips, sysmonTooltipLine } from "./topchips";

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
  // Dismissed guard (2026-11-21, "closed stays closed"): a user ⋮-close is
  // recorded by the present state machine (pi:sidebar-dock:dismissed:*); the
  // restorative auto-dock must NOT resurrect the block after refresh. Re-opening
  // goes through the toolbar gauge button (explicit non-auto present, which also
  // clears the record).
  let docked = false;
  const dockNow = () => {
    if (docked || readBlockDismissed(SY_KEY)) return;
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

  // Toolbar gauge button — the re-open entry after a user ⋮-close (dismissed
  // blocks skip the restorative auto-dock above, so an explicit open path is
  // required; same shape as aiti-ai-schedule's clock button). Explicit non-auto
  // present also clears the dismissed record (state-machine contract).
  const openPanel = () => {
    try { present(SY_KEY, `dock:${sidebarZoneOf(SY_KEY)}`); } catch { /* ignore */ }
  };
  ctx.registerItems?.("toolbar", [{
    id: "aiti-sysmon-open",
    meta: {
      label: "i18n:sy.toolbar.label",
      title: "i18n:sy.toolbar.title",
      // ExtItemIcon contract: {svg} / emoji / ".svg" asset path — {url} is NOT
      // supported by the toolbar button renderer (silent no-icon/no-render).
      icon: "icons/gauge.svg",
      onClick: openPanel,
      // Pin into the always-visible cluster: without an order the button sorts by
      // manifest (alphabetical) order and lands deep in the ⋯ More overflow on
      // narrower windows — unreachable for the primary re-open entry.
      order: 1,
    },
  }]);

  // Session-info stats-button trailing chips (same item id "chips" as the
  // manifest static slot; narrow-tier gating + feature toggle live in TopChips).
  // meta.tooltip contributes the system line to the host button's own tooltip
  // (contract in lib/ext-ui-store.ts): ` CPU 8% · MEM 87% · 49.9 / 58.6 GB · swap …`
  // meta.order 10: pinned ahead of the provider-usage quota chip (order 20) so
  // the tail reads CPU/MEM first, quota last.
  ctx.registerItems?.("sessionStatsInline", [{
    id: "chips",
    render: TopChips,
    meta: { label: "i18n:sy.chips.label", tooltip: sysmonTooltipLine, order: 10 },
  }]);

  try { console.log("[aiti-sysmon] client mounted (sidebar dock panel, auto-docked)"); } catch { /* noop */ }
}
