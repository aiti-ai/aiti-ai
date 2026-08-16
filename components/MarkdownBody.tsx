"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import { resolveLocalFileHref } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { apiUrl } from "@/lib/base-path";
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeDisplayMath, escapeRawHtmlTags } from "@/lib/markdown";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { QuoteReplyPopover } from "./QuoteReplyPopover";
import { useI18n } from "@/hooks/useI18n";
import { parseParagraph, type ParsedSegment } from "@/lib/quote-reply";

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, fileName?: string) => void;
  /** Reveal a directory in the sidebar file tree (from the popover). */
  onRevealDir?: (absPath: string) => void;
  /** 消息角色（"user" / "assistant" / undefined）——供消息点击识别 provider 判断（如只对用户输入显示收藏按钮） */
  messageRole?: string;
  /** When set (assistant messages), each paragraph becomes hoverable/clickable
   *  to pop a quote-reply popover. */
  onQuoteReply?: (quote: string) => void;
}

/** Exactly one quote-reply popover can be open at a time (per message body). */
const QuoteOpenContext = createContext<{ openId: string | null; setOpenId: (id: string | null) => void }>({
  openId: null,
  setOpenId: () => {},
});

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, onRevealDir, onQuoteReply, messageRole }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => {
    const normalized = normalizeDisplayMath(children);
    // User chat text can start with / embed raw HTML tags as paste artifacts
    // (e.g. aiti-devtools pick-element payloads like `<div> …` / `<button> …`).
    // rehype-raw would nest block/interactive elements inside the paragraph
    // (p > p / p > div) — invalid HTML that React flags as a hydration error.
    // Escape them so rehype-raw becomes a no-op; `&lt;` still renders as `<`.
    return messageRole === "user" ? escapeRawHtmlTags(normalized) : normalized;
  }, [children, messageRole]);
  const [openId, setOpenId] = useState<string | null>(null);
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
    p({ children, ...props }) {
      delete props.node;
      // react-markdown 以组件方式调用这些小写渲染函数（createElement(components.p)），
      // Hook 顺序稳定；rules-of-hooks 只按函数名小写误报。
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const pid = useId();
      if (!onQuoteReply) return <p {...props}>{children}</p>;
      return (
        <QuoteableParagraph pid={pid} onQuoteReply={onQuoteReply} onOpenFile={onOpenFile} onRevealDir={onRevealDir} cwd={cwd} messageRole={messageRole}>
          {children}
        </QuoteableParagraph>
      );
    },
    li({ children, ...props }) {
      delete props.node;
      // react-markdown 以组件方式调用这些小写渲染函数（createElement(components.li)）。
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const pid = useId();
      if (!onQuoteReply) return <li {...props}>{children}</li>;
      return (
        <QuoteableParagraph as="li" pid={pid} onQuoteReply={onQuoteReply} onOpenFile={onOpenFile} onRevealDir={onRevealDir} cwd={cwd} messageRole={messageRole}>
          {children}
        </QuoteableParagraph>
      );
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
    tr({ children, ...props }) {
      delete props.node;
      // react-markdown 以组件方式调用这些小写渲染函数（createElement(components.tr)）。
      // eslint-disable-next-line react-hooks/rules-of-hooks
      const pid = useId();
      if (!onQuoteReply) return <tr {...props}>{children}</tr>;
      return (
        <QuoteableParagraph as="tr" pid={pid} onQuoteReply={onQuoteReply} onOpenFile={onOpenFile} onRevealDir={onRevealDir} cwd={cwd} messageRole={messageRole}>
          {children}
        </QuoteableParagraph>
      );
    },
  }), [cwd, isStreaming, onOpenFile, onRevealDir, onQuoteReply, messageRole]);

  return (
    <QuoteOpenContext.Provider value={{ openId, setOpenId }}>
      <div className={["markdown-body", className].filter(Boolean).join(" ")}>
        <ReactMarkdown
          remarkPlugins={markdownRemarkPlugins}
          rehypePlugins={markdownRehypePlugins}
          components={components}
        >
          {normalizedMarkdown}
        </ReactMarkdown>
      </div>
    </QuoteOpenContext.Provider>
  );
}

/** A <p>/<li> whose plain text is parsed on hover (desktop) / click (mobile)
 *  to pop a quote-reply popover. The parse result is locked once shown so a
 *  streaming tail doesn't make the popover flicker; re-engaging re-parses. */
/** Plain text of a quoteable element, excluding transient UI children (the
 *  follow-mouse tooltip) so the quoted reply isn't polluted. */
function getQuoteText(el: HTMLElement | null): string {
  if (!el) return "";
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-quote-tip]").forEach((n) => n.remove());
  return clone.textContent ?? "";
}

