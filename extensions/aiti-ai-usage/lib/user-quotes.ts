/**
 * aiti-ai-usage · 用户输入消息分析（引用识别 + 机器注入判定）——纯函数，零依赖。
 *
 * 引用格式调研（2026-09，用于本文件的识别规则）：
 *   - Markdown / GitHub / ChatGPT 输出 / Slack / Telegram / Matrix 回退：行首 `>`（可嵌套 `>>`）
 *   - 邮件 / Usenet posting style：行首 `>` 前缀表示被引文本，`>>` 嵌套；
 *     attribution 行 "On <date>, <name> wrote:"（中文邮件客户端 "在 … 写道："）
 *   - Discord：`> ` 单行引用 + `>>>` 整段引用
 *   - 论坛 BBCode（phpBB/vBulletin/Discuz）：[quote]…[/quote]
 *   - AI 编码工具（Cursor/Copilot/Cline/pi）：@file / #file 上下文提及
 *   - 本仓自身（pi-web）：引用回复 = 选中文本逐行 `> ` 前缀（lib/quoted-selection.ts 与
 *     aiti-msg-smart formatQuote）；文件提及 @path
 *   - 微信/WhatsApp 等 IM 的"引用"是结构化消息，文本里不落前缀（无法从文本识别，不计）
 *
 * 本地实测（开发机 ~/.pi/agent/sessions 全量 12710 条 user 文本消息）：
 *   `> ` 引用 1404 条（11.0%）· `>>` 嵌套 0 · @file 136 条（1.1%）· 邮件 attribution 0
 *   → `>` 系列是绝对主力（我们的引用回复），@file 次之；其余格式留作扩展位。
 */

// ---------------------------------------------------------------- 机器注入模板

/**
 * 机器注入 user 消息模板（扩展自动会话的首条 prompt；启发式，宁可少杀不可错杀）。
 * 判定条件 = 会话首条 user 消息 && 文本长度 ≥ 30 && 命中任一模板 → kind='agent'。
 * 样本（开发机实测）：
 *   "你是 pi-web 扩展的 AI 助手。根据用户要求完成任务…"（ai-helper，69 会话）
 *   "你是「AI 资讯日报」推送员（每日 06:30/18:30 两报…）"（aiti-ai-schedule，13）
 *   "[任务] 你是页面卡顿调试助手（aiti-cpu-meter 外部版发起…"（12）
 *   "Task: 你是一名严谨的代码审计员。工作区：…"（pi-subagents，47）
 *   "⚠ 页面错误   · 类型: console.error   · 消息: …"（调试扩展上报，10）
 */
const MACHINE_PROMPT_RES: RegExp[] = [
  /^你是.{0,60}(助手|推送员|机器人|调试员)/, // 扩展助手模板（后缀标点不敏感）
  /^\[任务\]/,                                // 扩展派发任务
  /^Task:\s/,                                 // subagent 任务
  /^You are (a|an|the)\s/i,                   // 英文模板
  /^⚠ 页面错误/,                              // 页面错误上报（aiti-devtools 系）
];

/** 首条 user 消息是否为机器注入模板（长度门槛防误杀「你是助手吗？」这类短问句）。 */
export function looksMachinePrompt(text: string): boolean {
  const t = String(text ?? "").trim();
  if (t.length < 30) return false;
  return MACHINE_PROMPT_RES.some((re) => re.test(t));
}

// ---------------------------------------------------------------- 引用扫描

/** 引用类型（稳定 id，UI/DB 通用）：
 *  gt=Markdown/邮件/Slack 的 `>` 行 · gtnested=嵌套 `>>` · gt3=Discord 整段引用 `>>>`
 *  bbcode=论坛 [quote] · attrib=邮件回复头 · fileref=@file 提及 */
export type QuoteKind = "gt" | "gtnested" | "gt3" | "bbcode" | "attrib" | "fileref";

export interface UserTextScan {
  /** 文本字符数（含空白，反映输入体量） */
  chars: number;
  /** 文本行数（split("\n")） */
  lines: number;
  /** `>` 前缀行数（含嵌套行；引用体量） */
  quoteLines: number;
  /** 首非空行是引用行（引用回复形态：引用在前、正文在后） */
  quoteHead: boolean;
  /** 命中的引用类型集合（稳定顺序） */
  kinds: QuoteKind[];
}

const EMPTY_SCAN: UserTextScan = { chars: 0, lines: 0, quoteLines: 0, quoteHead: false, kinds: [] };

/** 邮件 attribution 行：英文 "On <...> wrote:"；中文 "在 <...> 写道："。 */
const ATTRIB_RE = /^\s*(On\s.{1,160}wrote[:：]|在.{1,80}(写道|寫道)[:：])/im;
/** BBCode 引用开标签（含 [quote=作者] 形态）。 */
const BBCODE_RE = /\[quote[=\] ]/i;
/** 文件引用：`@path/to/file`（含盘符/扩展名路径）或 Copilot 风格 `#file:path`。 */
const FILEREF_RE = /(^|[\s(（[【"'])@([\w.-]+\/[\w./~-]+|[\w-]+\.[A-Za-z0-9]{1,8})(?=$|[\s)）\]】,，。;；:：!?！？"'`])|(^|\s)#file[:：]?[\w./-]+/im;

/**
 * 扫描一条用户消息文本 → 引用特征。
 * 行级判定允许最多 3 个空格缩进（CommonMark blockquote 语法）。
 */
export function scanUserText(raw: string): UserTextScan {
  const text = String(raw ?? "");
  if (!text) return EMPTY_SCAN;
  const lines = text.split("\n");
  let quoteLines = 0;
  let nestedLines = 0;
  let deepLines = 0;
  let firstNonEmpty = "";
  for (const line of lines) {
    const body = line.replace(/^ {0,3}/, ""); // 剥 CommonMark 允许的前导空格
    if (body.startsWith(">")) {
      quoteLines++;
      if (body.startsWith(">>>")) deepLines++;
      else if (body.startsWith(">>") || body.startsWith("> >")) nestedLines++;
    }
    if (!firstNonEmpty && body.trim()) firstNonEmpty = body;
  }
  const kinds: QuoteKind[] = [];
  if (quoteLines > 0) kinds.push("gt");
  if (nestedLines > 0) kinds.push("gtnested");
  if (deepLines > 0) kinds.push("gt3");
  if (BBCODE_RE.test(text)) kinds.push("bbcode");
  if (ATTRIB_RE.test(text)) kinds.push("attrib");
  if (FILEREF_RE.test(text)) kinds.push("fileref");
  return {
    chars: text.length,
    lines: lines.length,
    quoteLines,
    quoteHead: firstNonEmpty.startsWith(">"),
    kinds,
  };
}

/** 从 user message 的 content（string | content[]）提取纯文本。 */
export function extractUserText(content: unknown): { text: string; image: boolean } {
  if (typeof content === "string") return { text: content, image: false };
  if (!Array.isArray(content)) return { text: "", image: false };
  let text = "";
  let image = false;
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const cc = c as Record<string, unknown>;
    if (cc.type === "text" && typeof cc.text === "string") text += cc.text;
    else if (cc.type === "image") image = true;
  }
  return { text, image };
}
