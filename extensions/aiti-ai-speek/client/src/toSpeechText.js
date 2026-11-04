/**
 * toSpeechText —— 朗读内容预处理（aiti-ai-speek 的灵魂，PLAN §6）
 *
 * 把 agent 的 markdown 回复转成「好读的」朗读段序列。每段带类型：
 *   summary  总结/结论/要点（必读）
 *   question 提问（必读）
 *   heading  标题（导航）
 *   note     代码块/表格 → 口语化概要（不逐行读）
 *   body     其余正文
 *
 * 三层策略（PLAN §6）：总结信息必读 / 问题信息必读 / 其余概要化。
 * 纯函数无副作用，可在 node 下直接跑单测（tools/toSpeechText.test.mjs）。
 */

export const SEG = { SUMMARY: "summary", QUESTION: "question", HEADING: "heading", NOTE: "note", BODY: "body" };

const SUMMARY_KEYWORDS = ["总结", "结论", "要点", "综上", "小结", "回顾", "总之", "关键", "核心", "一句话", "简单说", "概括", "最后"];
const QUESTION_KEYWORDS = ["您觉得", "你怎么看", "请告诉", "请问", "能否", "是否", "可不可以", "需要我", "要我", "帮我", "请回答", "你说呢", "你觉得呢", "你觉得", "可以吗", "行吗"];