function QuoteableParagraph({ children, onQuoteReply, onOpenFile, onRevealDir, cwd, as = "p", pid, messageRole }: { children: ReactNode; onQuoteReply: (quote: string) => void; onOpenFile?: (filePath: string, fileName?: string) => void; onRevealDir?: (absPath: string) => void; cwd?: string; as?: "p" | "li" | "tr"; pid: string; messageRole?: string }) {
  const { openId, setOpenId } = useContext(QuoteOpenContext);
  const { t } = useI18n();
  const open = openId === pid;
  const ref = useRef<HTMLElement>(null);
  const [segments, setSegments] = useState<ParsedSegment[] | null>(null);
  const [fullText, setFullText] = useState<string>("");
  const [showTip, setShowTip] = useState(false);
  const tipRef = useRef<HTMLSpanElement>(null);
  // When the popover opens inside a table row it must float (position: fixed)
  // so it does not take part in table column sizing — an in-flow box as a
  // direct child of <tr> spawns a phantom column and squeezes the real ones.
  // Null in <p>/<li> (the popover stays in flow there) and until first open.
  const [floatPos, setFloatPos] = useState<{ top: number; left: number } | null>(null);
  // Detect touch capability lazily (same approach as useIsMobile but local).
  const [coarse] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches);

  // Another paragraph opened its popover → close ours (only one popover at a time).
  useEffect(() => {
    if (!open && segments) setSegments(null);
  }, [open, segments]);

  // Ref + scroll-into-view for the popover element (works for both the in-flow
  // and the fixed/floating variants).
  const popoverRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (segments && popoverRef.current) {
      popoverRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [segments]);

  // Keep the floating (table-row) popover glued to its row while the page
  // scrolls or resizes; in-flow popovers (<p>/<li>) need no such tracking.
  useEffect(() => {
    if (as !== "tr" || !segments) return;
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setFloatPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 240)) });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [as, segments]);

  const openPopover = () => {
    if (segments || open) return;
    // For table rows, join cell text with " | " so the quoted line reads like
    // a markdown row instead of all cells mashed together.
    const el = ref.current;
    const text = as === "tr" && el
      ? Array.from(el.querySelectorAll("td, th")).map((c) => (c.textContent ?? "").trim()).join(" | ")
      : getQuoteText(el);
    // Any paragraph is quoteable (not just questions): closed questions get
    // option buttons, everything else gets a fallback quote button.
    const parsed = parseParagraph(text);
    if (parsed.length > 0) {
      setSegments(parsed);
      setFullText(text);
      setOpenId(pid);
      if (as === "tr" && el) {
        const r = el.getBoundingClientRect();
        setFloatPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 240)) });
      }
    }
  };
  const closePopover = () => {
    setSegments(null);
    setFloatPos(null);
    setOpenId(null);
  };
  // Click toggles: show on first click, hide on the second.
  const toggle = () => {
    if (segments) closePopover();
    else openPopover();
  };

  const Tag = as as React.ElementType;
  // The tooltip and popover are overlays (position: fixed) — inside a <tr>
  // they would be invalid <tr> children (hydration error), so render them
  // through a portal to document.body instead.
  const renderOverlay = (node: ReactNode) =>
    as === "tr" && typeof document !== "undefined" ? createPortal(node, document.body) : node;
  // Follow-the-mouse tooltip: position updated imperatively on mousemove (no
  // re-render per move); mouseenter sets it via rAF so it shows even if the
  // pointer doesn't move afterwards.
  const moveTip = (x: number, y: number) => {
    if (tipRef.current) {
      tipRef.current.style.left = `${x + 12}px`;
      tipRef.current.style.top = `${y + 14}px`;
    }
  };
  const showTooltip = (e: MouseEvent<HTMLElement>) => {
    if (coarse) return;
    setShowTip(true);
    const { clientX, clientY } = e;
    requestAnimationFrame(() => moveTip(clientX, clientY));
  };
  const hideTooltip = () => {
    setShowTip(false);
  };
  return (
    <Tag
      ref={ref}
      onMouseEnter={showTooltip}
      onMouseMove={coarse ? undefined : (e: MouseEvent<HTMLElement>) => moveTip(e.clientX, e.clientY)}
      onMouseLeave={hideTooltip}
      onClick={toggle}
      style={{ position: "relative", cursor: "pointer" }}
    >
      {children}
      {renderOverlay(showTip && !segments && (
        <span
          ref={tipRef}
          data-quote-tip
          style={{
            position: "fixed",
            left: -9999,
            top: -9999,
            fontSize: 11,
            color: "var(--text-dim)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "2px 6px",
            pointerEvents: "none",
            zIndex: 50,
            whiteSpace: "nowrap",
          }}
        >
          {t("chat.quoteReplyHint")}
        </span>
      ))}
      {/* segments 可能是 []（truthy）——引用弹窗只在有内容时挂载，否则会走到
          QuoteReplyPopover 的空态早退，改变 Hook 计数。 */}
      {renderOverlay(segments && segments.length > 0 && (
        <QuoteReplyPopover
          innerRef={popoverRef}
          segments={segments}
          fullText={fullText}
          onPick={(q) => { onQuoteReply(q); closePopover(); }}
          onOpenFile={onOpenFile}
          onRevealDir={onRevealDir}
          cwd={cwd}
          messageRole={messageRole}
          containerStyle={as === "tr" && floatPos ? {
            position: "fixed",
            top: floatPos.top,
            left: floatPos.left,
            marginTop: 0,
            zIndex: 60,
          } : undefined}
        />
      ))}
    </Tag>
  );
}
