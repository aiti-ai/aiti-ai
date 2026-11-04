/**
 * aiti-float —— 扩展弹窗「可拖拽 + 可缩放」自动增强（全局 UI 契约承载扩展）。
 *
 * 目标：扩展开发者给弹窗**面板根节点**加一个属性，自动获得 AI 窗/ai-helper 窗同款
 * 的拖拽移动 + 缩放能力，零逻辑零状态。本扩展是纯 client 扩展（无 server、无 UI 插槽）：
 * register 时安装 DOM 级增强器（MutationObserver 扫描，不侵入 React——同 aiti-helper
 * 全局弹窗 AI 按钮的模式）。
 *
 * ── 接入方用法（全部可选，最小只需一行）──────────────────────────────
 *   <div data-ext-float="1" ...>        ← 弹窗面板根节点（不是全屏遮罩层！）
 *     <div>标题栏…</div>                 ← 默认拖拽把手 = 面板第一个子元素
 *     <div style={{overflowY:"auto",minHeight:0}}>内容…</div>
 *   </div>
 *
 * 属性：
 *   data-ext-float          "1"（缺省 = 移动 + 缩放）| "drag"（仅移动）| "resize"（仅缩放）
 *   data-ext-float-drag     标在面板内某个子元素上 = 指定拖拽把手（缺省 = 第一个子元素）
 *   data-ext-float-w / -h   初始尺寸 px（缺省 = 增强时面板实际尺寸）
 *   data-ext-float-min-w / -min-h  最小尺寸（缺省 320×200）
 *   data-ext-float-key      持久化键（缺省按框架标注的 data-ext-item 反查，如 "ext:dialog"）
 *   data-ext-float-keepmask 豁免遮罩自动去除（"1" = 保留半透明遮罩与点外关闭，真模态确认框用）。
 *                           缺省行为：增强面板时自动把祖先链上的半透明全屏遮罩层（rgba 半透明
 *                           + 覆盖视口）变透明 + 点击穿透——浮窗不再挡消息区操作。不透明整页
 *                           宿主层不受影响。
 *   data-ext-float-full     小屏全屏："small" 或 "1" —— 小屏（≤640px 宽，与
 *                           aiti-configs/aiti-ai-usage 同款断点）下不浮窗，面板铺满视口（拖拽/
 *                           缩放/持久化全停，圆角归 0）；跨回大屏自动恢复浮窗与已存位置。
 *                           接入方只需加这一个标记，无需自己 matchMedia（仓内所有弹窗均已
 *                           迁移到本标记，新弹窗照做即可）。
 *
 * 全局 API（程序化控制；最大化按钮 v0.4.0 起由 float 自动注入，扩展零代码）：
 *   window.__piweFloat.toggleMax(panelEl) → boolean   切换最大化，返回切换后状态
 *   window.__piweFloat.setMax(panelEl, v) / .isMax(panelEl) / .isFull(panelEl)
 *   最大化时同样铺满视口 + 停手势/持久化；退出恢复浮窗。若小屏全屏仍激活则保持全屏。
 *
 * 小屏系统返回关闭浮窗（v0.5.0）：小屏（≤640px）上面板打开时，系统返回（Android 返回键 /
 * iOS 侧滑）优先关闭面板（= 点它自己的 ✕），不直退页面。由本扩展统一消费宿主退栈服务
 * `pi-web.overlayBack`（历史唯一写入口在宿主 lib/overlay-back.ts），接入方零代码；无 ✕ 的
 * 面板不注册。旧宿主/桌面自动降级，返回语义不变。方案：docs/pi-web-mobile-back-dismiss-plan.md。
 *
 * 自动注入最大化按钮：增强时往标题栏塞 ⛶/❐（插在最后一个交互元素=通常 ✕ 之前），
 * 点击切换并同步图标；小屏全屏态自动隐藏；data-ext-float-max="0" 豁免。
 * 不要再自备 toggleMax 按钮（extman/ai-usage/ai-schedule/subagents 已迁移）。
 *
 * 自动获得：拖拽移动（鼠标/触屏，交互元素上按下不触发）/ 右下左缘+右下角缩放 /
 * 位置尺寸 localStorage 持久化 / 点按置前（连带遮罩层）/ 视口夹紧 / 双击把手复位。
 *
 * 契约文档：pi-work docs/aiti-web-ext-float-dialogs.md。
 * 参考实现：aiti-ui-env 弹窗、demo（双写法）、templates/ext-jsx-client。
 *
 * AI 自管理：skills/float-dialog-adapter —— 帮 AI 把扩展弹窗接入本契约
 * （属性表/最大化 API/检查清单）。
 *
 * 注意：声明 data-ext-float 的面板，left/top/width/height 归本扩展管（!important 写入，
 * 防 React 重渲染冲掉）；未安装/禁用本扩展时面板回退普通居中弹窗（自身 style 兜底）。
 * 已有自绘拖拽逻辑的弹窗（如 ai-helper 的避让定位）不要接入，两套手势会打架。
 */
export default {
  id: "aiti-float",
  name: "弹窗浮动增强",
  version: "0.5.0",
  icon: "icon.svg",
  client: "dist/aiti-float-client.mjs",

  // 能力提供（依赖与能力模型）：DockStack 左栏区块栈容器（sidebar 统一 dock 方案 §3.8）。
  // session-manager dependsOn 本能力（hard）——extman 据此阻止 aiti-float 被单独禁用。
  provides: ["aiti-float.dockstack"],

  // AI 自管理清单：AI 能帮扩展弹窗接入本契约（属性表/最大化 API/检查清单）
  ai: {
    manage: true,
    intro: "AI 能帮我把扩展弹窗接入浮动契约（拖拽/缩放/小屏全屏/手动最大化）",
    skills: "skills",
  },
};
