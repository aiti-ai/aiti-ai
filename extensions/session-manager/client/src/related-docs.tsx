/**
 * 相关文档弹层（RelatedDocsHost + showRelatedDocs）——模块级状态 + 常驻宿主模式
 * （同 confirm-dialog / tag-ui：弹层挂 dialogs slot，行卸载/hover 离开不断）。
 *
 * 数据：session-manager server 端 `related-docs` 端点——进程内消费 aiti-doc-center
 * `services.docs.docsOfSession(sid)`（会话触达过的 md 文档，aiti-git-trace 采集 →
 * doc-center 回填 doc_sessions）。客户端不直连兄弟扩展 HTTP（同 msg-smart 红线）。
 *
 * UI：fixed 遮罩 + data-ext-float 浮窗契约（拖拽/缩放/持久化/小屏全屏，见
 * docs/aiti-web-ext-float-dialogs.md）；点行 → 宿主 openFile 右侧标签页打开。
 */
import { useState, useEffect } from "react";
import { t, openFile } from "./host-shim";
import { fetchRelatedDocs } from "./store";
import { ensureReadability, SIc } from "./helpers";

const relatedState = {
  open: null as null | { sessionId: string; title: string },
  subs: new Set<() => void>(),
};
export function showRelatedDocs(sessionId: string, title: string) {
  relatedState.open = { sessionId, title };
  for (const l of relatedState.subs) l();
}
function closeRelatedDocs() {
  relatedState.open = null;
  for (const l of relatedState.subs) l();
}

const docAbs = (d: { root?: string; relpath?: string }) =>
  String(d.root || "").replace(/\/+$/, "") + "/" + String(d.relpath || "");

export function RelatedDocsHost() {
  const [open, setOpen] = useState(relatedState.open);
  const [docs, setDocs] = useState<any[] | null>(null); // null = loading
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    const l = () => setOpen(relatedState.open);
    relatedState.subs.add(l);
    return () => { relatedState.subs.delete(l); };
  }, []);
  useEffect(() => {
    if (!open) return;
    setDocs(null);
    setAvailable(true);
    let alive = true;
    fetchRelatedDocs(open.sessionId).then((r) => {
      if (!alive) return;
      setAvailable(r.available);
      setDocs(r.docs);
    });
    return () => { alive = false; };
  }, [open?.sessionId]);

  if (!open) return null;
  const close = () => closeRelatedDocs();

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 292, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-ext-float="1" data-ext-float-w={480} data-ext-float-h={420} data-ext-float-full="1"
        style={{
          width: "min(480px, 94vw)", height: "min(420px, 80vh)", display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden",
          boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <strong style={{ fontSize: 13, whiteSpace: "nowrap" }}>{`${t("sm.relatedDocs") ?? "相关文档"}`}</strong>
          <span style={{ fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {open.title || open.sessionId.slice(0, 8)}
          </span>
          <button onClick={close} aria-label={t("sm.close")} title={t("sm.close")}
            style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px", flexShrink: 0 } as React.CSSProperties}>✕</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 6 }}>
          {!docs ? (
            <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 12, textAlign: "center" }}>{t("sm.loading") ?? "…"}</div>
          ) : !available ? (
            <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 12, textAlign: "center", lineHeight: 1.8 }}>
              {t("sm.docCenterAbsent") ?? "文档中心未启用（aiti-doc-center）"}
            </div>
          ) : docs.length === 0 ? (
            <div style={{ padding: 20, color: "var(--text-muted)", fontSize: 12, textAlign: "center", lineHeight: 1.8 }}>
              {t("sm.relatedDocsEmpty") ?? "该会话没有触达过文档"}
            </div>
          ) : docs.map((d, i) => {
            const name = d.title || String(d.relpath || "").split("/").pop() || d.relpath;
            return (
              <div
                key={d.id ?? `${d.root}/${d.relpath}/${i}`}
                title={docAbs(d)}
                onClick={() => openFile(docAbs(d), String(name).split("/").pop())}
                style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "7px 9px",
                  cursor: "pointer", borderRadius: 7,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
              >
                <span style={{ flexShrink: 0, display: "flex" }}><SIc name="fileText" size={13} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(d.relpath || "")}</div>
                </div>
                <span style={{ flexShrink: 0, fontSize: 10, color: ensureReadability("#a78bfa") }}>↗</span>
              </div>
            );
          })}
        </div>
        <div style={{ padding: "6px 12px", borderTop: "1px solid var(--border)", fontSize: 10, color: "var(--text-muted)" }}>
          {t("sm.relatedDocsHint") ?? "会话触达过的文档 · aiti-git-trace 采集 → aiti-doc-center 关联"}
        </div>
      </div>
    </div>
  );
}
