/**
 * aiti-proc-tree · client entry (JSX + TypeScript, vite lib build).
 *
 * register(ctx) wiring:
 *   - sidebar dock face (item id "panel"), auto-docked like the Tasks block;
 *   - toolbar button (re-open after a user close);
 *   - pages slot floating panel (data-ext-float contract).
 *
 * Build: node tools/build-client.mjs   Deploy: node tools/deploy.mjs
 */
import { __setCtx } from "./host-shim";
import {
  present, presentState, sidebarZoneOf, seedDockDefault, seedBlockCollapsedDefault,
  declareDockZones, readBlockDismissed, FLOAT_INSTALLED_EVENT,
} from "../../../_shared/ext-float-dock";
import { ProcTreeDockFace, ProcTreePage, PT_KEY, ptIconUrl } from "./app";

const DOCK_STACK_SERVICE = "aiti-float.dockstack";

function initDock() {
  const zone = sidebarZoneOf(PT_KEY);
  declareDockZones(PT_KEY, [zone], zone);
  seedDockDefault(PT_KEY, zone);
  seedBlockCollapsedDefault(PT_KEY, true);
}

export default function register(ctx: Record<string, any>) {
  __setCtx(ctx);
  initDock();

  // Restore-default-presence dock: once per mount, after the aiti-float state
  // machine is live. A user ⋮-close is remembered (dismissed) and respected.
  let docked = false;
  const dockNow = () => {
    if (docked || readBlockDismissed(PT_KEY)) return;
    docked = true;
    try { present(PT_KEY, `dock:${sidebarZoneOf(PT_KEY)}`, { auto: true }); } catch { /* ignore */ }
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
    render: ProcTreeDockFace,
    meta: { title: "i18n:pt.panel.label", icon: { url: ptIconUrl() }, priority: 5 },
  }]);

  // Floating panel (990x640, draggable/resizable by aiti-float; fullscreen on small screens).
  ctx.registerItems?.("pages", [{
    id: "aiti-proc-tree-page",
    render: ProcTreePage,
    meta: { label: "i18n:pt.panel.label" },
  }]);

  // Toolbar entry: explicit open (also clears the dismissed record).
  const openPanel = () => {
    try { present(PT_KEY, "float"); } catch { /* ignore */ }
  };
  ctx.registerItems?.("toolbar", [{
    id: "aiti-proc-tree-open",
    meta: {
      label: "i18n:pt.toolbar.label",
      title: "i18n:pt.toolbar.title",
      // ExtItemIcon contract: asset path string (no {url} for toolbar buttons).
      icon: "icons/process-tree.svg",
      onClick: openPanel,
      order: 2,
    },
  }]);

  // Kept for programmatic open (app center / other extensions may call it).
  if (typeof ctx.registerExtService === "function") {
    try { ctx.registerExtService("aiti-proc-tree.open", openPanel); } catch { /* old host */ }
  }

  try { console.log("[aiti-proc-tree] client mounted (dock + floating panel)"); } catch { /* noop */ }
}
