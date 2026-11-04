/**
 * speech-filter —— 服务端朗读内容筛选（根据配置 mode 只返回需要的，省带宽）
 *
 * 与前端 client/src/toSpeechText.js 的筛选逻辑保持一致：
 *   full      全文概要化：返回全部可朗读文本（toSpeechSegments 拼接）
 *   essentials仅要点：只保留 总结/问题/标题 段（kind=summary/question/heading），剔除正文/概要
 *
 * 纯函数无 DOM，供 aiti-ai-speek 服务端 /messages-content 按 mode 裁剪文本。
 */

export const SEG = { SUMMARY: "summary", QUESTION: "question", HEADING: "heading", NOTE: "note", BODY: "body" };

const SUMMARY_KEYWORDS = ["总结", "结论", "要点", "综上", "小结", "回顾", "总之", "关键", "核心", "一句话", "简单说", "概括", "最后"];
const QUESTION_KEYWORDS = ["您觉得", "你怎么看", "请告诉", "请问", "能否", "是否", "可不可以", "需要我", "要我", "帮我", "请回答", "你说呢", "你觉得呢", "你觉得", "可以吗", "行吗"];
const CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 去 markdown 标记（保留符号、不破折号归一——与前端 leanText 一致） */
function leanText(text) {
  return String(text || "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/…/g, "…")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSentences(text) {
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

function classifySentence(s) {
  const t = String(s || "").trim();
  if (!t) return SEG.BODY;
  if (QUESTION_KEYWORDS.some((k) => t.includes(k)) || /[？?]$/.test(t)) return SEG.QUESTION;
  if (SUMMARY_KEYWORDS.some((k) => t.includes(k))) return SEG.SUMMARY;
  return SEG.BODY;
}

function listNote(items) {
  const clean = items.map((x) => leanText(x).trim()).filter(Boolean).slice(0, 6);
  if (!clean.length) return "";
  return clean.length <= 3 ? clean.join("；") + "。" : clean.map((x, i) => `${CN_NUM[i] || i + 1}，${x}`).join("；") + "。";
}

function tableNote(blockLines) {
  const rows = [];
  for (const raw of blockLines) {
    let line = raw.trim();
    if (line.startsWith("|")) line = line.slice(1);
    if (line.endsWith("|")) line = line.slice(0, -1);
    const cells = line.split("|").map((c) => leanText(c).trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  if (!rows.length) return "（空表格）";
  const n = rows.length, m = Math.max(...rows.map((r) => r.length));
  const header = rows[0] || [], body = rows.slice(1);
  const first = body[0] || [], last = body[body.length - 1] || [];
  const parts = [`这是一张 ${n} 行 ${m} 列的表格`];
  if (header.length) parts.push(`表头：${header.filter(Boolean).join("、")}`);
  if (first.length) parts.push(`例如：${first.filter(Boolean).slice(0, 4).join("、")}`);
  if (last.length) parts.push(`结论：${last.filter(Boolean).slice(0, 4).join("、")}`);
  parts.push("细节请看屏幕");
  return parts.join("；") + "。";
}

function codeNote(lang, codeLines) {
  const langName = (lang || "代码").trim() || "代码";
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

/** markdown → 朗读段序列（与前端 toSpeechSegments 同构） */
export function toSpeechSegments(md) {
  const lines = String(md || "").split(/\r?\n/);
  const segs = [];
  let i = 0, headingCount = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```\s*/, "").trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
      i++;
      segs.push({ kind: SEG.NOTE, text: codeNote(lang, codeLines) });
      continue;
    }
    const hm = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (hm) {
      headingCount++;
      const title = leanText(hm[2]).trim();
      if (title) { const isSum = SUMMARY_KEYWORDS.some((k) => title.includes(k)); segs.push({ kind: isSum ? SEG.SUMMARY : SEG.HEADING, text: `第${headingCount}部分：${title}`, match: title }); }
      i++;
      continue;
    }
    if (line.trim().startsWith("|")) {
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { block.push(lines[i].trim()); i++; }
      segs.push({ kind: SEG.NOTE, text: tableNote(block) }); continue;
    }
    if (/^\s*(?:[-*+]\s+|\d+[.、)]\s+)/.test(line)) {
      const items = []; const ordered = /^\s*\d+[.、)]\s+/.test(line); let first = true, startNum = 1;
      while (i < lines.length && /^\s*(?:[-*+]\s+|\d+[.、)]\s+)/.test(lines[i])) {
        const m = /^\s*(?:(-|\*|\+)\s+|(\d+)[.、)]\s+)/.exec(lines[i]);
        if (first && ordered && m && m[2]) startNum = parseInt(m[2], 10) || 1;
        first = false;
        items.push(lines[i].replace(/^\s*[-*+]?\s*(\d+[.、)]\s+)?/, "")); i++;
      }
      const note = listNote(items);
      if (note) segs.push({ kind: SEG.BODY, text: note }); continue;
    }
    if (/^\s*[-*_]{3,}\s*$/.test(line)) { i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s*#{1,6}\s/.test(lines[i])
      && !lines[i].trim().startsWith("|") && !/^\s*(?:[-*+]\s+|\d+[.、)]\s+)/.test(lines[i]) && !/^\s*[-*_]{3,}\s*$/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    const text = leanText(para.join("\n"));
    if (text) for (const s of splitSentences(text)) segs.push({ kind: classifySentence(s), text: s, match: s });
  }
  return segs;
}

/** 按 mode 裁剪：full 返回全部拼接；essentials 只保留 summary/question/heading */
export function filterByMode(md, mode) {
  const segs = toSpeechSegments(md);
  if (mode === "essentials") {
    return segs.filter((s) => s.kind === SEG.SUMMARY || s.kind === SEG.QUESTION || s.kind === SEG.HEADING).map((s) => s.text).join("\n");
  }
  return segs.map((s) => s.text).join("\n");
}

/** 检测消息是否含「要点」标记（供仅要点模式导航：从当前位置找下一个重点消息） */
export function flagMessage(md) {
  const segs = toSpeechSegments(md);
  return {
    summary: segs.some((s) => s.kind === SEG.SUMMARY),
    question: segs.some((s) => s.kind === SEG.QUESTION),
    heading: segs.some((s) => s.kind === SEG.HEADING),
  };
}
