/**
 * aiti-testagent-native client entry —— testagent-native broker 可视面板（JSX + vite 构建版）。
 *
 * 面板：broker 状态点 + 会话表（eject）+ 进程表（attach）+ 挂钩表单 + 实时事件流
 * （subscribe + 1s 拉取）。数据经扩展服务端代理（/api/extensions/aiti-testagent-native）。
 */

import { useEffect, useState } from "react";
import { __setCtx, apiUrl, t } from "./host-shim";
import { useGate, DockBody, openFloat, closePanel, seedDockDefault } from "../../../_shared/ext-float-dock";

const WT_KEY = "aiti-testagent-native:panel";

const panel = {
  open() { openFloat(WT_KEY); },
  close() { closePanel(WT_KEY); },
};

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(apiUrl(`/api/extensions/aiti-testagent-native${path}`), {
    method, cache: "no-store",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  return d;
}

const th: Record<string, string | number> = { textAlign: "left", fontSize: 11, color: "var(--text-dim)", fontWeight: 500, padding: "4px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
const td: Record<string, string | number> = { fontSize: 12, padding: "4px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const ghostBtn: Record<string, string | number> = { padding: "2px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", background: "transparent", border: "1px solid var(--border)", color: "var(--text-muted)" };
const input: Record<string, string | number> = { padding: "3px 8px", borderRadius: 7, fontSize: 12, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)" };

const capsText = (c: unknown) => {
  if (!c || typeof c !== "object") return "";
  return Object.entries(c as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k).join(",") || "-";
};

type SessionRow = { session_id: string; pid: number; arch?: string; alive?: boolean; capabilities?: unknown };
type ProcRow = { pid: number; name: string; arch?: string; injected?: boolean };

export function Panel() { return renderWTPanel("float"); }
export function WTDockFace() { return renderWTPanel({ dock: "right-panel" }); }

function renderWTPanel(face: "float" | { dock: "right-panel" }) {
  // useGate 第二参必需（"float" | {dock}）：漏传会读 undefined.dock 崩溃（2026-09-10 修）
  const gate = useGate(WT_KEY, face);
  const floating = face === "float";
  const [up, setUp] = useState<boolean | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [procs, setProcs] = useState<ProcRow[]>([]);
  const [q, setQ] = useState("");
  const [sid, setSid] = useState("");
  const [wmod, setWmod] = useState("kernel32");
  const [wfn, setWfn] = useState("CreateFile*");
  const [subId, setSubId] = useState("");
  const [events, setEvents] = useState<any[]>([]);
  const [busy, setBusy] = useState("");

  const refresh = async () => {
    try {
      const h = await api("GET", "/health");
      setUp(!!h.ok);
      if (!h.ok) return;
      const sj = await api("GET", "/sessions");
      setSessions(sj.sessions || []);
      const pj = await api("GET", `/processes?query=${encodeURIComponent(q)}`);
      setProcs(pj.procs || []);
    } catch { setUp(false); }
  };
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!subId) return;
    const iv = setInterval(async () => {
      try {
        const j = await api("POST", "/events", { sub_id: subId });
        if (j.events?.length) setEvents((old) => [...old, ...j.events].slice(-400));
      } catch { /* broker 重启/会话变化：静默 */ }
    }, 1000);
    return () => clearInterval(iv);
  }, [subId]);

  // 渲染门控（所有 hooks 之后）：非本 face 呈现态不渲染——浮窗/dock 双 face 结构性防双开
  if (!gate) return null;

  const doAttach = async (pid: number) => {
    setBusy(`attach:${pid}`);
    try { await api("POST", "/attach", { pid }); await refresh(); } catch (e) { alert(String(e)); }
    setBusy("");
  };
  const doDetach = async (session_id: string) => {
    setBusy(`detach:${session_id}`);
    try {
      await api("POST", "/detach", { session_id });
      if (subId) { setSubId(""); setEvents([]); }
      await refresh();
    } catch (e) { alert(String(e)); }
    setBusy("");
  };
  const doWatch = async () => {
    if (!sid) return;
    setBusy("watch");
    try {
      await api("POST", "/watch", { session_id: sid, module: wmod, func_glob: wfn });
      const j = await api("POST", "/subscribe", { session_id: sid });
      setSubId(j.sub_id || "");
    } catch (e) { alert(String(e)); }
    setBusy("");
  };

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
      <span style={{ width: 9, height: 9, borderRadius: 99, background: up === null ? "#6b7280" : up ? "#10b981" : "var(--danger, #ef4444)", display: "inline-block" }} />
      <b style={{ fontSize: 13 }}>{t("wt.title")}</b>
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("wt.broker")}: 127.0.0.1:8766</span>
      <span style={{ flex: 1 }} />
      <button style={ghostBtn} onClick={() => void refresh()}>{t("wt.refresh")}</button>
      {/* ✕ 仅浮窗：停靠态 TabBar 页签已有 ✕，双 ✕ 会双关闭（v3.1 工具条收敛） */}
      {floating && <button style={ghostBtn} onClick={() => panel.close()}>{t("wt.eject") === "卸载" ? "✕" : "✕"}</button>}
    </div>
  );

  const body = (
    <div style={{ flex: 1, overflow: "auto", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 10 }}>
      {up === false && <div style={{ fontSize: 12, color: "var(--danger, #ef4444)" }}>{t("wt.offline")}</div>}

      <div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", margin: "2px 0 4px" }}>{t("wt.sessions")}</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>session</th><th style={th}>pid</th><th style={th}>arch</th><th style={th}>caps</th><th style={th}></th></tr></thead>
          <tbody>
            {sessions.length === 0 && <tr><td style={td} colSpan={5}>{t("wt.none")}</td></tr>}
            {sessions.map((s) => (
              <tr key={s.session_id}>
                <td style={td}>{s.session_id}</td>
                <td style={td}>{s.pid}</td>
                <td style={td}>{s.arch}</td>
                <td style={{ ...td, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{capsText(s.capabilities)}</td>
                <td style={td}>
                  <button style={ghostBtn} disabled={busy === `detach:${s.session_id}`} onClick={() => void doDetach(s.session_id)}>{t("wt.eject")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", margin: "2px 0 4px" }}>{t("wt.processes")}</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>pid</th><th style={th}>name</th><th style={th}>arch</th><th style={th}></th></tr></thead>
          <tbody>
            {procs.length === 0 && <tr><td style={td} colSpan={4}>{t("wt.none")}</td></tr>}
            {procs.map((p) => (
              <tr key={p.pid}>
                <td style={td}>{p.pid}</td>
                <td style={td}>{p.name}</td>
                <td style={td}>{p.arch}</td>
                <td style={td}>
                  {!p.injected && <button style={ghostBtn} disabled={busy === `attach:${p.pid}`} onClick={() => void doAttach(p.pid)}>{t("wt.attach")}</button>}
                  {p.injected && <span style={{ fontSize: 11, color: "#10b981" }}>injected</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("wt.watch")}</span>
        <select style={input} value={sid} onChange={(e) => setSid(e.target.value)}>
          {sessions.length === 0 && <option value="">- {t("wt.none")} -</option>}
          {sessions.map((s) => <option key={s.session_id} value={s.session_id}>{s.session_id} (pid {s.pid})</option>)}
        </select>
        <input style={{ ...input, width: 110 }} value={wmod} onChange={(e) => setWmod(e.target.value)} placeholder={t("wt.module")} />
        <input style={{ ...input, width: 150 }} value={wfn} onChange={(e) => setWfn(e.target.value)} placeholder={t("wt.func")} />
        <button style={ghostBtn} disabled={!sid || busy === "watch"} onClick={() => void doWatch()}>{t("wt.watch")}</button>
      </div>

      <div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", margin: "2px 0 4px" }}>
          {t("wt.events")} {subId ? <span style={{ color: "#10b981" }}>live</span> : null}
          <button style={{ ...ghostBtn, marginLeft: 8 }} onClick={() => setEvents([])}>clear</button>
        </div>
        <div style={{ maxHeight: 260, overflow: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={th}>#</th><th style={th}>kind</th><th style={th}>phase</th><th style={th}>module!func</th><th style={th}>value</th></tr></thead>
            <tbody>
              {events.length === 0 && <tr><td style={td} colSpan={5}>{t("wt.none")}</td></tr>}
              {events.map((e: any, i: number) => {
                const pv = e.args?.find((a: any) => a.preview)?.preview;
                return (
                  <tr key={i} title={JSON.stringify(e)} style={{ cursor: "pointer" }} onClick={() => console.log("[aiti-testagent-native]", e)}>
                    <td style={td}>{i + 1}</td>
                    <td style={td}>{e.kind}</td>
                    <td style={{ ...td, color: e.phase === "enter" ? "#58a6ff" : "#3fb950" }}>{e.phase}</td>
                    <td style={td}>{e.module}!{e.func}</td>
                    <td style={{ ...td, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {e.phase === "leave" ? `ret=${e.ret?.hex ?? ""} err=${e.last_error ?? ""}` : pv ?? e.args?.[0]?.hex ?? ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );

  const content = (
    <>
      {header}
      {body}
    </>
  );

  if (floating) {
    return (
      <div style={{ position: "fixed", inset: 0, zIndex: 292, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => panel.close()}>
        <div
          onClick={(e) => e.stopPropagation()}
          data-ext-float="1" data-ext-float-key={WT_KEY} data-ext-float-dock="right-panel" data-ext-float-dock-default="right-panel" data-ext-float-full="1" data-ext-float-w={820} data-ext-float-h={600}
          style={{ width: "min(820px, 95vw)", height: "min(80vh, 640px)", borderRadius: 14, display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.4)" }}
        >
          {content}
        </div>
      </div>
    );
  }
  return (
    <DockBody itemKey={WT_KEY} zone="right-panel" title={t("wt.title")} chrome="tab" zones={["right-panel"]} defaultZone="right-panel">
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "var(--bg-panel)", color: "var(--text)" }}>
        {content}
      </div>
    </DockBody>
  );
}

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx);
  const reg = ctx.registerItems as ((slot: string, items: unknown[]) => void) | undefined;
  seedDockDefault(WT_KEY, "right-panel");
  reg?.("rightFileDock", [{ id: "panel", render: WTDockFace, meta: { title: "Win" } }]);
  reg?.("toolbar", [{
    id: "testagent-native",
    meta: {
      label: "Win",
      title: t("wt.title"),
      icon: "icons/monitor.svg",
      onClick: () => panel.open(),
    },
  }]);
  reg?.("dialogs", [{ id: "panel", render: Panel }]);
  console.log("[aiti-testagent-native] client 已挂载（testagent-native 面板 dialogs + toolbar 声明式条目，JSX 构建版）");
}
