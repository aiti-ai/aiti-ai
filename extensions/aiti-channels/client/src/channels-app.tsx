/**
 * aiti-channels client —— cc-connect 完整管理面板（v4 · JSX 版，自手写 h() 版迁移）
 *
 * 定位（用户澄清：aiti-channels 是 cc-connect 的完整管理者，从安装到配置全生命周期托管）：
 *   9 个 tab：🏠总览 / 📦安装 / 📝配置 / 🗂项目 / 🔌渠道 / 💬会话 / 📜消息 / 📋日志 / 🖥️原版
 *   - 大屏：左侧导航栏 + 内容区
 *   - 小屏：底部导航栏（横向滚动）+ 内容区全屏
 *   - 顶栏：状态灯 + 启停/重启 + 💾reload + ♻自重启 + ⟳刷新 + ✕关闭
 *
 * 数据源（index.ts API）：
 *   status / start / stop / restart / log / config(GET+POST) / send / sessions
 *   / reload-cc / restart-cc / msg-log / install / install-status
 *
 * 架构：模块级单例 store（state/listeners/setState）+ ChannelsPanelComp 订阅强制重渲染
 * ——与手写版一致（configForm 等跨 tab 状态保留语义不变），仅渲染层 h() → JSX。
 */
import { useState, useEffect, useRef } from "react";
import { apiUrl, t } from "./host-shim";
import { PLATFORM_SCHEMAS, platformSchema } from "../../lib/platform-schema.ts";

const API = (p: string) => apiUrl(p);

// ---------- 模块级状态 ----------
const state: Record<string, any> = {
  open: false,
  status: null,          // /status 载荷
  tab: "overview",       // 当前 tab
  nav: "left",           // left(大屏) | bottom(小屏)
  log: [],
  sessions: [],
  msgLog: [],
  install: null,         // /install-status 载荷
  configRaw: "",         // config.toml 原文
  configCfg: null,
  instances: [],          // 实例列表
  curInstance: "default", // 当前实例 id
  configForm: {
    management: { port: 9820, token: "" },
    bridge: { port: 9810 },
    projects: [{ name: "", agent: "piweb", work_dir: "", platforms: [{ type: "dingtalk", client_id: "", client_secret: "", agent_id: "" }] }],
  },
  newInst: { id: "", name: "", dataDir: "" }, // 新建实例表单（旧）
  addCfg: { open: false, name: "" }, // ➕添加配置向导：只填名字，其余自动
  sendForm: { project: "", session_key: "", message: "" },
  busy: false,
  loading: false,
  error: null,
  msg: null,             // 操作结果提示
};
const listeners = new Set<() => void>();
function notify() { for (const l of listeners) l(); }
function setState(patch: Record<string, unknown>) { Object.assign(state, patch); notify(); }

