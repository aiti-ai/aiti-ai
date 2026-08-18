"use client";

import { memo, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { apiUrl } from "@/lib/base-path";
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeDisplayMath, escapeRawHtmlTags } from "@/lib/markdown";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { useI18n } from "@/hooks/useI18n";
import { useParagraphClickHandlers } from "./ExtSlots";

// 流式期间两次全量 Markdown 解析的最小间隔：200ms 内文本增量不重解析（约 5 次/s）。
const STREAM_PARSE_INTERVAL_MS = 200;

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, fileName?: string) => void;
  /** 消息角色（"user" / "assistant" / undefined）——供段落点击识别器判断（如只对用户输入显示动作） */
  messageRole?: string;
  /** 段落所在会话/消息（可选透传，扩展需要时填写进 ParagraphClickInfo） */
  sessionId?: string;
  messageId?: string;
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, messageRole, sessionId, messageId }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => {
    const normalized = normalizeDisplayMath(children);
    // User chat text can start with / embed raw HTML tags as paste artifacts
    // (e.g. aiti-devtools pick-element payloads like `<div> …` / `<button> …`).
    // rehype-raw would nest block/interactive elements inside the paragraph
    // (p > p / p > div) — invalid HTML that React flags as a hydration error.
    // Escape them so rehype-raw becomes a no-op; `&lt;` still renders as `<`.
    return messageRole === "user" ? escapeRawHtmlTags(normalized) : normalized;
  }, [children, messageRole]);
  // 流式节流解析：流式期间 children 每帧增长（rAF 合并的 delta），直接交给 ReactMarkdown
  // 会每帧全量重解析累计文本（O(n²)，长流式=主线程尖峰）。这里至少间隔 200ms 才把最新文本
  // 交给 ReactMarkdown（其内部按 children 缓存解析结果）——中间帧解析直接跳过，尾部文本稍后补上。
  // 非流式（历史消息/流式结束）始终立即解析最终文本。
  const [renderText, setRenderText] = useState(normalizedMarkdown);
  const lastParseTs = useRef(0);
  useEffect(() => {
    if (!isStreaming) {
      setRenderText(normalizedMarkdown);
      return;
    }
    const now = performance.now();
    if (now - lastParseTs.current >= STREAM_PARSE_INTERVAL_MS) {
      lastParseTs.current = now;
      setRenderText(normalizedMarkdown);
    } else {
      // 未到节流窗口：定时复查一次，确保跟上最新文本（delta 停止后也会补解析）。
      const t = setTimeout(() => {
        lastParseTs.current = performance.now();
        setRenderText(normalizedMarkdown);
      }, STREAM_PARSE_INTERVAL_MS - (now - lastParseTs.current));
      return () => clearTimeout(t);
    }
  }, [normalizedMarkdown, isStreaming]);
  // 段落点击薄扩展点：有 handler 注册（扩展加载）时段落可点击；无扩展时段落渲染普通元素。
  const hasClickHandlers = useParagraphClickHandlers().length > 0;
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} />;
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <a href={href} {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath);
      };

      return (
        <a href={href} {...props} onClick={handleClick}>
          {children}
        </a>
      );
    },
    img({ src, alt, ...props }) {
      delete props.node;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? apiUrl(`/api/files/${encodeFilePathForApi(filePath)}?type=read`)
        : src;
      // Dynamic local paths are served directly by the file API.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
    },
    // react-markdown 以组件方式调用这些小写渲染函数（createElement(components.p)），
    // Hook 顺序稳定；rules-of-hooks 只按函数名小写误报。
    // eslint-disable-next-line react-hooks/rules-of-hooks
    p({ children, ...props }) {
      delete props.node;
      if (!hasClickHandlers) return <p {...props}>{children}</p>;
      return <ClickableParagraph as="p" messageRole={messageRole} cwd={cwd} sessionId={sessionId} messageId={messageId}>{children}</ClickableParagraph>;
    },
    // eslint-disable-next-line react-hooks/rules-of-hooks
    li({ children, ...props }) {
      delete props.node;
      if (!hasClickHandlers) return <li {...props}>{children}</li>;
      return <ClickableParagraph as="li" messageRole={messageRole} cwd={cwd} sessionId={sessionId} messageId={messageId}>{children}</ClickableParagraph>;
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
    // eslint-disable-next-line react-hooks/rules-of-hooks
    tr({ children, ...props }) {
      delete props.node;
      if (!hasClickHandlers) return <tr {...props}>{children}</tr>;
      return <ClickableParagraph as="tr" messageRole={messageRole} cwd={cwd} sessionId={sessionId} messageId={messageId}>{children}</ClickableParagraph>;
    },
  }), [cwd, isStreaming, onOpenFile, messageRole, hasClickHandlers]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <MemoizedMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        components={components}
      >
        {renderText}
      </MemoizedMarkdown>
    </div>
  );
}

