"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { apiUrl } from "@/lib/base-path";

import type { CSSProperties, Ref } from "react";
import { encodeFilePathForApi, getFileDirectory, joinFilePath } from "@/lib/file-paths";
import type { ParsedSegment, QuoteOption } from "@/lib/quote-reply";
import { extractFilePaths, formatQuote, type ExtractedPath } from "@/lib/quote-reply";
import { usePopoverActionProviders } from "./ExtSlots";
import type { PopoverAction } from "@/lib/ext/types";

interface Props {
  segments: ParsedSegment[];
  /** Called with the formatted quote-reply text (caller inserts it into the input). */
  onPick: (quote: string) => void;
  /** Full paragraph text — quoted verbatim by the trailing "引用回复" button
   *  (same summary label style as the per-segment ones), shown only when the
   *  segment rows don't already cover the whole paragraph. */
  fullText: string;
  /** Open a file path (from inline paths mentioned in the text). */
  onOpenFile?: (filePath: string, fileName?: string) => void;
  /** Reveal a directory in the sidebar file tree. */
  onRevealDir?: (absPath: string) => void;
  /** Session cwd used to resolve relative paths before checking /api/files. */
  cwd?: string;
  /** 消息角色（user/assistant）——透传给扩展 provider 的 recognize ctx */
  messageRole?: string;
  /** Optional ref to the popover element (caller scrolls it into view on open). */
  innerRef?: Ref<HTMLSpanElement>;
  /** Style overrides for the root element. The caller uses this to switch the
   *  popover to `position: fixed` when it is rendered inside a table row, so
   *  the in-flow box does not spawn a phantom table column and squeeze the
   *  real columns. */
  containerStyle?: CSSProperties;
}

/**
 * A button row for one paragraph's parsed questions. Each question gets its
 * own sub-row: detected options (是/否, A/B, …) when available, otherwise a
 * single fallback "quote" button. Clicking inserts a quoted reply into the
 * input box — never sends.
 */
export function QuoteReplyPopover({ segments, onPick, onOpenFile, onRevealDir, cwd, innerRef, fullText, containerStyle, messageRole }: Props) {
  const { t } = useI18n();
  // Show every segment: closed questions get option buttons, the rest get a
  // fallback quote button. (Any paragraph is quoteable.)
  const questions = segments;
  // Hooks 必须无条件调用——早退只能放在它们之后。调用处守卫 `segments &&
  // segments.length > 0` 挡的是空数组，但 [] 是 truthy，旧写法 `if
  // (questions.length === 0) return null` 在 Hook 之前会让本组件出现
  // “0 个 Hook”渲染路径；一旦同一实例收到非空 segments 就触发
  // “rendered more hooks”崩溃。
  const [existingPaths, setExistingPaths] = useState<ExtractedPath[]>([]);
  useEffect(() => {
    let cancelled = false;
    const allPaths = Array.from(new Set(questions.flatMap((seg) => extractFilePaths(seg.text))));
    Promise.all(
      allPaths.map(async (p) => {
        const abs = p.path.startsWith("/") ? p.path : (cwd ? joinFilePath(cwd, p.path) : p.path);
        try {
          const type = p.isDir ? "list" : "meta";
          const res = await fetch(apiUrl(`/api/files/${encodeFilePathForApi(abs)}?type=${type}`));
          return res.ok ? { path: abs, isDir: p.isDir } : null;
        } catch {
          return null;
        }
      }),
    ).then((found) => {
      if (!cancelled) setExistingPaths(found.filter((f): f is ExtractedPath => !!f));
    });
    return () => { cancelled = true; };
  }, [questions, cwd]);

  // 扩展点：消息点击识别动作 provider（每个 provider 异步识别段落 → 渲染自己的动作区；静默，不显示 loading）
  const popoverProviders = usePopoverActionProviders();
  const [actionsByProvider, setActionsByProvider] = useState<Record<string, PopoverAction[]>>({});
  useEffect(() => {
    let cancelled = false;
    const full = questions.map((seg) => seg.text).join("\n").slice(0, 50000);
    if (!full.trim()) { setActionsByProvider({}); return; }
    const run = async () => {
      const next: Record<string, PopoverAction[]> = {};
      for (const p of popoverProviders) {
        try {
          const acts = await p.recognize(full, { cwd, messageRole });
          if (cancelled) return;
          if (Array.isArray(acts) && acts.length) next[p.id] = acts;
        } catch { /* provider 识别失败静默跳过 */ }
      }
      if (!cancelled) setActionsByProvider(next);
    };
    void run();
    return () => { cancelled = true; };
  }, [questions, cwd, popoverProviders, messageRole]);

  if (questions.length === 0) return null;

  return (
    <span
      ref={innerRef}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 3,
        marginTop: 4,
        width: "fit-content",
        maxWidth: "100%",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 4,
        boxShadow: "0 4px 14px rgba(0,0,0,0.14)",
        ...containerStyle,
      }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
    >
      {(onOpenFile || onRevealDir) && existingPaths.length > 0 && (
        <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {existingPaths.map(({ path: abs, isDir }) => (
            <span key={abs} style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
              {!isDir && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpenFile?.(abs, abs.split("/").pop() ?? abs); }}
                  title={t("i18n.openFile")}
                  style={actionBtnStyle}
                >
                  <FolderOpenIcon />
                  {t("i18n.openFile")}: {abs.split("/").pop()}
                </button>
              )}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRevealDir?.(isDir ? abs : getFileDirectory(abs)); }}
                title={t("export.revealDir")}
                style={actionBtnStyle}
              >
                <FolderIcon />
                {t("export.revealDir")}: {isDir ? abs.split("/").pop() : getFileDirectory(abs).split("/").pop() || abs.split("/").pop()}
              </button>
            </span>
          ))}
        </span>
      )}
      {/* 扩展点动作区：每个 provider 渲染自己的识别结果（type 决定图标：command→＋ 等） */}
      {Object.entries(actionsByProvider).map(([pid, acts]) => (
        <span key={pid} style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
          {acts.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={(e) => { e.stopPropagation(); a.onClick(fullText, cwd); }}
              title={a.title}
              style={{ ...actionBtnStyle, color: a.danger ? "#ef4444" : a.unavailable ? "var(--text-muted)" : "var(--accent)", borderColor: a.danger ? "#fca5a5" : a.unavailable ? "var(--border)" : undefined, opacity: a.unavailable ? 0.75 : undefined }}
            >
              {TYPE_ICON[a.type] ?? ""}{a.unavailable ? " ❌" : ""}{a.danger ? " ⚠" : ""} {a.label}
            </button>
          ))}
        </span>
      ))}
      {questions.map((seg, i) => (
        <SegmentRow key={i} segment={seg} onPick={onPick} t={t} />
      ))}
      {/* Trailing quote for the WHOLE paragraph, shown only when the segment
          rows above don't already cover it: multi-segment paragraphs (each
          row quotes just one part) and single questions with option buttons
          (是/否 etc. — no plain quote row). A single fallback button already
          quotes the whole paragraph, so it is skipped to avoid duplicates. */}
      {(questions.length > 1 || questions[0].options != null) && (
        <SegmentRow segment={{ text: fullText, options: null }} onPick={onPick} t={t} />
      )}
    </span>
  );
}

