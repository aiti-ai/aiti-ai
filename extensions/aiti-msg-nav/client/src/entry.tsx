/**
 * aiti-msg-nav · 消息滚动导航 client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx) 把导航条注册进 chatOverlay 插槽（core 在消息区覆盖层渲染该插槽；
 * 插槽挂载点自带 position:relative 上下文，工具条 absolute 定位即可对齐消息列右缘）。
 * 插槽 extra 透传 agentRunning/isMobile —— 组件 props 里接。
 */
import { __setCtx } from "./host-shim";
import { ScrollNavToolbar } from "./msg-nav-toolbar";

export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);

  ctx.registerItems?.("chatOverlay", [{
    id: "msg-nav-toolbar",
    render: (props: Record<string, unknown>) => (
      <ScrollNavToolbar
        agentRunning={props.agentRunning === true}
        isMobile={props.isMobile === true}
        revealHistory={typeof props.revealHistory === "function" ? props.revealHistory as () => void : undefined}
        sessionId={(props.currentSession as { id?: string } | null)?.id}
      />
    ),
  }]);
}