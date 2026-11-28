/**
 * aiti-codehub client entry.
 *
 * Registers two independent dockable surfaces (work items / repositories), their
 * floating dialogs, the shared settings dialog, the workspace-hub clone source and
 * cross-extension services.
 */
import { __setCtx, extSvc, regSvc, t } from "./host-shim";
import { closePanel, createDockFaces, openFloat, present, presentState, sidebarZoneOf, useGate } from "../../../_shared/ext-float-dock";
import { WorkItemsPanel } from "./workitems";
import { CodePanel } from "./code";
import { WorkItemDetailFace, openWorkItem } from "./detail";
import { WorkItemPickFace, pickWorkItem } from "./workitem-picker";
import { SettingsPanel } from "./settings";
import { MRFace } from "./mr";
import { CloneFace, openClone } from "./clone";
import { HubSource } from "./hub-source";
import { RepoWorkspaceContent, openRepoWorkspace } from "./repo-workspace";
import { ensureReadOnlyEditor } from "./editor-provider";
import { registerCommitAction } from "./commit-action";
import { FloatShell, ICONS, toast } from "./ui";
import { CODE_KEY, EXT, HUB_SOURCE_ID, PICK_DIALOG_ID, REPO_KEY, SETTINGS_KEY, WORKITEMS_KEY } from "./keys";

function SettingsFace() {
  const gate = useGate(SETTINGS_KEY, "float");
  if (!gate) return null;
  return (
    <FloatShell title={t("ch.dlg.settings")} width={860} height={680} onClose={() => closePanel(SETTINGS_KEY)}>
      <SettingsPanel />
    </FloatShell>
  );
}

function openSettings(): void {
  openFloat(SETTINGS_KEY);
}

/** Work items open as a floating dialog by default; docked state is respected. */
function openWork(): void {
  const st = presentState(WORKITEMS_KEY);
  if (st === "closed" || st === "floating") present(WORKITEMS_KEY, "float");
  else openFloat(WORKITEMS_KEY);
}

function openHub(): void {
  const svc = extSvc<{ open?: () => void }>("aiti-quickstart.open");
  if (svc?.open) {
    svc.open();
    return;
  }
  toast(t("ch.appcmd.quickstartMissing"));
}

/** Host locale-switch event; client-registered slot metas hold evaluated strings,
 * so the catalog (commands etc.) is disposed and re-registered on a switch. */
const LOCALE_CHANGED_EVENT = "pi-web:locale-changed";

