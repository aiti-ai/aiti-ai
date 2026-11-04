/**
 * MiniMarkdown —— 扩展自带的轻量 markdown 渲染器（React 节点输出，零 dangerouslySetInnerHTML）。
 *
 * 为什么不引 react-markdown：扩展 bundle 全内联（vite external []），拖整条 md 生态过重；
 * 为什么不 marked+innerHTML：方案文本来自 agent，必须走 React 转义防注入。
 *
 * 覆盖面（zcode ExitPlanMode 方案文实测形态）：h1-h4 / hr / 引用块 / 无序+有序列表（缩进嵌套 ≤3 级 /
 * 任务清单 - [ ]）/ 围栏与行内代码 / 粗斜删 / http(s) 链接 / 段落硬换行。表格等罕见块退化为普通段落。
 */

import type { ReactNode } from "react";
import { createElement, Fragment } from "react";

// ---------- 行内解析 ----------

/** 行内 token 流：`code`、**bold**、*italic*、~~del~~、[text](http…)、纯文本。 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(~~[^~]+~~)|(\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}-i${i++}`;
    if (tok.startsWith("`")) {
      out.push(createElement("code", { key, style: { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px", fontSize: "0.92em", fontFamily: "var(--font-mono)" } }, tok.slice(1, -1)));
    } else if (tok.startsWith("**")) {
      out.push(createElement("strong", { key }, tok.slice(2, -2)));
    } else if (tok.startsWith("~~")) {
      out.push(createElement("del", { key }, tok.slice(2, -2)));
    } else if (tok.startsWith("[")) {
      const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(tok);
      if (link) {
        out.push(createElement("a", { key, href: link[2], target: "_blank", rel: "noopener noreferrer", style: { color: "var(--accent)", textDecoration: "underline" } }, link[1]));
      } else {
        out.push(tok);
      }
    } else {
      out.push(createElement("em", { key }, tok.slice(1, -1)));
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ---------- 块级解析 ----------

type Block =
  | { t: "heading"; level: number; text: string }
  | { t: "hr" }
  | { t: "quote"; lines: string[] }
  | { t: "code"; lang: string; lines: string[] }
  | { t: "list"; ordered: boolean; items: Array<{ depth: number; task: boolean | null; text: string }> }
  | { t: "p"; text: string };

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++; // 跳过收尾围栏（缺失也安全）
      blocks.push({ t: "code", lang: fence[1] ?? "", lines: body });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { blocks.push({ t: "heading", level: h[1].length, text: h[2] }); i++; continue; }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) { blocks.push({ t: "hr" }); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push({ t: "quote", lines: q });
      continue;
    }
    if (LIST_RE.test(line)) {
      const items: Array<{ depth: number; task: boolean | null; text: string }> = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        const m = LIST_RE.exec(lines[i])!;
        const depth = Math.min(2, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
        let text = m[3];
        let task: boolean | null = null;
        const taskM = /^\[([ xX])\]\s+(.*)$/.exec(text);
        if (taskM) { task = taskM[1] !== " "; text = taskM[2]; }
        items.push({ depth, task, text });
        i++;
      }
      const ordered = /^\d/.test(items[0]?.text ?? "") || /\d+[.)]/.test((LIST_RE.exec(lines.find((l) => LIST_RE.test(l)) ?? "")?.[2]) ?? "");
      blocks.push({ t: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|>|#{1,4}\s|(---+|\*\*\*+|___+)\s*$)/.test(lines[i]) && !LIST_RE.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    if (para.length) blocks.push({ t: "p", text: para.join("\n") });
    else i++;
  }
  return blocks;
}

const headingStyle: Record<number, React.CSSProperties> = {
  1: { fontSize: 16, fontWeight: 700, margin: "10px 0 6px" },
  2: { fontSize: 14.5, fontWeight: 700, margin: "10px 0 5px" },
  3: { fontSize: 13, fontWeight: 650, margin: "8px 0 4px" },
  4: { fontSize: 12.5, fontWeight: 650, margin: "8px 0 4px" },
};

/** 主入口：markdown 文本 → React 节点（all-safe，无 HTML 直插）。 */
export function MiniMarkdown({ text }: { text: string }): ReactNode {
  const blocks = parseBlocks(text);
  const out: ReactNode[] = [];
  blocks.forEach((b, bi) => {
    const key = `b${bi}`;
    switch (b.t) {
      case "heading":
        out.push(createElement("div", { key, style: headingStyle[b.level] }, inline(b.text, key)));
        break;
      case "hr":
        out.push(createElement("hr", { key, style: { border: "none", borderTop: "1px solid var(--border)", margin: "8px 0" } }));
        break;
      case "quote":
        out.push(createElement("div", { key, style: { borderLeft: "3px solid var(--border)", paddingLeft: 8, margin: "6px 0", color: "var(--text-muted)" } },
          b.lines.map((l, li) => createElement("div", { key: `${key}-${li}` }, inline(l, `${key}-${li}`)))));
        break;
      case "code":
        out.push(createElement("pre", { key, style: { background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 10px", margin: "6px 0", overflowX: "auto", fontSize: 11, fontFamily: "var(--font-mono)", lineHeight: 1.5 } },
          b.lines.join("\n")));
        break;
      case "list": {
        // 扁平 items → 嵌套渲染（depth ≤2；同层连续项合并为一组）
        const renderItems = (items: typeof b.items, depth: number, kPrefix: string): ReactNode => {
          const nodes: ReactNode[] = [];
          let n = 0;
          for (let idx = 0; idx < items.length;) {
            const it = items[idx];
            if (it.depth < depth) break;
            if (it.depth > depth) {
              const sub: typeof b.items = [];
              while (idx < items.length && items[idx].depth > depth) { sub.push(items[idx]); idx++; }
              nodes.push(createElement(Fragment, { key: `${kPrefix}-s${n++}` }, renderItems(sub, depth + 1, `${kPrefix}-s`)));
              continue;
            }
            const marker = it.task !== null
              ? createElement("input", { key: "c", type: "checkbox", checked: it.task, readOnly: true, style: { marginRight: 5, accentColor: "var(--accent)" } })
              : null;
            nodes.push(createElement("li", { key: `${kPrefix}-l${n++}` },
              marker,
              it.task === null ? createElement("span", { style: { marginRight: 6, color: "var(--text-dim)" } }, b.ordered && depth === 0 ? "" : "•") : null,
              inline(it.text, `${kPrefix}-l${n}`)));
            idx++;
          }
          // 有序清单编号交给 list-style；无序用圆点（task 行不带圆点）
          return createElement(b.ordered && depth === 0 ? "ol" : "ul", {
            key: kPrefix,
            style: { margin: "4px 0 4px 18px", padding: 0, listStyle: b.ordered && depth === 0 ? "decimal" : "none", lineHeight: 1.7, fontSize: 12 },
          }, nodes);
        };
        out.push(renderItems(b.items, 0, key));
        break;
      }
      case "p":
        out.push(createElement("div", { key, style: { margin: "5px 0", lineHeight: 1.65, fontSize: 12.5 } }, inline(b.text, key)));
        break;
    }
  });
  return createElement("div", { "data-mini-markdown": "1" }, out);
}
