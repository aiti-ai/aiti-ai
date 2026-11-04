/**
 * entry.tsx —— aiti-session-cards 扩展客户端入口（agent 能力 UI 去核化 P1，
 * 方案 docs/pi-web-agent-capability-ui-ext-plan.md §3.1）。
 *
 * 注册 sessionRequestCard 插槽（会话请求卡接管缝）：
 *   - interaction  交互元语五形态（zcode 方案审批/AskUser/CC 族工具授权/omp OAuth/自由兜底）
 *   - permission   工具授权卡（cursor/claude 等后端 permission_request）
 * 宿主按 request.kind + meta.backend 路由到唯一 item，未命中落 core 极简兜底卡。
 *
 * 构建 vite lib mode → dist/aiti-session-cards.mjs。
 */
import { __setCtx } from "./host-shim";
import InteractionRequestCard from "./InteractionRequestCard";
import PermissionCard from "./PermissionCard";

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx);
  const applyFeature = () => {
    const features = (ctx.getFeatures as (() => Record<string, boolean | string>) | undefined)?.() ?? {};
    const enabled = features["sessionCards.enabled"] !== false;
    // 先退旧注册再订新（feature 切换/热重载幂等；aii-recovery 同款）
    ctx.disposeItems?.("sessionRequestCard", ["interaction", "permission"]);
    if (enabled) {
      // registerItems 在旧宿主（无此插槽）上可能 throw → 包一层降级不抛（aiti-ctx-meter safeRegister 同款）
      try {
        ctx.registerItems?.("sessionRequestCard", [
          {
            id: "interaction",
            render: (p: Record<string, unknown>) => <InteractionRequestCard {...(p as never)} />,
            meta: {
              kinds: ["interaction:plan_approval", "interaction:ask_user", "interaction:tool_auth", "interaction:open_url", "interaction:generic"],
              priority: 0,
            },
          },
          {
            id: "permission",
            render: (p: Record<string, unknown>) => <PermissionCard {...(p as never)} />,
            meta: { kinds: ["permission"], priority: 0 },
          },
        ]);
      } catch (e) {
        console.warn("[aiti-session-cards] registerItems 失败（宿主过旧，core 兜底卡接管）:", (e as Error)?.message ?? e);
      }
    }
  };
  applyFeature();
  ctx.onFeatureChange?.(applyFeature);
}