/** 数字 → 中文序数（列表口播用） */
const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 清理 markdown 语法（保留符号原样，供 DOM 匹配；不做公式口播） */
export function leanText(text) {
  return String(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")           // 链接 → 只读文字
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")          // 图片 → alt
    .replace(/`([^`]+)`/g, "$1")                       // 行内代码 → 文字
    .replace(/^>\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/…/g, "…")
    .replace(/([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])[ \t\u00a0\u3000]+/g, "$1")
    .replace(/[ \t\u00a0\u3000]+([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 公式口播化（只在朗读文本上做；DOM 原文保留符号） */
export function verbalize(text) {
  return String(text || "")
    .replace(/√/g, "根号").replace(/≥/g, "大于等于").replace(/≤/g, "小于等于")
    .replace(/≠/g, "不等于").replace(/≈/g, "约等于").replace(/×/g, "乘").replace(/÷/g, "除以");
}

/** 可朗读判定：去符号后必须有中英文/数字——纯符号文本（如 ")、"---"、"***"、"```"）
 *  edge-tts 无法合成会失败（NoAudioReceived/超时），也必须过滤掉（不可读不朗读、不请求 TTS）。 */
export function speakable(t) {
  return /[\u4e00-\u9fffA-Za-z0-9]/.test(String(t || ""));
}

/** 清理 markdown → 朗读纯文本 = leanText + 公式口播化 */
export function cleanMarkdown(text) {
  return verbalize(leanText(text));
}

/** 按中文句末标点 + 换行拆句（保留标点） */
export function splitSentences(text) {
  const out = [];
  let cur = "";
  for (const ch of String(text || "")) {
    cur += ch;
    if (/[。！？!?…；;]/.test(ch) || ch === "\n") {
      const t = cur.replace(/\n+/g, " ").trim();
      if (t) out.push(t);
      cur = "";
    }
  }
  const tail = cur.replace(/\n+/g, " ").trim();
  if (tail) out.push(tail);
  return out;
}

/** 单句分类：question / summary / body / note */
export function classifySentence(s) {
  const t = String(s || "").trim();
  if (!t) return SEG.BODY;
  if (QUESTION_KEYWORDS.some((k) => t.includes(k)) || /[？?]$/.test(t)) return SEG.QUESTION;
  if (SUMMARY_KEYWORDS.some((k) => t.includes(k))) return SEG.SUMMARY;
  return SEG.BODY;
}

/** 表格 → 口语化概要 */
function tableNote(blockLines) {
  const rows = [];
  for (const raw of blockLines) {
    let line = raw.trim();
    if (line.startsWith("|")) line = line.slice(1);
    if (line.endsWith("|")) line = line.slice(0, -1);
    const cells = line.split("|").map((c) => cleanMarkdown(c).trim());
    // 分隔行 |---|---| 跳过
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  if (!rows.length) return "（空表格）";
  const n = rows.length, m = Math.max(...rows.map((r) => r.length));
  const header = rows[0] || [];
  const body = rows.slice(1);
  const first = body[0] || [];
  const last = body[body.length - 1] || [];
  const parts = [`这是一张 ${n} 行 ${m} 列的表格`];
  if (header.length) parts.push(`表头：${header.filter(Boolean).join("、")}`);
  if (first.length) parts.push(`例如：${first.filter(Boolean).slice(0, 4).join("、")}`);
  if (last.length) parts.push(`结论：${last.filter(Boolean).slice(0, 4).join("、")}`);
  parts.push("细节请看屏幕");
  return parts.join("；") + "。";
}

/** 代码块 → 口语化概要（不逐行读） */
function codeNote(lang, codeLines) {
  const langName = (lang || "代码").trim() || "代码";
  // 从首行注释/函数名提取「做什么」
  let hint = "";
  for (const l of codeLines) {
    const t = l.trim();
    if (!t) continue;
    const comment = /^(?:\/\/|#|--|\/\*|\*)\s*(.+)$/.exec(t);
    if (comment) { hint = comment[1].slice(0, 24); break; }
    const fn = /(?:function|def|const|let|var|export)\s+([A-Za-z0-9_$]+)\s*(?:\(|\s*=)/.exec(t);
    if (fn) { hint = "函数 " + fn[1]; break; }
    if (!hint) hint = t.slice(0, 16);
  }
  const lineDesc = codeLines.length > 1 ? `${codeLines.length} 行` : "1 行";
  return `接下来是一段${langName}代码，约${lineDesc}${hint ? `，主要实现${hint}` : ""}；细节请看屏幕。`;
}

/** 列表 → 每项独立口播段（有序读编号「第一…」；无序读内容；match=该项原文供高亮） */
function listSegments(items, ordered, startNum) {
  const segs = [];
  let n = startNum || 1;
  for (const raw of items) {
    const content = leanText(raw).trim();
    if (!content) { n++; continue; }
    const spoken = verbalize(content);
    // 有序：读编号（第一/二/三…，超过十用「第N项」）；无序：直接读内容
    let text;
    if (ordered) {
      text = n <= 10 && CN_NUM[n - 1] ? `${CN_NUM[n - 1]}，${spoken}` : `第${n}项，${spoken}`;
    } else {
      text = spoken;
    }
    segs.push({ kind: SEG.BODY, text, match: content });
    n++;
  }
  return segs;
}

/**
 * 主入口：markdown → 朗读段序列（带类型，供「全文概要化」与「仅要点」两模式消费）
 * @param {string} md agent 回复的 markdown
 * @returns {Array<{kind: string, text: string}>}
 */
export function toSpeechSegments(md) {
  const lines = String(md || "").split(/\r?\n/);
  const segs = [];
  let i = 0;
  let headingCount = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 代码围栏
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```\s*/, "").trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      i++; // 跳过收尾 ```
      const note = codeNote(lang, codeLines);
      if (note) segs.push({ kind: SEG.NOTE, text: note });
      continue;
    }
    // 标题
    const hm = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (hm) {
      headingCount++;
      const title = leanText(hm[2]).trim();
      if (title) {
        const isSum = SUMMARY_KEYWORDS.some((k) => title.includes(k));
        // text=朗读（带序号前缀 + 口播）；match=DOM 原文（不加前缀、不口播）用于高亮定位
        segs.push({ kind: isSum ? SEG.SUMMARY : SEG.HEADING, text: `第${headingCount}部分：${verbalize(title)}`, match: title });
      }
      i++;
      continue;
    }
    // 表格块
    if (line.trim().startsWith("|")) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { block.push(lines[i].trim()); i++; }
      segs.push({ kind: SEG.NOTE, text: tableNote(block) });
      continue;
    }
    // 列表（有序 = 数字开头，读编号；无序 = - * + 开头）
    const LIST_RE = /^\s*(?:(-|\*|\+)\s+|(\d+)[.、)]\s*)/;
    const ITEM_STRIP_RE = /^\s*(?:(-|\*|\+)\s+|(\d+)[.、)]\s*)/;
    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d+[.、)]\s*\S/.test(line);
      const items = [];
      let startNum = 1, first = true;
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const m = ITEM_STRIP_RE.exec(lines[i]);
        if (first && ordered && m && m[2]) startNum = parseInt(m[2], 10) || 1;
        first = false;
        items.push(lines[i].replace(ITEM_STRIP_RE, ""));
        i++;
      }
      const segs2 = listSegments(items, ordered, startNum);
      for (const s of segs2) { if (s.text) segs.push(s); }
      continue;
    }
    // 分隔线
    if (/^\s*[-*_]{3,}\s*$/.test(line)) { i++; continue; }
    // 空行
    if (!line.trim()) { i++; continue; }
    // 段落：收集到空行/特殊行前
    const para = [];
    while (
      i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i])
      && !/^\s*#{1,6}\s/.test(lines[i]) && !lines[i].trim().startsWith("|")
      && !/^\s*(?:[-*+]\s+|\d+[.、)]\s+)/.test(lines[i]) && !/^\s*[-*_]{3,}\s*$/.test(lines[i])
    ) { para.push(lines[i]); i++; }
    const text = leanText(para.join("\n"));
    if (text) {
      for (const s of splitSentences(text)) {
        // 纯符号句（如 ")、"""、"---" 残留）不可读：不产出 seg（edge-tts 会合成失败）
        if (!speakable(s)) continue;
        // match=lean 原文（DOM 渲染后与此一致）；text=口播化
        segs.push({ kind: classifySentence(s), text: verbalize(s), match: s });
      }
    }
  }
  return segs;
}

/** 按朗读内容模式过滤：full=全文概要化（全读）；essentials=仅要点（A+B+标题导航） */
export function filterSegments(segs, mode) {
  if (mode !== "essentials") return segs;
  return segs.filter((s) => s.kind === SEG.SUMMARY || s.kind === SEG.QUESTION || s.kind === SEG.HEADING);
}
