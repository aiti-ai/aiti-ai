"use client";

import { createContext, memo, useContext, useEffect, useId, useMemo, useRef, useState, type JSX, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import { parsePdfPageFragment, resolveLocalFileHref, shouldOpenLocalFileInApp } from "@/lib/file-links";
import { buildTicketUrl } from "@/lib/file-tickets";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { isAudioPath, isVideoPath } from "@/lib/file-types";
import { createMarkdownUrlTransform, isExternalMarkdownHref, markdownRehypePlugins, markdownRemarkPlugins, markdownUserRemarkPlugins, normalizeDisplayMath, escapeRawHtmlTags } from "@/lib/markdown";
import { useMathMarkdownPlugins } from "@/lib/use-math-plugins";
import { ImagePreview } from "./ImagePreview.tsx";
import { MermaidBlock, CodeBlock } from "./MermaidBlock.tsx";
import { useI18n } from "@/hooks/useI18n";
import { useParagraphClickHandlers } from "./ExtSlots.tsx";

// Minimum interval between two full Markdown parses while streaming: text deltas within
// 200ms are not re-parsed (about 5 times/s).
const STREAM_PARSE_INTERVAL_MS = 200;

const MarkdownLinkContext = createContext(false);

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string, page?: number) => void;
  /** Message role ("user" / "assistant" / undefined) — consumed by the paragraph-click recognizer (e.g. show actions only for user input) */
  messageRole?: string;
  /** Session/message the paragraph belongs to (optional passthrough; filled into ParagraphClickInfo when the extension needs it) */
  sessionId?: string;
  messageId?: string;
  /** A document reader's own links: relative paths and `#headings` stay in the reader. */
  onNavigateLink?: (href: string) => void;
  /** Render every line ending as a line break, for text the user typed. */
  keepLineBreaks?: boolean;
}