// react-markdown v9 的 Markdown 组件每次渲染都重跑 parse+runSync（无内部缓存）——
// 流式期间 MarkdownBody 每帧 re-render（即使 renderText 未变）也会全量重解析。
// 包一层 memo：children（renderText）与 plugins/components 引用稳定时直接跳过解析。
const MemoizedMarkdown = memo(function MemoizedMarkdown({ children, ...props }: Options & { children: string }) {
  return <ReactMarkdown {...props}>{children}</ReactMarkdown>;
});

/**
 * 段落点击薄扩展点（p/li/tr 可点击 + 点击事件广播 + setInline 挂载点 + hover 提示）。
 * 识别/弹层渲染/动作/关闭全在扩展侧；core 只提供：段落可点击、把完整上下文交给
 * handler、段落内联挂载（in-flow / tr 自动 portal 到 body）。定位/滚动跟随归扩展。
 */
function ClickableParagraph({ children, as = "p", messageRole, cwd, sessionId, messageId }: { children: ReactNode; as?: "p" | "li" | "tr"; messageRole?: string; cwd?: string; sessionId?: string; messageId?: string }) {
  const handlers = useParagraphClickHandlers();
  const pid = useId(); // 段落稳定标识：React 树结构不变时跨渲染稳定（扩展 toggle/去重用）
  const ref = useRef<HTMLElement>(null);
  // 扩展经 info.setInline 注入的段落内联展开节点（识别结果/动作条；null = 未展开）。
  const [inlineNode, setInlineNode] = useState<ReactNode | null>(null);
  const [showTip, setShowTip] = useState(false);
  const tipRef = useRef<HTMLSpanElement>(null);
  const { t } = useI18n();
  // Detect touch capability lazily (same approach as useIsMobile but local).
  const [coarse] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches);

  const handleClick = () => {
    // 段落纯文本（表格行 = 单元格 " | " 连接）；克隆排除瞬态 UI 子元素（提示）。
    const el = ref.current;
    const text = as === "tr" && el
      ? Array.from(el.querySelectorAll("td, th")).map((c) => (c.textContent ?? "").trim()).join(" | ")
      : (() => {
        if (!el) return "";
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("[data-quote-tip]").forEach((n) => n.remove());
        return clone.textContent ?? "";
      })();
    if (!text.trim()) return;
    const r = el?.getBoundingClientRect();
    const info = {
      text,
      cwd,
      messageRole,
      rect: r ? { top: r.top, left: r.left, bottom: r.bottom, width: r.width } : { top: 0, left: 0, bottom: 0, width: 0 },
      element: el ?? undefined,
      paragraphId: pid,
      sessionId,
      messageId,
      setInline: setInlineNode,
      close: () => setInlineNode(null),
    };
    for (const h of handlers) {
      try { h(info); } catch { /* 单 handler 异常不影响其他扩展 */ }
    }
  };

  // 鼠标跟随提示（段落可点击的视觉契约）；coarse 指针（触屏）不显示。
  const moveTip = (x: number, y: number) => {
    if (tipRef.current) { tipRef.current.style.left = `${x + 12}px`; tipRef.current.style.top = `${y + 14}px`; }
  };
  const showTooltip = (e: MouseEvent<HTMLElement>) => {
    if (coarse) return;
    setShowTip(true);
    requestAnimationFrame(() => moveTip(e.clientX, e.clientY));
  };

  const Tag = as as React.ElementType;
  const tip = showTip && !inlineNode && (
    <span
      ref={tipRef}
      data-quote-tip
      style={{
        position: "fixed", left: -9999, top: -9999,
        fontSize: 11, color: "var(--text-dim)", background: "var(--bg-panel)",
        border: "1px solid var(--border)", borderRadius: 4, padding: "2px 6px",
        pointerEvents: "none", zIndex: 50, whiteSpace: "nowrap",
      }}
    >
      {t("chat.quoteReplyHint")}
    </span>
  );
  // p/li 的 inline 展开渲染在段落之后（sibling，避免 <p><div> 无效 HTML/hydration 错）；
  // tr 内 in-flow 渲染 div 会破坏表格结构 → portal 到 body（定位由扩展自管）。
  const inline = as === "tr" && typeof document !== "undefined"
    ? createPortal(inlineNode, document.body)
    : inlineNode;
  // tip 同理：<span> 不能是 <tr> 的子元素（否则 hydration 报错）→ tr 时 portal 到 body。
  const tipOut = as === "tr" && tip && typeof document !== "undefined"
    ? createPortal(tip, document.body)
    : tip;

  return (
    <>
      <Tag
        ref={ref}
        onMouseEnter={showTooltip}
        onMouseMove={coarse ? undefined : (e: MouseEvent<HTMLElement>) => moveTip(e.clientX, e.clientY)}
        onMouseLeave={() => setShowTip(false)}
        onMouseDown={() => setShowTip(false)}
        onClick={handleClick}
        style={{ position: "relative", cursor: "pointer" }}
      >
        {children}
      </Tag>
      {tipOut}
      {inline}
    </>
  );
}