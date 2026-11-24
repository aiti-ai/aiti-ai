/**
 * aiti-editor · large-file surfaces (info card + chunked plain-text viewer).
 *
 * Why: a 2MB session export currently freezes the page (JSON outline was O(n²), and the
 * whole file was loaded into Monaco / edit cache). Above 2MB we no longer load the file by
 * default: the tab shows a stable info card, and content is only fetched when the user asks
 * for "show part (read-only)" — one line-aligned window at a time.
 *
 * Design notes:
 * - read-only, plain text; no Monaco, no syntax highlighting, no preview, no cache;
 * - `@` mentioning keeps working: the file tab still exists, and the card/viewer offer
 *   explicit "reference in chat" actions (`@path` / `@path#Lx-Ly`);
 * - info card is a stable state, not an error state (refresh/tab switch/multi-open safe).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { editorBase, ensureEditorTicket, t } from "./host-shim";
import { formatSize } from "./lib";
import { TEXT_WINDOW_CHUNK_BYTES, WINDOW_PAGE_LINES } from "../../shared/limits";
import { uiConfirm } from "../../../_shared/ui-dialogs";

const mono = "var(--font-mono, ui-monospace, monospace)";

const btn: any = {
  padding: "5px 11px", borderRadius: 6, border: "1px solid var(--border,#d0d0d0)",
  background: "var(--bg,#fff)", color: "var(--text,#222)", cursor: "pointer", fontSize: 12,
};
const btnPrimary: any = { ...btn, borderColor: "var(--accent,#4f8ef7)", color: "var(--accent,#4f8ef7)", fontWeight: 600 };

function fmtTime(ms: number): string {
  try { return ms ? new Date(ms).toLocaleString() : "—"; } catch { return "—"; }
}

export interface LargeFileInfoProps {
  filePath: string;
  size: number;
  mtimeMs: number;
  lineCount: number | null;
  canEdit: boolean;
  /** Offer "I know the risk, open anyway" (beyond the Monaco ceiling, within forceMaxMB). */
  canForce: boolean;
  forceMaxMB: number;
  /** A large /raw read is in flight (the card must show progress, not look dead). */
  busy?: boolean;
  onOpenViewer: () => void;
  onOpenEditor: () => void;
  onForceOpen: () => void;
  onDownload: () => void;
  onCopyPath: () => void;
  onMention: () => void;
}

export function LargeFileInfo(props: LargeFileInfoProps): unknown {
  const name = props.filePath.split(/[\\/]/).pop() || props.filePath;
  const dir = props.filePath.slice(0, props.filePath.lastIndexOf("/")) || "/";
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: 560, maxWidth: "94vw", border: "1px solid var(--border,#ddd)", borderRadius: 12, padding: "18px 20px", background: "var(--bg,#fff)", boxShadow: "0 10px 30px rgba(0,0,0,0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 18 }}>📄</span>
          <span style={{ fontWeight: 600, fontSize: 14, wordBreak: "break-all", fontFamily: mono }}>{name}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12, color: "var(--text-dim,#777)", marginBottom: 12 }}>
          <span>{t("大小")}</span><span style={{ color: "var(--text,#222)" }}>{formatSize(props.size)}</span>
          <span>{t("修改时间")}</span><span style={{ color: "var(--text,#222)" }}>{fmtTime(props.mtimeMs)}</span>
          <span>{t("行数")}</span><span style={{ color: "var(--text,#222)" }}>{props.lineCount != null ? String(props.lineCount) : t("统计中…")}</span>
          <span>{t("目录")}</span><span style={{ color: "var(--text,#222)", fontFamily: mono, wordBreak: "break-all" }}>{dir}</span>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text,#222)", marginBottom: 14 }}>
          {t("文件较大（{size}），已暂停加载全文，避免页面卡顿。", { size: formatSize(props.size) })}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" style={btnPrimary} disabled={props.busy} onClick={props.onOpenViewer}>{t("只显示部分（只读）")}</button>
          {props.canEdit && <button type="button" style={btn} disabled={props.busy} onClick={props.onOpenEditor}>{t("用编辑器打开（只读）")}</button>}
          {!props.canEdit && props.canForce && (
            <button
              type="button"
              disabled={props.busy}
              style={{ ...btn, borderColor: "var(--warn,#d97706)", color: "var(--warn,#d97706)" }}
              onClick={async () => {
                const ok = await uiConfirm({
                  title: t("用编辑器打开大文件？"),
                  message: t("文件 {size} 超过编辑器安全上限。强制打开会占用大量内存，页面可能明显卡顿甚至无响应（上限 {max}MB）。确定继续？", { size: formatSize(props.size), max: props.forceMaxMB }),
                  danger: true,
                  confirmText: t("我了解风险，继续打开"),
                });
                if (ok) props.onForceOpen();
              }}
            >{t("我了解风险，仍用编辑器打开")}</button>
          )}
          <button type="button" style={btn} onClick={props.onMention}>{t("在聊天中引用")}</button>
          <button type="button" style={btn} onClick={props.onDownload}>{t("下载")}</button>
          <button type="button" style={btn} onClick={props.onCopyPath}>{t("复制路径")}</button>
        </div>
        {props.busy && (
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-dim,#888)" }}>
            <span style={{ width: 12, height: 12, border: "2px solid var(--border,#ddd)", borderTopColor: "#4f8ef7", borderRadius: "50%", display: "inline-block", animation: "aiti-spin 0.6s linear infinite" }} />
            {t("正在读取文件…（大文件可能需要数秒，页面暂无响应属正常）")}
          </div>
        )}
        <div style={{ marginTop: 12, fontSize: 11.5, color: "var(--text-dim,#888)" }}>
          {t("分块只读查看不会加载全文；@ 引用、文件 chip、下载等能力不受影响。")}
        </div>
      </div>
    </div>
  );
}

