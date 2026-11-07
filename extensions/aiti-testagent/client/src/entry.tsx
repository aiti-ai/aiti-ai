/**
 * aiti-testagent client entry —— JSX + vite 构建版（自手写 h() 一比一迁移，SOP §三）。
 * 逻辑与行为 1:1，无迁移修正项。i18n 走 ctx.t（at.* 词条在 index.ts ui.i18n）。
 *
 * UI：toolbar 声明式条目（☕ meta.icon + onClick）→ dialogs 面板：
 *     桥管理（模式/自建/外部配置 + JTO 开关 + 端点表 + 操作台/邀请）+ 直连 TA
 *     + 已挂载会话表（web 打开/关闭）+ 候选进程表（一键 attach）。
 */

import { useEffect, useState } from "react";
import { __setCtx, apiUrl, t } from "./host-shim";
// dock v3（P3 批）：面板显隐收口展示状态机（gate 唯一渲染开关）+ 右栏停靠 face
import { useGate, usePresent, DockBody, openFloat, closePanel, seedDockDefault } from "../../../_shared/ext-float-dock";

/** 面板 itemKey（= rightFileDock 注册复合 id "aiti-testagent:panel"） */
const TA_KEY = "aiti-testagent:panel";

// ---- 模块级开关（toolbar 与 dialogs 面板共享）——收口展示状态机 ----
const panel = {
  open() { openFloat(TA_KEY); },
  close() { closePanel(TA_KEY); },
};