export default function register(ctx: Record<string, any>) {
  __setCtx(ctx);

  // Two independent dockable surfaces (default right panel; can move left or float).
  const workfaces = createDockFaces({
    key: WORKITEMS_KEY,
    title: t("ch.dock.workitems"),
    icon: "icons/workitems.svg",
    // Default = floating dialog; the user can dock it to the right/left via the
    // float header's position menu. Do not seed a dock default.
    zones: ["right-panel", sidebarZoneOf(WORKITEMS_KEY)],
    w: 900,
    hh: 680,
    floatAttrs: { "data-ext-float-full": "1" },
    renderContent: () => <WorkItemsPanel />,
  });
  const repofaces = createDockFaces({
    key: REPO_KEY,
    title: t("ch.dock.repo"),
    icon: "icons/repo.svg",
    zones: ["right-panel", sidebarZoneOf(REPO_KEY)],
    w: 1100,
    hh: 760,
    floatAttrs: { "data-ext-float-full": "1" },
    renderContent: () => <RepoWorkspaceContent />,
  });
  const codefaces = createDockFaces({
    key: CODE_KEY,
    title: t("ch.dock.code"),
    icon: "icons/repo.svg",
    zones: ["right-panel", sidebarZoneOf(CODE_KEY)],
    defaultZone: "right-panel",
    w: 860,
    hh: 640,
    floatAttrs: { "data-ext-float-full": "1" },
    renderContent: () => <CodePanel />,
  });

  ctx.registerItems?.("rightFileDock", [...workfaces.rightFileDock, ...codefaces.rightFileDock, ...repofaces.rightFileDock]);
  ctx.registerItems?.("sidebarExplorerDock", [...workfaces.sidebarExplorerDock, ...codefaces.sidebarExplorerDock, ...repofaces.sidebarExplorerDock]);

  ctx.registerItems?.("dialogs", [
    ...workfaces.dialogsItems,
    ...codefaces.dialogsItems,
    ...repofaces.dialogsItems,
    { id: "workitem-detail", render: WorkItemDetailFace, meta: { label: t("ch.dlg.detail") } },
    { id: PICK_DIALOG_ID, render: WorkItemPickFace, meta: { label: t("ch.dlg.pick") } },
    { id: "settings", render: SettingsFace, meta: { label: t("ch.dlg.settings") } },
    { id: "mr", render: MRFace, meta: { label: t("ch.dlg.mr") } },
    { id: "clone", render: CloneFace, meta: { label: t("ch.dlg.clone") } },
  ]);

  // Toolbar entry (manifest static item takes over once materialized).
  ctx.registerItems?.("toolbar", [{
    id: "open-workitems",
    meta: {
      // Merge with the dock work-items card: same (extId,label) as ch.dock.workitems, so the
      // app-center keeps one card before and after lazy materialization (was "CodeHub").
      label: t("ch.dock.workitems"),
      title: t("ch.toolbar.title"),
      icon: "icons/workitems.svg",
      onClick: () => openWork(),
    },
  }, {
    id: "open-code",
    meta: {
      label: t("ch.toolbar.code"),
      title: t("ch.toolbar.codeTitle"),
      icon: "icons/repo.svg",
      onClick: () => openFloat(CODE_KEY),
    },
  }]);

  // Command catalog (app center + input command hints). Re-registered on locale
  // switches (labels are evaluated strings; host disposeItems takes local ids).
  const registerCommands = () => {
    ctx.registerItems?.("commands", [
      {
        id: "search-workitems",
        meta: {
          label: t("ch.appcmd.search"),
          icon: { svg: ICONS.list },
          onClick: () => openWork(),
        },
      },
      {
        id: "browse-code",
        meta: {
          label: t("ch.appcmd.browse"),
          icon: { svg: ICONS.branch },
          onClick: () => openFloat(CODE_KEY),
        },
      },
      {
        id: "clone-repo",
        meta: {
          label: t("ch.appcmd.clone"),
          icon: { svg: ICONS.folder },
          onClick: () => openHub(),
        },
      },
      {
        id: "open-settings",
        meta: {
          label: t("ch.appcmd.settings"),
          icon: { svg: ICONS.gear },
          onClick: () => openSettings(),
        },
      },
    ]);
  };
  registerCommands();
  try {
    window.addEventListener(LOCALE_CHANGED_EVENT, registerCommands);
  } catch { /* non-browser (tests) */ }

  // Workspace-hub clone source (consumed by aiti-quickstart since 2026-11-26).
  try {
    ctx.registerTopicItem?.("workspace-hub.source", {
      id: HUB_SOURCE_ID,
      label: t("ch.appcmd.hubSource"),
      icon: "icons/repo.svg",
      order: 40,
      render: HubSource,
    });
  } catch { /* old host without a topic registry */ }

  // Cross-extension services (DI): open a surface / open the clone dialog.
  regSvc("aiti-codehub.open", {
    open: (surface?: "workitems" | "code") => (surface === "code" ? openFloat(CODE_KEY) : openWork()),
  });
  regSvc("aiti-codehub.settings", { open: () => openSettings() });
  regSvc("aiti-codehub.clone", {
    open: (target: { provider: string; repo: any }) => {
      if (!target?.repo) {
        openHub();
        return;
      }
      openClone({ provider: target.provider, repo: target.repo });
    },
  });
  // Work-item picker (consumed by aiti-folder's commit / group-commit dialogs:
  // open() → Promise<PickResult | null>, text formatted with the paste template).
  regSvc("aiti-codehub.pickWorkItem", { open: () => pickWorkItem() });
  // Register the "Work item" button into aiti-folder's commit-dialog action row.
  registerCommitAction();

  try { console.log("[aiti-codehub] client mounted"); } catch { /* ignore */ }
}

// Register the read-only Monaco provider for remote copies (lazy editor is fine).
void ensureReadOnlyEditor();
