/**
 * aiti-quickstart · workspace-hub —— 获取工作区对话框（v2 checkout 专项，
 * 方案 docs/aiti-quickstart-hub-plan.md §5）。
 *
 * 四入口：Git 克隆（本扩展 server API：表单 → POST workspace/clone → event-bus
 * topic 进度帧 → 成功落欢迎页）/ 上传压缩包（session-manager uploadWorkspace
 * 服务复用——开关提为模块级 store，本扩展零重实现）/ 本地目录 / 新建空目录
 * （均 aiti-folder DirectoryBrowser，暂缺时降级手输 + 宿主 API）。
 *
 * 「最近」区：GET workspace/history（记录 + ~/workspace 扫描合并——覆盖既往
 * zip 上传无历史的工作区），chip 点击 → pi-web.newSession.setCwd 落欢迎页。
 *
 * UI 契约：createPortal 躲 transform containing block + data-ext-float="1"
 * （aiti-float 拖拽/缩放/持久化/置前）+ data-ext-float-full="1"（≤640px 铺满）。
 * 打开通道：window 事件 `aiti-quickstart:open-hub`（openWorkspaceHub 派发；
 * entry.tsx 同时注册跨扩展服务 `aiti-quickstart.open`）。
 */
import { useState, useEffect, t, extSvc, createPortal, apiUrl } from "./host-shim";
import { parseGitUrl } from "./quickstart-logic";

/* ── 服务面（全部软依赖，缺席降级） ── */

interface HistoryEntry { id: string; source: string; root: string; name: string; time: number; url?: string }

async function fetchHistory(): Promise<HistoryEntry[]> {
  try {
    const res = await fetch(apiUrl("/api/extensions/aiti-quickstart/workspace/history"), { headers: { accept: "application/json" } });
    const d = (await res.json()) as { ok?: boolean; workspaces?: HistoryEntry[] };
    return Array.isArray(d.workspaces) ? d.workspaces : [];
  } catch {
    return [];
  }
}

/** session-manager 上传服务（open({onSelect,onClose})；缺席 → null）。 */
function uploadService(): { open: (cb: { onSelect: (root: string) => void; onClose: () => void }) => void } | null {
  try {
    const svc = extSvc<{ open?: unknown }>("session-manager.uploadWorkspace");
    if (svc && typeof svc.open === "function") return svc as never;
  } catch { /* ignore */ }
  return null;
}

function setCwd(root: string): void {
  try { extSvc<{ setCwd: (p: string) => void }>("pi-web.newSession")?.setCwd?.(root); } catch { /* ignore */ }
}

function recordAndEnter(root: string, source: "clone" | "local" | "new", extra?: { url?: string }): void {
  // 服务端 clone 已记历史；local/new 在前端补一条（幂等：同 root 去重置顶）
  if (source !== "clone") {
    void fetch(apiUrl("/api/extensions/aiti-quickstart/workspace/history"), {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "record", source, root, name: root.split(/[\\/]/).filter(Boolean).pop() ?? root, time: Date.now() }),
    }).catch(() => {});
  }
  setCwd(root);
}

/* ── 样式 ── */
const overlayStyle: Record<string, unknown> = {
  position: "fixed", inset: 0, zIndex: 130, background: "rgba(0,0,0,0.4)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
};
const panelStyle: Record<string, unknown> = {
  width: 440, maxWidth: "94vw", maxHeight: "min(560px, 82dvh)", display: "flex", flexDirection: "column",
  background: "var(--bg, #1a1a1a)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 12,
  boxShadow: "0 10px 40px rgba(0,0,0,0.5)", overflow: "hidden",
};
const headStyle: Record<string, unknown> = {
  display: "flex", alignItems: "center", gap: 8, padding: "12px 14px 8px", flexShrink: 0,
};
const bodyStyle: Record<string, unknown> = {
  flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 14px 14px", display: "flex", flexDirection: "column", gap: 12,
};
const tabBtn = (active: boolean): Record<string, unknown> => ({
  border: "1px solid " + (active ? "var(--accent, #2563eb)" : "var(--border, #3a3a3a)"),
  borderRadius: 8, padding: "4px 10px", fontSize: 12, background: "none", cursor: "pointer",
  color: active ? "var(--accent, #2563eb)" : "var(--text-muted, #999)", fontFamily: "inherit",
});
const inputStyle: Record<string, unknown> = {
  width: "100%", boxSizing: "border-box", background: "var(--bg-hover, #232323)",
  border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, padding: "6px 9px",
  color: "var(--text, #ddd)", fontSize: 12, fontFamily: "inherit", outline: "none",
};
const goBtn: Record<string, unknown> = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
  border: "1px solid var(--accent, #2563eb)", borderRadius: 8, padding: "6px 14px",
  background: "none", color: "var(--accent, #2563eb)", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
};
const labelStyle: Record<string, unknown> = { fontSize: 11, color: "var(--text-dim, #888)", flexShrink: 0 };
const errStyle: Record<string, unknown> = { fontSize: 11.5, color: "var(--danger, #ef4444)", lineHeight: 1.5, wordBreak: "break-all" };

