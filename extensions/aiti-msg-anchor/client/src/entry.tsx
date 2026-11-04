/**
 * aiti-msg-anchor · 消息锚点横幅 client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx) 把横幅注册进 chatOverlay 插槽（core 在消息区覆盖层渲染该插槽；
 * 插槽挂载点自带 position:relative 上下文，横幅 absolute 定位钉在消息列顶部）。
 * 插槽 extra 透传 agentRunning/isMobile；currentSession 由 ChatWindow 透传
 * （name = 会话标题，title 模式用）。
 */
import { __setCtx } from "./host-shim";
import { MsgAnchorBanner } from "./msg-anchor-banner";

export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);

  ctx.registerItems?.("chatOverlay", [{
    id: "msg-anchor-banner",
    render: (props: Record<string, unknown>) => (
      <MsgAnchorBanner
        currentSession={(props as { currentSession?: { id: string; cwd: string; name?: string } | null }).currentSession ?? null}
        isMobile={props.isMobile === true}
      />
    ),
  }]);
}
