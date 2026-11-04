/**
 * aiti-editor · 移动到弹窗（两级选择：先 workspace，再目录）——自包含实现
 *
 * 与 aiti-folder 的 MoveToDialog 同款交互（不跨扩展引用组件）：
 *  - 一级 workspace：默认当前文件所在目录（root），下拉列出已知项目（/api/sessions 聚合）+ 自定义路径
 *  - 二级目录：复用 /api/cwd/browse（只列子目录 + parentPath）
 *  - 确认 POST /move { filePath, targetDir } → 移动当前文件到浏览目录
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { apiUrl, extSvc } from "./host-shim";
import { dedupeFetch } from "../../../_shared/dedupe-fetch";
import { dismissOnBack } from "../../../_shared/overlay-back-client";

// ── 轻量路径工具（lib.ts 无现成，内联）──
function lastSeg(p?: string): string {
  if (!p) return p;
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}
function displayCwd(cwd?: string, home?: string): string {
  return home && cwd && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}
/** 已知项目：按 projectKey/cwd 去重取最近修改（对标 aiti-folder recentProjects） */
function recentProjects(sessions: any[]): string[] {
  const m = new Map<string, { root: string; modified: string }>();
  for (const s of sessions) {
    const root = s.projectRoot || s.cwd;
    if (!root) continue;
    const k = s.projectKey || s.cwd || s.id || root;
    const p = m.get(k);
    if (!p || s.modified > p.modified) m.set(k, { root, modified: s.modified });
  }
  return [...m.values()].sort((a, b) => (b.modified || "").localeCompare(a.modified || "")).map((x) => x.root);
}

function FolderIcon({ open }: { open?: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d={ open ? "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z" : "M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" } />
    </svg>
  );
}
function CaretIcon() {
  return <svg width={9} height={9} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="2 3.5 5 6.5 8 3.5" /></svg>;
}
function CheckIcon() {
  return <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>;
}