type Tab = "clone" | "upload" | "local" | "new";

/* ── Hub 主组件 ── */

export function WorkspaceHub() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("clone");
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setTab("clone");
      void fetchHistory().then(setHistory);
    };
    try { window.addEventListener("aiti-quickstart:open-hub", onOpen); } catch { /* ignore */ }
    return () => { try { window.removeEventListener("aiti-quickstart:open-hub", onOpen); } catch { /* ignore */ } };
  }, []);

  if (!open) return null;

  const refreshHistory = () => { void fetchHistory().then(setHistory); };
  const enter = (root: string, source: "clone" | "local" | "new", extra?: { url?: string }) => {
    recordAndEnter(root, source, extra);
    setOpen(false);
  };

  return createPortal(
    <div style={overlayStyle} onClick={(e: any) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div style={{ ...panelStyle }} data-ext-float="1" data-ext-float-full="1" data-ext-float-w="440" data-ext-float-h="420">
        <div style={headStyle}>
          <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: "var(--text, #ddd)" }}>{t("qs.hub.title")}</span>
          <button type="button" title={t("qs.hub.close")} aria-label={t("qs.hub.close")} onClick={() => setOpen(false)}
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, padding: 0, background: "none", border: "none", borderRadius: 6, color: "var(--text-dim, #888)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}
            onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-hover, #232323)"; e.currentTarget.style.color = "var(--text, #ddd)"; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-dim, #888)"; }}>✕</button>
        </div>
        <div style={bodyStyle}>
          {/* 最近 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 10, borderBottom: "1px solid var(--border, #3a3a3a)" }}>
            <span style={labelStyle}>{t("qs.hub.recent")}</span>
            {history.length === 0 ? (
              <span style={{ fontSize: 11.5, color: "var(--text-dim, #888)" }}>{t("qs.hub.recentEmpty")}</span>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {history.map((h) => (
                  <span key={h.id} style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--border, #3a3a3a)", borderRadius: 999, overflow: "hidden" }}>
                    <button type="button" title={h.root} onClick={() => enter(h.root, h.source === "clone" ? "clone" : h.source === "new" ? "new" : h.source === "local" ? "local" : "local", h.url ? { url: h.url } : undefined)}
                      style={{ border: "none", background: "none", padding: "3px 4px 3px 10px", cursor: "pointer", color: "var(--text-muted, #999)", fontSize: 11.5, fontFamily: "inherit" }}
                      onMouseEnter={(e: any) => { e.currentTarget.style.color = "var(--accent, #2563eb)"; }}
                      onMouseLeave={(e: any) => { e.currentTarget.style.color = "var(--text-muted, #999)"; }}>
                      {h.name}
                    </button>
                    <button type="button" title={t("qs.hub.forget")} onClick={async () => {
                      await fetch(apiUrl("/api/extensions/aiti-quickstart/workspace/forget"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: h.id }) }).catch(() => {});
                      refreshHistory();
                    }}
                      style={{ border: "none", background: "none", padding: "3px 8px 3px 2px", cursor: "pointer", color: "var(--text-dim, #888)", fontSize: 10 }}>✕</button>
                  </span>
                ))}
              </div>
            )}
          </div>
          {/* 四入口 tab */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, flexShrink: 0 }}>
            {(["clone", "upload", "local", "new"] as Tab[]).map((k) => (
              <button key={k} type="button" style={tabBtn(tab === k)} onClick={() => setTab(k)}>{t(`qs.hub.tab.${k}`)}</button>
            ))}
          </div>
          {tab === "clone" ? <CloneTab onEnter={enter} onRefreshHistory={refreshHistory} /> : null}
          {tab === "upload" ? <UploadTab /> : null}
          {tab === "local" ? <LocalTab onEnter={enter} /> : null}
          {tab === "new" ? <NewTab onEnter={enter} /> : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ── Git 克隆 tab ── */

function CloneTab(props: { onEnter: (root: string, source: "clone", extra?: { url?: string }) => void; onRefreshHistory: () => void }) {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [dir, setDir] = useState("");
  const [depth, setDepth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const parsed = url.trim() ? parseGitUrl(url) : null;

  const go = async () => {
    setError(null);
    if (!parsed) { setError(t("qs.hub.err.parse")); return; }
    setBusy(true);
    setProgress("…");
    try {
      const res = await fetch(apiUrl("/api/extensions/aiti-quickstart/workspace/clone"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: parsed.ref, branch: parsed.branch ?? (branch.trim() || undefined), dir: dir.trim() || undefined, depth: depth ? 1 : undefined }),
      });
      const d = (await res.json()) as { ok?: boolean; root?: string; url?: string; error?: string; jobId?: string };
      if (!res.ok || !d.ok) { setError(d.error ?? `HTTP ${res.status}`); setBusy(false); setProgress(null); return; }
      props.onRefreshHistory();
      props.onEnter(d.root ?? "", "clone", { url: parsed.ref });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>{t("qs.hub.clone.url")}</span>
        <input style={inputStyle} value={url} onChange={(e: any) => setUrl(e.target.value)} placeholder="https://github.com/user/repo.git" disabled={busy} />
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={labelStyle}>{t("qs.hub.clone.branch")}</span>
          <input style={inputStyle} value={branch} onChange={(e: any) => setBranch(e.target.value)} disabled={busy} />
        </label>
        <label style={{ flex: 1.4, display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={labelStyle}>{t("qs.hub.clone.dir")}</span>
          <input style={inputStyle} value={dir} onChange={(e: any) => setDir(e.target.value)} placeholder="~/workspace" disabled={busy} />
        </label>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-muted, #999)", cursor: "pointer" }}>
        <input type="checkbox" checked={depth} onChange={(e: any) => setDepth(e.target.checked)} disabled={busy} />
        {t("qs.hub.clone.depth")}
      </label>
      {busy ? <div style={{ fontSize: 11.5, color: "var(--text-dim, #888)" }}>{progress ?? "…"}</div> : null}
      {error ? <div style={errStyle}>{error}</div> : null}
      <button type="button" style={{ ...goBtn, alignSelf: "flex-start", opacity: busy || !parsed ? 0.5 : 1 }} disabled={busy || !parsed} onClick={() => { void go(); }}>
        {t("qs.hub.clone.go")}
      </button>
    </div>
  );
}

/* ── 上传 tab（session-manager service 复用） ── */

function UploadTab() {
  const svc = uploadService();
  if (!svc) {
    return <div style={{ fontSize: 12, color: "var(--text-dim, #888)", lineHeight: 1.6 }}>{t("qs.hub.upload.fallback")}</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted, #999)" }}>{t("qs.hub.tab.upload")}</span>
      <button type="button" style={{ ...goBtn, alignSelf: "flex-start" }} onClick={() => {
        svc.open({
          onSelect: (root) => { recordAndEnter(root, "local"); }, // 上传历史由服务端扫描兜底呈现；此处仅进入
          onClose: () => { /* UploadDialog 自关 */ },
        });
      }}>{t("qs.hub.tab.upload")}</button>
    </div>
  );
}

/* ── 本地目录 / 新建空目录 tab（DirectoryBrowser 软依赖 + 宿主 API 降级） ── */

function pickLocalDir(onPick: (p: string) => void, onCancel: () => void): void {
  try { window.dispatchEvent(new CustomEvent("aiti-quickstart:pick-local", { detail: { onPick, onCancel } })); } catch { /* ignore */ }
  onCancel(); // v1：无 DirectoryBrowser 接线时直接取消（表单手输是主路径）
}

function LocalTab(props: { onEnter: (root: string, source: "local") => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setError(null);
    const p = path.trim().replace(/^~(?=\/|$)/, "").trim();
    if (!p) { setError(t("qs.hub.err.parse")); return; }
    try {
      const res = await fetch(apiUrl("/api/cwd/validate"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: p }) });
      const d = (await res.json()) as { cwd?: string; error?: string };
      if (!res.ok || !d.cwd) { setError(d.error ?? `HTTP ${res.status}`); return; }
      props.onEnter(d.cwd, "local");
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={labelStyle}>{t("qs.hub.tab.local")}</span>
        <input style={inputStyle} value={path} onChange={(e: any) => setPath(e.target.value)} placeholder="/home/you/projects/my-app" />
      </label>
      {error ? <div style={errStyle}>{error}</div> : null}
      <button type="button" style={{ ...goBtn, alignSelf: "flex-start" }} onClick={() => { void go(); }}>{t("qs.hub.tab.local")}</button>
    </div>
  );
}

function NewTab(props: { onEnter: (root: string, source: "new") => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/default-cwd"), { method: "POST" });
      const d = (await res.json()) as { cwd?: string; error?: string };
      if (!res.ok || !d.cwd) { setError(d.error ?? `HTTP ${res.status}`); setBusy(false); return; }
      props.onEnter(d.cwd, "new");
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 12, color: "var(--text-muted, #999)", lineHeight: 1.6 }}>
        {t("qs.start.acquireHint")}
      </span>
      {error ? <div style={errStyle}>{error}</div> : null}
      <button type="button" style={{ ...goBtn, alignSelf: "flex-start", opacity: busy ? 0.5 : 1 }} disabled={busy} onClick={() => { void go(); }}>
        {t("qs.hub.new.go")}
      </button>
    </div>
  );
}

/** Hub 容器（entry.tsx registerItems 之外的全局挂载面——dialogs 插槽自绘，无需宿主 slot）。 */
export function WorkspaceHubRoot() {
  return <WorkspaceHub />;
}