interface WindowPage {
  content: string;
  startOffset: number;
  nextOffset: number;
  lines: number;
  eof: boolean;
  startLine: number;
}

export interface LargeFileViewerProps {
  filePath: string;
  size: number;
  onBack: () => void;
  onDownload: () => void;
  onCopyPath: () => void;
  /** Quote a visible line range back into the composer (`@path#Lx-Ly`). */
  onMentionLines: (startLine: number, endLine: number) => void;
}

export function LargeFileViewer(props: LargeFileViewerProps): unknown {
  const [pages, setPages] = useState<WindowPage[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const fetchPage = useCallback(async (offset: number, startLine: number): Promise<WindowPage | null> => {
    const ticket = await ensureEditorTicket(props.filePath);
    const q = new URLSearchParams({
      offset: String(offset),
      maxBytes: String(TEXT_WINDOW_CHUNK_BYTES),
      maxLines: String(WINDOW_PAGE_LINES),
      encoding: "utf-8",
      t: String(Date.now()),
    });
    const r = await fetch(editorBase() + "/t/" + ticket + "/text-window?" + q.toString(), { cache: "no-store" });
    const d = await r.json().catch(() => null);
    if (!d || !d.ok) throw new Error((d && d.error) || ("HTTP " + r.status));
    return {
      content: String(d.content || ""),
      startOffset: Number(d.startOffset) || offset,
      nextOffset: Number(d.nextOffset) || offset,
      lines: Number(d.lines) || 0,
      eof: d.eof === true,
      startLine,
    };
  }, [props.filePath]);

  useEffect(() => {
    aliveRef.current = true;
    setPages([]); setIndex(0); setErr(null); setLoading(true);
    fetchPage(0, 1)
      .then((p) => { if (!aliveRef.current || !p) return; setPages([p]); })
      .catch((e) => { if (aliveRef.current) setErr(String(e && e.message || e)); })
      .finally(() => { if (aliveRef.current) setLoading(false); });
    return () => { aliveRef.current = false; };
  }, [fetchPage]);

  const page = pages[index] || null;
  const goPrev = () => { if (index > 0) setIndex(index - 1); };
  const goNext = async () => {
    if (!page || page.eof) return;
    if (pages[index + 1]) { setIndex(index + 1); return; }
    setLoading(true); setErr(null);
    try {
      const next = await fetchPage(page.nextOffset, page.startLine + page.lines);
      if (!aliveRef.current || !next) return;
      setPages((prev) => [...prev, next]);
      setIndex((i) => i + 1);
    } catch (e) {
      if (aliveRef.current) setErr(String(e && e.message || e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  };

  const bodyLines = page ? page.content.split("\n") : [];
  if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === "") bodyLines.pop();
  const firstLine = page ? page.startLine : 1;
  const lastLine = page ? page.startLine + Math.max(0, bodyLines.length - 1) : 1;
  const numbers = bodyLines.map((_, i) => String(firstLine + i)).join("\n");

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "nowrap", overflowX: "auto", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--border,#e3e3e3)", background: "var(--bg-alt, rgba(127,127,127,0.04))", fontSize: 12 }}>
        <span style={{ fontWeight: 600, flexShrink: 0 }}>{t("大文件只读")}</span>
        <span style={{ color: "var(--text-dim,#888)", flexShrink: 0 }}>
          {page ? t("第 {a}–{b} 行", { a: firstLine, b: lastLine }) : t("加载中…")} · {formatSize(props.size)}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={{ ...btn, flexShrink: 0 }} disabled={loading || index <= 0} onClick={goPrev}>{t("上一页")}</button>
        <button type="button" style={{ ...btn, flexShrink: 0 }} disabled={loading || !page || page.eof} onClick={() => { void goNext(); }}>{loading ? t("加载中…") : t("下一页")}</button>
        <button type="button" style={{ ...btn, flexShrink: 0 }} onClick={() => props.onMentionLines(firstLine, lastLine)}>{t("引用本页")}</button>
        <button type="button" style={{ ...btn, flexShrink: 0 }} onClick={props.onDownload}>{t("下载")}</button>
        <button type="button" style={{ ...btn, flexShrink: 0 }} onClick={props.onCopyPath}>{t("复制路径")}</button>
        <button type="button" style={{ ...btn, flexShrink: 0 }} onClick={props.onBack}>{t("返回信息")}</button>
      </div>
      {err && <div style={{ padding: "10px 14px", color: "var(--danger,#f87171)", fontSize: 12 }}>{t("读取失败：{msg}", { msg: err })}</div>}
      {!err && !page && loading && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim,#888)", fontSize: 13 }}>{t("正在加载文件片段…")}</div>
      )}
      {page && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: "var(--bg,#fff)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", fontFamily: mono, fontSize: 12.5, lineHeight: 1.55 }}>
            <pre style={{ margin: 0, padding: "8px 10px 20px", textAlign: "right", color: "var(--text-dim,#999)", userSelect: "none", borderRight: "1px solid var(--border,#eee)", background: "var(--bg-alt, rgba(127,127,127,0.03))" }}>{numbers}</pre>
            <pre style={{ margin: 0, padding: "8px 14px 20px", whiteSpace: "pre", flex: 1, minWidth: 0, tabSize: 4 as any }}>{bodyLines.join("\n")}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
