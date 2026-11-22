/**
 * aiti-feedback · client entry.
 *
 * register(ctx) wires:
 *   - toolbar button ("Report an issue") → opens the compose dialog
 *   - dialogs slot: the compose dialog (module-level state controls visibility)
 *
 * Build: node tools/build-client.mjs   Deploy: node tools/deploy.mjs
 */
import { __setCtx } from "./host-shim";
import { FeedbackDialog, openFeedback } from "./feedback-app";

export default function register(ctx: Record<string, any>) {
  __setCtx(ctx);
  ctx.registerItems("toolbar", [{
    id: "aiti-feedback-open",
    meta: {
      label: "i18n:fb.open.label",
      title: "i18n:fb.open.title",
      icon: "icons/message-circle.svg",
      onClick: () => openFeedback(),
    },
  }]);
  ctx.registerItems("dialogs", [{ id: "aiti-feedback-dialog", render: FeedbackDialog }]);
}
