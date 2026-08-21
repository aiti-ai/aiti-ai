"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/base-path";
import { useI18n } from "@/hooks/useI18n";
import { getFileIcon, FolderIcon } from "./FileIcons";
import { PathPicker } from "./PathPicker";
import {
  encodeFilePathForApi,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
} from "@/lib/file-paths";

interface Entry { name: string; isDir: boolean; size: number; modified: string; }
interface Node {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: Node[];
  loaded?: boolean;
}

async function fetchEntries(dirPath: string): Promise<Node[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(apiUrl(`/api/files/${encoded}?type=list`));
  if (!res.ok) {
    let message = `Failed to load (HTTP ${res.status})`;
    try { const d = await res.json() as { error?: string }; if (d.error) message = d.error; } catch {}
    throw new Error(message);
  }
  const data = await res.json() as { entries?: Entry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

interface Props {
  folderPath: string;
  cwd?: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onOpenFolder: (folderPath: string, folderName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
}

/**
 * First-class folder viewer (right-panel tab, kind="folder").
 * - Browses a root directory (tree, inline expand).
 * - File row → open file (onOpenFile); folder row → inline expand on click,
 *   "打开" button → open as a new folder tab (onOpenFolder).
 * - Top-right "切换文件夹" changes THIS tab's root only (display; no cwd effect).
 */
export function FolderViewer({ folderPath, cwd, onOpenFile, onOpenFolder, onAtMention }: Props) {
  const { t } = useI18n();
  // Local root — switchable without affecting the agent cwd.
  const [root, setRoot] = useState<string>(folderPath);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [roots, setRoots] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setRoot(folderPath);
  }, [folderPath]);

  useEffect(() => {
    setLoading(true); setError(null);
    let cancelled = false;
    fetchEntries(root)
      .then((e) => { if (!cancelled) setRoots(e); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [root]);

  const toggle = useCallback((fullPath: string, open: boolean) => {
    setExpanded((prev) => { const n = new Set(prev); if (open) n.add(fullPath); else n.delete(fullPath); return n; });
  }, []);

  const rootName = getFileName(root) || root;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      {/* Header: breadcrumb + switch button */}
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "6px 10px", borderBottom: "1px solid var(--border)",
        background: "var(--bg-panel)", flexShrink: 0,
      }}>
        <FolderIcon size={15} open={true} />
        <span
          title={root}
          style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "var(--text)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {rootName}
        </span>
        <button
          onClick={() => setPickerOpen(true)}
          title={t("files.switchFolder")}
          style={headerBtnStyle}
        >
          {t("files.switchFolder")}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "2px 0" }}>
        {loading ? (
          <div style={{ padding: "12px", fontSize: 12, color: "var(--text-dim)" }}>{t("files.loading")}</div>
        ) : error ? (
          <div style={{ padding: "12px", fontSize: 12, color: "#f87171" }}>{error}</div>
        ) : roots.length === 0 ? (
          <div style={{ padding: "12px", fontSize: 12, color: "var(--text-dim)" }}>{t("files.noFiles")}</div>
        ) : (
          roots.map((node) => (
            <FolderTreeNode
              key={node.fullPath}
              node={node}
              depth={0}
              cwd={cwd ?? root}
              expanded={expanded}
              onToggle={toggle}
              onOpenFile={onOpenFile}
              onOpenFolder={onOpenFolder}
              onAtMention={onAtMention}
              t={t}
            />
          ))
        )}
      </div>

      {pickerOpen && (
        <PathPicker
          initialPath={root}
          title={t("files.switchFolder")}
          onPick={(p) => { setPickerOpen(false); setRoot(p); setExpanded(new Set()); }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function FolderTreeNode({
  node, depth, cwd, expanded, onToggle, onOpenFile, onOpenFolder, onAtMention, t,
}: {
  node: Node;
  depth: number;
  cwd: string;
  expanded: Set<string>;
  onToggle: (fullPath: string, open: boolean) => void;
  onOpenFile: (filePath: string, fileName: string) => void;
  onOpenFolder: (folderPath: string, folderName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [children, setChildren] = useState<Node[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const open = expanded.has(node.fullPath);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const e = await fetchEntries(node.fullPath);
      setChildren(e); setLoaded(true);
    } catch {} finally { setLoading(false); }
  }, [loaded, node.fullPath]);

  useEffect(() => { if (open && !loaded) loadChildren(); }, [open, loaded, loadChildren]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggle(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node, open, loaded, loadChildren, onOpenFile, onToggle]);

  return (
    <div>
      <div
        onClick={handleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative", display: "flex", alignItems: "center", gap: 4,
          paddingLeft: 8 + depth * 14, paddingRight: 8, height: 24,
          cursor: "pointer", background: hovered ? "var(--bg-hover)" : "transparent",
          borderRadius: 4, userSelect: "none",
        }}
      >
        {node.isDir && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}>
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span style={{
          fontSize: 12, color: "var(--text)", overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
        }} title={node.fullPath}>
          {node.name}
        </span>
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)"
            strokeWidth="2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }}>
            <path d="M21 12a9 9 0 1 1-5.7-8.4" />
          </svg>
        )}
        {/* Folder: "打开" (open as new tab) on hover */}
        {node.isDir && hovered && (
          <button
            onClick={(e) => { e.stopPropagation(); onOpenFolder(node.fullPath, node.name); }}
            title={t("files.openInPanel")}
            style={openBtnStyle}
          >
            {t("files.open")}
          </button>
        )}
        {/* @mention on hover */}
        {onAtMention && hovered && (
          <button
            onClick={(e) => { e.stopPropagation(); onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir); }}
            title={t("files.insertPath")}
            style={mentionBtnStyle}
          >
            @
          </button>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <FolderTreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              expanded={expanded}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onOpenFolder={onOpenFolder}
              onAtMention={onAtMention}
              t={t}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              {t("files.noFiles")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const headerBtnStyle: React.CSSProperties = {
  height: 24, padding: "0 10px", border: "1px solid var(--border)",
  borderRadius: 4, background: "var(--bg)", color: "var(--text-muted)",
  cursor: "pointer", fontSize: 11, fontWeight: 600, flexShrink: 0,
};

const openBtnStyle: React.CSSProperties = {
  position: "absolute", right: 28, top: "50%", transform: "translateY(-50%)",
  display: "flex", alignItems: "center", justifyContent: "center",
  height: 20, padding: "0 8px",
  background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4,
  color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
};

const mentionBtnStyle: React.CSSProperties = {
  position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
  display: "flex", alignItems: "center", justifyContent: "center",
  width: 20, height: 20,
  background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4,
  color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 700,
};