// lucide 图标 path（与系统内建线条图标同风格）
const Ic = ({ size, paths }: { size: number; paths: string[] }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);
const ICON: Record<string, string[]> = {
  home: ["m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z", "M9 22V12h6v10"],
  package: ["m7.5 4.27 9 5.15", "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z", "M3.3 7 12 12l8.7-5", "M12 22V12"],
  fileEdit: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M10.4 12.6a2 2 0 0 1 3 3L8 21l-4 1 1-4Z"],
  folder: ["M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"],
  plug: ["M12 22v-5", "M9 8V2", "M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"],
  msg: ["M7.9 20A9 9 0 1 0 4 16.1L2 22Z"],
  scroll: ["M19 17H5a2 2 0 0 0-2 2", "M19 17V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v12", "M8 7h8", "M8 11h6"],
  list: ["M8 6H21", "M8 12H21", "M8 18H21", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  monitor: ["M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M8 21h8", "M12 17v4"],
  play: ["m6 3 14 9-14 9V3z"],
  save: ["M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M17 21v-7H7v7", "M7 3v4h10"],
  refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
  upRight: ["M7 7h10v10", "M7 17 17 7"],
  circle: ["M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z"],
  file: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4"],
  settings: ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  wrench: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
  x: ["M18 6 6 18", "m6 6 12 12"],
};

const C = {
  panelBg: "var(--bg, #ffffff)",
  border: "1px solid var(--border, rgba(127,127,127,0.18))",
  muted: "var(--text-muted, #6b7280)",
  text: "var(--text, #111827)",
  accent: "var(--accent, #6366f1)",
  bgHover: "var(--bg-hover, rgba(127,127,127,0.08))",
};
const btnStyle = {
  padding: "5px 12px", background: C.bgHover, border: C.border, borderRadius: 8,
  color: C.text, cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
};
function chip(bg: string, fg: string) {
  return { fontSize: 10, padding: "2px 8px", borderRadius: 10, background: bg, color: fg, whiteSpace: "nowrap", flexShrink: 0 };
}
const cardStyle = {
  background: "var(--bg-elevated, #ffffff)", border: C.border, borderRadius: 12,
  padding: "12px 14px", boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
};
const inp = { padding: "7px 10px", border: "1px solid var(--border, rgba(127,127,127,0.2))", borderRadius: 8, fontSize: 13, background: "var(--bg-elevated, #fff)", color: "var(--text, #111)", outline: "none", flex: 1, minWidth: 120 };
const sectionTitle = { fontSize: 13, fontWeight: 700, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 };

// ---------- 数据 ----------
async function refreshStatus() {
  setState({ loading: true, error: null });
  try {
    const r = await fetch(API("/api/extensions/aiti-channels/status"), { cache: "no-store" });
    const d = await r.json();
    setState({ status: d, loading: false });
    void refreshLog();
  } catch (e: any) { setState({ loading: false, error: "状态拉取失败：" + e.message }); }
}
async function refreshLog() {
  try {
    const r = await fetch(API("/api/extensions/aiti-channels/log?n=120"), { cache: "no-store" });
    const d = await r.json();
    setState({ log: d.lines || [] });
  } catch { /* ignore */ }
}
async function refreshSessions() {
  try {
    const r = await fetch(API("/api/extensions/aiti-channels/sessions"), { cache: "no-store" });
    const d = await r.json();
    if (d.ok) {
      const raw = d.data;
      setState({ sessions: Array.isArray(raw) ? raw : (raw && raw.sessions) || [] });
    }
  } catch { /* ignore */ }
}
async function refreshMsgLog() {
  try {
    const r = await fetch(API("/api/extensions/aiti-channels/msg-log?n=100"), { cache: "no-store" });
    const d = await r.json();
    setState({ msgLog: (d && d.logs) || [] });
  } catch { /* ignore */ }
}
async function refreshInstall() {
  setState({ loading: true });
  try {
    const r = await fetch(API("/api/extensions/aiti-channels/install-status"), { cache: "no-store" });
    const d = await r.json();
    setState({ install: d, loading: false });
  } catch (e: any) { setState({ loading: false, error: "安装状态拉取失败：" + e.message }); }
}
async function refreshInstances() {
  try {
    const r = await fetch(API("/api/extensions/aiti-channels/instances"), { cache: "no-store" });
    const d = await r.json();
    if (d.ok) setState({ instances: d.instances || [] });
  } catch { /* ignore */ }
}
/** 按当前实例拉状态（status?instance=<id>） */
async function refreshStatusInst() {
  setState({ loading: true, error: null });
  try {
    const r = await fetch(API(`/api/extensions/aiti-channels/status?instance=${state.curInstance}`), { cache: "no-store" });
    const d = await r.json();
    setState({ status: d, loading: false });
    void refreshLog();
  } catch (e: any) { setState({ loading: false, error: "状态拉取失败：" + e.message }); }
}
async function refreshConfig() {
  setState({ loading: true });
  try {
    const r = await fetch(API("/api/extensions/aiti-channels/config"), { cache: "no-store" });
    const d = await r.json();
    setState({ configCfg: d.cfg || null, configRaw: d.raw || "", loading: false });
  } catch (e: any) { setState({ loading: false, error: "配置拉取失败：" + e.message }); }
}
async function op(action: string, label: string) {
  setState({ busy: true, error: null, msg: null });
  try {
    const r = await fetch(API(`/api/extensions/aiti-channels/${action}`), { method: "POST" });
    const d = await r.json();
    setState({ busy: false, error: d.error ? `${label}失败：${d.error}` : null, msg: d.note || (d.ok ? `${label}完成` : null) });
    await refreshStatus(); await refreshSessions();
  } catch (e: any) { setState({ busy: false, error: `${label}失败：` + e.message }); }
}
/** 触发 cc-connect reload（热应用）或 restart（自动重启） */
async function ccAction(action: string, label: string) {
  setState({ busy: true, error: null, msg: null });
  try {
    const r = await fetch(API(`/api/extensions/aiti-channels/${action}`), { method: "POST" });
    const d = await r.json();
    if (d.ok && d.data) {
      const msg = d.data.projects_updated
        ? `已热应用配置 → 项目：${d.data.projects_updated.join("、")}`
        : (d.data.message || "reload 已触发");
      setState({ busy: false, msg });
    } else {
      setState({ busy: false, error: d.error || (label + "失败") });
    }
    await refreshStatus();
  } catch (e: any) { setState({ busy: false, error: label + "失败：" + e.message }); }
}

// ---------- Tab 定义 ----------
const TABS: [string, string, string][] = [
  ["overview", "home", "总览"],
  ["install", "package", "安装"],
  ["config", "fileEdit", "配置"],
  ["projects", "folder", "项目"],
  ["channels", "plug", "渠道"],
  ["sessions", "msg", "会话"],
  ["msglog", "scroll", "消息"],
  ["log", "list", "日志"],
  ["original", "monitor", "原版"],
];

// ---------- Tab 内容 ----------
function renderTab() {
  switch (state.tab) {
    case "overview": return <TabOverview />;
    case "install": return <TabInstall />;
    case "config": return <TabConfig />;
    case "projects": return <TabProjects />;
    case "channels": return <TabChannels />;
    case "sessions": return <TabSessions />;
    case "msglog": return <TabMsgLog />;
    case "log": return <TabLog />;
    case "original": return <TabOriginal />;
    default: return null;
  }
}

// ---------- 🏠 总览 ----------
function TabOverview() {
  const s = state.status || {};
  const running = !!s.running;
  const projects = (s.cfg && s.cfg.projects) || [];
  const platforms: Record<string, number> = {};
  projects.forEach((p: any) => (p.platforms || []).forEach((pl: any) => { platforms[pl.type] = (platforms[pl.type] || 0) + 1; }));
  const inst = state.install || {};
  const statusColor = running ? (s.sockAlive ? "#22c55e" : "#eab308") : "#ef4444";
  const stat = (label: string, value: any, color?: string) => (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 4, minWidth: 120 }}>
      <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 700, color: color || C.text }}>{value == null ? "-" : String(value)}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 状态横幅 */}
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
        <span style={{ fontSize: 15, fontWeight: 700 }}>{running ? "cc-connect 运行中" : "cc-connect 未运行"}</span>
        <span style={{ fontSize: 12, color: C.muted }}>{`${s.version || "?"} · pid ${s.pid || "-"}`}</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {!running
            ? <button style={{ ...btnStyle, background: "#22c55e", color: "#fff", border: "none" }} disabled={state.busy} onClick={() => op("start", "启动")}><Ic size={13} paths={ICON.play} />启动</button>
            : <button style={{ ...btnStyle, background: "#ef4444", color: "#fff", border: "none" }} disabled={state.busy} onClick={() => op("stop", "停止")}>⏹ 停止</button>}
          {running && <button style={btnStyle} disabled={state.busy} onClick={() => op("restart", "重启")}>🔄 重启</button>}
          <button style={btnStyle} disabled={state.busy} title="热应用 config.toml" onClick={() => ccAction("reload-cc", "reload")}><Ic size={13} paths={ICON.save} />reload</button>
          {running && <button style={btnStyle} disabled={state.busy} title="自动重启（保留 pid）" onClick={() => ccAction("restart-cc", "重启")}><Ic size={13} paths={ICON.refresh} />自重启</button>}
        </span>
      </div>
      {/* 状态指标 */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {stat("项目", projects.length)}
        {stat("渠道", Object.keys(platforms).length)}
        {stat("会话", state.sessions.length)}
        {stat("消息记录", state.msgLog.length)}
        {stat("端口", running ? (s.port9820 ? "9820" : "-") : "-")}
      </div>
      {/* 安装状态摘要 */}
      {inst && (
        <div style={{ ...cardStyle, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 700 }}><Ic size={12} paths={ICON.package} /> 版本</span>
          <span style={chip(inst.current ? "rgba(99,102,241,0.12)" : "rgba(239,68,68,0.12)", inst.current ? C.accent : "#ef4444")}>{`当前 ${inst.current || "未安装"}`}</span>
          {inst.latest && <span style={chip("rgba(14,165,233,0.12)", "#0ea5e9")}>{`最新 ${inst.latest}`}</span>}
          {inst.needUpdate && <span style={{ fontSize: 11, color: "#ea580c" }}><Ic size={12} paths={ICON.upRight} /> 有新版本</span>}
          <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => setState({ tab: "install" })}>去安装</button>
        </div>
      )}
      {/* 快捷入口 */}
      <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={sectionTitle}>快捷操作</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {[["sessions", "msg", "发消息"], ["msglog", "scroll", "消息日志"], ["config", "fileEdit", "编辑配置"], ["original", "monitor", "打开管理台"]].map(([k, icon, l]) =>
            <button key={k} style={{ ...btnStyle, flex: 1, minWidth: 100 }} onClick={() => setState({ tab: k })}>{l}</button>)}
        </div>
      </div>
      {/* 配置摘要 */}
      {s.cfg && (
        <div style={{ ...cardStyle, fontSize: 12, lineHeight: 1.8, display: "flex", flexDirection: "column", gap: 2 }}>
          <div style={sectionTitle}>配置摘要</div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}><Ic size={11} paths={ICON.file} />{" " + (s.cfg.path || "")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}><Ic size={11} paths={ICON.settings} />{" [management] " + (s.cfg.management && s.cfg.management.enabled ? "开" : "关") + " :" + (s.cfg.management && s.cfg.management.port) + " · [bridge] " + (s.cfg.bridge && s.cfg.bridge.enabled ? "开" : "关") + " :" + (s.cfg.bridge && s.cfg.bridge.port)}</div>
          <div><Ic size={12} paths={ICON.folder} />{" 项目：" + projects.map((p: any) => p.name).join("、") || "无"}</div>
        </div>
      )}
    </div>
  );
}

