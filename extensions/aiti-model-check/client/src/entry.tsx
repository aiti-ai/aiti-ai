/**
 * aiti-model-check · client 入口（JSX + TypeScript + vite 构建）。
 *
 * register(ctx) 装配：
 *   - pages slot 常驻 dialog（状态/余额/历史；meta.open 供 extman 直接打开）
 *   - toolbar 📡 按钮（feature 门控：behavior.showToolbar，默认关，动态注册/注销）
 *   - window.__aitiModelCheckApp = App（aiti-model-wizard「检查」tab 内嵌渲染）
 *
 * 构建：node tools/build-client.mjs   （或 npm run build:client）
 * 部署：node tools/deploy.mjs         （自动先构建再拷贝）
 */
import { __setCtx } from "./host-shim";
import { declareDockZones, sidebarZoneOf } from "../../../_shared/ext-float-dock";
import { App, ModelDialog, ModelCheckDockFace, ModelCheckDockRight, setMcCtx, syncToolbar, initRecoverWatcher, MC_KEY } from "./model-check-app";

export default function register(ctx: Record<string, any>) {
  // 重要：必须在任何 JSX 组件渲染前调用（host-shim 模块级持 ctx）
  __setCtx(ctx);
  setMcCtx(ctx);

  ctx.registerItems?.("pages", [{ id: "aiti-model-check-dialog", render: ModelDialog, meta: { open: () => { try { window.__aitiModelCheckOpen && window.__aitiModelCheckOpen(); } catch {} } } }]);
  // zones 全集注册（v3.1）：TabBar ⇱ 菜单在 face 未挂载时的数据源；zone 用规范值 sidebar:<key>
  declareDockZones(MC_KEY, [sidebarZoneOf(MC_KEY), "right-panel"], sidebarZoneOf(MC_KEY));
  ctx.registerItems?.("rightFileDock", [{ id: "panel", render: ModelCheckDockRight, meta: { title: "模型可用性" } }]);
  // aiti-float dock v3（P3 批）：左栏可选（保守无 default）
  ctx.registerItems?.("sidebarExplorerDock", [{ id: "panel", render: ModelCheckDockFace, meta: { title: "模型检查", priority: 3 } }]);
  syncToolbar();
  if (typeof ctx.onFeatureChange === "function") ctx.onFeatureChange(syncToolbar);
  // 限流到期提醒（recover）：页面级监听 mc:recover → 浏览器通知（面板不在前台/未打开也能收）
  // 注：依赖 index.ts ui.clientImmediately=true（页面加载即加载本 bundle，不依赖面板物化）
  try { initRecoverWatcher(); } catch { /* noop */ }
  // 导出 App 供其它扩展嵌入渲染（aiti-model-wizard「检查」tab 同窗口内嵌；同一宿主 React）
  try { window.__aitiModelCheckApp = App; } catch {}
  // DI 方案 P2：内嵌 App 组件导出（services 双轨；组件值同样是合法服务 impl）
  try { ctx.registerExtService?.("aiti-model-check.app", App); } catch {}
  try { console.log("[aiti-model-check] client 已挂载（toolbar 📡 → pages 面板 + window.__aitiModelCheckApp 内嵌导出）"); } catch {}
}