// ---- fetch ----
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(apiUrl(`/api/extensions/aiti-testagent${path}`), {
    method, cache: "no-store",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  return d;
}

const ICONS: Record<string, string[]> = {
  cup: ["M17 8h1a4 4 0 1 1 0 8h-1", "M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z", "M6 2v2", "M10 2v2", "M14 2v2"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
};
function Ic({ size, paths }: { size?: number; paths: string[] }) {
  const s = size ?? 14;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

const fmtCmd = (s: unknown) => String(s || "").slice(0, 90);
const fmtTime = (ts?: number | string) => {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const th: Record<string, string | number> = { textAlign: "left", fontSize: 11, color: "var(--text-dim)", fontWeight: 500, padding: "5px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap" };
const td: Record<string, string | number> = { fontSize: 12, padding: "5px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const ghostBtn: Record<string, string | number> = { padding: "3px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer", background: "transparent", border: "1px solid var(--border)", color: "var(--text-muted)" };
const iconBtn: Record<string, string | number> = { width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 7, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 };

function Dot({ ok }: { ok?: boolean }) {
  return (
    <span
      title={ok ? t("at.active") : t("at.inactive")}
      style={{ display: "inline-block", width: 8, height: 8, borderRadius: 99, background: ok ? "#10b981" : "#6b7280", flexShrink: 0 }}
    />
  );
}

type SessionRow = { pid: number | string; active?: boolean; httpPort?: number; agentVersion?: string; startTime?: number | string; cmd?: string; web?: { enrolled?: boolean } };
type CandidateRow = { pid: number | string; port?: number; cmd?: string };

function AttachedTable({ rows, busyPid, onOpenWeb, onCloseWeb }: { rows: SessionRow[]; busyPid: string; onOpenWeb: (s: SessionRow) => void; onCloseWeb: (s: SessionRow) => void }) {
  if (rows.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "4px 8px" }}>{t("at.none")}</div>;
  }
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr>
          <th style={th} />
          <th style={th}>pid</th>
          <th style={th}>httpPort</th>
          <th style={th}>ver</th>
          <th style={th}>start</th>
          <th style={th}>cmd</th>
          <th style={{ ...th, textAlign: "right" }}>p-web</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => {
          const online = !!s.active;
          const busy = busyPid === `open:${s.pid}` || busyPid === `close:${s.pid}`;
          return (
            <tr key={String(s.pid)}>
              <td style={td}><Dot ok={online} /></td>
              <td style={{ ...td, fontWeight: 600 }}>{String(s.pid)}</td>
              <td style={{ ...td, color: "var(--accent)" }}>{String(s.httpPort ?? "")}</td>
              <td style={{ ...td, color: "var(--text-dim)" }}>{String(s.agentVersion ?? "")}</td>
              <td style={{ ...td, color: "var(--text-dim)" }}>{fmtTime(s.startTime)}</td>
              <td style={{ ...td, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }} title={s.cmd}>{fmtCmd(s.cmd)}</td>
              <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                {online && onOpenWeb ? (
                  <button
                    onClick={() => onOpenWeb(s)}
                    disabled={!!busyPid}
                    title={t("at.openTip")}
                    style={{ ...ghostBtn, color: "var(--accent)", fontWeight: 600, opacity: busyPid ? 0.5 : 1 }}
                  >
                    {busy && busyPid === `open:${s.pid}` ? "…" : `${t("at.open")}`}
                  </button>
                ) : null}
                {s.web?.enrolled && onCloseWeb ? (
                  <button onClick={() => onCloseWeb(s)} disabled={!!busyPid} title={t("at.webClose")} style={{ ...ghostBtn, marginLeft: 4, opacity: busyPid ? 0.5 : 1 }}>
                    {busy && busyPid === `close:${s.pid}` ? "…" : "⛓✕"}
                  </button>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CandidateTable({ rows, busyPid, onAttach }: { rows: CandidateRow[]; busyPid: string; onAttach: (pid: number | string) => void }) {
  if (rows.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)", padding: "4px 8px" }}>{t("at.none")}</div>;
  }
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr>
          <th style={th}>pid</th>
          <th style={th}>appPort</th>
          <th style={th}>cmd</th>
          <th style={{ ...th, textAlign: "right" }} />
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => {
          const busy = busyPid === String(p.pid);
          return (
            <tr key={String(p.pid)}>
              <td style={{ ...td, fontWeight: 600 }}>{String(p.pid)}</td>
              <td style={{ ...td, color: "var(--text-dim)" }}>{String(p.port || "—")}</td>
              <td style={{ ...td, maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis" }} title={p.cmd}>{fmtCmd(p.cmd)}</td>
              <td style={{ ...td, textAlign: "right" }}>
                <button
                  onClick={() => onAttach(p.pid)}
                  disabled={!!busyPid}
                  style={{ ...ghostBtn, opacity: busyPid ? 0.5 : 1, ...(busy ? { color: "var(--text)", fontWeight: 600 } : {}) }}
                >
                  {busy ? t("at.attaching") : t("at.attach")}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Section({ title, count, children }: { title: string; count: number; children?: ReactNodeLike }) {
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{`${title}（${count}）`}</div>
      {children}
    </div>
  );
}
type ReactNodeLike = unknown;

// ---- 面板 ----
export function Panel() { return renderTAPanel("float"); }
export function TADockFace() { return renderTAPanel("dock"); }

function renderTAPanel(face?: string) {
  const st = usePresent(TA_KEY);
  const open = face === "float" ? st === "floating" : st === "docked:right-panel";
  const floating = face === "float";
  const [data, setData] = useState<{ attached?: SessionRow[]; candidates?: CandidateRow[] } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busyPid, setBusyPid] = useState("");
  const [tick, setTick] = useState(0);
  // 桥管理（服务端 bridge.json 驱动）：模式/自建/外部配置 + JTO 开关 + 状态——一次拉取，保存后刷新
  const LS = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
  const SAVED = (k: string, v: string) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };
  const [bridgeInfo, setBridgeInfo] = useState<Record<string, unknown> | null>(null);
  const [mode, setMode] = useState("self");
  const [selfCfg, setSelfCfg] = useState({ httpPort: "8666", wsPort: "8667", regToken: "", useToken: "" });
  const [extCfg, setExtCfg] = useState({ url: "", ws: "", useToken: "", regToken: "" });
  const [bridgeMsg, setBridgeMsg] = useState("");
  // 直连 TA（次级：不经桥直连某个 TA 地址 ping）——保留
  const [taInput, setTaInput] = useState(() => LS("ta_direct_url", "http://127.0.0.1:8564"));
  const [taTokenInput, setTaTokenInput] = useState(() => LS("ta_direct_token", ""));
  const [taInfo, setTaInfo] = useState<{ online: boolean; status?: number } | null>(null);
  const applyBridgeInfo = (d: Record<string, unknown> | null) => {
    setBridgeInfo(d);
    if (d?.config) {
      const config = d.config as { mode?: string; self?: Record<string, unknown>; external?: Record<string, unknown> };
      setMode(config.mode === "external" ? "external" : "self");
      if (config.self) setSelfCfg((c) => ({ ...c, ...Object.fromEntries(Object.entries(config.self!).map(([k, v]) => [k, String(v ?? "")])) }));
      if (config.external) setExtCfg((c) => ({ ...c, ...Object.fromEntries(Object.entries(config.external!).map(([k, v]) => [k, String(v ?? "")])) }));
    }
  };
  useEffect(() => {
    if (!open) return;
    api("GET", "/bridge").then(applyBridgeInfo).catch((e) => setBridgeMsg("✗ " + (e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tick]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setErr("");
    api("GET", "/processes")
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e?.message ?? String(e)); });
    return () => { alive = false; };
  }, [open, tick]);

  if (!open) return null;
  const attached = data?.attached ?? [];
  const candidates = data?.candidates ?? [];

  const doAttach = async (pid: number | string) => {
    setBusyPid(String(pid));
    setMsg("");
    try {
      // 已配置桥 → attach 同时挂上桥（ws 地址/注册 token 来自桥配置；agentmain 幂等，旧挂载进程运行时补连）
      const st = (bridgeInfo?.status ?? null) as { configured?: boolean; ws?: string; url?: string } | null;
      const onBridge = st?.configured && st?.ws;
      const r = await api("POST", "/attach", {
        pid,
        ...(onBridge ? {
          bridge: st!.url, useToken: mode === "self" ? selfCfg.useToken : extCfg.useToken,
          bridgeWs: st!.ws, regToken: mode === "self" ? selfCfg.regToken : extCfg.regToken,
        } : {}),
      });
      if (r.ok) { setMsg(`${t("at.attachOk")} — pid=${r.session?.pid} httpPort=${r.session?.httpPort}${r.onBridge ? "（已上桥）" : ""}`); setTick((v) => v + 1); }
      else setMsg(`${r.error || t("at.attachFail")}`);
    } catch (e) { setMsg(`${(e as Error)?.message ?? String(e)}`); }
    finally { setBusyPid(""); }
  };

  /** 保存桥配置：self 模式自动拉起（幂等）；jto 开着则服务端重写自动挂载段（bashrc 块 / 用户级 JAVA_TOOL_OPTIONS） */
  const doSaveBridge = async () => {
    setBridgeMsg("保存中…");
    try {
      const body = mode === "self"
        ? { mode, self: { httpPort: Number(selfCfg.httpPort) || undefined, wsPort: Number(selfCfg.wsPort) || undefined, regToken: selfCfg.regToken, useToken: selfCfg.useToken } }
        : { mode, external: extCfg };
      const r = await api("POST", "/bridge", body);
      if (!r.ok) { setBridgeMsg("✗ " + (r.error || "保存失败")); return; }
      applyBridgeInfo(r);
      const st = r.status ?? {};
      setBridgeMsg(st.online ? `桥在线 ${st.url}（在线端点 ${st.endpointCount}/${st.endpoints.length}）` : "桥未就绪（查看系统临时目录下的 ta-bridge-*.log）");
    } catch (e) { setBridgeMsg("✗ " + ((e as Error)?.message ?? String(e))); }
  };

  const doJto = async (enabled: boolean) => {
    setBridgeMsg(enabled ? "开启中…" : "关闭中…");
    try {
      const r = await api("POST", "/bridge/jto", { enabled });
      if (!r.ok) { setBridgeMsg("✗ " + (r.error || "失败")); return; }
      setBridgeInfo((d) => ({ ...d, jto: { ...((d as Record<string, unknown>)?.jto ?? {}), enabled: r.enabled } }));
      setBridgeMsg(enabled
        ? "已写入 JAVA_TOOL_OPTIONS 自动挂载（Linux/macOS = shell rc 标记块，Windows = 用户级环境变量）—— 之后新起的 Java 进程自动挂 agent 连桥（对已运行的进程不生效）"
        : "已移除 JAVA_TOOL_OPTIONS 自动挂载段（用户其他参数保留）");
    } catch (e) { setBridgeMsg("✗ " + ((e as Error)?.message ?? String(e))); }
  };

  /** 打开桥操作台：挂桥 httpPort（vhost）→ 可带 ?endpoint= 直达指定端点（免手动下拉）；带 ?bridge-token= 自动登录 */
  const doOpenBridgeConsole = async (endpointId?: string) => {
    const st = (bridgeInfo?.status ?? null) as { configured?: boolean; url?: string } | null;
    if (!st?.configured) { setBridgeMsg("桥未配置"); return; }
    let port = Number((st.url || "").match(/:(\d+)/)?.[1] ?? 0);
    if (!port && mode === "self") port = Number(selfCfg.httpPort) || 0;
    if (!port) { setBridgeMsg("无法解析桥 HTTP 端口"); return; }
    const useToken = mode === "self" ? selfCfg.useToken : extCfg.useToken;
    setBridgeMsg("打开操作台中…");
    const win = window.open("", "_blank"); // 同步开窗（用户手势栈内防拦截）
    try {
      const r = await api("POST", "/web-open", { port, basePath: "/testagent" });
      if (!r.ok) { if (win && !win.closed) win.close(); setBridgeMsg("✗ " + (r.error || t("at.openFail"))); return; }
      const url = r.url + (useToken ? (r.url.includes("?") ? "&" : "?") + "bridge-token=" + encodeURIComponent(useToken) : "")
        + (endpointId ? (r.url.includes("?") ? "&" : "?") + "endpoint=" + encodeURIComponent(endpointId) : "");
      setBridgeMsg(`桥操作台${endpointId ? "（直达端点 " + endpointId.slice(0, 12) + "…）" : ""}：${r.url}${r.degraded ? t("at.degraded") : ""}${r.synced ? "" : t("at.syncWarn")}`);
      if (win && !win.closed) win.location.href = url;
      else {
        try { await navigator.clipboard.writeText(url); setBridgeMsg((m) => m + "（弹窗被拦截：URL 已复制）"); }
        catch { setBridgeMsg((m) => m + "（弹窗被拦截：" + url + "）"); }
      }
      setTick((v) => v + 1);
    } catch (e) {
      try { if (win && !win.closed) win.close(); } catch {}
      setBridgeMsg("✗ " + ((e as Error)?.message ?? String(e)));
    }
  };

  const doDirectTa = async () => {
    SAVED("ta_direct_url", taInput.trim()); SAVED("ta_direct_token", taTokenInput.trim());
    setTaInfo(null); setMsg("");
    try {
      const r = await api("POST", "/ta/call", { url: taInput.trim(), token: taTokenInput.trim(), path: "/api/ping" });
      if (r.ok) { setTaInfo({ online: true }); setMsg(`TA 直连在线：${taInput.trim()}（pong）`); }
      else setTaInfo({ online: false, status: r.status });
    } catch (e) { setTaInfo({ online: false }); setMsg("✗ " + ((e as Error)?.message ?? String(e))); }
  };

  /** 打开 Web 操作台：同步开空白窗（保住用户手势防拦截）→ 服务端 service-tunnels proxy no-auth
   *  登记 + 对端同步 → 导航到 p-web 域下的操作台 URL；弹窗被拦时退化为复制 URL 提示。 */
  const doOpenWeb = async (s: SessionRow) => {
    setBusyPid(`open:${s.pid}`); setMsg("");
    const win = window.open("", "_blank"); // 必须同步调用（用户手势栈内）
    try {
      const r = await api("POST", "/web-open", { pid: s.pid });
      if (!r.ok) { if (win && !win.closed) win.close(); setMsg(`${r.error || t("at.openFail")}`); return; }
      setMsg(`${t("at.open")}: ${r.url}${r.degraded ? t("at.degraded") : ""}${r.synced ? "" : t("at.syncWarn")}`);
      if (win && !win.closed) win.location.href = r.url;
      else {
        try { await navigator.clipboard.writeText(r.url); setMsg((m) => m + "（弹窗被拦截：URL 已复制）"); }
        catch { setMsg((m) => m + "（弹窗被拦截：" + r.url + "）"); }
      }
      setTick((v) => v + 1);
    } catch (e) {
      try { if (win && !win.closed) win.close(); } catch {}
      setMsg(`${(e as Error)?.message ?? String(e)}`);
    } finally { setBusyPid(""); }
  };

  const doCloseWeb = async (s: SessionRow) => {
    if (!s.httpPort) return;
    setBusyPid(`close:${s.pid}`); setMsg("");
    try {
      const r = await api("POST", "/web-close", { port: s.httpPort });
      setMsg(r.ok ? `${t("at.webClose")}: port=${s.httpPort}` : `${r.error || "失败"}`);
      setTick((v) => v + 1);
    } catch (e) { setMsg(`${(e as Error)?.message ?? String(e)}`); }
    finally { setBusyPid(""); }
  };

  // 通用小输入框（连接配置行）
  const inp = (props: { value: string; set: (v: string) => void; placeholder?: string; title?: string; w?: number; type?: string; onEnter?: () => void }) => (
    <input
      value={props.value}
      placeholder={props.placeholder || ""}
      title={props.title || ""}
      onChange={(e) => props.set(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && props.onEnter) props.onEnter(); }}
      style={{ width: props.w || 150, padding: "4px 8px", fontSize: 11, borderRadius: 7, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}
      type={props.type || "text"}
    />
  );

  const bridgeApiTarget = () => ({ bridge: bridgeSt?.url || "", useToken: bridgeToken() });
  const doRemoveEndpoint = async (endpointId: string) => {
    setMsg("");
    try {
      const r = await api("POST", "/tunnel-remove", { ...bridgeApiTarget(), endpointId });
      if (r.ok) { setMsg(`已移除 ${endpointId.slice(0, 10)}`); setTick((v) => v + 1); }
      else setMsg(`${r.error || "移除失败"}`);
    } catch (e) { setMsg(`${(e as Error)?.message ?? String(e)}`); }
  };

  const doInvite = async () => {
    setMsg("");
    try {
      const r = await api("POST", "/reg-token", { ...bridgeApiTarget(), ttlSec: 300 });
      if (r.ok && r.data?.token) setMsg(`邀请票据（${r.data.ttlSec}s 内有效）：${r.data.token} —— 发给对方，对方用 -Dtestagent.bridge.token=${r.data.token} 上桥`);
      else setMsg("✗ " + (r.error || "签发失败"));
    } catch (e) { setMsg(`${(e as Error)?.message ?? String(e)}`); }
  };

  const doTunnelStatus = async (endpointId: string) => {
    setMsg("");
    try {
      const r = await api("POST", "/tunnel", { ...bridgeApiTarget(), action: "status", endpointId });
      const d = r.data || {};
      setMsg(`⇄ ${endpointId.slice(0, 10)}：state=${d.state || "?"}${d.endpointId ? " id=" + d.endpointId : ""}${d.lastError ? " lastError=" + d.lastError : ""}`);
    } catch (e) { setMsg(`${(e as Error)?.message ?? String(e)}`); }
  };

  const header = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      <strong style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
        <Ic size={15} paths={ICONS.cup} />
        {t("at.title")}
      </strong>
      <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
        <button onClick={() => setTick((v) => v + 1)} title={t("at.refresh")} style={iconBtn}><Ic size={13} paths={ICONS.refresh} /></button>
        {/* 关闭按钮：aria-label="close" —— aiti-helper 全局 AI 按钮（🤖）的注入锚点；停靠态不渲染（TabBar ✕ 关闭） */}
        {floating && <button onClick={() => panel.close()} aria-label="close" title={t("at.close")} style={{ ...iconBtn, color: "var(--text)" }}><Ic size={13} paths={ICONS.x} /></button>}
      </span>
    </div>
  );

  const tip = <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "0 4px" }}>{t("at.tip")}</div>;

  // 桥管理（服务端 bridge.json 驱动）：端点列表含离线；[🖥] 打开桥操作台（vhost，右上角端点下拉选目标）
  const bridgeSt = (bridgeInfo?.status ?? null) as { configured?: boolean; url?: string; online?: boolean; endpointCount?: number; identityOk?: boolean; instanceId?: string; bridgeInstanceId?: string; endpoints?: Array<{ endpointId: string; online?: boolean; pid?: number; httpPort?: number; remoteIp?: string; cmd?: string }> } | null;
  const identityWarn = !!(bridgeSt?.online && bridgeSt.identityOk === false);
  const bridgeEndpoints = bridgeSt?.endpoints ?? [];
  const bth = { ...th };
  const bridgeToken = () => (mode === "self" ? selfCfg.useToken : extCfg.useToken);
  const bridgeSection = bridgeSt?.configured ? (
    <Section
      title={`⇄ 桥端点（${bridgeSt.url}${bridgeSt.online ? ` · 在线 ${bridgeSt.endpointCount}/${bridgeEndpoints.length}` : " · 离线"}）`}
      count={bridgeEndpoints.length}
    >
      {!bridgeSt.online ? (
        <div style={{ fontSize: 12, color: "var(--danger, #f87171)", padding: "4px 8px" }}>{"桥不可达（自建桥保存时自动拉起；查看宿主日志，系统临时目录下 ta-bridge-*.log）"}</div>
      ) : identityWarn ? (
        <div style={{ fontSize: 12, color: "var(--danger, #f87171)", background: "rgba(248,113,113,.08)", border: "1px solid rgba(248,113,113,.3)", borderRadius: 6, padding: "6px 8px" }}>{`端口上是另一个不同配置的 TaBridge（instanceId=${bridgeSt.bridgeInstanceId}，期望=${bridgeSt.instanceId}）——本面板未接管，请换端口或先停旧桥`}</div>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={bth} />
              <th style={bth}>endpointId</th>
              <th style={bth}>pid</th>
              <th style={bth}>port</th>
              <th style={bth}>remote</th>
              <th style={bth}>cmd</th>
              <th style={{ ...bth, textAlign: "right" }} />
            </tr>
          </thead>
          <tbody>
            {bridgeEndpoints.map((e) => (
              <tr key={e.endpointId}>
                <td style={td}><Dot ok={e.online} /></td>
                <td style={{ ...td, fontFamily: "var(--mono, monospace)" }}>{e.endpointId}</td>
                <td style={td}>{String(e.pid ?? "")}</td>
                <td style={td}>{String(e.httpPort ?? "")}</td>
                <td style={{ ...td, color: "var(--text-dim)" }}>{String(e.remoteIp ?? "")}</td>
                <td style={{ ...td, maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }} title={e.cmd}>{fmtCmd(e.cmd)}</td>
                <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                  <button onClick={() => doOpenBridgeConsole(e.endpointId)} title="直达该端点操作台（?endpoint= 参数，X-TA-Endpoint 路由）" style={{ ...ghostBtn, marginRight: 4, color: "var(--accent)" }}>🖥</button>
                  <button onClick={() => doTunnelStatus(e.endpointId)} title="经桥查该端点隧道状态" style={{ ...ghostBtn, marginRight: 4 }}>{"隧道"}</button>
                  {!e.online ? <button onClick={() => doRemoveEndpoint(e.endpointId)} title="移除离线条目（下次上线自动恢复同 id）" style={ghostBtn}>✕</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  ) : null;

  // 桥管理卡片：模式切换 + 配置 + 保存拉起 + JTO 自动挂载开关 + 打开操作台
  const modeSeg = (
    <span style={{ display: "inline-flex", gap: 0, borderRadius: 7, overflow: "hidden", border: "1px solid var(--border)" }}>
      {["self", "external"].map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          style={{ padding: "3px 10px", fontSize: 11, cursor: "pointer", border: "none", background: mode === m ? "var(--accent)" : "transparent", color: mode === m ? "#fff" : "var(--text-muted)", fontWeight: mode === m ? 600 : 400 }}
        >
          {m === "self" ? "自建桥" : "外部桥"}
        </button>
      ))}
    </span>
  );
  const connRow = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 11 }}>
      {/* 行 1：模式 + 状态 + 打开操作台 + 邀请 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        {modeSeg}
        {bridgeSt?.configured ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--text-dim)" }}>
            <Dot ok={!!bridgeSt.online} />
            {bridgeSt.online ? `在线 · 端点 ${bridgeSt.endpointCount}/${bridgeEndpoints.length}` : "离线"}
          </span>
        ) : null}
        <button
          onClick={() => doOpenBridgeConsole()}
          disabled={!bridgeSt?.configured}
          title="挂载桥端口到 pi-web 域（service-tunnels proxy 无认证）并打开完整操作台；右上角端点下拉切换目标，MCP 同源路由"
          style={{ ...ghostBtn, color: "var(--accent)", fontWeight: 600 }}
        >
          {"打开操作台"}
        </button>
        <button onClick={doInvite} disabled={!bridgeSt?.configured} title="签发 5 分钟临时注册票据（发给受邀者 -Dtestagent.bridge.token 上桥用，过期自动作废）" style={ghostBtn}>{"邀请"}</button>
        <button onClick={doSaveBridge} style={ghostBtn}>{mode === "self" ? "保存并启动" : "保存并连接"}</button>
      </div>
      {/* 行 2：按模式配置 */}
      {mode === "self" ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={{ color: "var(--text-dim)" }}>{"自建桥"}</span>
          {inp({ value: selfCfg.httpPort, set: (v) => setSelfCfg((c) => ({ ...c, httpPort: v })), placeholder: "http 端口", w: 76, title: "桥 HTTP 端口（操作台+转发）" })}
          {inp({ value: selfCfg.wsPort, set: (v) => setSelfCfg((c) => ({ ...c, wsPort: v })), placeholder: "ws 端口", w: 70, title: "桥 WS 端口（端点隧道）" })}
          {inp({ value: selfCfg.regToken, set: (v) => setSelfCfg((c) => ({ ...c, regToken: v })), placeholder: "注册 token（可选）", w: 130, type: "password", title: "端点注册需携带（--reg-token）" })}
          {inp({ value: selfCfg.useToken, set: (v) => setSelfCfg((c) => ({ ...c, useToken: v })), placeholder: "access token（可选）", w: 130, type: "password", title: "桥访问鉴权（--use-token）" })}
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={{ color: "var(--text-dim)" }}>{"外部桥"}</span>
          {inp({ value: extCfg.url, set: (v) => setExtCfg((c) => ({ ...c, url: v })), placeholder: "http://host:8666", w: 170, title: "外部桥 HTTP 地址（操作台+转发）" })}
          {inp({ value: extCfg.ws, set: (v) => setExtCfg((c) => ({ ...c, ws: v })), placeholder: "ws://host:8667/ta/ws", w: 180, title: "外部桥 WS 地址（attach 上桥用；桥操作台 URL 推导亦可）" })}
          {inp({ value: extCfg.useToken, set: (v) => setExtCfg((c) => ({ ...c, useToken: v })), placeholder: "access token（可选）", w: 130, type: "password", title: "桥访问鉴权（X-TA-Bridge-Token）" })}
          {inp({ value: extCfg.regToken, set: (v) => setExtCfg((c) => ({ ...c, regToken: v })), placeholder: "注册 token（可选）", w: 130, type: "password", title: "端点注册需携带" })}
        </div>
      )}
      {/* 行 3：JTO 自动挂载开关 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <button
          onClick={() => doJto(!((bridgeInfo as { jto?: { enabled?: boolean } } | null)?.jto?.enabled))}
          disabled={!bridgeSt?.configured}
          title="写/删 JAVA_TOOL_OPTIONS 自动挂载（Linux/macOS = ~/.bashrc 标记块，Windows = 用户级环境变量）：让之后新起的 Java 进程自动挂 agent 并连桥（httpPort 随机）——设好后等 ta client 自动注册即可"
          style={{ ...ghostBtn, color: (bridgeInfo as { jto?: { enabled?: boolean } } | null)?.jto?.enabled ? "var(--accent)" : "var(--text-muted)", fontWeight: 600 }}
        >
          {(bridgeInfo as { jto?: { enabled?: boolean } } | null)?.jto?.enabled ? "JAVA_OPTS 自动挂载：开" : "⚪ JAVA_OPTS 自动挂载：关"}
        </button>
        <span style={{ color: "var(--text-dim)" }}>
          {(bridgeInfo as { jto?: { enabled?: boolean } } | null)?.jto?.enabled ? "新 Java 进程自动挂 agent 连桥，等注册即可（含 maven/gradle 等，注意开销）" : "开启后之后新起的 Java 进程默认连桥（Linux/macOS 写 shell rc，Windows 写用户级环境变量）"}
        </span>
      </div>
      {/* 行 4：直连 TA（次级：不经桥直连某个 TA 地址 ping） */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", paddingTop: 2, borderTop: "1px dashed var(--border)" }}>
        <span style={{ color: "var(--text-dim)" }}>{"直连 TA"}</span>
        {inp({ value: taInput, set: setTaInput, placeholder: "http://127.0.0.1:8564", w: 170, onEnter: doDirectTa })}
        {inp({ value: taTokenInput, set: setTaTokenInput, placeholder: "token（可选）", w: 110, type: "password", onEnter: doDirectTa })}
        <button onClick={doDirectTa} style={ghostBtn}>{"ping"}</button>
      </div>
      {bridgeMsg ? <div style={{ fontSize: 11, color: "var(--text-dim)", wordBreak: "break-all" }}>{bridgeMsg}</div> : null}
    </div>
  );

  const body = (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg)" }}>
        {connRow}
        {taInfo ? <div style={{ fontSize: 11, color: taInfo.online ? "var(--text-dim)" : "var(--danger, #f87171)" }}>{taInfo.online ? "TA 在线" : "TA 不在线（HTTP " + (taInfo.status ?? "-") + "）"}</div> : null}
      </div>
      {err ? <div style={{ color: "var(--danger, #f87171)", fontSize: 12 }}>{err}</div> : null}
      {msg ? <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{msg}</div> : null}
      <Section title={t("at.attached")} count={attached.length}>
        <AttachedTable rows={attached} busyPid={busyPid} onOpenWeb={doOpenWeb} onCloseWeb={doCloseWeb} />
      </Section>
      {bridgeSection}
      <Section title={t("at.candidates")} count={candidates.length}>
        <CandidateTable rows={candidates} busyPid={busyPid} onAttach={doAttach} />
      </Section>
      {tip}
    </div>
  );

  const taContent = (
    <>
      {header}
      {body}
    </>
  );

  // dock v3 分面：float = 遮罩+浮窗壳；dock = 右栏 tab（DockBody chrome 带 ⇲/位置菜单，TabBar ✕ 关闭）
  if (floating) {
    return (
      <div
        style={{ position: "fixed", inset: 0, zIndex: 292, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
        onClick={() => panel.close()}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          data-ext-float="1"
          data-ext-float-key={TA_KEY}
          data-ext-float-dock="right-panel"
          data-ext-float-dock-default="right-panel"
          data-ext-float-full="1"
          data-ext-float-w={780}
          data-ext-float-h={560}
          style={{ width: "min(780px, 95vw)", height: "min(78vh, 620px)", borderRadius: 14, display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", overflow: "hidden", boxShadow: "0 18px 60px rgba(0,0,0,0.4)" }}
        >
          {taContent}
        </div>
      </div>
    );
  }
  return (
    <DockBody itemKey={TA_KEY} zone="right-panel" title={t("at.title")} chrome="tab" zones={["right-panel"]} defaultZone="right-panel">
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "var(--bg-panel)", color: "var(--text)" }}>
        {taContent}
      </div>
    </DockBody>
  );
}

// ToolbarEntry 已迁声明式条目（register meta.icon + meta.onClick，宿主统一渲染按钮）；保留 ICONS.cup 供其引用

export default function register(ctx: Record<string, unknown>) {
  __setCtx(ctx);
  const reg = ctx.registerItems as ((slot: string, items: unknown[]) => void) | undefined;
  // 声明式工具条条目（2026-08 契约）：无 render，宿主用 meta.icon + meta.onClick 统一渲染
  // 标准 36×36 灰度按钮（右分隔线 + hover），⋯ 菜单里同款图标槽 + label —— 外观归宿主，不再自绘
  // aiti-float dock v3（P3 批）：默认右栏 tab（双表格需横向空间）
  seedDockDefault(TA_KEY, "right-panel");
  reg?.("rightFileDock", [{ id: "panel", render: TADockFace, meta: { title: "Java" } }]);
  reg?.("toolbar", [{
    id: "java",
    meta: {
      label: "Java",
      title: t("at.title"),
      icon: "icons/coffee.svg",
      onClick: () => panel.open(),
    },
  }]);
  reg?.("dialogs", [{ id: "panel", render: Panel }]);

  console.log("[aiti-testagent] client 已挂载（Java 面板 dialogs + toolbar 声明式条目，JSX 构建版）");
}
