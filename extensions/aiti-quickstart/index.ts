/**
 * aiti-quickstart —— 快速上手（空白态引导 + 工作区获取）。
 *
 * 覆盖 pi-web「完全空白」面 + 初次使用全流程（v2 Workspace Hub，方案
 * docs/aiti-quickstart-hub-plan.md）：
 *   1) 新建会话欢迎页：newSessionWidgets 插槽 3 枚 widget——guide 是状态机开始卡
 *      （fresh=获取工作区/配置模型大按钮流；hasWorkspace=上次工作区+配置模型引导；
 *      full=v1 四步卡），shortcuts/examples 照旧；
 *   2) 左栏 DockStack 全折叠空白：引导卡经 client 服务 `aiti-quickstart.api` 交付
 *      session-manager 编排器（可选消费），与 aiti-app-center 同屏共存；无 cwd 态
 *      引导卡出「获取工作区/配置模型」两按钮；
 *   3) 工作区获取（checkout 专项）：server API
 *      `POST /api/extensions/aiti-quickstart/workspace/clone`（git clone --progress，
 *      staging+never-overwrite 落位，stderr 进度 → aiti-event-bus topic 帧）、
 *      `GET workspace/history`（获取记录 + ~/workspace 目录扫描合并——覆盖既往
 *      zip 上传无历史的工作区）、`POST workspace/forget`；Hub 对话框四入口
 *      （Git 克隆/上传压缩包（session-manager service 复用）/本地目录/新建空目录），
 *      workspacePickerActions 静态条目 → Workspace 下拉可达。
 *
 * [URL 规范] cwd 不进 URL：重返走 tab-session/window.__piWebCwd/最近项目解析，
 * 导航 = pi-web.newSession.setCwd。
 *
 * 常用「重返」入口：manifest sidebarFooter 静态条目**只作应用中心收编源**（可钉住
 * 卡片）；client 物化后同 id 注册条目 render=null 接管——左下工具条（与 extman 同排）
 * 不渲染按钮（2026-11-07 用户拍板：app center 有卡就够了）。
 *
 * 软依赖：session-manager（filler 消费 + upload 复用）、aiti-event-bus（clone 进度帧）、
 * aiti-model-wizard（配置模型深链，client 服务缺席降级）。
 */
import { api } from "./server/api.ts";

