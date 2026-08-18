"use client";

/**
 * 代码行级点击薄扩展点（core）：任意 <pre> 挂 onClick → 按 y 坐标 + 计算样式
 * 算行号 → 广播该行文本（ParagraphClick 同款 info，含 rowIndex/element/setInline）。
 *
 * 使用方：MarkdownBody CodeBlock（markdown 代码块）、MessageView ToolCallBlock/
 * PairedResult/CustomMessageView（工具参数/结果/details）——行高/内边距由
 * getComputedStyle 实时取，各处字号规格不同也精确。识别/弹层/定位全在扩展。
 */
import { useId, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useParagraphClickHandlers } from "@/components/ExtSlots";

export interface CodeLineClickOptions {
  code: string;
  messageRole?: string;
  cwd?: string;
  sessionId?: string;
  messageId?: string;
  /** 显式禁用（默认：有 handler 且非 user 即可点） */
  enabled?: boolean;
}

/** 行几何（计算样式）：pre 规格各异（CodeBlock 12.5/1.62/11 vs 工具调用 12/1.5/8），实时取最准 */
function lineMetrics(el: HTMLElement): { lineH: number; padTop: number } {
  const cs = getComputedStyle(el);
  const fs = parseFloat(cs.fontSize) || 12;
  const lh = parseFloat(cs.lineHeight) || Math.round(fs * 1.5);
  return { lineH: Math.max(1, lh), padTop: parseFloat(cs.paddingTop) || 0 };
}

export function useCodeLineClick(opts: CodeLineClickOptions) {
  const handlers = useParagraphClickHandlers();
  const clickable = handlers.length > 0 && opts.enabled !== false && opts.messageRole !== "user";
  const [inlineNode, setInlineNode] = useState<ReactNode | null>(null);
  const pid = useId();

  const handlePreClick = (e: MouseEvent<HTMLPreElement>) => {
    if (!clickable) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    const { lineH, padTop } = lineMetrics(el);
    const row = Math.floor((e.clientY - rect.top - padTop) / lineH);
    const lines = opts.code.split("\n");
    if (row < 0 || row >= lines.length) return;
    const lineText = lines[row].trim();
    if (!lineText) return;
    const info = {
      text: lineText,
      cwd: opts.cwd,
      messageRole: opts.messageRole,
      rect: { top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width },
      element: el,
      rowIndex: row,
      paragraphId: `code:${pid}:${row}`,
      sessionId: opts.sessionId,
      messageId: opts.messageId,
      setInline: setInlineNode,
      close: () => setInlineNode(null),
    };
    for (const h of handlers) {
      try { h(info); } catch { /* 单 handler 异常不影响其他扩展 */ }
    }
  };

  // pre 内不能插块级 → portal 到 body（定位由扩展自管，与 tr 浮层同机制）
  const inline = typeof document !== "undefined" ? createPortal(inlineNode, document.body) : inlineNode;

  return { clickable, handlePreClick, inline };
}
