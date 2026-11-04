/**
 * 扩展展示名（id → 双语友好名）——唯一权威来源。
 *
 * 用途：扩展技术 id（如 aiti-cmd / aiti-git-review）对用户不友好，各扩展 client
 * （aiti-extman / aiti-helper …）展示扩展分组/列表时用它显示中文/英文友好名，
 * 表内缺失的扩展回退到 server name / id。
 *
 * 约定：新增扩展时在此补一行（en + zh）。此表只放「展示名」，不做逻辑。
 */

export const EXT_DISPLAY_NAMES: Record<string, { en: string; zh: string }> = {
  "aiti-acp-agent": { en: "ACP Session Backend", zh: "ACP 会话后端" },
  "aiti-ai-input": { en: "AI Input Enhancer", zh: "AI 输入增强" },
  "aiti-ai-schedule": { en: "AI Schedule", zh: "AI 定时任务" },
  "aiti-ai-speek": { en: "AI Voice Reading", zh: "AI 语音朗读" },
  "aiti-ai-usage": { en: "AI Usage", zh: "AI 用量统计" },
  "aiti-append-system": { en: "Append System Prompt", zh: "追加系统提示词" },
  "aiti-attach-agent": { en: "Attach Session Backend", zh: "附着会话后端" },
  "aiti-channels": { en: "IM Channels", zh: "IM 渠道" },
  "aiti-claude-code-agent": { en: "Claude Code Session Backend", zh: "Claude Code 会话后端" },
  "aiti-cmd": { en: "Command Palette", zh: "命令面板" },
  "aiti-codex-agent": { en: "Codex Session Backend", zh: "Codex 会话后端" },
  "aiti-configs": { en: "Config Versioning & Self-check", zh: "配置版本化 + 崩溃自检" },
  "aiti-cpu-meter": { en: "CPU Meter", zh: "CPU 流畅度仪表" },
  "aiti-crash-fatal": { en: "Crash Drill (dev)", zh: "崩溃演习（开发）" },
  "aiti-cursor-agent": { en: "Cursor Session Backend", zh: "Cursor 会话后端" },
  "aiti-debug-inject": { en: "Remote Debug Inject", zh: "远程调试注入" },
  "aiti-devtools": { en: "Page DevTools", zh: "页面 AI 调试工具" },
  "aiti-devtools-vite": { en: "DevTools Vite Plugin", zh: "DevTools Vite 插件" },
  "aiti-devtools-vue": { en: "DevTools Vue Plugin", zh: "DevTools Vue 插件" },
  "aiti-doc-center": { en: "Doc Center", zh: "文档中心" },
  "aiti-draft-keeper": { en: "Draft Keeper", zh: "草稿保管员" },
  "aiti-echo-agent": { en: "Echo Session Backend", zh: "Echo 会话后端" },
  "aiti-editor": { en: "File Editor", zh: "文件编辑器" },
  "aiti-event-bus": { en: "Page Event Bus", zh: "页面事件总线" },
  "aiti-extman": { en: "Extension Manager", zh: "扩展管理器" },
  "aiti-float": { en: "Dialog Float Enhancer", zh: "弹窗浮动增强器" },
  "aiti-folder": { en: "Folder Browser", zh: "文件夹浏览器" },
  "aiti-git-review": { en: "Git Review", zh: "Git 代码审核" },
  "aiti-git-trace": { en: "AI Change Trace", zh: "AI 变更追踪" },
  "aiti-helper": { en: "AI Helper", zh: "AI 助手入口" },
  "aiti-inject": { en: "Debug Inject FAB", zh: "调试注入按钮" },
  "aiti-mcp-bridge": { en: "MCP Bridge", zh: "MCP 桥" },
  "aiti-model-check": { en: "Model Availability", zh: "模型可用性管理" },
  "aiti-model-wizard": { en: "Model Wizard", zh: "模型添加向导" },
  "aiti-msg-anchor": { en: "Message Anchor Banner", zh: "消息锚点横幅" },
  "aiti-msg-nav": { en: "Message Scroll Nav", zh: "消息滚动导航" },
  "aiti-msg-smart": { en: "Message Intelligence", zh: "消息智能" },
  "aiti-onlyoffice": { en: "OnlyOffice Editor", zh: "OnlyOffice 编辑" },
  "aiti-pi-agent": { en: "pi Session Backend", zh: "pi 会话后端" },
  "aiti-plan-first": { en: "Plan-First Reminder", zh: "方案先行" },
  "aiti-plan-review": { en: "Plan Review", zh: "方案评审" },
  "aiti-prompts": { en: "Prompt Snippets", zh: "Prompt 片段收藏库" },
  "aiti-qoder-agent": { en: "Qoder Session Backend", zh: "Qoder 会话后端" },
  "aiti-queue-keeper": { en: "Queue Keeper", zh: "队列管家" },
  "aiti-sheet-univer": { en: "Excel Editor", zh: "Excel 编辑器" },
  "aiti-subagents": { en: "Subagents", zh: "子代理" },
  "aiti-testagent": { en: "TestAgent · Java Debugging", zh: "TestAgent · Java 后端调试" },
  "aiti-ui-env": { en: "UI Environment", zh: "UI 环境（桌面/无头虚拟屏）" },
  "aiti-word-docx-preview": { en: "Word Preview", zh: "Word 预览" },
  "aiti-word-superdoc": { en: "Word Editor", zh: "Word 编辑" },
  "aiti-zcode-agent": { en: "ZCode Session Backend", zh: "ZCode 会话后端" },
  "demo": { en: "Demo Extension", zh: "示例扩展" },
  "demo-lazy": { en: "Demo Extension (Lazy)", zh: "示例扩展（懒加载）" },
  "devtools-vscode": { en: "VS Code Plugin", zh: "VS Code 插件" },
  "devtools-idea": { en: "IDEA Plugin", zh: "IDEA 插件" },
  "ext-jsx-client": { en: "JSX Client Template", zh: "扩展 JSX 客户端模板" },
  "service-tunnels": { en: "Service Tunnels", zh: "服务隧道" },
  "session-manager": { en: "Session Manager", zh: "会话管理器" },
  "sm-demo-source": { en: "Demo Session Source", zh: "第三方会话源示例" },
};

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** 当前界面语言（localStorage pi-locale，与宿主 useI18n 同源；缺省 en）。 */
export function currentUiLocale(): "zh-CN" | "en" {
  try {
    const v = window.localStorage.getItem("pi-locale");
    if (v === "zh-CN" || v === "en") return v;
  } catch { /* 存储不可用时用缺省 */ }
  return "en";
}

/** 按界面语言解析扩展展示名：zh → 双语表 zh / server name / id；
 *  en → 双语表 en / 无 CJK 的 server name / id。 */
export function extDisplayName(id: string, fallbackName?: string | null): string {
  const entry = EXT_DISPLAY_NAMES[id];
  if (currentUiLocale() === "zh-CN") return (entry && entry.zh) || fallbackName || id;
  if (entry) return entry.en;
  return fallbackName && !CJK_RE.test(fallbackName) ? fallbackName : id;
}
