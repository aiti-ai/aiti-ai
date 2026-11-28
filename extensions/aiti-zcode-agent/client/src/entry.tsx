/**
 * entry.tsx — aiti-zcode-agent extension client entry (agent capability UI de-core P1).
 *
 * Registers the sessionRequestCard slot: the provider_headers captcha card (kind="provider_headers",
 * backend="zcode" — only captcha requests from zcode backends are claimed by this extension; the
 * "extension-owned capability UI" exemplar, plan docs/pi-web-agent-capability-ui-ext-plan.md §3.2).
 *
 * Build: vite lib mode → dist/aiti-zcode-cards.mjs.
 */
import { __setCtx } from "./host-shim";
import CaptchaRequestCard from "./CaptchaRequestCard";

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx);
  // Legacy host (no sessionRequestCard slot) → registerItems may throw → degrade without throwing (core fallback card takes over)
  try {
    ctx.registerItems?.("sessionRequestCard", [
      {
        id: "provider-headers",
        render: (p: Record<string, unknown>) => <CaptchaRequestCard {...(p as never)} />,
        meta: { kinds: ["provider_headers"], backend: "zcode", priority: 10 },
      },
    ]);
  } catch (e) {
    console.warn("[aiti-zcode-agent] registerItems failed (host too old; core fallback card takes over):", (e as Error)?.message ?? e);
  }
}