export default {
  id: "aiti-quickstart",
  name: "快速上手",
  version: "0.2.0",
  icon: "icons/rocket.svg",
  client: "dist/aiti-quickstart-client.mjs",

  // 应用中心分类：会话与项目（分类解析链第一优先级，无需 APP_OVERRIDES 兜底）
  category: "session",

  // server API（工作区获取：clone/history/record/forget）——宿主 registry 经
  // ext.ext.server.api 调用，必须挂 server.api 形（对齐 session-manager index.ts:172）
  server: { api },

  // 软依赖：缺席各自降级（filler 消费 / 上传复用）；无硬依赖
  optionalDependsOn: ["session-manager"],

  ui: {
    clientImmediately: false, // 懒扩展：静态条目（footer/欢迎页/下拉动作）+ session-manager ensureMaterialized 双物化路径
    // 静态条目（懒加载 v2）：物化前由宿主渲染标准形（底部行按钮 / widget 区网格单元），
    // 点击/渲染触发物化后由 client 同 id 注册条目接管。meta 仅数据（无 onClick 函数），
    // title 用 zh 字面（与 extman sidebarFooter 静态条目同约定），client 接管后走 t() 多语。
    newSessionWidgets: [
      { id: "guide", meta: { title: "快速上手", areas: ["top", "bottom"], defaultArea: "top", w: 8, h: 1, priority: -1 } },
      { id: "shortcuts", meta: { title: "快捷操作", areas: ["top", "bottom"], defaultArea: "top", w: 8, h: 1, priority: 10 } },
      { id: "examples", meta: { title: "试试这样问", areas: ["top", "bottom"], defaultArea: "bottom", w: 8, h: 1, priority: 20 } },
    ],
    sidebarFooter: [{ id: "quickstart-open", label: "快速上手", title: "快速上手：回到欢迎页引导", icon: "icons/rocket.svg" }],
    // Workspace 下拉底部动作区（上传/管理旁）：获取工作区 Hub 入口（日常可达，不只首用）
    workspacePickerActions: [{ id: "acquire", label: "获取工作区…", title: "获取工作区：Git 克隆 / 上传 / 本地目录 / 新建", icon: "icons/rocket.svg" }],
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
        "qs.sc.enter": "Enter 发送消息",
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
        // v2 开始卡 / Hub
        "qs.start.title": "开始使用",
        "qs.start.subtitle": "三步开始：获取工作区 → 配置模型 → 发第一条消息",
        "qs.start.recent": "上次工作区",
        "qs.start.acquire": "获取工作区…",
        "qs.start.acquireHint": "Git 克隆 / 上传压缩包 / 本地目录 / 新建空目录",
        "qs.start.configureModel": "配置模型…",
        "qs.start.modelMissing": "尚未配置可用模型",
        "qs.start.importModels": "从 Agent 导入…",
        "qs.start.importModelsTitle": "从其他 Agent 导入模型配置（codex / zcode / opencode…）",
        "qs.start.importModelsHint": "本机其他 Agent 已配好的模型一键导入",
        "qs.start.modelOk": "模型已就绪",
        "qs.start.step.workspace": "① 获取工作区",
        "qs.start.step.model": "② 配置模型",
        "qs.start.step.msg": "③ 输入消息开始",
        "qs.open.hub": "获取工作区…",
        "qs.hub.title": "获取工作区",
        "qs.hub.close": "关闭",
        "qs.hub.recent": "最近",
        "qs.hub.recentEmpty": "还没有工作区记录",
        "qs.hub.tab.clone": "Git 克隆",
        "qs.hub.tab.upload": "上传压缩包",
        "qs.hub.tab.local": "本地目录",
        "qs.hub.tab.new": "新建空目录",
        "qs.hub.clone.url": "仓库地址（https://…/repo.git 或 git@host:path）",
        "qs.hub.clone.branch": "分支（可选）",
        "qs.hub.clone.dir": "目标目录（可选，默认 ~/workspace/<仓库名>）",
        "qs.hub.clone.depth": "浅克隆（--depth 1，只取最新提交）",
        "qs.hub.clone.go": "开始克隆",
        "qs.hub.clone.needGit": "未找到 git——请先安装 git 再使用克隆",
        "qs.hub.clone.ok": "克隆完成：{root}",
        "qs.hub.upload.fallback": "未安装 session-manager——请用 Workspace 下拉的「上传工作区」",
        "qs.hub.local.browse": "浏览目录…",
        "qs.hub.local.selected": "已选：{path}",
        "qs.hub.new.go": "创建并使用",
        "qs.hub.new.created": "已创建：{root}",
        "qs.hub.forget": "移除记录",
        "qs.hub.err.parse": "无法识别的仓库地址（支持 https…git / git@host:path / git:<url> / 本地路径）",
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
        "qs.sc.enter": "Enter to send",
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
        // v2 start card / hub
        "qs.start.title": "Get started",
        "qs.start.subtitle": "Three steps: get a workspace → configure a model → send your first message",
        "qs.start.recent": "Recent workspaces",
        "qs.start.acquire": "Get a workspace…",
        "qs.start.acquireHint": "Git clone / upload archive / local directory / new empty folder",
        "qs.start.configureModel": "Configure models…",
        "qs.start.modelMissing": "No usable model configured yet",
        "qs.start.importModels": "Import from agents…",
        "qs.start.importModelsTitle": "Import model configs from other agents on this machine (codex / zcode / opencode…)",
        "qs.start.importModelsHint": "One-click import of models already configured in local agents",
        "qs.start.modelOk": "Models ready",
        "qs.start.step.workspace": "① Get a workspace",
        "qs.start.step.model": "② Configure models",
        "qs.start.step.msg": "③ Send your first message",
        "qs.open.hub": "Get a workspace…",
        "qs.hub.title": "Get a workspace",
        "qs.hub.close": "Close",
        "qs.hub.recent": "Recent",
        "qs.hub.recentEmpty": "No workspace history yet",
        "qs.hub.tab.clone": "Git clone",
        "qs.hub.tab.upload": "Upload archive",
        "qs.hub.tab.local": "Local directory",
        "qs.hub.tab.new": "New empty folder",
        "qs.hub.clone.url": "Repository URL (https://…/repo.git or git@host:path)",
        "qs.hub.clone.branch": "Branch (optional)",
        "qs.hub.clone.dir": "Target directory (optional, default ~/workspace/<repo>)",
        "qs.hub.clone.depth": "Shallow clone (--depth 1, latest commit only)",
        "qs.hub.clone.go": "Clone",
        "qs.hub.clone.needGit": "git not found — install git to use clone",
        "qs.hub.clone.ok": "Cloned: {root}",
        "qs.hub.upload.fallback": "session-manager not installed — use “Upload workspace” in the Workspace dropdown",
        "qs.hub.local.browse": "Browse…",
        "qs.hub.local.selected": "Selected: {path}",
        "qs.hub.new.go": "Create & use",
        "qs.hub.new.created": "Created: {root}",
        "qs.hub.forget": "Forget",
        "qs.hub.err.parse": "Unrecognized repository URL (https…git / git@host:path / git:<url> / local path)",
      },
    },
  },
};
