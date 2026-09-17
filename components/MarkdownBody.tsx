"use client";

import { memo, useEffect, useId, useMemo, useRef, useState, type JSX, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import { resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { buildTicketUrl } from "@/lib/file-tickets";
import { markdownDataImageUrlTransform, markdownRehypePlugins, markdownRemarkPlugins, markdownUrlTransform, normalizeDisplayMath, escapeRawHtmlTags } from "@/lib/markdown";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { useI18n } from "@/hooks/useI18n";
import { useParagraphClickHandlers } from "./ExtSlots";
import { openImageInEditorViewer } from "./editor-image-preview";

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

/** 语义块点击候选（core 只提供渲染壳；哪些标签可点由扩展 handler.tags 声明过滤） */
const CLICKABLE_TAGS = ["p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"] as const;
type ClickableTag = (typeof CLICKABLE_TAGS)[number];

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
  // 段落点击薄扩展点：有 handler 注册（扩展加载）时语义块可点击；无扩展时段落渲染普通元素。
  const handlers = useParagraphClickHandlers();
  const hasClickHandlers = handlers.length > 0;
  // 可点击标签 = 扩展声明的并集（handler.tags；未声明默认 p/li/tr）。core 不硬编码业务——
  // 标题/引用块等新场景由扩展声明即生效，无需改 core。
  const clickTags = useMemo(() => {
    const set = new Set<string>();
    for (const h of handlers) for (const t of h.tags ?? ["p", "li", "tr"]) set.add(t);
    return set;
  }, [handlers]);
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    code({ className, children, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return (
            <MermaidBlock
              code={raw.replace(/\n$/, "")}
              isStreaming={isStreaming}
              defaultPreview
            />
          );
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} messageRole={messageRole} cwd={cwd} sessionId={sessionId} messageId={messageId} />;
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
        if (!shouldOpenLocalFileInApp(event)) return;
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
      if (!filePath) {
        // 远程 / data URL 图片：点击 → aiti-editor 统一查看器（扩展不可用/未实现时保持无动作）。
        const previewable = typeof src === "string";
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={alt ?? ""}
            loading="lazy"
            {...props}
            // stopPropagation：不让段落点击识别器（quote 弹层）同时触发
            onClick={previewable ? (e) => { e.stopPropagation(); void openImageInEditorViewer(src as string, { alt: alt ?? "" }); } : undefined}
            style={{ ...props.style, ...(previewable ? { cursor: "zoom-in" as const } : null) }}
          />
        );
      }
      // 本地图片：路径不进 URL，经短时效票据换 GET 地址；点击 → 右栏文件面板（同文件链接）。
      // LocalImage 内部把 {...props} 落到 img 上，onClick/style 经此透传。
      return (
        <LocalImage
          filePath={filePath}
          alt={alt ?? ""}
          {...props}
          onClick={onOpenFile ? (e) => { e.stopPropagation(); onOpenFile(filePath); } : undefined}
          style={{ ...props.style, ...(onOpenFile ? { cursor: "zoom-in" as const } : null) }}
        />
      );
    },
    // react-markdown 以组件方式调用这些小写渲染函数（createElement(components.p)），
    // Hook 顺序稳定；rules-of-hooks 只按函数名小写误报。候选标签统一生成渲染壳：
    // 是否包 ClickableParagraph 由「扩展声明 clickTags」决定（core 不持有业务判断）。
    // eslint-disable-next-line react-hooks/rules-of-hooks
    ...CLICKABLE_TAGS.reduce((acc, tag) => {
      acc[tag] = ({ children, ...props }) => {
        delete props.node;
        const enabled = hasClickHandlers && clickTags.has(tag) && messageRole !== "user";
        if (!enabled) {
          const Tag = tag as keyof JSX.IntrinsicElements;
          return <Tag {...props}>{children}</Tag>;
        }
        return <ClickableParagraph as={tag} messageRole={messageRole} cwd={cwd} sessionId={sessionId} messageId={messageId}>{children}</ClickableParagraph>;
      };
      return acc;
    }, {} as Record<string, (p: { children?: ReactNode; [k: string]: unknown }) => ReactNode>),
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  }), [cwd, isStreaming, onOpenFile, messageRole, handlers, clickTags, messageId, sessionId]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <MemoizedMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={markdownRehypePlugins}
        // 两种分支都放行 data:image（img src → aiti-editor 查看器）；file: 仅在应用内文件处理器存在时放行
        urlTransform={onOpenFile ? markdownUrlTransform : markdownDataImageUrlTransform}
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
function LocalImage({ filePath, alt, ...props }: { filePath: string; alt: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    buildTicketUrl(filePath, "read")
      .then((u) => { if (alive) setSrc(u); })
      .catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [filePath]);
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src ?? undefined} alt={alt} loading="lazy" {...props} />;
}

function ClickableParagraph({ children, as = "p", messageRole, cwd, sessionId, messageId }: { children: ReactNode; as?: ClickableTag; messageRole?: string; cwd?: string; sessionId?: string; messageId?: string }) {
  const handlers = useParagraphClickHandlers();
  const pid = useId(); // 段落稳定标识：React 树结构不变时跨渲染稳定（扩展 toggle/去重用）
  const ref = useRef<HTMLElement>(null);
  // 扩展经 info.setInline 注入的段落内联展开节点（识别结果/动作条；null = 未展开）。
  const [inlineNode, setInlineNode] = useState<ReactNode | null>(null);
  const [showTip, setShowTip] = useState(false);
  const tipRef = useRef<HTMLSpanElement>(null);
  // tip 文案由扩展注册 handler 的 hint 提供（core 不持有 quote-reply 语义文案）
  const tipText = handlers.map((h) => h.hint).find(Boolean) ?? "";
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
  const tip = showTip && !inlineNode && tipText && (
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
      {tipText}
    </span>
  );
  // p/li 的 inline 展开渲染在段落之后（sibling，避免 <p><div> 无效 HTML/hydration 错）；
  // tr 内 in-flow 渲染 div 会破坏表格结构 → portal 到 body（定位由扩展自管）。
  const inline = as === "tr" && typeof document !== "undefined"
    ? createPortal(inlineNode, document.body)
    : inlineNode;
  // tip 一律 portal 到 body（position: fixed 本来就脱离文档流）：若作为 p/li 的 DOM 兄弟插入
  // markdown-body/blockquote 内部，会让原 :last-child 失效——`.markdown-body p:last-child
  // { margin-bottom: 0 }` 停止匹配，段落 8px 底边距恢复 → hover 时内容被撑开 8px（实测复现）。
  // 挂到 body 后 markdown DOM 树保持原样，:last-child 规则不受影响；fixed 定位视觉不变。
  const tipOut = tip && typeof document !== "undefined"
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