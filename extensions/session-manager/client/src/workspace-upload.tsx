/**
 * workspace-upload —— workspace 下拉「上传工作区」弹窗（懒 chunk）
 * （方案 docs/session-manager-workspace-upload-plan.md §6）
 *
 * 流程：选压缩包（accept 按 capabilities：rar/7z 系统无工具则剔除并提示）→
 * 选目标父目录（DirectoryBrowser，默认 ~/workspace）→ XHR 流式上传（进度条）→
 * 服务端解压（单根检测 + 永不覆盖顺延）→ 成功后 onSelect(root) 自动切换 + toast。
 *
 * UI 范式同 workspace-manage：createPortal overlay（躲 AnimatedDropdown transform
 * containing block）+ data-ext-float 浮动契约（拖拽/缩放/持久化/小屏全屏）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t, apiUrl } from "./host-shim";
import { ghostBtn } from "./helpers";
import { showToast } from "./toast";
import { DirectoryBrowser } from "../../../aiti-folder/client/src/directory-browser";
import { dedupeFetch } from "../../../_shared/dedupe-fetch";

/** accept 基础集（zip/tar 三平台保证）；rar/7z 按 capabilities 追加。 */
const BASE_ACCEPT = ".zip,.tar.gz,.tgz,.tar.bz2,.tbz2,.tar.xz,.txz,.tar";

export interface UploadWorkspaceProps {
  /** 上传成功后切换到解压出的目录（workspacePickerActions 插槽 onSelect）。 */
  onSelect: (root: string) => void;
  onCloseDialog: () => void;
}

interface Caps {
  rar: string | null;
  sevenz: string | null;
}

const overlayStyle: Record<string, string | number> = {
  position: "fixed", inset: 0, zIndex: 293, background: "rgba(0,0,0,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center",
};

const labelStyle: Record<string, string | number> = {
  fontSize: 11, color: "var(--text-muted)", marginBottom: 4, display: "block",
};

const rowStyle: Record<string, string | number> = {
  display: "flex", alignItems: "center", gap: 6,
};

