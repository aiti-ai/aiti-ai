/**
 * aiti-quickstart —— 快速上手（空白态引导扩展）。
 *
 * 纯 client 扩展，覆盖 pi-web 两个「完全空白」面：
 *   1) 新建会话欢迎页：newSessionWidgets 插槽 3 枚 widget（上手步骤 / 快捷操作 /
 *      示例提示词）——宿主网格布局 + ⚙ 自定义面板统一管理，本扩展只出内容；
 *   2) 左栏 DockStack 全折叠空白：引导卡经 client 服务 `aiti-quickstart.api`
 *      交付 session-manager 编排器（可选消费），与 aiti-app-center 同屏共存
 *      （引导卡在上、应用抽屉在下；✕ 关闭持久化，关闭后回退现状）。
 *
 * 常用「重返」入口：manifest sidebarFooter 静态条目 → 宿主底部行标准按钮 +
 * 应用中心自动收编为可钉住卡片（静态条目物化转发）；物化后同 id 注册条目接管
 * （render 按钮 + onClick → pi-web.newSession.setCwd 落空白欢迎页）。
 *
 * 消费方 session-manager（optionalDependsOn）；方案：aiti-ai docs（quickstart 引导方案）。
 */
export default {
  id: "aiti-quickstart",
  name: "快速上手",
  version: "0.1.0",
  icon: "icons/rocket.svg",
  client: "dist/aiti-quickstart-client.mjs",

  // 应用中心分类：会话与项目（分类解析链第一优先级，无需 APP_OVERRIDES 兜底）
  category: "session",

  ui: {
    clientImmediately: false, // 懒扩展：静态条目（footer/欢迎页）+ session-manager ensureMaterialized 双物化路径
    // 静态条目（懒加载 v2）：物化前由宿主渲染标准形（底部行按钮 / widget 区网格单元），
    // 点击/渲染触发物化后由 client 同 id 注册条目接管。meta 仅数据（无 onClick 函数），
    // title 用 zh 字面（与 extman sidebarFooter 静态条目同约定），client 接管后走 t() 多语。
    newSessionWidgets: [
      { id: "guide", meta: { title: "快速上手", areas: ["top"], defaultArea: "top", w: 8, h: 2, priority: 0 } },
      { id: "shortcuts", meta: { title: "快捷操作", areas: ["top"], defaultArea: "top", w: 4, h: 1, priority: 10 } },
      { id: "examples", meta: { title: "试试这样问", areas: ["bottom"], defaultArea: "bottom", w: 8, h: 1, priority: 20 } },
    ],
    sidebarFooter: [{ id: "quickstart-open", label: "快速上手", title: "快速上手：回到欢迎页引导", icon: "icons/rocket.svg" }],
    i18n: {
      "zh-CN": {
        "qs.guideTitle": "快速上手",
        "qs.step1": "选择项目目录——左栏项目行或上方 Workspace 下拉",
        "qs.step2": "输入第一条消息，回车即开始会话",
        "qs.step3": "@ 引用文件，/ 调出命令菜单",
        "qs.step4": "底部选择器切换模型",
        "qs.guideHint": "⚙ 可隐藏/移动这些卡片",
        "qs.shortcutsTitle": "快捷操作",
        "qs.sc.newSession": "Ctrl+Alt+N 新建会话",
        "qs.sc.at": "@ 引用文件",
        "qs.sc.slash": "/ 命令菜单",
        "qs.sc.enter": "Enter 发送 · Shift+Enter 换行",
        "qs.examplesTitle": "试试这样问",
        "qs.ex.1": "分析这个项目的目录结构，给出模块依赖关系",
        "qs.ex.2": "帮我实现一个新功能：先给方案，我确认后再写代码",
        "qs.ex.3": "跑一遍测试，修复失败的用例",
        "qs.ex.4": "审查最近一次提交，指出潜在问题",
        "qs.filler.title": "快速上手",
        "qs.filler.step1": "选个项目目录",
        "qs.filler.step2": "发第一条消息",
        "qs.filler.step3": "左栏 ⋮ 打开面板与应用抽屉",
        "qs.filler.open": "打开快速上手页",
        "qs.filler.dismiss": "关闭引导",
        "qs.footer.label": "快速上手",
        "qs.footer.title": "快速上手：回到欢迎页引导",
        "qs.toast.noCwd": "未找到工作目录，请先在左栏选择项目",
      },
      en: {
        "qs.guideTitle": "Quickstart",
        "qs.step1": "Pick a project directory — the sidebar project row or the Workspace dropdown above",
        "qs.step2": "Type your first message and press Enter to start",
        "qs.step3": "@ to reference files, / for the command menu",
        "qs.step4": "Switch models in the selector below",
        "qs.guideHint": "⚙ Hide or rearrange these cards",
        "qs.shortcutsTitle": "Shortcuts",
        "qs.sc.newSession": "Ctrl+Alt+N New session",
        "qs.sc.at": "@ Reference files",
        "qs.sc.slash": "/ Command menu",
        "qs.sc.enter": "Enter send · Shift+Enter newline",
        "qs.examplesTitle": "Try asking",
        "qs.ex.1": "Analyze this project's structure and map module dependencies",
        "qs.ex.2": "Build a new feature: propose a plan first, code after I confirm",
        "qs.ex.3": "Run the test suite and fix the failing cases",
        "qs.ex.4": "Review the latest commit and flag potential issues",
        "qs.filler.title": "Get started",
        "qs.filler.step1": "Pick a project directory",
        "qs.filler.step2": "Send your first message",
        "qs.filler.step3": "Open panels & the app drawer via ⋮ in the sidebar",
        "qs.filler.open": "Open the quickstart page",
        "qs.filler.dismiss": "Dismiss guide",
        "qs.footer.label": "Quickstart",
        "qs.footer.title": "Quickstart: back to the welcome-page guide",
        "qs.toast.noCwd": "No working directory found — pick a project in the sidebar first",
      },
    },
  },
};
