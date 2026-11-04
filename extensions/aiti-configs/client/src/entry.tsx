/**
 * aiti-configs · client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx) 装配：
 *   - toolbar 🛡 按钮（触发全局打开）
 *   - pages slot 常驻 dialog（安全盾：状态/历史/自检/配置）
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 * 部署：node tools/deploy.mjs         （自动先构建再拷贝）
 */
import { __setCtx } from "./host-shim";
import { ConfigsButton, ConfigsDialog } from "./configs-app";

export default function register(ctx: Record<string, unknown>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);

  // 懒加载 v2 两段式：声明式条目（无 render）
  ctx.registerItems?.("toolbar", [{
    id: "aiti-configs-open",
    meta: {
      label: "配置",
      title: "aiti-configs：配置版本化 + 自检",
      icon: "icons/shield.svg",
      onClick: () => { try { window.__aitiConfigsOpen && window.__aitiConfigsOpen(); } catch { /* noop */ } },
    },
  }]);
  ctx.registerItems?.("pages", [{ id: "aiti-configs-dialog", render: ConfigsDialog }]);
  try { console.log("[aiti-configs] client 安全盾已挂载（toolbar 触发 → pages 渲染，状态/历史/自检/配置）"); } catch {}
}
