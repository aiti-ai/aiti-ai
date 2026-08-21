"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { apiUrl } from "@/lib/base-path";
import { useI18n } from "@/hooks/useI18n";
import { FolderIcon } from "./FileIcons";
import { getFileName } from "@/lib/file-paths";

interface BrowseResult {
  path: string;
  parentPath: string | null;
  directories: string[];
  drives?: string[];
  error?: string;
}

interface Props {
  /** Initial directory to show. */
  initialPath?: string;
  /** Title shown at the top of the picker. */
  title: string;
  /** Called when the user picks a directory. */
  onPick: (path: string) => void;
  /** Called when the user cancels. */
  onCancel: () => void;
}

/**
 * Browse the filesystem for a directory (dirs only) via /api/cwd/browse.
 * Reused by the "open folder" menu item and the per-folder "switch folder".
 */
export function PathPicker({ initialPath, title, onPick, onCancel }: Props) {
  const { t } = useI18n();
  const [path, setPath] = useState<string>(initialPath ?? "");
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 防并发重复加载的守卫用 ref（不参与渲染，load 保持稳定 → effect 依赖干净）
  const loadingRef = useRef(false);

  const load = useCallback((target: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (target) params.set("path", target);
    fetch(apiUrl(`/api/cwd/browse?${params.toString()}`), { cache: "no-store" })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as BrowseResult;
        if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
        setData(d);
        setPath(d.path);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => { loadingRef.current = false; setLoading(false); });
  }, []);

  // 挂载时加载 initialPath（PathPicker 每次打开都全新挂载，initialPath 恒定）
  useEffect(() => { load(initialPath ?? ""); }, [initialPath, load]);

  // Esc cancels.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const dirs = data?.directories ?? [];
  const drives = data?.drives;

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 400,
        background: "rgba(0,0,0,0.35)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div style={{
        width: "min(560px, 92vw)", maxHeight: "80vh",
        display: "flex", flexDirection: "column",
        background: "var(--bg-panel)", border: "1px solid var(--border)",
        borderRadius: 8, boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
        overflow: "hidden",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "8px 12px", borderBottom: "1px solid var(--border)",
          background: "var(--bg)", flexShrink: 0,
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", flex: 1 }}>
            {title}
          </span>
          <button onClick={onCancel} title={t("i18n.close")} aria-label={t("i18n.close")}
            style={btnStyle}>✕</button>
        </div>

        {/* Breadcrumb / current path */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6, padding: "6px 12px",
          borderBottom: "1px solid var(--border)", flexShrink: 0,
          fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)",
          overflowX: "auto", whiteSpace: "nowrap",
        }}>
          {data?.parentPath !== null && data?.parentPath !== undefined && (
            <button
              onClick={() => load(data.parentPath!)}
              title={t("files.parentDir")}
              style={linkBtnStyle}
            >↑</button>
          )}
          <span title={path} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {path || "/"}
          </span>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {loading && (
            <div style={{ padding: "12px", fontSize: 12, color: "var(--text-dim)" }}>
              {t("files.loading")}
            </div>
          )}
          {error && (
            <div style={{ padding: "12px", fontSize: 12, color: "#f87171" }}>{error}</div>
          )}
          {!loading && !error && drives && drives.length > 0 && (
            drives.map((d) => (
              <button key={d} onClick={() => load(d)} style={rowStyle}>
                <FolderIcon size={14} open={false} />
                <span style={{ fontSize: 12 }}>{d}</span>
              </button>
            ))
          )}
          {!loading && !error && dirs.length === 0 && (!drives || drives.length === 0) && (
            <div style={{ padding: "12px", fontSize: 12, color: "var(--text-dim)" }}>
              {t("files.noSubdirs")}
            </div>
          )}
          {!loading && !error && dirs.map((d) => {
            const name = getFileName(d) || d;
            return (
              <button key={d} onClick={() => load(d)} style={rowStyle}
                onDoubleClick={() => onPick(d)}
              >
                <FolderIcon size={14} open={false} />
                <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                <span style={{ fontSize: 10, color: "var(--text-dim)" }}>→</span>
              </button>
            );
          })}
        </div>

        <div style={{
          display: "flex", gap: 8, padding: "8px 12px",
          borderTop: "1px solid var(--border)", flexShrink: 0, background: "var(--bg)",
        }}>
          <button
            onClick={() => path && onPick(path)}
            disabled={!path}
            style={{ ...btnPrimaryStyle, opacity: path ? 1 : 0.5, cursor: path ? "pointer" : "not-allowed" }}
          >
            {t("files.selectFolder")}
          </button>
          <button onClick={onCancel} style={btnStyle}>{t("files.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  height: 28, padding: "0 10px", border: "1px solid var(--border)",
  borderRadius: 5, background: "var(--bg-panel)", color: "var(--text)",
  cursor: "pointer", fontSize: 12,
};

const btnPrimaryStyle: React.CSSProperties = {
  height: 28, padding: "0 12px", border: "none",
  borderRadius: 5, background: "var(--accent)", color: "#fff",
  cursor: "pointer", fontSize: 12, fontWeight: 600,
};

const linkBtnStyle: React.CSSProperties = {
  height: 22, padding: "0 6px", border: "1px solid var(--border)",
  borderRadius: 4, background: "var(--bg-panel)", color: "var(--text-muted)",
  cursor: "pointer", fontSize: 12, flexShrink: 0,
};

const rowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, width: "100%",
  padding: "0 12px", height: 26, border: "none", background: "transparent",
  color: "var(--text)", cursor: "pointer", textAlign: "left",
};