export function MoveToDialog(props: {
  filePath: string;
  /** 当前文件所在目录（作默认 workspace） */
  root: string;
  onClose: () => void;
  onMoved: (newPath: string) => void;
}) {
  const { filePath, root, onClose, onMoved } = props;
  const srcName = lastSeg(filePath) || "";
  const [ws, setWs] = useState<string>(root);
  const [wsList, setWsList] = useState<string[]>([]);
  const [home, setHome] = useState("");
  const [wsOpen, setWsOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState(root);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<any>(null);
  // 小屏系统返回 = 关闭移动弹窗（等同取消；busy 中不关）——本组件仅 open 时挂载
  const busyRef = useRef(busy);
  useEffect(() => { busyRef.current = busy; }, [busy]);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => dismissOnBack(
    () => extSvc("pi-web.overlayBack"),
    () => { if (!busyRef.current) closeRef.current(); },
  ), []);
  const loadBrowse = useCallback((target: string) => {
    setLoading(true); setError(null);
    fetch(apiUrl("/api/cwd/browse"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target }) })
      .then(async (r) => { const d = await r.json(); if (!r.ok || d.error) throw new Error(d.error || ("HTTP " + r.status)); setData(d); setBrowsePath(d.path); })
      .catch((e) => setError(e && e.message ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    dedupeFetch(apiUrl("/api/home")).then((r) => r.json()).then((d) => { if (d.home) setHome(d.home); }).catch(() => {});
    fetch(apiUrl("/api/sessions"), { cache: "no-store" }).then((r) => r.json()).then((d) => {
      const ps = recentProjects(d.sessions || []);
      const seen = new Set<string>(); const list: string[] = [];
      for (const p of [root, ...ps]) { if (p && !seen.has(p)) { seen.add(p); list.push(p); } }
      setWsList(list);
    }).catch(() => {});
    loadBrowse(root);
  }, []);
  const switchWs = (p: string) => { setWs(p); setWsOpen(false); loadBrowse(p); };
  const dirs = (data && data.directories) || [];
  const doMove = async () => {
    if (busy || !browsePath) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-editor/move"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filePath, targetDir: browsePath }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) setMsg({ err: d.error || ("HTTP " + r.status) });
      else onMoved(d.newPath || browsePath + "/" + srcName);
    } catch (e: any) { setMsg({ err: e && e.message ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const rowStyle: Record<string, any> = { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "0 12px", height: 26, border: "none", background: "transparent", color: "var(--text)", cursor: "pointer", textAlign: "left", fontSize: 12 };
  return (
    <div onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 800, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "min(540px,92vw)", maxHeight: "82vh", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", overflow: "hidden" }}>
        {/* 标题 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>移动到</span>
          <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono,ui-monospace,monospace)", fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={filePath}>{srcName}</span>
          <button onClick={() => { if (!busy) onClose(); }} title="关闭" style={{ height: 26, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 12, flexShrink: 0 }}>✕</button>
        </div>
        {/* 一级：workspace */}
        <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim,#888)", fontWeight: 600, flexShrink: 0 }}>workspace</span>
          <button type="button" onClick={() => setWsOpen((v) => !v)} title={ws}
            style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, cursor: "pointer", fontSize: 12, fontFamily: "var(--font-mono,ui-monospace,monospace)", color: "var(--text)", overflow: "hidden" }}>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayCwd(ws, home)}</span>
            <CaretIcon />
          </button>
          {wsOpen ? (
            <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 12, right: 12, zIndex: 120, maxHeight: "min(44vh,300px)", overflowY: "auto", background: "var(--bg,#fff)", border: "1px solid var(--border,#d0d0d0)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,0.15)", padding: 4 }}>
              {wsList.map((p) => { const cur = p === ws; return (
                <button key={p} type="button" onClick={() => switchWs(p)} title={p}
                  style={{ ...rowStyle, fontFamily: "var(--font-mono,ui-monospace,monospace)", color: cur ? "var(--accent)" : "var(--text)", fontWeight: cur ? 600 : 400 }}>
                  <FolderIcon open={false} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayCwd(p, home)}</span>
                  {cur ? <CheckIcon /> : null}
                </button>
              ); })}
            </div>
          ) : null}
        </div>
        {/* 二级：目录浏览 */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0, fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflowX: "auto", whiteSpace: "nowrap" }}>
          {(data && data.parentPath != null) ? <button onClick={() => loadBrowse(data.parentPath)} title="上级目录" style={{ height: 22, padding: "0 6px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, flexShrink: 0 }}>↑</button> : null}
          <span title={browsePath} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{browsePath || "/"}</span>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}>
          {loading ? <div style={{ padding: "12px", fontSize: 12, color: "var(--text-dim)" }}>正在加载…</div> : null}
          {error ? <div style={{ padding: "12px", fontSize: 12, color: "#f87171" }}>{error}</div> : null}
          {(!loading && !error && dirs.length === 0) ? <div style={{ padding: "12px", fontSize: 12, color: "var(--text-dim)" }}>无子目录</div> : null}
          {(!loading && !error) ? dirs.map((d: any) => (
            <button key={d.path} onClick={() => loadBrowse(d.path)} title={d.path} style={rowStyle}>
              <FolderIcon open={false} />
              <span style={{ flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>→</span>
            </button>
          )) : null}
        </div>
        {/* 底部 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 12px", borderTop: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0 }}>
          {msg ? <div style={{ fontSize: 11, color: msg.err ? "#f87171" : "#4ade80" }}>{msg.err || msg.ok}</div> : null}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono,ui-monospace,monospace)", fontSize: 11, color: "var(--text-dim,#888)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={browsePath}>→ 目标目录: {browsePath || "/"}</span>
            <button onClick={() => { if (!busy) onClose(); }} style={{ height: 28, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 12 }}>取消</button>
            <button onClick={() => void doMove()} disabled={busy || !browsePath} style={{ height: 28, padding: "0 12px", border: "none", borderRadius: 5, background: "var(--accent,#4f8ef7)", color: "#fff", cursor: busy ? "default" : "pointer", fontSize: 12, fontWeight: 600, opacity: (busy || !browsePath) ? 0.6 : 1 }}>{busy ? "…" : "移动到此目录"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
