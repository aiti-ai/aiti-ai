/**
 * Registers the "Work item" action into aiti-folder's commit dialog through the
 * `aiti-folder.commit-actions` slot: the button opens the pick dialog and
 * prepends the formatted header to the commit message (idempotent). Soft
 * dependency — materializes aiti-folder once if the slot is not there yet, and
 * stays silent (no button) when the slot is genuinely absent.
 */
import { ensureMaterialized, extSvc, t } from "./host-shim";
import { pickWorkItem } from "./workitem-picker";
import { prependHeader } from "./pick-header";

interface CommitActionCtx {
  root: string;
  getMessage: () => string;
  setMessage: (updater: (m: string) => string) => void;
  getFiles: () => string[];
}

interface CommitActionsService {
  register?: (r: {
    id: string;
    order?: number;
    factory: (ctx: CommitActionCtx) => { label: string; title?: string; onClick: (ctx: CommitActionCtx) => void | Promise<void> } | null;
  }) => (() => void) | void;
}

export function registerCommitAction(): void {
  void (async () => {
    let svc = extSvc<CommitActionsService>("aiti-folder.commit-actions");
    if (!svc?.register) {
      try { await ensureMaterialized("aiti-folder"); } catch { /* absent */ }
      svc = extSvc<CommitActionsService>("aiti-folder.commit-actions");
    }
    if (!svc?.register) return;
    svc.register({
      id: "aiti-codehub.work-item",
      order: 90,
      factory: () => ({
        label: t("ch.commitAction.workItem"),
        title: t("ch.commitAction.workItemTitle"),
        onClick: async (ctx: CommitActionCtx) => {
          const r = await pickWorkItem();
          const header = String(r?.text || "").trim();
          if (header) ctx.setMessage((m: string) => prependHeader(header, m, "\n\n"));
        },
      }),
    });
  })();
}
