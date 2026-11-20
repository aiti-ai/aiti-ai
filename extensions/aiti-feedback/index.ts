/**
 * aiti-feedback · user feedback extension (pure client: compose a sanitized
 * report → open a prefilled GitHub issue).
 *
 * No server API; zero tokens — the user logs into GitHub themselves and
 * submits; the dialog preview IS the final content (sanitized, user-confirmed
 * before redirect). Plan: pi-work docs/aiti-feedback-plan.md.
 */
export default {
  id: "aiti-feedback",
  name: "报告问题",
  icon: "icon.svg",
  client: "dist/aiti-feedback-client.mjs",

  ui: {
    clientImmediately: false,
    toolbar: [{ id: "aiti-feedback-open", label: "i18n:fb.open.label", title: "i18n:fb.open.title", icon: "icons/message-circle.svg" }],
    dialogs: [{ id: "aiti-feedback-dialog", label: "i18n:fb.open.label" }],
    i18n: {
      en: {
        "fb.open.label": "Report an issue",
        "fb.open.title": "Report an issue / send feedback",
        "报告问题": "Report an issue",
        "关闭": "Close",
        "将以 GitHub issue 打开（预填内容）；提交前请确认不含敏感信息。": "Opens a prefilled GitHub issue; review the preview and make sure it carries nothing sensitive before submitting.",
        "类型": "Type",
        "问题": "Bug",
        "建议": "Suggestion",
        "其他": "Other",
        "标题": "Title",
        "一句话摘要": "one-line summary",
        "描述（必填）": "Description (required)",
        "发生了什么？期望是什么？": "What happened? What did you expect?",
        "复现步骤（可选）": "Steps to reproduce (optional)",
        "1. 打开…\n2. 点击…": "1. Open…\n2. Click…",
        "＋ 会话上下文（可选，自行粘贴）": "＋ Session context (optional, paste yourself)",
        "粘贴相关日志/输出（将做脱敏处理，预览里请再确认）": "Paste relevant logs/output (sanitized; double-check in the preview)",
        "联系方式（可选：邮箱等，公开可见）": "Contact (optional: email etc., publicly visible)",
        "附带环境信息（浏览器/平台，不含会话内容）": "Include environment info (browser/platform; no session content)",
        "预览（将提交的内容，已脱敏）": "Preview (what will be submitted, sanitized)",
        "复制全文": "Copy full text",
        "已复制全文": "Full text copied",
        "复制失败": "Copy failed",
        "前往 GitHub 提交": "Open GitHub to submit",
        "描述是必填项": "Description is required",
        "内容超长已截断，完整内容已复制到剪贴板": "Too long for GitHub prefill — truncated; full text copied to clipboard",
      },
      "zh-TW": {
        "fb.open.label": "回報問題",
        "fb.open.title": "回報問題 / 提供建議",
        "报告问题": "回報問題",
        "关闭": "關閉",
        "将以 GitHub issue 打开（预填内容）；提交前请确认不含敏感信息。": "將以 GitHub issue 打開（預填內容）；提交前請確認不含敏感資訊。",
        "类型": "類型",
        "问题": "問題",
        "建议": "建議",
        "其他": "其他",
        "标题": "標題",
        "一句话摘要": "一句話摘要",
        "描述（必填）": "描述（必填）",
        "发生了什么？期望是什么？": "發生了什麼？期望是什麼？",
        "复现步骤（可选）": "重現步驟（可選）",
        "1. 打开…\n2. 点击…": "1. 打開…\n2. 點擊…",
        "＋ 会话上下文（可选，自行粘贴）": "＋ 會話上下文（可選，自行貼上）",
        "粘贴相关日志/输出（将做脱敏处理，预览里请再确认）": "貼上相關日誌/輸出（將做脫敏處理，預覽裡請再確認）",
        "联系方式（可选：邮箱等，公开可见）": "聯繫方式（可選：信箱等，公開可見）",
        "附带环境信息（浏览器/平台，不含会话内容）": "附帶環境資訊（瀏覽器/平台，不含會話內容）",
        "预览（将提交的内容，已脱敏）": "預覽（將提交的內容，已脫敏）",
        "复制全文": "複製全文",
        "已复制全文": "已複製全文",
        "复制失败": "複製失敗",
        "前往 GitHub 提交": "前往 GitHub 提交",
        "描述是必填项": "描述為必填項",
        "内容超长已截断，完整内容已复制到剪贴板": "內容超長已截斷，完整內容已複製到剪貼簿",
      },
    },
  },
};
