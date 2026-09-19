/**
 * host-ui-contract —— 宿主能力客户端服务契约（slot extra 回调解耦方案，2026-09-16）。
 *
 * 宿主（AppShell/ChatInput）经 registerExtClientService 注册两个只读服务，向全部扩展
 * 开放「引用稳定」的宿主能力（回调/ref/工厂）；扩展消费链 = 插槽 rp 优先 → 服务兜底
 * （范式参考 aiti-folder resolveHostFace）。
 *
 * 红线：服务只放引用稳定成员（useCallback 回调 / ref / 组件工厂）。随渲染变化的
 * **数据**（sessionId/cwd/isStreaming/inputValue/context…）必须走插槽 extra props——
 * 服务 get 是命令式快照，数据走服务会造成「冻结值」bug。
 */

/** "pi-web.ui" —— AppShell 侧宿主能力（与 sidebarContent extra 同集 + onLineMention）。 */
export const HOST_UI_SERVICE = { provider: "pi-web", name: "pi-web.ui" } as const;

/** "pi-web.composer" —— ChatInput 侧 composer 能力（回调/ref 集，无数据）。 */
export const HOST_COMPOSER_SERVICE = { provider: "pi-web", name: "pi-web.composer" } as const;

/** HOST_UI_SERVICE 字段分类（契约文档；运行时以 hostUiRef 实集为准）。 */
export const HOST_UI_FIELDS = {
  /** 回调：文件查看器 行引用插入（@ file:line；宿主 TabBodyCtx.onLineMention 同源）。 */
  onLineMention: "callback",
  /** 回调：收回全部顶栏下拉面板（会话信息/工具/分支…，setActiveTopPanel(null)）——
   *  顶栏面板内的扩展条目调起别的全屏表面前调用，避免小屏旧面板盖住新表面。 */
  closeTopPanels: "callback",
  /** 回调：其余导航/提及回调与 sidebarContent extra 同集（onSelectSession/onOpenFile/onAtMention…，分类见 AppShell sidebarContentExtra）。 */
  sidebarContentExtra: "callback-or-factory",
} as const;

/** HOST_COMPOSER_SERVICE 字段清单（全部引用稳定；ChatInput composerUiRef 实集）。 */
export const HOST_COMPOSER_FIELDS = [
  /** 回调：受控写输入框文本（ChatInput setInputValue）。 */
  "setInputValue",
  /** 回调：聚焦输入框（refocusInput）。 */
  "focusComposer",
  /** ref：输入框 textarea（RefObject<HTMLTextAreaElement>）。 */
  "textareaRef",
  /** 回调：打开会话统计面板（小屏附带收起 InfoSheet）。 */
  "openSessionInfo",
  /** 回调集：队列面板 actions 原语（与 queuePanel extra.actions 同集）。 */
  "queueActions",
] as const;
