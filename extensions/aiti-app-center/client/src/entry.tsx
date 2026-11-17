/**
 * aiti-app-center · client 入口。
 *
 * 注册跨扩展客户端服务 `aiti-app-center.api`（{ renderAppCenter }）——session-manager
 * 编排器消费后作 DockStack filler 渲染进全折叠空白（docs/aiti-app-center-plan.md §2.3）。
 * 服务是本扩展唯一出口：无 UI 插槽条目、无浮窗、无区块。
 */
import { __setCtx, regSvc } from "./host-shim";
import { createAppCenterApi } from "./app-center";
import { registerCommandsService } from "./commands";

export default function register(ctx: Record<string, unknown>): () => void {
  __setCtx(ctx);
  const dispose = regSvc("aiti-app-center.api", createAppCenterApi(ctx));
  // 应用命令提示查询服务（aiti-ai-input suggest kind="app" 数据源）+ manifest 后台预热
  const disposeCmd = registerCommandsService();
  return () => {
    try { dispose?.(); } catch { /* ignore */ }
    try { disposeCmd?.(); } catch { /* ignore */ }
  };
}