// ---------- 📦 安装 ----------
function TabInstall() {
  const inst = state.install || {};
  // 版本号自动带：预填 latest（不需要用户输入）
  const target = state.installTag || (inst.latest ? inst.latest : "");
  const latest = !!inst.latest;
  const isLatest = !!(inst.current && inst.latest && inst.current === inst.latest);
  const doInstall = async (e?: any) => {
    e && e.preventDefault();
    setState({ busy: true, error: null, msg: null });
    try {
      const r = await fetch(API("/api/extensions/aiti-channels/install"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tag: target || undefined, systemBin: true }) });
      const d = await r.json();
      setState({ busy: false, error: d.error ? "安装失败：" + d.error : null, msg: d.ok ? `✅ 已安装 ${d.version}（${d.triple}）到托管目录，sudo 可用时已同步系统 bin` : null });
      await refreshInstall(); await refreshStatus();
    } catch (e2: any) { setState({ busy: false, error: "安装失败：" + e2.message }); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
      <div style={{ ...sectionTitle, display: "flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICON.package} />cc-connect 安装 / 更新（justget 多源竞速 + gitee 镜像）</div>
      <button style={btnStyle} disabled={state.loading} onClick={() => refreshInstall()}><Ic size={13} paths={ICON.refresh} />检测版本</button>
      {/* 版本状态 */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={{ ...cardStyle, flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: C.muted }}>当前安装</span>
          <span style={{ fontSize: 18, fontWeight: 700 }}>{inst.current || "未安装"}</span>
          <span style={{ fontSize: 10, color: C.muted, wordBreak: "break-all" }}>{inst.currentBin || ""}</span>
        </div>
        <div style={{ ...cardStyle, flex: 1, minWidth: 160, display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 11, color: C.muted }}>最新发布</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: isLatest ? "#16a34a" : (inst.needUpdate ? "#ea580c" : C.text) }}>{inst.latest || "未知"}</span>
          <span style={{ fontSize: 10, color: C.muted }}>{`源：${inst.latestSource || "-"}${isLatest ? " · 已是最新" : (inst.needUpdate ? " · 可更新" : "")}`}</span>
        </div>
      </div>
      {/* 下载源信息 */}
      <div style={{ ...cardStyle, fontSize: 12, lineHeight: 1.8, display: "flex", flexDirection: "column", gap: 2 }}>
        <div style={sectionTitle}>下载方式</div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}><Ic size={11} paths={ICON.wrench} />{" 下载器：justget（多源竞速分块下载） — " + (inst.justgetCli || "-")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}><Ic size={10} paths={ICON.circle} /> 主源 GitHub：https://github.com/chenhg5/cc-connect/releases</div>
        <div>🟠 镜像 Gitee：https://gitee.com/cg33/cc-connect/releases/download/（国内快，谁快用谁）</div>
        <div style={{ color: C.muted }}><Ic size={12} paths={ICON.package} />{" 安装位置：" + (inst.managedBin || "-") + "（免 sudo；sudo 可用时同步 /usr/local/bin/cc-connect）"}</div>
      </div>
      {/* 安装表单 */}
      <form onSubmit={doInstall} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700 }}>{isLatest ? "已是最新版本" : "执行安装 / 更新"}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ ...inp, flex: 1, display: "flex", alignItems: "center", background: "rgba(0,0,0,0.04)", color: C.muted }}>
            <span style={{ fontSize: 12 }}>{"版本：" + (target || "自动获取最新")}</span>
          </div>
          {isLatest
            ? <button type="button" style={{ ...btnStyle, background: "rgba(34,197,94,0.12)", color: "#16a34a", border: "1px solid rgba(34,197,94,0.3)" }} disabled>✓ 已是最新</button>
            : <button type="submit" style={{ ...btnStyle, background: C.accent, color: "#fff", border: "none" }} disabled={state.busy || !latest}>{state.busy ? "下载中…" : "⬇ 安装 / 更新"}</button>}
        </div>
        <div style={{ fontSize: 10, color: C.muted }}>版本自动取最新发布版（无需手动输入）；下载较大（约 50MB 二进制），耗时取决于网络；进度看服务端日志。</div>
      </form>
      {/* 提示 */}
      {inst.error && <div style={{ fontSize: 11, color: "#ea580c" }}>{"版本检测告警：" + inst.error}</div>}
      <div style={{ ...cardStyle, fontSize: 11, color: C.muted, lineHeight: 1.7 }}>
        说明：安装后当前运行进程不受影响；下次重启（♻自重启/restart-cc）会用新版本。官方 release 不含本地源码定制（如小屏适配），升级前请注意。
      </div>
    </div>
  );
}