/** Click candidates among semantic blocks (core only provides the render shell; which tags are clickable is declared via extension handler.tags) */
const CLICKABLE_TAGS = ["p", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"] as const;
type ClickableTag = (typeof CLICKABLE_TAGS)[number];

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, onNavigateLink, keepLineBreaks, messageRole, sessionId, messageId }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => {
    const normalized = normalizeDisplayMath(children);
    // User chat text can start with / embed raw HTML tags as paste artifacts
    // (e.g. aiti-devtools pick-element payloads like `<div> …` / `<button> …`).
    // rehype-raw would nest block/interactive elements inside the paragraph
    // (p > p / p > div) — invalid HTML that React flags as a hydration error.
    // Escape them so rehype-raw becomes a no-op; `&lt;` still renders as `<`.
    return messageRole === "user" ? escapeRawHtmlTags(normalized) : normalized;
  }, [children, messageRole]);
  // Throttled parsing while streaming: during streaming children grow every frame (rAF-coalesced
  // deltas); handing them straight to ReactMarkdown would re-parse the accumulated text every
  // frame (O(n²); long streams = main-thread spikes). Here the latest text is handed to
  // ReactMarkdown at most every 200ms (it caches parse results per children internally) —
  // intermediate frames skip parsing entirely and the tail text is caught up shortly after.
  // Non-streaming (history messages / stream finished) always parses the final text immediately.
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
      // Throttle window not yet elapsed: schedule one re-check to catch up with the latest text (also picks up parsing after deltas stop).
      const t = setTimeout(() => {
        lastParseTs.current = performance.now();
        setRenderText(normalizedMarkdown);
      }, STREAM_PARSE_INTERVAL_MS - (now - lastParseTs.current));
      return () => clearTimeout(t);
    }
  }, [normalizedMarkdown, isStreaming]);
  // Thin extension point for paragraph clicks: when handlers are registered (extensions loaded) semantic blocks become clickable; without extensions paragraphs render as plain elements.
  const handlers = useParagraphClickHandlers();
  // Math plugins loaded on demand (P1.2): katex/remark-math are not pulled in when the body has no math markers (saves ~300KB on first paint)
  // Upstream keepLineBreaks (typed line breaks in user messages): swap in the plugin list containing remarkKeepLineBreaks, math plugins are still appended on demand
  const { remark: activeRemarkPlugins, rehype: activeRehypePlugins } = useMathMarkdownPlugins(
    renderText,
    keepLineBreaks ? markdownUserRemarkPlugins : markdownRemarkPlugins,
    markdownRehypePlugins,
  );
  // data:image and desktop-app links are allowed in both branches (img src → preview/viewer); file: only when an in-app file handler exists
  const urlTransform = useMemo(() => createMarkdownUrlTransform(Boolean(onOpenFile)), [onOpenFile]);
  const hasClickHandlers = handlers.length > 0;
  // Clickable tags = union of what extensions declare (handler.tags; defaults to p/li/tr when undeclared). Core hardcodes no business rules —
  // new cases like headings/quote blocks take effect as soon as an extension declares them, no core change needed.
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
      if (onNavigateLink && href && !isExternalMarkdownHref(href)) {
        // No href: a middle-click or "Open in new tab" would load the path on the app's own URL.
        const navigate = () => onNavigateLink(href);
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a {...props} role="link" tabIndex={0} onClick={navigate} onKeyDown={(event) => { if (event.key === "Enter") navigate(); }}>
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }
      if (href?.startsWith("#")) {
        // An in-page link: never a second tab of Pi Web.
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a href={href} {...props} onClick={jumpToMarkdownFragment}>
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }
      const filePath = onOpenFile ? resolveLocalFileHref(href, cwd) : null;
      const openFile = onOpenFile;
      if (!filePath || !openFile) {
        return (
          <MarkdownLinkContext.Provider value={true}>
            <a href={href} {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          </MarkdownLinkContext.Provider>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!shouldOpenLocalFileInApp(event)) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(filePath, parsePdfPageFragment(href) ?? undefined);
      };

      return (
        <MarkdownLinkContext.Provider value={true}>
          <a href={href} {...props} onClick={handleClick}>
            {children}
          </a>
        </MarkdownLinkContext.Provider>
      );
    },
    img({ src, alt, ...props }) {
      delete props.node;
      // Audio/video inline playback (upstream #1280): `![take 2](out/take2.wav)` is how a model
      // shows a sound or clip it made, and an <img> cannot play it. The file API already streams
      // both kinds with range requests, so pick the element by the file's kind. Local paths go
      // through the ticket contract like every other file URL (fork rule: paths never enter URLs) —
      // a hook may not run inside this callback, so the local case delegates to <LocalMedia>.
      const mediaHref = typeof src === "string" ? src : undefined;
      const mediaFilePath = mediaHref ? resolveLocalFileHref(mediaHref, cwd) : null;
      const mediaPath = mediaFilePath ?? mediaHref?.split(/[?#]/, 1)[0] ?? "";
      if (isAudioPath(mediaPath) || isVideoPath(mediaPath)) {
        const label = alt?.trim() ? alt : undefined;
        if (mediaFilePath) {
          return <LocalMedia filePath={mediaFilePath} kind={isAudioPath(mediaPath) ? "audio" : "video"} alt={label} />;
        }
        if (isAudioPath(mediaPath)) return <audio controls preload="metadata" src={mediaHref} aria-label={label} />;
        return <video controls playsInline preload="metadata" src={mediaHref} aria-label={label} />;
      }
      // Image inside a link: the link's own navigation wins, no preview click layer added (upstream behavior).
      const insideLink = useContext(MarkdownLinkContext);
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      if (!filePath) {
        // Remote / data URL images: wrap in ImagePreview — click first goes to the file-editor extension's unified viewer,
        // falls back to the native lightbox when the extension is unavailable (upstream behavior). stopPropagation sits on the wrapper
        // layer, preventing the paragraph-click recognizer (quote popup) from firing at the same time.
        const previewable = typeof src === "string" && !insideLink;
        const image = (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt={alt ?? ""} loading="lazy" {...props} />
        );
        if (!previewable) return image;
        return (
          <span onClick={(event) => event.stopPropagation()}>
            <ImagePreview src={src} alt={alt ?? ""} className="markdown-image">
              {image}
            </ImagePreview>
          </span>
        );
      }
      // Local images: the path never enters a URL; a short-lived ticket is exchanged for a GET address; click → right-side file panel (same as file links).
      // LocalImage spreads {...props} onto the img, so onClick/style pass through here.
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
    ol({ node, start, style, ...props }) {
      // An outside marker wider than the list's left padding is clipped by
      // .markdown-body's overflow-x, so the padding follows the largest number.
      const items = node?.children.filter((child) => child.type === "element" && child.tagName === "li").length ?? 0;
      const digits = String(Math.abs((start ?? 1) + Math.max(items, 1) - 1)).length;
      return <ol start={start} style={{ ...style, ["--ol-marker-digits" as string]: Math.max(digits, 2) }} {...props} />;
    },
    // react-markdown invokes these lowercase render functions as components (createElement(components.p)),
    // so hook order stays stable; rules-of-hooks false-positives purely on the lowercase function name.
    // Candidate tags uniformly get a render shell: whether to wrap in ClickableParagraph is decided by
    // the clickTags extensions declare (core holds no business judgment).
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
      // The frame draws the border; the scroller inside it fades its scrolled
      // edges, which on the bordered box would fade the border too.
      return (
        <div className="markdown-table-frame">
          <div className="markdown-table-wrap">
            <table>{children}</table>
          </div>
        </div>
      );
    },
  }), [cwd, isStreaming, onOpenFile, onNavigateLink, messageRole, handlers, clickTags, messageId, sessionId]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <MemoizedMarkdown
        remarkPlugins={activeRemarkPlugins}
        rehypePlugins={activeRehypePlugins}
        urlTransform={urlTransform}
        components={components}
      >
        {renderText}
      </MemoizedMarkdown>
    </div>
  );
}