export function UploadDialog(props: UploadWorkspaceProps) {
  const [dir, setDir] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [percent, setPercent] = useState<number | null>(null); // null = 空闲；0-100 上传；101 = 解压中
  const [error, setError] = useState("");
  const [browseOpen, setBrowseOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busy = percent !== null;

  // capabilities（accept 调整 + rar/7z 提示）+ 默认目标目录 ~/workspace（/api/home 同源）
  useEffect(() => {
    void (async () => {
      try {
        const r = await dedupeFetch(apiUrl("/api/extensions/session-manager/workspace/capabilities"));
        const d = await r.json();
        if (d?.ok) setCaps({ rar: d.rar ?? null, sevenz: d.sevenz ?? null });
      } catch { /* 缺席不阻塞：accept 用基础集 */ }
      try {
        const r = await dedupeFetch(apiUrl("/api/home"));
        const d = await r.json();
        if (d?.home) setDir((cur) => cur || d.home + "/workspace");
      } catch { /* 默认空，用户手选 */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accept = BASE_ACCEPT + (caps?.rar ? ",.rar" : "") + (caps?.sevenz ? ",.7z" : "");
  const rarHint = caps && (!caps.rar || !caps.sevenz)
    ? t("sm.uploadNoRar7z", { rar: caps.rar ? "✓" : "✗", sevenz: caps.sevenz ? "✓" : "✗" })
    : "";

  function start() {
    if (!file || !dir || busy) return;
    setError("");
    const xhr = new XMLHttpRequest();
    const url = apiUrl(
      `/api/extensions/session-manager/workspace/upload?name=${encodeURIComponent(file.name)}&dir=${encodeURIComponent(dir)}`,
    );
    xhr.open("POST", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) setPercent(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.upload.onload = () => setPercent(101); // 包已传完，等服务端解压响应
    xhr.onload = () => {
      setPercent(null);
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* 非 JSON */ }
      if (xhr.status === 200 && body?.ok) {
        const root = String(body.root ?? "");
        showToast(
          (body.renamed
            ? t("sm.uploadSuccessRenamed", { name: body.finalName ?? "", root })
            : t("sm.uploadSuccess", { root }))
          + (body.singleRoot ? "" : " · " + t("sm.uploadCreatedDir")),
          4500,
        );
        props.onSelect(root);
        props.onCloseDialog();
      } else {
        setError(body?.error || `${t("sm.uploadFailedPrefix")}（HTTP ${xhr.status}）`);
      }
    };
    xhr.onerror = () => { setPercent(null); setError(t("sm.uploadFailedPrefix") + "：network"); };
    setPercent(0);
    xhr.send(file);
  }

  const close = () => { if (!busy) props.onCloseDialog(); };

  return createPortal(
    <div style={overlayStyle} onClick={close}>
      <div
        onClick={(e) => e.stopPropagation()}
        data-ext-float="1" data-ext-float-w={460} data-ext-float-h={300} data-ext-float-full="1"
        style={{
          width: "min(460px, 94vw)", maxHeight: "min(360px, 84vh)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 14,
          overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
        }}
      >
        {/* 标题栏（首子元素 = aiti-float 拖拽把手） */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 16px 8px" }}>
          <strong style={{ fontSize: 13, flex: 1 }}>{t("sm.uploadWorkspace")}</strong>
          <button onClick={close} disabled={busy} title={t("sm.close") ?? "关闭"}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
        </div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "0 16px 10px", lineHeight: 1.5 }}>
          {t("sm.uploadHint")}
          {rarHint && <div style={{ marginTop: 3, color: "var(--text-dim)" }}>{rarHint}</div>}
        </div>

        {/* 压缩包选择 */}
        <div style={{ padding: "0 16px 10px" }}>
          <span style={labelStyle}>{t("sm.uploadFile")}</span>
          <div style={rowStyle}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
              style={ghostBtn as Record<string, string | number>}
            >{t("sm.uploadChooseFile")}</button>
            <span style={{
              flex: 1, minWidth: 0, fontSize: 11, fontFamily: "var(--font-mono)",
              color: file ? "var(--text)" : "var(--text-dim)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{file ? `${file.name}（${Math.max(1, Math.round(file.size / 1024))} KB）` : t("sm.uploadNoFile")}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept={accept}
              style={{ display: "none" }}
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0] ?? null;
                setFile(f);
                setError("");
              }}
            />
          </div>
        </div>

        {/* 目标目录 */}
        <div style={{ padding: "0 16px 10px" }}>
          <span style={labelStyle}>{t("sm.uploadTarget")}</span>
          <div style={rowStyle}>
            <span style={{
              flex: 1, minWidth: 0, fontSize: 11, fontFamily: "var(--font-mono)",
              color: dir ? "var(--text)" : "var(--text-dim)",
              background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
              padding: "5px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }} title={dir}>{dir || "…"}</span>
            <button type="button" disabled={busy} onClick={() => setBrowseOpen(true)}
              style={ghostBtn as Record<string, string | number>}>{t("sm.uploadBrowse")}</button>
          </div>
        </div>

        {/* 进度 / 错误 */}
        <div style={{ padding: "0 16px 10px", minHeight: 18 }}>
          {percent !== null && (
            <div>
              <div style={{ height: 4, borderRadius: 2, background: "var(--bg)", overflow: "hidden" }}>
                <div style={{
                  height: "100%", width: `${Math.min(percent, 100)}%`,
                  background: "var(--accent)", transition: "width 120ms linear",
                }} />
              </div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>
                {percent >= 101 || percent >= 100 ? t("sm.uploadExtracting") : `${t("sm.uploadUploading")} ${percent}%`}
              </div>
            </div>
          )}
          {error && <div style={{ fontSize: 11, color: "var(--danger, #f87171)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{error}</div>}
        </div>

        {/* 动作行 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "2px 16px 14px", marginTop: "auto" }}>
          <button type="button" onClick={close} disabled={busy}
            style={ghostBtn as Record<string, string | number>}>{t("sm.cancel") ?? "取消"}</button>
          <button
            type="button"
            onClick={start}
            disabled={!file || !dir || busy}
            style={{
              padding: "6px 14px", borderRadius: 7, border: "none",
              background: !file || !dir || busy ? "var(--bg)" : "var(--accent)",
              color: !file || !dir || busy ? "var(--text-dim)" : "#fff",
              cursor: !file || !dir || busy ? "default" : "pointer",
              fontSize: 12, fontWeight: 600,
            }}
          >{busy ? t("sm.uploadWorking") : t("sm.uploadStart")}</button>
        </div>
      </div>

      {browseOpen && (
        <DirectoryBrowser
          initialPath={dir || undefined}
          onSelect={(p) => { setBrowseOpen(false); setDir(p); }}
          onCancel={() => setBrowseOpen(false)}
        />
      )}
    </div>,
    document.body,
  );
}
