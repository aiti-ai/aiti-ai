/**
 * aiti-agent-badge client entry.
 *
 * Registers one composerTools item; the host renders the same slot under the
 * desktop input and in the mobile + sheet, so one registration covers both.
 */
import { __setCtx } from "./host-shim";
import { AgentBadge } from "./agent-badge";

export default function register(ctx: Record<string, any>) {
  __setCtx(ctx);

  const apply = () => {
    const features = (ctx.getFeatures as (() => Record<string, boolean | string>) | undefined)?.() ?? {};
    const enabled = features["badge.show"] !== false;
    ctx.disposeItems?.("composerTools", ["agent-badge"]);
    if (enabled) {
      ctx.registerItems?.("composerTools", [{ id: "agent-badge", render: AgentBadge }]);
    }
  };

  apply();
  const off = ctx.onFeatureChange?.(apply);

  return () => {
    try { off?.(); } catch { /* already disposed */ }
    ctx.disposeItems?.("composerTools", ["agent-badge"]);
  };
}