// react-markdown v9's Markdown component re-runs parse+runSync on every render (no internal cache) —
// while streaming, MarkdownBody re-renders every frame (even when renderText is unchanged) and would
// fully re-parse each time. Wrap it in memo: skip parsing entirely when children (renderText) and the
// plugins/components references are stable.
const MemoizedMarkdown = memo(function MemoizedMarkdown({ children, ...props }: Options & { children: string }) {
  return <ReactMarkdown {...props}>{children}</ReactMarkdown>;
});

/**
 * Thin extension point for paragraph clicks (clickable p/li/tr + click event broadcast +
 * setInline mount point + hover hint). Recognition / popup rendering / actions / dismissal all
 * live on the extension side; core only provides: clickable paragraphs, handing the full context
 * to the handler, and in-paragraph inline mounting (in-flow; tr auto-portals to body).
 * Positioning and scroll-following belong to the extension.
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

/** Local audio/video player (upstream #1280 × fork ticket contract): the media src is a
 *  short-lived ticket URL, same as LocalImage's — never a plaintext path. */
function LocalMedia({ filePath, kind, alt }: { filePath: string; kind: "audio" | "video"; alt?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    buildTicketUrl(filePath, "read")
      .then((u) => { if (alive) setSrc(u); })
      .catch(() => { if (alive) setSrc(null); });
    return () => { alive = false; };
  }, [filePath]);
  return kind === "audio"
    ? <audio controls preload="metadata" src={src ?? undefined} aria-label={alt} />
    : <video controls playsInline preload="metadata" src={src ?? undefined} aria-label={alt} />;
}

function ClickableParagraph({ children, as = "p", messageRole, cwd, sessionId, messageId }: { children: ReactNode; as?: ClickableTag; messageRole?: string; cwd?: string; sessionId?: string; messageId?: string }) {
  const handlers = useParagraphClickHandlers();
  const pid = useId(); // stable paragraph id: stays stable across renders while the React tree structure is unchanged (used by extensions for toggle/dedupe)
  const ref = useRef<HTMLElement>(null);
  // Inline expansion node injected into the paragraph by extensions via info.setInline (recognition result / action bar; null = not expanded).
  const [inlineNode, setInlineNode] = useState<ReactNode | null>(null);
  const [showTip, setShowTip] = useState(false);
  const tipRef = useRef<HTMLSpanElement>(null);
  // Tip text comes from the hint of the handler registered by the extension (core holds no quote-reply copy)
  const tipText = handlers.map((h) => h.hint).find(Boolean) ?? "";
  // Detect touch capability lazily (same approach as useIsMobile but local).
  const [coarse] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches);

  const handleClick = () => {
    // Paragraph plain text (table row = cells joined with " | "); the clone excludes transient UI children (the tip).
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
      try { h(info); } catch { /* a single failing handler doesn't affect other extensions */ }
    }
  };

  // Mouse-following tip (the visual contract for clickable paragraphs); not shown for coarse pointers (touch).
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
  // For p/li the inline expansion renders after the paragraph (as a sibling, avoiding invalid <p><div> HTML / hydration errors);
  // rendering a div in-flow inside a tr would break the table structure → portal to body (positioning managed by the extension itself).
  const inline = as === "tr" && typeof document !== "undefined"
    ? createPortal(inlineNode, document.body)
    : inlineNode;
  // The tip is always portaled to body (position: fixed is out of flow anyway): inserting it as a DOM sibling
  // of p/li inside markdown-body/blockquote would break the original :last-child — `.markdown-body p:last-child
  // { margin-bottom: 0 }` stops matching, the paragraph's 8px bottom margin returns → content shifts 8px on hover (reproduced in testing).
  // Attached to body, the markdown DOM tree stays intact, the :last-child rule is unaffected, and the fixed positioning looks identical.
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