/** Approximate rendered width in CJK units (full-width/CJK ≈ 1, ASCII/
 *  half-width ≈ 0.55 — at 12px font a CJK glyph is ~12px, ASCII ~6.3px). */
function unitWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += /[\u3000-\u9FFF\uFF00-\uFFEF\u2014\u2018\u2019\u201C\u201D\u2026]/u.test(ch) ? 1 : 0.55;
  }
  return w;
}

/** Head…tail summary of a segment, filling the fallback quote button's text
 *  area so several buttons (one per segment of a multi-segment paragraph)
 *  stay tellable apart. Short text is shown whole.
 *
 *  宽度评估（常规小屏 360–375px）：弹窗在聊天列内（屏宽 − 2×16px ≈ 328–343px），
 *  比按钮自身的 maxWidth:220 还宽，所以瓶颈是按钮宽度而非屏幕。
 *  220 − 左右 padding 18px = 202px 文字区；前缀 “引用回复：”/“Quote reply: ”
 *  约占 60px，留给摘要 ≈ 142px ≈ 12px 字号下 11~12 个全角字符。
 *  预算取 11 单位（全角≈1、半角≈0.55），超出部分由按钮的 CSS
 *  text-overflow: ellipsis 兜底，不会溢出。 */
function summarizeSegment(text: string): string {
  const t = text.trim();
  const BUDGET = 11;
  if (unitWidth(t) <= BUDGET) return t;
  let head = 3;
  let tail = 3;
  while (head + tail < t.length) {
    const wHead = unitWidth(t.slice(0, head + 1)) + 1 + unitWidth(t.slice(-tail));
    const wTail = unitWidth(t.slice(0, head)) + 1 + unitWidth(t.slice(-(tail + 1)));
    if (wHead <= BUDGET && wTail <= BUDGET) {
      // 两侧都能扩展时优先扩展增量更窄的一侧（并列时扩展头部）
      if (unitWidth(t[head] ?? "") <= unitWidth(t[t.length - tail - 1] ?? "")) head++;
      else tail++;
    } else if (wHead <= BUDGET) head++;
    else if (wTail <= BUDGET) tail++;
    else break;
  }
  return `${t.slice(0, head)}…${t.slice(-tail)}`;
}

function SegmentRow({
  segment,
  onPick,
  t,
}: {
  segment: ParsedSegment;
  onPick: (quote: string) => void;
  t: (k: string) => string;
}) {
  // Fallback quote buttons carry the segment's text summary so a popover
  // with multiple quotes shows which paragraph each button refers to.
  const options: QuoteOption[] =
    segment.options ?? [{ label: `${t("chat.quoteReply")}：${summarizeSegment(segment.text)}`, value: "" }];
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {options.map((opt, j) => (
        <button
          key={j}
          onClick={(e) => {
            e.stopPropagation();
            onPick(formatQuote(segment.text, opt.value || undefined));
          }}
          title={segment.text.slice(0, 60)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 9px",
            fontSize: 12,
            color: opt.value ? "var(--accent)" : "var(--text-muted)",
            background: opt.value
              ? "color-mix(in srgb, var(--accent) 10%, transparent)"
              : "var(--bg-hover)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            cursor: "pointer",
            whiteSpace: "nowrap",
            maxWidth: 220,
            overflow: "hidden",
            textOverflow: "ellipsis",
            transition: "background 0.12s, border-color 0.12s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--border)";
          }}
        >
          {opt.label}
        </button>
      ))}
    </span>
  );
}

function FolderOpenIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

const actionBtnStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 9px",
  fontSize: 12,
  color: "var(--accent)",
  background: "color-mix(in srgb, var(--accent) 10%, transparent)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  cursor: "pointer",
  whiteSpace: "nowrap",
  maxWidth: 220,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/** 动作类型 → 图标（quote=问题回复 / file=文件 / command=命令；未知类型无图标） */
const TYPE_ICON: Record<string, string> = {
  quote: "💬",
  file: "📂",
  command: "＋",
};