// ---------- 📝 配置 ----------
function TabConfig() {
  // ---- 表单辅助 ----
  const f = state.configForm;
  const up = (patch: any) => setState({ configForm: { ...state.configForm, ...patch } });
  const upProj = (i: number, patch: any) => { const ps = state.configForm.projects.slice(); ps[i] = { ...ps[i], ...patch }; up({ projects: ps }); };
  const upPlat = (pi: number, pli: number, patch: any) => { const ps = state.configForm.projects.slice(); const pls = ps[pi].platforms.slice(); pls[pli] = { ...pls[pli], ...patch }; ps[pi] = { ...ps[pi], platforms: pls }; up({ projects: ps }); };
  const delProj = (i: number) => { const ps = state.configForm.projects.slice(); ps.splice(i, 1); up({ projects: ps.length ? ps : [{ name: "", agent: "piweb", work_dir: "", platforms: [{ type: "dingtalk", client_id: "", client_secret: "", agent_id: "" }] }] }); };
  const delPlat = (pi: number, pli: number) => { const ps = state.configForm.projects.slice(); const pls = ps[pi].platforms.slice(); pls.splice(pli, 1); ps[pi] = { ...ps[pi], platforms: pls.length ? pls : [{ type: "dingtalk", client_id: "", client_secret: "", agent_id: "" }] }; up({ projects: ps }); };
  const addProj = () => up({ projects: [...state.configForm.projects, { name: "", agent: "piweb", work_dir: "", platforms: [{ type: "dingtalk", client_id: "", client_secret: "", agent_id: "" }] }] });
  const addPlat = (pi: number) => { const ps = state.configForm.projects.slice(); ps[pi] = { ...ps[pi], platforms: [...ps[pi].platforms, { type: "dingtalk", fields: {} }] }; up({ projects: ps }); };
  const upField = (pi: number, pli: number, key: string, v: string) => {
    const ps = state.configForm.projects.slice();
    const pls = ps[pi].platforms.slice();
    pls[pli] = { ...pls[pli], fields: { ...(pls[pli].fields || {}), [key]: v } };
    ps[pi] = { ...ps[pi], platforms: pls };
    up({ projects: ps });
  };
  /** 生成前必填校验：按 schema 检查每个平台的 required 字段 */
  const validatePlatforms = (): string | null => {
    for (const pj of state.configForm.projects) {
      for (const pl of pj.platforms || []) {
        const sch = platformSchema(pl.type);
        if (!sch) continue;
        for (const f of sch.fields) {
          if (f.required && !(pl.fields || {})[f.key]) return `项目「${pj.name || "未命名"}」的 ${sch.label} 缺必填项：${f.label}`;
        }
      }
      if (pj.agent === "piweb" && !pj.work_dir) return `项目「${pj.name || "未命名"}」是 piweb（pi-web 会话），需要填 work_dir`;
    }
    return null;
  };

  const genAndSave = async () => {
    setState({ busy: true, error: null, msg: null });
    try {
      const r = await fetch(API(`/api/extensions/aiti-channels/config-gen?instance=${state.curInstance}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.configForm) });
      const d = await r.json();
      setState({ busy: false, error: d.error ? "配置生成失败：" + d.error : null, msg: d.note || (d.ok ? "配置已生成" : null) });
    } catch (e: any) { setState({ busy: false, error: "配置生成失败：" + e.message }); }
  };
  const startInst = async () => {
    setState({ busy: true, error: null, msg: null });
    try {
      const r = await fetch(API(`/api/extensions/aiti-channels/start?instance=${state.curInstance}`), { method: "POST" });
      const d = await r.json();
      setState({ busy: false, error: d.error ? "启动失败：" + d.error : null, msg: d.note || (d.ok ? "已启动" : null) });
      await refreshStatusInst();
    } catch (e: any) { setState({ busy: false, error: "启动失败：" + e.message }); }
  };
  const createInst = async () => {
    const ni = state.newInst;
    if (!ni.id || !ni.dataDir) { setState({ error: "需要实例 id + dataDir（cc-connect 数据目录）" }); return; }
    setState({ busy: true, error: null, msg: null });
    try {
      const r = await fetch(API("/api/extensions/aiti-channels/instance"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "create", id: ni.id, name: ni.name || ni.id, dataDir: ni.dataDir }) });
      const d = await r.json();
      setState({ busy: false, error: d.error ? "创建失败：" + d.error : null, msg: d.ok ? "✅ 实例已创建，填写下方表单生成配置" : null, curInstance: d.ok ? ni.id : state.curInstance, newInst: { id: "", name: "", dataDir: "" } });
      await refreshInstances(); await refreshStatusInst();
    } catch (e: any) { setState({ busy: false, error: "创建失败：" + e.message }); }
  };

  // ➕ 添加配置向导：只填名字 → 后端自动分配 id/dataDir/端口/token → 建实例 + 预填表单（piweb 项目 + IM 壳）
  const addCfgOpen = (v: boolean) => setState({ addCfg: { open: v, name: "" } });
  const addCfgRun = async () => {
    const name = String(state.addCfg.name || "").trim();
    if (!name) { setState({ error: "先填配置名（如 my-im）" }); return; }
    setState({ busy: true, error: null, msg: null });
    try {
      // ① 自动分配 id/dataDir/端口/token
      const s = await (await fetch(API("/api/extensions/aiti-channels/suggest-config"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json();
      if (!s.ok) { setState({ busy: false, error: "分配失败：" + (s.error || "?") }); return; }
      // ② 建实例
      const c = await (await fetch(API("/api/extensions/aiti-channels/instance"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "create", id: s.id, name: s.name, dataDir: s.dataDir }) })).json();
      if (!c.ok) { setState({ busy: false, error: "创建失败：" + (c.error || "?") }); return; }
      // ③ 预填表单（piweb 项目 + 钉钉 IM 壳）+ 切实例
      setState({
        busy: false,
        addCfg: { open: false, name: "" },
        curInstance: s.id,
        configForm: {
          management: { port: s.managementPort, token: s.token },
          bridge: { port: s.bridgePort },
          projects: [{ name: "", agent: "piweb", work_dir: "", platforms: [{ type: "dingtalk", client_id: "", client_secret: "", agent_id: "" }] }],
        },
        msg: `✅ 配置「${s.name}」已建（端口 ${s.managementPort}/${s.bridgePort} 自动分配）。填 workspace 路径 + IM 凭证，然后点 🚀 生成并启动`,
      });
      await refreshInstances(); await refreshStatusInst();
    } catch (e: any) { setState({ busy: false, error: "添加配置失败：" + e.message }); }
  };
  // 🚀 生成并启动：校验 → config-gen 成功后自动 start
  const genStart = async () => {
    const err = validatePlatforms();
    if (err) { setState({ error: err }); return; }
    await genAndSave();
    if (!state.error) await startInst();
  };
  const genAndSave2 = genAndSave; // 别名：仅生成也走校验

  // ---- 扫码授权向导（feishu；device flow 标准轮询——OAuth Device Authorization Grant 协议要求，
  //      completed/denied/expired 即停，非实时刷新）----
  const wizRef = useRef<any>(null);
  const stopWiz = () => { if (wizRef.current) { clearInterval(wizRef.current); wizRef.current = null; } setState({ setupWiz: null }); };
  useEffect(() => () => { if (wizRef.current) clearInterval(wizRef.current); }, []);
  const startWiz = async (pi: number, pli: number) => {
    const sch = platformSchema(state.configForm.projects[pi].platforms[pli].type);
    if (!sch?.wizard) return;
    setState({ busy: true, setupWiz: { platform: sch.wizard, status: "begin", err: null } });
    try {
      const r = await fetch(API(`/api/extensions/aiti-channels/setup/${sch.wizard}/begin`), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const d = await r.json();
      const dd = d.data?.data || d.data || {}; // 代理包一层 + cc-connect mgmtJSON 再包一层
      if (!d.ok || !dd.qr_url) { setState({ busy: false, setupWiz: { platform: sch.wizard, status: "error", err: d.error || dd.error || "begin 失败（实例未运行？）" } }); return; }
      const interval = Math.max((Number(dd.interval) || 5) * 1000, 3000);
      setState({ busy: false, setupWiz: { platform: sch.wizard, status: "pending", qrUrl: dd.qr_url, deviceCode: dd.device_code, err: null } });
      const tick = async () => {
        try {
          const pr = await fetch(API(`/api/extensions/aiti-channels/setup/${sch.wizard}/poll`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: wizDevice.current }) });
          const pd = await pr.json();
          const s = pd.data?.data || pd.data || {};
          if (s.status === "completed" && s.app_id) {
            stopWiz();
            upField(pi, pli, "app_id", String(s.app_id));
            upField(pi, pli, "app_secret", String(s.app_secret || ""));
            setState({ setupWiz: { platform: sch.wizard, status: "done", err: null } });
            return;
          }
          if (s.status === "denied" || s.status === "expired" || s.status === "error") {
            stopWiz();
            setState({ setupWiz: { platform: sch.wizard, status: "error", err: s.status + (s.error ? ": " + s.error : "") } });
          }
        } catch { /* 网络抖动继续下一轮 */ }
      };
      wizDevice.current = d.data.device_code;
      wizRef.current = setInterval(tick, interval);
    } catch (e: any) { setState({ busy: false, setupWiz: { platform: sch.wizard, status: "error", err: e.message } }); }
  };
  const wizDevice = useRef<any>(null);

  const cur = (state.instances || []).find((i: any) => i.id === state.curInstance);
  const instStatus = state.status || {};
  const running = !!instStatus.running;
  const field = (label: string, value: any, onChange: (v: string) => void, ph?: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 120 }}>
      <span style={{ fontSize: 10, color: C.muted }}>{label}</span>
      <input value={value} placeholder={ph || ""} onChange={(e) => onChange(e.target.value)} style={inp} />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 实例选择 + 新建 */}
      <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}>🧩 实例</span>
          <select value={state.curInstance} onChange={(e) => { setState({ curInstance: e.target.value }); void refreshStatusInst(); }} style={{ ...inp, flex: 1, maxWidth: 220, cursor: "pointer" }}>
            {(state.instances || []).map((i: any) => <option key={i.id} value={i.id}>{`${i.id}${i.name && i.name !== i.id ? " · " + i.name : ""}`}</option>)}
          </select>
          <span style={{ fontSize: 11, color: C.muted }}>{running ? `● 运行中 ${instStatus.version || ""}` : "○ 未运行"}</span>
          <button style={{ ...btnStyle, background: "#22c55e", color: "#fff", border: "none" }} disabled={state.busy} onClick={startInst}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={13} paths={running ? ICON.refresh : ICON.play} />{running ? "重启" : "启动"}</span>
          </button>
          <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => refreshInstances()}><Ic size={13} paths={ICON.refresh} />刷新</button>
        </div>
        {cur && (
          <div style={{ fontSize: 11, color: C.muted, fontFamily: "monospace", wordBreak: "break-all" }}>
            {`config: ${cur.config} · dataDir: ${cur.dataDir}${instStatus.sock ? " · sock: " + instStatus.sock : ""}`}
          </div>
        )}
        {/* ➕ 添加配置向导：只填名字，其余自动 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: C.border, paddingTop: 8 }}>
          {!state.addCfg.open ? (
            <button style={{ ...btnStyle, alignSelf: "flex-start", background: "rgba(99,102,241,0.1)", color: C.accent, border: "1px solid rgba(99,102,241,0.3)" }} onClick={() => addCfgOpen(true)}>
              ➕ 添加配置（多 workspace × 多 IM，一键建）
            </button>
          ) : (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <input autoFocus placeholder="配置名（如 my-im、atest）" value={state.addCfg.name} onChange={(e) => setState({ addCfg: { ...state.addCfg, name: e.target.value } })} onKeyDown={(e: any) => e.key === "Enter" && addCfgRun()} style={{ ...inp, flex: 1, minWidth: 160 }} />
              <button style={{ ...btnStyle, background: C.accent, color: "#fff", border: "none" }} disabled={state.busy} onClick={addCfgRun}>自动创建（id/dataDir/端口全自动）</button>
              <button style={btnStyle} onClick={() => addCfgOpen(false)}>取消</button>
              <span style={{ fontSize: 10, color: C.muted, flexBasis: "100%" }}>创建后默认带一个 piweb（pi-web 会话）项目 + 钉钉 IM 壳，填路径和凭证即可用</span>
            </div>
          )}
        </div>
      </div>
      {/* 全局配置 */}
      <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>⚙️ 全局（management / bridge / log）</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {field("management 端口", String(f.management.port || ""), (v) => up({ management: { ...f.management, port: v } }), "如 9820")}
          {field("management token（Web UI 登录）", f.management.token || "", (v) => up({ management: { ...f.management, token: v } }), "自动生成/留空")}
          {field("bridge 端口", String(f.bridge.port || ""), (v) => up({ bridge: { ...f.bridge, port: v } }), "如 9810")}
        </div>
      </div>
      {/* 项目列表 */}
      <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700 }}><Ic size={12} paths={ICON.folder} />{" 项目（" + state.configForm.projects.length + "）"}</span>
          <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={addProj}>➕ 添加项目</button>
        </div>
        {state.configForm.projects.map((pj: any, pi: number) => (
          <div key={pi} style={{ display: "flex", flexDirection: "column", gap: 6, border: C.border, borderRadius: 10, padding: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.accent }}>{`项目 ${pi + 1}`}</span>
              <button style={{ ...btnStyle, marginLeft: "auto", color: "#ef4444", border: "1px solid rgba(239,68,68,0.3)" }} onClick={() => delProj(pi)}>🗑 删除</button>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {field("项目名", pj.name, (v) => upProj(pi, { name: v }), "如 atest")}
              <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 100 }}>
                <span style={{ fontSize: 10, color: C.muted }}>agent 类型</span>
                <select value={pj.agent || "claudecode"} onChange={(e) => upProj(pi, { agent: e.target.value })} style={{ ...inp, cursor: "pointer" }}>
                  {["piweb", "claudecode", "codex", "cursor", "gemini", "qoder", "opencode"].map((a) => <option key={a} value={a}>{a === "piweb" ? "piweb（pi-web 会话）" : a}</option>)}
                </select>
              </div>
              {field("工作目录 work_dir", pj.work_dir, (v) => upProj(pi, { work_dir: v }), "如 /home/.../atest")}
            </div>
            {pj.agent === "piweb" && pj.work_dir && (
              <div style={{ fontSize: 10, color: C.muted, lineHeight: 1.6 }}>
                💡 piweb：IM 消息会进 <b>{pj.work_dir}</b> 下的 pi-web 会话（带完整工具能力），会话可在 All Sessions 里打开查看/继续互动；图片附件落在该目录 .cc-connect/attachments/。
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8, cursor: "pointer", color: C.text }}>
                  <input type="checkbox" checked={!!pj.piwebNative} onChange={(e) => upProj(pi, { piwebNative: e.target.checked })} />
                  原生直连（type=piweb，无连接器进程；需新版 cc-connect）
                </label>
              </div>
            )}
            {/* 平台（schema 驱动：每类型字段不同，来源 cc-connect 源码实证） */}
            {(pj.platforms || []).map((pl: any, pli: number) => {
              const sch = platformSchema(pl.type);
              const wiz: any = state.setupWiz;
              const wizHere = wiz && sch?.wizard && wiz.platform === sch.wizard;
              return (
              <div key={pli} style={{ display: "flex", flexDirection: "column", gap: 4, border: "1px dashed var(--border, rgba(127,127,127,0.25))", borderRadius: 8, padding: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#0ea5e9" }}><Ic size={11} paths={ICON.plug} />{" 平台 " + (pli + 1)}{sch ? " · " + sch.label : ""}</span>
                  <button style={{ ...btnStyle, marginLeft: "auto", color: "#ef4444", padding: "3px 8px" }} onClick={() => delPlat(pi, pli)} aria-label="删除"><Ic size={11} paths={ICON.x} /></button>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 100 }}>
                    <span style={{ fontSize: 10, color: C.muted }}>平台类型</span>
                    <select value={pl.type} onChange={(e) => upPlat(pi, pli, { type: e.target.value, fields: {} })} style={{ ...inp, cursor: "pointer" }}>
                      {PLATFORM_SCHEMAS.map((s: any) => <option key={s.type} value={s.type}>{s.label}</option>)}
                    </select>
                  </div>
                  {sch ? sch.fields.map((f: any) => (
                    <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 120 }}>
                      <span style={{ fontSize: 10, color: C.muted }}>{f.label}{f.required ? " *" : ""}</span>
                      <input type={f.secret ? "password" : "text"} value={(pl.fields || {})[f.key] || ""} placeholder={f.ph || ""} onChange={(e) => upField(pi, pli, f.key, e.target.value)} style={inp} />
                    </div>
                  )) : (
                    <div style={{ fontSize: 10, color: "#ea580c", alignSelf: "center" }}>该类型未收录参数表——生成后到 config.toml 手填 options</div>
                  )}
                </div>
                {/* 申请指引：怎么注册、去哪拿 token */}
                {sch?.guide && (
                  <details style={{ fontSize: 11, color: C.muted }}>
                    <summary style={{ cursor: "pointer", color: "#0ea5e9", userSelect: "none" }}>❓ 怎么注册 / 获取凭证？（{sch.label}）</summary>
                    <ol style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.8, display: "flex", flexDirection: "column", gap: 2 }}>
                      {sch.guide.steps.map((s: string, si: number) => <li key={si}>{s}</li>)}
                    </ol>
                    {sch.guide.link && <div style={{ marginTop: 4 }}>官网入口：<a href={sch.guide.link.url} target="_blank" rel="noreferrer" style={{ color: "#0ea5e9" }}>{sch.guide.link.label}</a></div>}
                    {sch.guide.note && <div style={{ marginTop: 2, color: "#f59e0b" }}>💡 {sch.guide.note}</div>}
                  </details>
                )}
                {/* 扫码授权（feishu；需实例已启动，management 可达） */}
                {sch?.wizard === "feishu" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {!wizHere || wizHere.status === "done" || wizHere.status === "error" || wizHere.status === "begin" ? (
                      <button style={{ ...btnStyle, alignSelf: "flex-start", color: "#0ea5e9", border: "1px solid rgba(14,165,233,0.3)" }} disabled={state.busy} onClick={() => startWiz(pi, pli)}>📱 扫码授权（自动获取 AppID/Secret）</button>
                    ) : wizHere.status === "pending" ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11 }}>
                        <a href={wizHere.qrUrl} target="_blank" rel="noreferrer" style={{ color: "#0ea5e9" }}>打开授权页并扫码确认</a>
                        <span style={{ color: C.muted }}>等待授权中…完成后凭证自动填入</span>
                        <button style={{ ...btnStyle, padding: "2px 8px" }} onClick={stopWiz}>取消</button>
                      </div>
                    ) : null}
                    {wizHere?.status === "done" && <div style={{ fontSize: 10, color: "#16a34a" }}>✅ 授权成功，凭证已自动填入上方字段</div>}
                    {wizHere?.status === "error" && <div style={{ fontSize: 10, color: "#ea580c" }}>{"授权失败：" + wizHere.err + "（可手填凭证）"}</div>}
                  </div>
                )}
              </div>
              );
            })}
            <button style={{ ...btnStyle, color: "#0ea5e9", border: "1px solid rgba(14,165,233,0.3)" }} onClick={() => addPlat(pi)}>➕ 添加平台</button>
          </div>
        ))}
      </div>
      {/* 操作 */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button style={{ ...btnStyle, background: "#22c55e", color: "#fff", border: "none" }} disabled={state.busy} onClick={genStart}><Ic size={13} paths={ICON.play} />🚀 生成并启动（配置写入 + 拉起实例）</button>
        <button style={btnStyle} disabled={state.busy} onClick={genAndSave}><Ic size={13} paths={ICON.save} />仅生成配置</button>
        <button style={btnStyle} onClick={() => setState({ tab: "log" })}><Ic size={13} paths={ICON.list} />查看日志</button>
      </div>
      <div style={{ ...cardStyle, fontSize: 11, color: C.muted, lineHeight: 1.7 }}>
        表单化配置：填好项目/平台/凭据 → 生成 config.toml（自动备份）→ 启动实例。每个实例独立 config/dataDir/socket/端口，互不影响。钉钉接入需在钉钉开放平台建应用（Stream 模式，AppKey/AppSecret/AgentId）。
      </div>
    </div>
  );
}

// ---------- 🗂 项目 ----------
function TabProjects() {
  const projects = (state.status && state.status.cfg && state.status.cfg.projects) || [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={sectionTitle}><Ic size={12} paths={ICON.folder} />{" 项目（" + projects.length + "）"}</div>
      {projects.length === 0 && <div style={{ ...cardStyle, color: C.muted, fontSize: 12 }}>无项目 — 到 📝配置 添加 [[projects]]</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {projects.map((p: any) => (
          <div key={p.name} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{p.name}</span>
              <span style={chip("rgba(99,102,241,0.12)", C.accent)}>{p.agentType || "agent"}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted }}>{`会话 ${p.sessions_count ?? "-"}`}</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {(p.platforms || []).map((pl: any) => <span key={pl.type} style={chip("rgba(14,165,233,0.12)", "#0ea5e9")}>{pl.type}</span>)}
              {(p.platforms || []).length === 0 && <span style={{ fontSize: 11, color: C.muted }}>(无平台)</span>}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: C.muted, fontFamily: "monospace", wordBreak: "break-all" }}>
              <div>{`work_dir: ${(p.agentOptions && p.agentOptions.work_dir) || "-"}`}</div>
              <div>{`bot_name: ${(p.platforms && p.platforms[0] && p.platforms[0].bot_name) || "-"}`}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 🔌 渠道 ----------
function TabChannels() {
  const projects = (state.status && state.status.cfg && state.status.cfg.projects) || [];
  const agg: Record<string, any> = {};
  projects.forEach((p: any) => (p.platforms || []).forEach((pl: any) => {
    const k = pl.type;
    agg[k] = agg[k] || { type: k, projects: [], count: 0 };
    agg[k].projects.push(p.name);
    agg[k].count += 1;
  }));
  const icon: Record<string, string> = { dingtalk: "🐜", feishu: "🪽", wechat: "💬", slack: "🪟", telegram: "✈️", discord: "🎮", lark: "🪽" };
  const list = Object.values(agg);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={sectionTitle}>{`🔌 渠道（${list.length}）`}</div>
      {list.length === 0 && <div style={{ ...cardStyle, color: C.muted, fontSize: 12 }}>未配置平台 — 到 📝配置 在 [[projects.platforms]] 添加</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {list.map((c: any) => (
          <div key={c.type} style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 18 }}>{icon[c.type] || "🔗"}</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{c.type}</span>
            <span style={chip("rgba(99,102,241,0.12)", C.accent)}>{`${c.count} 个接入`}</span>
            <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted }}>{c.projects.join("、")}</span>
          </div>
        ))}
      </div>
      <div style={{ ...cardStyle, fontSize: 11, color: C.muted, lineHeight: 1.7 }}>
        渠道接入（钉钉/飞书/微信…）在 cc-connect 配置 [projects] 的 platforms 里定义（app_id/secret/bot 等）。出站发消息走 socket API，接入细节见原版管理台 🖥️。
      </div>
    </div>
  );
}

// ---------- 💬 会话 + 发消息 ----------
function TabSessions() {
  const sessions = state.sessions;
  const f = state.sendForm;
  const send = async (e?: any) => {
    e && e.preventDefault();
    if (!f.project || !f.message) { setState({ error: "需要项目名 + 消息内容" }); return; }
    setState({ busy: true, error: null, msg: null });
    try {
      const r = await fetch(API("/api/extensions/aiti-channels/send"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
      const d = await r.json();
      setState({ busy: false, error: d.error ? "发送失败：" + d.error : null, msg: d.ok ? "✅ 消息已发送并记录日志" : null, sendForm: d.ok ? { project: "", session_key: "", message: "" } : f });
      await refreshMsgLog();
    } catch (e2: any) { setState({ busy: false, error: "发送失败：" + e2.message }); }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* 发消息表单 */}
      <form onSubmit={send} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>💬 发消息（socket API → IM）</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input placeholder="项目名（如 autoai）" value={f.project} onChange={(e) => setState({ sendForm: { ...f, project: e.target.value } })} style={{ ...inp, flex: 1 }} />
          <input placeholder="session_key（点下方会话填充）" value={f.session_key} onChange={(e) => setState({ sendForm: { ...f, session_key: e.target.value } })} style={{ ...inp, flex: 1.5 }} />
        </div>
        <textarea placeholder="消息内容…" rows={2} value={f.message} onChange={(e) => setState({ sendForm: { ...f, message: e.target.value } })} style={{ ...inp, resize: "vertical" }} />
        <button type="submit" style={{ ...btnStyle, background: C.accent, color: "#fff", border: "none" }} disabled={state.busy || !f.project || !f.message}>发送</button>
      </form>
      {/* 会话列表 */}
      <div style={sectionTitle}>{`活跃会话（${sessions.length}）`}</div>
      {sessions.length === 0 && <div style={{ ...cardStyle, textAlign: "center", color: C.muted, fontSize: 12 }}>无活跃会话（IM 里给机器人发消息激活）</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {sessions.map((s: any, i: number) => (
          <div key={s.session_key || i} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 4, cursor: "pointer" }}
            onClick={() => setState({ sendForm: { ...f, project: s.project || f.project, session_key: s.session_key || "" } })}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={chip("rgba(99,102,241,0.12)", C.accent)}>{s.project || "-"}</span>
              <span style={chip("rgba(14,165,233,0.12)", "#0ea5e9")}>{s.platform || "im"}</span>
              {s.active && <span style={chip("rgba(34,197,94,0.12)", "#16a34a")}>活跃</span>}
              {s.chat_name && <span style={{ fontSize: 11, color: C.muted, marginLeft: "auto" }}>{s.chat_name}</span>}
            </div>
            <div style={{ fontSize: 10, color: C.muted, fontFamily: "monospace", wordBreak: "break-all" }}>{s.session_key || s.id || ""}</div>
            {s.last_message && (
              <div style={{ fontSize: 11, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {`↪ ${typeof s.last_message === "string" ? s.last_message : (s.last_message && s.last_message.content) || ""}`}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 📜 消息日志 ----------
function TabMsgLog() {
  const logs = state.msgLog || [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={sectionTitle}>{`📜 消息日志（${logs.length}）`}</div>
        <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => refreshMsgLog()}>⟳ 刷新</button>
      </div>
      {logs.length === 0 && <div style={{ ...cardStyle, color: C.muted, fontSize: 12 }}>暂无消息记录 — 经本面板/aiti-im-send 发出的消息都会记录</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {logs.map((l: any, i: number) => (
          <div key={i} style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: C.muted, fontFamily: "monospace" }}>{(l.ts || "").replace("T", " ").slice(0, 19)}</span>
              <span style={chip("rgba(99,102,241,0.12)", C.accent)}>{l.project || "-"}</span>
              <span style={{ fontSize: 10, color: C.muted, fontFamily: "monospace", wordBreak: "break-all" }}>{(l.session_key || "").slice(0, 30)}</span>
              <span style={{ marginLeft: "auto", ...chip(l.result === "ok" ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)", l.result === "ok" ? "#16a34a" : "#ef4444") }}>{l.result || "-"}</span>
            </div>
            <div style={{ fontSize: 12, color: C.text }}>{l.message || "(空消息)"}</div>
            {l.file && <div style={{ fontSize: 10, color: "#0ea5e9", fontFamily: "monospace" }}>{`📎 ${l.file}`}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 📋 运行日志 ----------
function TabLog() {
  const lines = state.log || [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={sectionTitle}>📋 cc-connect 运行日志</div>
        <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => refreshLog()}>⟳ 刷新</button>
      </div>
      <pre style={{ margin: 0, maxHeight: "70vh", overflowY: "auto", background: "rgba(0,0,0,0.05)", borderRadius: 10, padding: 12, fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {lines.length ? lines.join("\n") : "(无日志)"}
      </pre>
    </div>
  );
}

// ---------- 🖥️ 原版视图 ----------
function TabOriginal() {
  const s = state.status || {};
  const url = s.iframeUrl;
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ ...cardStyle, marginBottom: 8, fontSize: 12, color: C.muted, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13 }}>🖥️ cc-connect 原生管理台（独立子域 iframe，共享登录态，含实时聊天）</span>
        {url && <a href={url} target="_blank" rel="noreferrer" style={{ ...btnStyle, textDecoration: "none", marginLeft: "auto" }}>↗ 新窗打开</a>}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {url
          ? <iframe src={url} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "1px solid var(--border, rgba(127,127,127,0.18))", borderRadius: 10 }} title="cc-connect 管理台" allow="clipboard-write" />
          : <div style={{ padding: 40, textAlign: "center", color: C.muted }}>管理台地址未就绪（需 cc-connect 启用 [management]）</div>}
      </div>
    </div>
  );
}

// ---------- 导航 ----------
function NavButtons({ vertical }: { vertical: boolean }) {
  return (state.nav === "left" ? TABS : TABS).map(([k, icon, label]) => {
    const active = state.tab === k;
    return (
      <button
        key={k} onClick={() => setState({ tab: k })}
        style={vertical
          ? { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 12px", border: "none", borderRadius: 8, cursor: "pointer", fontSize: 12, fontWeight: active ? 700 : 500, background: active ? C.bgHover : "transparent", color: active ? C.accent : C.muted, textAlign: "left", flexShrink: 0 }
          : { display: "flex", alignItems: "center", gap: 4, padding: "8px 12px", borderTop: "none", borderLeft: "none", borderRight: "none", borderBottom: active ? "2px solid " + C.accent : "2px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: active ? 700 : 500, background: "none", color: active ? C.accent : C.muted, whiteSpace: "nowrap", flexShrink: 0 }}
      >
        <span style={{ display: "inline-flex" }}>{ICON[icon] ? <Ic size={14} paths={ICON[icon]} /> : icon}</span>
        {vertical && <span>{label}</span>}
      </button>
    );
  });
}

// ---------- 顶栏 ----------
function TopBar() {
  const s = state.status || {};
  const running = !!s.running;
  const statusColor = running ? (s.sockAlive ? "#22c55e" : "#eab308") : "#ef4444";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: C.border, background: "rgba(255,255,255,0.92)", backdropFilter: "blur(8px)", flexShrink: 0, flexWrap: "wrap" }}>
      <span title={running ? "运行中" : "未运行"} style={{ width: 10, height: 10, borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
      <span style={{ fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICON.msg} />IM 渠道 &amp; cc-connect</span>
      <span style={{ fontSize: 11, color: C.muted }}>{s.version || ""}</span>
      <span style={{ fontSize: 11, color: C.muted }}>{running ? `pid ${s.pid || ""}` : "未运行"}</span>
      <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {!running
          ? <button style={{ ...btnStyle, background: "#22c55e", color: "#fff", border: "none" }} disabled={state.busy} onClick={() => op("start", "启动")}><Ic size={13} paths={ICON.play} />启动</button>
          : <button style={{ ...btnStyle, background: "#ef4444", color: "#fff", border: "none" }} disabled={state.busy} onClick={() => op("stop", "停止")}>⏹ 停止</button>}
        {running && <button style={btnStyle} disabled={state.busy} onClick={() => op("restart", "重启")}>🔄 重启</button>}
        <button style={btnStyle} disabled={state.busy} title="热应用 config.toml（POST /api/v1/reload）" onClick={() => ccAction("reload-cc", "reload")}>💾 reload</button>
        {running && <button style={btnStyle} disabled={state.busy} title="自动重启（进程替换保留 pid）" onClick={() => ccAction("restart-cc", "重启")}>♻ 自重启</button>}
        <button style={btnStyle} disabled={state.loading} onClick={() => { refreshStatus(); refreshSessions(); refreshMsgLog(); refreshInstall(); }}>⟳</button>
        <button style={{ ...btnStyle, padding: "4px 10px" }} onClick={() => setState({ open: false })}>✕</button>
      </span>
      {(state.error || state.msg) && <div style={{ width: "100%", fontSize: 11, color: state.error ? "#ef4444" : "#16a34a" }}>{state.error || state.msg}</div>}
    </div>
  );
}

// ---------- 面板主体 ----------
function ChannelsPanel() {
  const leftNav = state.nav === "left";
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 2147483646, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}>
      <div style={panelBox(state)}>
        <TopBar />
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          {/* 大屏：左侧导航 */}
          {leftNav && (
            <nav style={{ width: 132, flexShrink: 0, borderRight: C.border, display: "flex", flexDirection: "column", gap: 2, padding: 8, background: "var(--bg, #fff)", overflowY: "auto" }}>
              <NavButtons vertical={true} />
            </nav>
          )}
          {/* 内容区 */}
          <div style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: 14 }}>
            {renderTab()}
          </div>
        </div>
        {/* 小屏：底部导航 */}
        {!leftNav && (
          <nav style={{ display: "flex", gap: 2, padding: "6px 8px calc(6px + env(safe-area-inset-bottom, 0px))", borderTop: C.border, background: "rgba(255,255,255,0.95)", overflowX: "auto", flexShrink: 0 }}>
            <NavButtons vertical={false} />
          </nav>
        )}
      </div>
    </div>
  );
}

function panelBox(_s: Record<string, unknown>) {
  return { width: "100vw", height: "100dvh", maxWidth: "100vw", maxHeight: "100dvh", display: "flex", flexDirection: "column", background: C.panelBg, overflow: "hidden" };
}

// ---------- register 辅助（entry.tsx 调用；matchMedia 导航模式监听与手写版同位） ----------
export function setupNavMediaQuery() {
  if (typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(max-width: 720px)");
    const apply = () => setState({ nav: mq.matches ? "bottom" : "left" });
    apply();
    mq.addEventListener && mq.addEventListener("change", apply);
  }
}

/** 懒加载 v2 两段式：静态条目点击转发用（模块级开台 + 状态刷新） */
export function openFromToolbar() {
  setState({ open: true, tab: "overview", error: null, msg: null });
  void refreshStatus(); void refreshSessions(); void refreshMsgLog(); void refreshInstall(); void refreshConfig(); void refreshInstances();
}

export function ToolbarButton() {
  return (
    <button
      title={t("channels.title")}
      onClick={() => {
        setState({ open: true, tab: "overview", error: null, msg: null });
        void refreshStatus(); void refreshSessions(); void refreshMsgLog(); void refreshInstall(); void refreshConfig(); void refreshInstances();
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, padding: 0,
        background: "none", borderTop: "none", borderRight: "1px solid var(--border)",
        color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, fontSize: 16, lineHeight: 1,
        transition: "color 0.12s",
      }}
    >
      {/* lucide message-circle：IM 会话——与系统内建线条图标同风格 */}
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      </svg>
    </button>
  );
}

export function ChannelsPanelComp() {
  const [, force] = useState(0);
  useEffect(() => { const l = () => force((x) => x + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return state.open ? <ChannelsPanel /> : null;
}
