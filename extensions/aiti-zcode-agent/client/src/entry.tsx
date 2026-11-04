/**
 * entry.tsx —— aiti-zcode-agent 扩展客户端入口（agent 能力 UI 去核化 P1）。
 *
 * 注册 sessionRequestCard 插槽：provider_headers 验证码卡（kind="provider_headers"、
 * backend="zcode"——只有 zcode 后端的验证码请求由本扩展认领渲染；「agent 扩展自带专属
 * 能力 UI」样板件，方案 docs/pi-web-agent-capability-ui-ext-plan.md §3.2）。
 *
 * 构建 vite lib mode → dist/aiti-zcode-cards.mjs。
 */
import { __setCtx } from "./host-shim";
import CaptchaRequestCard from "./CaptchaRequestCard";

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx);
  // 旧宿主（无 sessionRequestCard 插槽）→ registerItems 可能 throw → 降级不抛（core 兜底卡接管）
  try {
    ctx.registerItems?.("sessionRequestCard", [
      {
        id: "provider-headers",
        render: (p: Record<string, unknown>) => <CaptchaRequestCard {...(p as never)} />,
        meta: { kinds: ["provider_headers"], backend: "zcode", priority: 10 },
      },
    ]);
  } catch (e) {
    console.warn("[aiti-zcode-agent] registerItems 失败（宿主过旧，core 兜底卡接管）:", (e as Error)?.message ?? e);
  }
}
