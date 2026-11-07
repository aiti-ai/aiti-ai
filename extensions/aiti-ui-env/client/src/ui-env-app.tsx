/**
 * aiti-ui-env · 显示环境管理面板（JSX 版，自手写 h() 版迁移，功能一比一）。
 *
 * 4 模式 + 桌面/虚拟屏探测 + VNC-on-web / RDP-on-web + 环境预览 + 组件安装状态。
 * toolbar 🖥️ 按钮 → dialogs 面板（data-ext-float 契约：aiti-float 自动接管拖拽/缩放/持久化）。
 *
 * 迁移修正：openViewSafe 移入组件作用域——原版在 register 作用域引用 Dialog 内的
 * setErr，弹窗被拦截路径会 ReferenceError 且被 .catch(() => {}) 吞掉；正常路径行为不变。
 */
import { useState, useEffect, useRef } from "react";
import { apiUrl, t } from "./host-shim";

// ── 模块级开关：toolbar 按钮与 dialog 共享（Esc 关闭 / 遮罩点击关闭都走这里） ──
// dock v3（P3 批）：显隐收口展示状态机（P3 保守：无 default，浮窗照旧；⇱ 菜单可手动右栏）
import { useGate, usePresent, presentState, DockBody, openFloat, closePanel, seedDockDefault } from "../../../_shared/ext-float-dock";
import { uiAlert, uiConfirm, uiPrompt } from "../../../_shared/ui-dialogs";

const UIENV_KEY = "aiti-ui-env:panel";
function setPanelOpen(v: boolean) { if (v) openFloat(UIENV_KEY); else closePanel(UIENV_KEY); }
/** 懒加载 v2 两段式：静态条目点击转发用（模块级开合，不依赖组件状态） */
export function togglePanelFromToolbar() {
  if (presentState(UIENV_KEY) === "closed") openFloat(UIENV_KEY);
  else closePanel(UIENV_KEY);
}

// ── 主题（与宿主 CSS 变量对齐） ──
const C = {
  panel: "var(--bg-panel, #1a1a22)",
  panel2: "var(--bg-hover, rgba(128,128,128,0.08))",
  border: "var(--border)",
  text: "var(--text)",
  muted: "var(--text-muted)",
  dim: "var(--text-dim)",
  accent: "var(--accent)",
  ok: "var(--ok, #22c55e)",
  bad: "var(--danger, #ef4444)",
  warn: "var(--warn, #f59e0b)",
  mono: "var(--font-mono, monospace)",
};

// lucide 图标（与系统内建线条图标同风格）
const Ic = ({ size, paths }: { size: number; paths: string[] }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {paths.map((d, i) => <path key={i} d={d} />)}
  </svg>
);
const ICONS = {
  monitor: ["M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M8 21h8", "M12 17v4"],
  cloud: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"],
  monitorPlay: ["M10 7.75a.75.75 0 0 1 1.142-.638l3.664 2.249a.75.75 0 0 1 0 1.278l-3.664 2.25a.75.75 0 0 1-1.142-.64z", "M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M8 21h8", "M12 17v4"],
  flask: ["M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2", "M8.5 2h7", "M7 16h10"],
  wrench: ["M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"],
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  alert: ["m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z", "M12 9v4", "M12 17h.01"],
};

function usePanelOpen(): boolean {
  return usePresent(UIENV_KEY) !== "closed";
}

/** 小屏（手机/窄窗）探测：仅用于内容密度（内边距等）；弹窗小屏全屏已交给 aiti-float 的
 *  data-ext-float-full 标记，这里不再手写全屏切换 */
function useSmallScreen(): boolean {
  const [small, setSmall] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const upd = () => setSmall(mq.matches);
    upd();
    if (mq.addEventListener) mq.addEventListener("change", upd);
    else mq.addListener(upd);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", upd);
      else mq.removeListener(upd);
    };
  }, []);
  return small;
}

const card = (extra?: Record<string, unknown>): Record<string, unknown> => ({
  background: C.panel, border: "1px solid " + C.border, borderRadius: 12,
  padding: "12px 14px", marginBottom: 10, ...extra,
});
const secTitle = () => ({
  display: "flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 700,
  color: C.text, marginBottom: 10, letterSpacing: "0.01em",
});
const accentBar = (color?: string) => ({ width: 3, height: 12, borderRadius: 2, background: color || C.accent, flexShrink: 0 });
const dot = (color: string) => ({ width: 7, height: 7, borderRadius: 4, background: color, flexShrink: 0 });
const chip = (color: string, bg?: string) => ({
  fontSize: 10, padding: "1px 8px", borderRadius: 9, background: bg || "transparent",
  color, whiteSpace: "nowrap", flexShrink: 0, border: "1px solid " + (bg ? "transparent" : C.border),
});
const btn = (extra?: Record<string, unknown>): Record<string, unknown> => ({
  padding: "4px 11px", borderRadius: 7, fontSize: 11, cursor: "pointer",
  background: C.panel2, border: "1px solid " + C.border, color: C.muted,
  whiteSpace: "nowrap", transition: "all .12s", ...extra,
});
const rowStyle = { display: "flex", alignItems: "baseline", gap: 8, padding: "2.5px 0" };

function copyText(text: string) {
  try { navigator.clipboard.writeText(text).catch(() => {}); } catch {}
}

/** host:port 单页连接表单：trigger 按钮展开一行输入——host autoFocus + 全选，回车→port，再回车→确认。
 *  onStart(host, port) 返回 true = 成功（关闭表单），false/抛错 = 保持打开显示错误。 */
function ConnForm({ trigger, defaultHost, defaultPort, onStart, busy, placeholder }: {
  trigger: string;
  defaultHost: string;
  defaultPort: string;
  onStart: (host: string, port: number) => Promise<boolean>;
  busy: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState(defaultHost);
  const [port, setPort] = useState(defaultPort);
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);

  const focusPort = () => setTimeout(() => portRef.current?.focus(), 0);
  async function start() {
    const h = host.trim();
    const p = Number(port || defaultPort);
    if (!h) { setErr("需要目标主机"); hostRef.current?.focus(); return; }
    if (!Number.isFinite(p) || p <= 0 || p > 65535) { setErr("端口需为 1-65535"); portRef.current?.focus(); return; }
    setStarting(true); setErr(null);
    try {
      const ok = await onStart(h, p);
      if (ok) { setOpen(false); setHost(defaultHost); setPort(defaultPort); }
    } catch (e: any) { setErr(String(e && e.message || e)); }
    setStarting(false);
  }
  const inputStyle = { padding: "3px 8px", borderRadius: 7, fontSize: 11.5, background: C.panel2, border: "1px solid " + C.border, color: C.text, fontFamily: C.mono } as Record<string, unknown>;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <button style={btn()} onClick={() => { setOpen(!open); setErr(null); }} disabled={busy}>{trigger}</button>
      {open ? (
        <>
          <input ref={hostRef} autoFocus value={host} placeholder="host / IP"
            onChange={(e) => setHost(e.target.value)}
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            onKeyDown={(e) => { if (e.key === "Enter") focusPort(); }}
            style={{ ...inputStyle, width: 150 }} />
          <span style={{ color: C.dim }}>:</span>
          <input ref={portRef} value={port} placeholder="port"
            onChange={(e) => setPort(e.target.value)}
            onFocus={(e) => (e.target as HTMLInputElement).select()}
            onKeyDown={(e) => { if (e.key === "Enter") start(); }}
            style={{ ...inputStyle, width: 64 }} />
          <button style={{ ...btn({ color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" }), cursor: starting ? "wait" : "pointer" }}
            onClick={start} disabled={starting || busy}>{starting ? "连接中…" : "连接"}</button>
          <button style={btn()} onClick={() => setOpen(false)}>取消</button>
          {err ? <span style={{ color: C.bad, fontSize: 10.5 }}>{err}</span> : null}
        </>
      ) : null}
      {placeholder ? <span style={{ fontSize: 10.5, color: C.dim }}>{placeholder}</span> : null}
    </span>
  );
}

/** 构建 VNC 访问 URL：POST /vnc-session 设 HttpOnly cookie（30min 会话）+ 取该实例真随机令牌；
 *  URL 路径段 = 实例 token（代表该实例/端口，不落目标地址）；复制到其他机器/浏览器无 cookie 直接 403。
 *  instId：指定实例（多实例）；缺省=默认实例。 */
async function buildVncUrl(instId?: string): Promise<string> {
  const q = instId ? "?id=" + encodeURIComponent(instId) : "";
  const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc-session" + q), { method: "POST", cache: "no-store" });
  const d = await r.json();
  if (!d.ok || !d.token) throw new Error("vnc-session 失败");
  const api = new URL(apiUrl("/x"), location.origin); // apiUrl 是相对路径（含 basePath）
  const basePath = api.pathname.endsWith("/x") ? api.pathname.slice(0, -2) : "";
  const wsPath = (basePath + "/aiti-ui-env/vnc/" + d.token + "/ws").replace(/^\/+/, "");
  const query = "autoconnect=true&resize=scale&path=" + encodeURIComponent(wsPath);
  // view.html = 查看外壳（旋转/双指捏合缩放，直连 RFB 无 iframe）；query 原样透传
  return location.origin + basePath + "/aiti-ui-env/vnc/" + d.token + "/view.html?" + query;
}

/** 构建 RDP 访问 URL：POST /rdp-session 设 cookie + 取该实例真随机令牌；
 *  URL 路径段 = token（不落目标地址）；grdpwasm 页面自动连该实例的 RDP 目标。 */
async function buildRdpUrl(instId?: string): Promise<string> {
  const q = instId ? "?id=" + encodeURIComponent(instId) : "";
  const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/rdp-session" + q), { method: "POST", cache: "no-store" });
  const d = await r.json();
  if (!d.ok || !d.token) throw new Error("rdp-session 失败");
  const api = new URL(apiUrl("/x"), location.origin);
  const basePath = api.pathname.endsWith("/x") ? api.pathname.slice(0, -2) : "";
  return location.origin + basePath + "/aiti-ui-env/rdp/" + d.token + "/index.html";
}

/** 分辨率解析：xdpyinfo 原始串 → "1920×1080" */
function fmtRes(r: unknown): string {
  if (!r) return "—";
  const m = String(r).match(/(\d+)\s*x\s*(\d+)/);
  return m ? `${m[1]}×${m[2]}` : String(r).slice(0, 24);
}

/* ── 主面板 ── */
export function UiEnvDockFace() { return renderUiEnvDialog("dock"); }
function Dialog() { return renderUiEnvDialog("float"); }
function renderUiEnvDialog(face?: string) {
  const st0 = usePresent(UIENV_KEY);
  const open = face === "float" ? st0 === "floating" : st0 === "docked:right-panel";
  const floating = face === "float";
  const small = useSmallScreen();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyWhat, setBusyWhat] = useState<string | null>(null); // 在跑操作的归属：headless/vnc/rdp/deps/mode/disp（按钮文案只看自己卡）
  const [preview, setPreview] = useState<any>(null);
  const [vncUrl, setVncUrl] = useState<string | null>(null); // 默认实例会话 URL（无凭据，30min cookie 会话）
  const [deps, setDeps] = useState<any>(null); // 依赖自检结果（多 OS）
  const [dispMode, setDispMode] = useState<string | null>(null); // "auto" | "fixed"（DISPLAY 号配置）
  const [dispNum, setDispNum] = useState("");
  const [vncTab, setVncTab] = useState("own"); // VNC 卡视图：own=扩展实例 | sys=系统 VNC
  const [sysVnc, setSysVnc] = useState<any[] | null>(null);   // 系统 VNC 列表（sys-scan 结果）
  const [sysBusy, setSysBusy] = useState(false);

  async function refresh() {
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/status?refresh=1"), { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error("HTTP " + r.status);
      setData(d); setErr(null);
      // DISPLAY 号配置：面板数据首次到达时初始化表单
      if (d.displayConfig) {
        setDispMode((prev: string | null) => prev || d.displayConfig.mode || "auto");
        setDispNum((prev: string) => prev || String(d.displayConfig.num || ""));
      }
      // VNC 会话 URL：POST vnc-session 建 30min HttpOnly cookie（刷新/重复打开可用）
      buildVncUrl().then((u) => setVncUrl(u)).catch(() => {}); // 默认实例会话 URL（string）
    } catch (e: any) { setErr(String(e && e.message || e)); }
  }
  useEffect(() => { if (open) refresh(); }, [open]);
  // 依赖自检（不阻塞主状态）：缺失组件 + 自动安装 + 手动指引
  async function loadDeps() {
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/deps"), { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      setDeps(await r.json());
    } catch { /* 忽略：deps 区块不强求 */ }
  }
  useEffect(() => { if (open) loadDeps(); }, [open]);

  // 所有按钮类操作统一包装：setBusy(true)+busyWhat=what → 操作 → 复位。
  // busyWhat：当前在跑的操作归属（headless/vnc/rdp/deps/mode/disp）——只影响对应卡片的按钮文案，
  // 避免点 VNC 卡的按钮时虚拟屏卡误显「停止中…」（全部按钮仍统一禁用防并发）。
  // 超时保护：任何 fetch 挂起（网络/服务端卡死）最多 60s 自动复位 busy。
  async function withBusy(what: string, fn: () => Promise<void>) {
    setBusy(true); setBusyWhat(what);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      setBusy(false);
      setErr("操作超时（60s）——后端无响应，已复位面板；请重试或刷新");
    }, 60000);
    try {
      await fn();
    } catch (e: any) { setErr(String(e && e.message || e)); }
    done = true;
    clearTimeout(timer);
    setBusy(false); setBusyWhat(null);
  }

  /** Windows 自管 winvnc（UltraVNC）首次启动/安装需要用户提供 VNC 密码：弹框输入 → 写入 server 配置。
   *  密码由 VNC server 自己认证（桥不代答）；返回 false 表示用户取消。 */
  async function ensureVncPassword(): Promise<boolean> {
    try {
      const st = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc-password"), { cache: "no-store" });
      if (st.ok) { const sd = await st.json().catch(() => ({})); if (sd.set) return true; }
    } catch { /* 查不到当作未设置 */ }
    const pw = await uiPrompt({
      title: "设置 VNC 密码",
      message: "VNC 连接需要密码（1~8 位，UltraVNC 最长 8 位）。该密码写入本机 VNC server 配置，之后在浏览器查看时输入即可。",
      placeholder: "1~8 位密码",
      required: true,
    });
    if (pw == null || !pw.trim()) return false;
    const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc-password"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: pw.trim() }),
    });
    const rd = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(rd.error || "设置 VNC 密码失败 HTTP " + r.status);
    return true;
  }

  /** 本机是否为 Windows（自管 winvnc 路径）——用于决定是否要询问 VNC 密码。 */
  function isWindowsEnv(): boolean {
    return deps?.os === "windows" || (data as any)?.headless?.kind === "windows";
  }

  async function installDepsBtn() {
    await withBusy("deps", async () => {
      if (isWindowsEnv() && !(await ensureVncPassword())) return; // 用户取消：不装，避免装完无法设密码
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/deps"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "install" }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      setDeps(await r.json());
    });
  }
  // Esc 关闭（标准模态行为）—— 必须在 early return 之前（React hooks 规则：hooks 调用顺序必须稳定）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPanelOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function setMode(mode: string) {
    await withBusy("mode", async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/set-mode"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      await refresh();
    });
  }

  async function vncAction(action: string, id?: string) {
    await withBusy("vnc", async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      await refresh();
    });
  }
  async function rdpAction(action: string, id?: string) {
    await withBusy("rdp", async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/rdp"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      await refresh();
    });
  }
  /** RDP 启动（单页表单发起）：返回是否成功（false=失败，错误已显示在标题栏） */
  async function startRdp(host: string, port: number): Promise<boolean> {
    let ok = false;
    await withBusy("rdp", async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/rdp"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", host, port }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      ok = true;
      await refresh();
    });
    return ok;
  }
  /** 外部/远程 VNC 连接（sys-open 带 host）：成功即自动开查看窗 */
  async function connectVnc(host: string, port: number): Promise<boolean> {
    let ok = false;
    await withSysBusy(async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sys-open", host, port, label: `${host}:${port}` }),
      });
      const d = await r.json();
      if (d.ok) {
        ok = true;
        openViewSafe(buildVncUrl, d.inst.id).catch(() => {});
        refresh();
      } else {
        throw new Error(d.error || "打开失败");
      }
    });
    return ok;
  }

  /* ── 系统 VNC：探测/打开/停止（自由切换扩展 VNC 与系统已有 VNC） ── */
  // 同 withBusy：sys-scan/open/stop 也可能因后端卡死挂起，统一 60s 超时复位。
  async function withSysBusy(fn: () => Promise<void>) {
    setSysBusy(true);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      setSysBusy(false);
      setErr("操作超时（60s）——后端无响应，已复位；请重试");
    }, 60000);
    try {
      await fn();
    } catch (e: any) { setErr(String(e && e.message || e)); }
    done = true;
    clearTimeout(timer);
    setSysBusy(false);
  }
  /** 重设某个系统 VNC 的密码（Linux 写 -rfbauth/密码文件；Windows 写注册表；多数需重启该 VNC 后生效）。 */
  async function resetSysPassword(v: any) {
    if (!v.passwordResettable) return;
    const pw = await uiPrompt({
      title: "重设 VNC 密码",
      message: `目标：${v.kind}${v.display ? " " + v.display : ""}${v.pid ? "（pid " + v.pid + "）" : ""}\n1~8 位（VNC 密码上限 8 位）。${v.passwordNote || ""}`,
      placeholder: "1~8 位密码",
      required: true,
    });
    if (pw == null || !pw.trim()) return;
    await withSysBusy(async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc-password"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw.trim(), id: v.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      const lines = [ ...(d.applied || []), ...(d.errors || []) ].join("\n");
      await uiAlert({ message: "已重设 VNC 密码。" + (lines ? "\n" + lines : "") + (d.note ? "\n" + d.note : "") });
      await loadSysVnc();
    });
  }

  async function loadSysVnc() {
    await withSysBusy(async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sys-scan" }),
      });
      const d = await r.json();
      if (d.ok) setSysVnc(d.sysVnc || []); else setErr(d.error || "系统 VNC 扫描失败");
    });
  }
  async function openSys(v: any) {
    await withSysBusy(async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sys-open", port: v.port, label: v.kind + v.display }),
      });
      const d = await r.json();
      if (d.ok) {
        openViewSafe(buildVncUrl, d.inst.id).catch(() => {});
      } else setErr(d.error || "打开失败");
    });
  }
  async function stopSys(v: any) {
    if (!(await uiConfirm({ message: "确定停止系统 VNC 进程（" + (v.cmd || v.kind) + "）？该操作只发停止信号，权限不足会失败。", danger: true }))) return;
    await withSysBusy(async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sys-stop", pid: v.pid }),
      });
      const d = await r.json();
      if (d.ok) { loadSysVnc(); } else setErr(d.error || "停止失败");
    });
  }

  async function headlessAction(action: string) {
    await withBusy("headless", async () => {
      if (action === "start" && isWindowsEnv() && !(await ensureVncPassword())) return; // 用户取消
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/headless"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      await refresh();
    });
  }

  /** 设置/修改 VNC 密码（Windows 自管 winvnc）：写 server 配置 + 重启 VNC 生效。 */
  async function changeVncPassword() {
    const pw = await uiPrompt({
      title: "设置/修改 VNC 密码",
      message: "1~8 位（UltraVNC 上限 8 位）。写入本机 VNC server 配置并重启 VNC 使其生效。",
      placeholder: "1~8 位密码",
      required: true,
    });
    if (pw == null || !pw.trim()) return;
    await withBusy("vnc", async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/vnc-password"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw.trim() }),
      });
      const rd = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(rd.error || "HTTP " + r.status);
      await refresh();
    });
  }

  async function saveDispCfg() {
    await withBusy("disp", async () => {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/display-config"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: dispMode === "fixed" ? "fixed" : "auto", num: dispMode === "fixed" ? Number(dispNum) : undefined }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      setData((prev: any) => ({ ...prev, displayConfig: d.config }));
      await refresh(); // 重新解析 DISPLAY（配置变更后下次启动生效）
    });
  }

  async function loadPreview() {
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/resolve"), { cache: "no-store" });
      setPreview(await r.json());
    } catch (e: any) { setPreview({ error: String(e && e.message || e) }); }
  }

  /** 弹窗安全打开：点击瞬间同步开空白窗（保住用户手势），拿到会话 URL 再导航；
   *  连同步开窗都被拦时退化为复制 URL 提示。（组件作用域内可直接 setErr） */
  async function openViewSafe(buildUrl: (instId?: string) => Promise<string>, instId?: string) {
    const win = window.open("", "_blank"); // 必须同步调用（用户手势栈内）
    try {
      const u = await buildUrl(instId);
      if (win && !win.closed) { win.location.href = u; return; }
      try { copyText(u); setErr("弹窗被拦截：查看 URL 已复制，可粘到新标签页打开（30 分钟内有效）"); } catch { setErr("弹窗被拦截：" + u); }
    } catch (e: any) {
      try { if (win && !win.closed) win.close(); } catch {}
      setErr("会话建立失败：" + String((e && e.message) || e));
    }
  }

  if (!open) return null;

  const d = data || {};
  const mode = d.mode;
  const desktop = d.desktop || {};
  const headless = d.headless || {};
  const vnc = d.vnc || {};
  const install = d.install || {};
  const feats = d.features || {};
  const modeLabel = (d.modes || []).find((m: any) => m.id === mode);
  const vncInsts = vnc.instances || [];
  const rdp = d.rdp || {};
  const rdpInsts = rdp.instances || [];

  const uienvContent = (
    <>
      {/* ── 窗口标题栏：标题 + 模式徽章 + 关闭 ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", borderBottom: "1px solid " + C.border, flexShrink: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}><Ic size={15} paths={ICONS.monitor} />{t("uiEnv.title")}</span>
          {modeLabel ? <span style={chip("#a5b4fc", "rgba(99,102,241,0.16)")}>{"当前：" + modeLabel.label}</span> : null}
          <span style={{ marginLeft: "auto", fontSize: 10.5, color: C.dim, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>作用于新启动的 MCP / 应用</span>
          {err ? <span style={{ color: C.bad, fontSize: 10.5 }}>{String(err)}</span> : null}
          {floating && (
            <button onClick={() => setPanelOpen(false)} title={t("uiEnv.close")} aria-label={t("uiEnv.close")}
              style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 4, fontSize: 14, lineHeight: 1, flexShrink: 0 }}>
              <Ic size={12} paths={ICONS.x} />
            </button>
          )}
        </div>
        {/* ── 内容区（可滚动） ── */}
        <div style={{ flex: 1, overflowY: "auto", padding: small ? "10px 10px 16px" : "14px 18px 20px" }}>

          {/* ── 模式区 ── */}
          <div style={card({ marginBottom: 12 })}>
            <div style={secTitle()}>
              <span style={accentBar("#818cf8")} />显示模式
              {d.envOverrides?.UI_ENV_MODE ? <span style={chip(C.warn)}>{"env 覆盖：UI_ENV_MODE=" + d.envOverrides.UI_ENV_MODE}</span> : null}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 7 }}>
              {(d.modes || []).map((m: any) => {
                const active = mode === m.id;
                return (
                  <button key={m.id} onClick={() => setMode(m.id)} disabled={busy} title={m.desc}
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 8, textAlign: "left",
                      padding: "8px 10px", borderRadius: 9, cursor: "pointer", flex: 1, minWidth: 0,
                      background: active ? "rgba(99,102,241,0.14)" : C.panel2,
                      border: active ? "1px solid #818cf8" : "1px solid " + C.border,
                      transition: "all .12s",
                    }}>
                    <span style={{
                      width: 13, height: 13, borderRadius: 7, marginTop: 1, flexShrink: 0,
                      border: "2px solid " + (active ? "#818cf8" : C.dim),
                      background: active ? "#818cf8" : "transparent",
                      display: "inline-block",
                    }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: active ? "#c7d2fe" : C.text, display: "block" }}>{m.label}</span>
                      <span style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.45, display: "block", marginTop: 2 }}>{m.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            {d.target ? (
              <div style={{ marginTop: 10, fontSize: 11, color: C.dim, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={dot(C.accent)} />
                当前裁决：<b style={{ color: "#a5b4fc", fontWeight: 600 }}>{d.target.rationale}</b>
                {d.target.warnings?.length ? <span style={{ color: C.warn }}><Ic size={11} paths={ICONS.alert} /> {" "}{d.target.warnings.slice(0, 2).join("；")}</span> : null}
              </div>
            ) : null}
          </div>

          {/* ── DISPLAY 号配置（默认 auto 随机；可指定固定数字） ── */}
          <div style={card({ marginBottom: 12 })}>
            <div style={secTitle()}>
              <span style={accentBar("var(--warn, #f59e0b)")} />DISPLAY 号配置
              {d.randomDisplayFeature === false ? <span style={chip(C.dim)}>feature 关：不随机</span> : null}
              {d.envOverrides?.UI_ENV_DISPLAY_NUM ? <span style={chip(C.warn)}>{"env 覆盖：UI_ENV_DISPLAY_NUM=" + d.envOverrides.UI_ENV_DISPLAY_NUM}</span> : null}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => setDispMode("auto")} disabled={busy} style={{ ...btn(), ...(dispMode === "auto" ? { color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" } : {}) }}>auto · 随机空闲</button>
              <button onClick={() => setDispMode("fixed")} disabled={busy} style={{ ...btn(), ...(dispMode === "fixed" ? { color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" } : {}) }}>指定数字</button>
              {dispMode === "fixed" ? (
                <input type="number" min={1} max={65535} value={dispNum} placeholder="如 99"
                  onChange={(e) => setDispNum(e.target.value)}
                  style={{ width: 70, padding: "3px 7px", borderRadius: 7, fontSize: 11, background: C.panel2, border: "1px solid " + C.border, color: C.text }} />
              ) : null}
              <button onClick={saveDispCfg} disabled={busy} style={{ ...btn({ color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" }), cursor: busy ? "wait" : "pointer" }}>{busy ? "保存中…" : "保存"}</button>
            </div>
            <div style={{ fontSize: 10, color: C.dim, marginTop: 6, lineHeight: 1.5 }}>
              {"当前 DISPLAY：" + (d.headless?.display || "—") + " · 默认 auto：启动时自动选空闲号（随机 90–189），避免固定 :99 被其他 X 服务占用" +
                (d.randomDisplayFeature === false ? "；feature 关时不随机，用固定号" : "")}
            </div>
          </div>

          {/* ── 环境卡 ×2 ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10, marginBottom: 12 }}>
            {desktop.kind === "macos" ? envCard(<><Ic size={13} paths={ICONS.monitor} />{" "}Aqua 桌面（控制台会话）</>, desktop, desktop.available, [
              ["会话", desktop.display + (desktop.consoleUser ? " · " + desktop.consoleUser : "")],
              ["类型", "macOS Aqua（WindowServer）"],
              ["分辨率", fmtRes(desktop.resolution)],
              ["WM", desktop.wm || "—"],
            ]) : desktop.kind === "windows" ? envCard(<><Ic size={13} paths={ICONS.monitor} />{" "}真实桌面</>, desktop, desktop.available, [
              ["会话", desktop.display],
              ["类型", "Windows 交互会话"],
              ["分辨率", fmtRes(desktop.resolution)],
              ["Shell", desktop.wm || "explorer"],
            ]) : envCard(<><Ic size={13} paths={ICONS.monitor} />{" "}真实桌面</>, desktop, desktop.available, [
              ["DISPLAY", desktop.display],
              ["类型", desktop.kind === "wayland" ? "Wayland" : "X11"],
              ["Xauthority", desktop.xauthority || "—"],
              ["分辨率", fmtRes(desktop.resolution)],
              ["WM", desktop.wm || "—"],
              ["AT-SPI", desktop.atspi ? "在跑" : "无"],
            ])}
            {headless.kind === "macos" ? envCard(<><Ic size={13} paths={ICONS.cloud} />{" "}{"无头层（屏幕共享 VNC）"}</>, headless, headless.available, [
              ["VNC server", headless.available ? "屏幕共享 :5900 在跑" : "未开启", headless.available ? C.ok : C.warn],
              ["分辨率", fmtRes(headless.resolution)],
              ["说明", "GUI 落控制台桌面（mac 无进程隔离）；无头 = 屏幕共享 VNC 远程查看通道"],
            ], (
              <div style={{ marginTop: "auto", paddingTop: 6, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                {!headless.available ? (
                  <button onClick={() => headlessAction("start")} disabled={busy}
                    title="开启屏幕共享（免密 sudo 自动开；否则给手动步骤）"
                    style={{ ...btn({ color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" }), cursor: busy ? "wait" : "pointer" }}>
                    {busyWhat === "headless" ? "开启中…" : "▶ 开启屏幕共享"}
                  </button>
                ) : (
                  <span style={{ fontSize: 10, color: C.dim }}>屏幕共享为系统服务：本扩展只桥接不启停（查看走下方 VNC 卡）</span>
                )}
                {feats.autostart === false ? <span style={{ fontSize: 10, color: C.dim }}>autostart 关：未开启时需手动点上方按钮</span> : null}
              </div>
            )) : headless.kind === "windows" ? envCard(<><Ic size={13} paths={ICONS.cloud} />{" "}{"虚拟屏（驱动+VNC）"}</>, headless, headless.available, [
              ["虚拟驱动", headless.wm ? "已装（" + headless.wm + "）" : "未检测到", headless.wm ? C.ok : C.warn],
              ["VNC server", headless.vnc?.tcp ? ":5900 回环在跑" : "未起", headless.vnc?.tcp ? C.ok : C.warn],
              ["说明", "GUI 落交互桌面（无进程隔离），虚拟屏 = 无屏可用 + VNC 查看通道"],
            ]) : envCard(<><Ic size={13} paths={ICONS.cloud} />{" "}{"无头虚拟屏 " + (headless.display || ":99")}</>, headless, headless.available, [
              ["DISPLAY", headless.display],
              ["Xauthority", headless.xauthority || "—"],
              ["AT-SPI 总线", headless.dbusBus || "—"],
              ["openbox", headless.wm ? "在跑" : "无"],
              ["分辨率", fmtRes(headless.resolution)],
              ["VNC TCP", headless.vnc?.tcp ? `:${headless.vnc.tcpPort}` : "未起", headless.vnc?.tcp ? C.ok : C.warn],
              ["VNC web", headless.vnc?.web ? `:${headless.vnc.webPort}` : "未起", headless.vnc?.web ? C.ok : C.warn],
            ], (
              <div style={{ marginTop: "auto", paddingTop: 6, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                {headless.available ? (
                  <button onClick={async () => { if (await uiConfirm({ message: "确定停止虚拟屏？将关闭 VNC 与虚拟桌面上的所有程序（仅虚拟屏，不动真实桌面）。", danger: true })) headlessAction("stop"); }} disabled={busy}
                    title="停止 Xvfb+openbox+dbus+AT-SPI 及 VNC 实例（仅虚拟屏，不碰真实桌面）"
                    style={{ ...btn({ color: "var(--danger, #f87171)", borderColor: "rgba(239,68,68,0.45)", background: "rgba(239,68,68,0.12)" }), cursor: busy ? "wait" : "pointer" }}>
                    {busyWhat === "headless" ? "停止中…" : "■ 停止虚拟屏"}
                  </button>
                ) : (
                  <button onClick={() => headlessAction("start")} disabled={busy}
                    title="拉起 Xvfb+openbox+dbus+AT-SPI（幂等，已在跑则直接返回就绪）"
                    style={{ ...btn({ color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" }), cursor: busy ? "wait" : "pointer" }}>
                    {busyWhat === "headless" ? "启动中…" : "▶ 启动虚拟屏"}
                  </button>
                )}
                {feats.autostart === false ? <span style={{ fontSize: 10, color: C.dim }}>autostart 关：未启动时需手动点上方按钮启动</span> : null}
              </div>
            ))}
          </div>

          {/* ── VNC 卡（扩展 VNC / 系统 VNC，自由切换） ── */}
          <div style={card({})}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
              <span style={accentBar("var(--ok, #22c55e)")} />
              <span style={{ fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.monitorPlay} />VNC-on-web</span>
              <button onClick={() => setVncTab("own")} style={{ ...btn(), ...(vncTab === "own" ? { color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" } : {}) }}>扩展 VNC</button>
              <button onClick={() => { setVncTab("sys"); if (!sysVnc) loadSysVnc(); }} style={{ ...btn(), ...(vncTab === "sys" ? { color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" } : {}) }}>系统 VNC</button>
              <span style={chip(vnc.tcpRunning ? C.ok : C.dim, vnc.tcpRunning ? "rgba(34,197,94,0.12)" : undefined)}>{vnc.tcpRunning ? <Ic size={11} paths={ICONS.check} /> : <Ic size={11} paths={ICONS.x} />} RFB</span>
              <span style={chip(vnc.webRunning ? C.ok : C.dim, vnc.webRunning ? "rgba(34,197,94,0.12)" : undefined)}>{vnc.webRunning ? <Ic size={11} paths={ICONS.check} /> : <Ic size={11} paths={ICONS.x} />} Web</span>
              {vncTab === "sys" ? (
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  <button style={btn()} onClick={loadSysVnc} disabled={sysBusy}>刷新</button>
                </span>
              ) : (
                <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {isWindowsEnv() ? <button style={btn()} onClick={changeVncPassword} disabled={busy} title="设置/修改 VNC 密码（写入 UltraVNC 配置并重启 VNC 生效）">密码</button> : null}
                  <button style={btn()} onClick={() => vncAction("start")} disabled={busy}>▶ 启动/新实例</button>
                  <button style={btn()} onClick={() => vncAction("stop")} disabled={busy}>■ 停默认</button>
                </span>
              )}
            </div>

            {/* ── 系统 VNC 视图：系统已有 VNC server（真实桌面/自起 vncserver），临时 bridge 转发查看 ── */}
            {vncTab === "sys" ? (
              <>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                <ConnForm trigger="手动连接 host:port" defaultHost="127.0.0.1" defaultPort="5900"
                  busy={sysBusy} onStart={connectVnc}
                  placeholder="外部/远程 VNC（如 192.168.1.20:5900）；也可连本机未扫描到的端口" />
              </div>
              {sysVnc === null ? <div style={{ fontSize: 11, color: C.dim, padding: "6px 0" }}>扫描系统 VNC 中…</div> :
              sysVnc.length === 0 ? <div style={{ fontSize: 11, color: C.dim, padding: "6px 0" }}>未发现系统 VNC server（本扩展自启的已排除）。点「刷新」重扫。</div> :
                sysVnc.map((v) => (
                  <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid " + C.border, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, fontFamily: C.mono }}>{v.kind}</span>
                    <span style={chip(C.muted)}>{v.display}</span>
                    <span style={chip(v.port ? (v.listening ? C.ok : C.warn) : C.dim, v.port ? "rgba(34,197,94,0.10)" : undefined)}>{v.listening ? "port " + v.port : "port " + v.port + "·未监听"}</span>
                    {v.pid ? <span style={{ fontSize: 10, color: C.dim }}>{"pid " + v.pid + (v.stoppable ? "" : "（非本用户，不可停）")}</span> : null}
                    <span style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
                      <button style={btn()} onClick={() => openSys(v)} disabled={sysBusy || !v.listening} title={v.listening ? "" : "端口无监听（-loop 等待中/未运行），无法连接"}>{v.listening ? "打开" : "不可连"}</button>
                      <button style={btn()} onClick={() => resetSysPassword(v)} disabled={sysBusy || !v.passwordResettable}
                        title={v.passwordNote || "该 VNC server 的密码本扩展不能改"}>{v.passwordResettable ? "重设密码" : "不可改"}</button>
                      {v.stoppable && v.pid ? <button style={{ ...btn(), color: C.bad }} onClick={() => stopSys(v)} disabled={sysBusy}>停止</button> : null}
                    </span>
                  </div>
                ))}
              </>
            ) : (
              /* ── 扩展 VNC 视图：多实例列表 ── */
              vncInsts.length === 0 ? <div style={{ fontSize: 11, color: C.dim, padding: "6px 0" }}>无实例（点 ▶ 启动创建；端口每次随机分配，避免与桌面/其他服务冲突）</div> :
                vncInsts.map((inst: any) => (
                  <div key={inst.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid " + C.border, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: inst.id === "default" ? "#a5b4fc" : C.text, fontFamily: C.mono }}>{inst.id === "default" ? "default" : inst.id}</span>
                    {inst.sys ? <span style={chip(C.warn)}>{inst.sys.host && inst.sys.host !== "127.0.0.1" ? `${inst.sys.host}:${inst.sys.port}` : "系统:" + inst.sys.port}</span> : <span style={chip(C.muted)}>{" :" + inst.displayNum}</span>}
                    <span style={chip(inst.tcp ? C.ok : C.dim, inst.tcp ? "rgba(34,197,94,0.10)" : undefined)}>{"RFB :" + inst.rfbPort}</span>
                    <span style={chip(inst.web ? C.ok : C.dim, inst.web ? "rgba(34,197,94,0.10)" : undefined)}>{"Web :" + inst.webPort}</span>
                    <span style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
                      <button style={btn()} onClick={() => { openViewSafe(buildVncUrl, inst.id).catch(() => {}); }}>打开</button>
                      <button style={btn()} onClick={() => { buildVncUrl(inst.id).then((u) => copyText(u)).catch(() => setErr("会话建立失败")); }}>复制</button>
                      {inst.id !== "default" ? <button style={btn()} onClick={() => vncAction("stop", inst.id)} disabled={busy}>停止</button> : null}
                    </span>
                  </div>
                ))
            )}
            {/* 说明文字是独立子节点（不能放进 ternary 分支值里被吞掉） */}
            {vncTab === "sys" ? (
              <div style={{ marginTop: 8, fontSize: 10.5, color: C.dim, lineHeight: 1.6 }}>
                {"系统 VNC = 机器上已有的 VNC server（如真实桌面 :0 的 x11vnc、vncserver 起的虚拟桌面），本扩展起临时 bridge 转发，noVNC 直接连。"}
                {"有密码的会在 noVNC 里提示输入；「停止」仅对本用户启动的进程生效（root/gdm 的无权限会自动失败）。"}
                {"「打开」产生的临时实例也出现在扩展 VNC 列表（id 以 sys- 开头），可在那边停止。"}
              </div>
            ) : (
              <div style={{ marginTop: 8, fontSize: 10.5, color: C.dim, lineHeight: 1.6 }}>
                {"多实例：每次「▶ 启动」新实例随机分配 RFB/Web 端口，URL 路径段 = 实例真随机 token（代表该实例/端口，不落目标地址，定期轮换）。"}
                {"URL 零凭据——会话走 HttpOnly cookie（30 分钟，从本面板打开即自动建立），复制到别处无 cookie 打不开（防泄露）"}
                {" · noVNC 目录：" + (vnc.noVncDir || "未找到（跑 setup-linux.sh 下载）")}
              </div>
            )}
          </div>

          {/* ── RDP 卡（grdpwasm WASM RDP 客户端；目标不落 URL，路径段=实例真随机 token） ── */}
          <div style={card({})}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
              <span style={accentBar("#38bdf8")} />
              <span style={{ fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.monitorPlay} />RDP-on-web</span>
              <span style={chip((rdpInsts[0] || {}).web ? C.ok : C.dim, (rdpInsts[0] || {}).web ? "rgba(34,197,94,0.12)" : undefined)}>{(rdpInsts[0] || {}).web ? <Ic size={11} paths={ICONS.check} /> : <Ic size={11} paths={ICONS.x} />} Web</span>
              <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                <ConnForm trigger="▶ 启动 (host:port)" defaultHost="127.0.0.1" defaultPort="3389" busy={busy} onStart={startRdp} />
                <button style={btn()} onClick={() => rdpAction("stop")} disabled={busy}>■ 停默认</button>
              </span>
            </div>
            {rdpInsts.length === 0 ? <div style={{ fontSize: 11, color: C.dim, padding: "6px 0" }}>无实例（点「▶ 启动」填 RDP 目标 host:port，如 127.0.0.1:3390）</div> :
              rdpInsts.map((inst: any) => (
                <div key={inst.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid " + C.border, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: inst.id === "default" ? "#38bdf8" : C.text, fontFamily: C.mono }}>{inst.id === "default" ? "default" : inst.id}</span>
                  {inst.sys ? <span style={chip(C.warn)}>{"系统:" + inst.sys.port}</span> : <span style={chip(C.muted)}>{inst.host + ":" + inst.port}</span>}
                  <span style={chip(inst.web ? C.ok : C.warn, inst.web ? "rgba(34,197,94,0.10)" : "rgba(245,158,11,0.14)")}>{inst.web ? "Web :" + inst.webPort : "断开 :" + inst.webPort}</span>
                  <span style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
                    {/* 断开（bridge 进程没了）不再禁用：点击先按原参数重建 bridge 再打开——禁用无反馈是「点了没反应」的体验黑洞 */}
                    <button style={btn()} onClick={async () => {
                      if (!inst.web) {
                        await withBusy("rdp", async () => {
                          const r = await fetch(apiUrl("/api/extensions/aiti-ui-env/rdp"), {
                            method: "POST", headers: { "content-type": "application/json" },
                            body: JSON.stringify({ action: "start", id: inst.id, host: inst.host, port: inst.port, sysPort: inst.sys ? inst.sys.port : undefined, sysLabel: inst.sys ? inst.sys.label : undefined }),
                          });
                          if (!r.ok) throw new Error("HTTP " + r.status);
                          await refresh();
                        });
                      }
                      openViewSafe(buildRdpUrl, inst.id).catch(() => {});
                    }} disabled={busy}>{inst.web ? "打开" : "重连打开"}</button>
                    <button style={btn()} onClick={() => { buildRdpUrl(inst.id).then((u) => copyText(u)).catch(() => setErr("会话建立失败")); }}>复制</button>
                    {inst.id !== "default" ? <button style={btn()} onClick={() => rdpAction("stop", inst.id)} disabled={busy}>停止</button> : null}
                  </span>
                </div>
              ))}
            <div style={{ marginTop: 8, fontSize: 10.5, color: C.dim, lineHeight: 1.6 }}>
              {"RDP 经 grdpwasm WASM 客户端（浏览器 WebCodecs H.264 解码）桥接。目标 host:port 不落 URL——路径段是实例真随机 token（代表该实例/端口，定期轮换）。"}
              {"打开前先点本卡「打开/复制」建立 30min HttpOnly cookie 会话；复制到别处无 cookie 打不开（防泄露）"}
            </div>
          </div>

          {/* ── 环境预览 ── */}
          <div style={card({})}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span style={accentBar(C.warn)} />
              <span style={{ fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.flask} />环境裁决预览</span>
              <button style={{ ...btn(), marginLeft: "auto" }} onClick={loadPreview}>运行 resolve</button>
            </div>
            {preview ? (
              preview.ok || preview.error === undefined ? (
                <div style={{ marginTop: 9 }}>
                  <div style={{ fontSize: 11, color: C.dim, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={dot(C.accent)} />
                    target: <b style={{ color: "#a5b4fc" }}>{preview.target}</b>
                    {"· " + preview.rationale}
                    {preview.warnings?.length ? <span style={{ color: C.warn }}><Ic size={11} paths={ICONS.alert} /> {" "}{preview.warnings.join("；")}</span> : null}
                  </div>
                  <pre style={{
                    fontSize: 10.5, fontFamily: C.mono, background: C.panel2, padding: "9px 11px",
                    borderRadius: 7, overflow: "auto", maxHeight: 170, marginTop: 7, lineHeight: 1.55, color: C.muted,
                  }}>{(preview.exportLines || []).join("\n") || "（无输出）"}</pre>
                </div>
              ) : (
                <div style={{ marginTop: 9, fontSize: 11, color: C.bad }}>{"error: " + (preview.error || "resolve 失败") + (preview.hint ? " · " + preview.hint : "")}</div>
              )
            ) : null}
          </div>

          {/* ── 安装状态 ── */}
          <div style={card({ marginBottom: 0 })}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 9 }}>
              <span style={accentBar(C.muted)} />
              <span style={{ fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICONS.wrench} />组件安装状态</span>
              <span style={{ marginLeft: "auto", fontSize: 10.5, color: C.dim }}>{"OS: " + (install.os || "?")}</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
              {Object.entries(install.tools || {}).map(([k, v]: [string, any]) => (
                <span key={k} style={chip(v ? C.ok : C.bad, v ? "rgba(34,197,94,0.10)" : "rgba(239,68,68,0.10)")}>{v ? <Ic size={11} paths={ICONS.check} /> : <Ic size={11} paths={ICONS.x} />}{k}</span>
              ))}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
              {Object.entries(install.units || {}).map(([k, v]: [string, any]) => (
                <span key={k} style={chip(
                  v === "active" ? C.ok : (v === "missing" ? C.dim : C.bad),
                  v === "active" ? "rgba(34,197,94,0.10)" : undefined,
                )}>{k + ": " + v}</span>
              ))}
            </div>
            <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.6, marginTop: 6 }}>
              {install.os === "windows"
                ? "Windows：依赖自检可自动安装便携 UltraVNC（免管理员）；虚拟显示驱动可选装（IddSampleDriver/usbmmidd，需管理员一次）；Home 版无 RDP 服务端（被看用 VNC）。"
                : install.os === "macos"
                  ? "macOS：核心 = Aqua 会话 + 屏幕共享 VNC（系统设置 → 通用 → 共享 → 屏幕共享；免密 sudo 时「启动虚拟屏」可自动开）；可选增强走 brew（cliclick/XQuartz）。"
                  : "安装：scripts/linux/setup-linux.sh（apt + justget 兜底）· 服务化：install-service.sh · Windows：setup-windows.ps1 · macOS：scripts/macos/setup-macos.sh"}
            </div>
            {/* ── 依赖自检 + 自动安装（多 OS） ── */}
            {deps ? (
              <div style={{ borderTop: "1px solid " + C.border, marginTop: 9, paddingTop: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={dot(deps.allInstalled ? C.ok : C.warn)} />
                  <span style={{ fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}><Ic size={11} paths={ICONS.check} />依赖自检</span>
                  <button style={{ ...btn(), marginLeft: "auto" }} onClick={loadDeps} disabled={busy}>重新自检</button>
                </div>
                <div style={{ fontSize: 10, color: C.dim, marginBottom: 6 }}>
                  {(deps.distro || "?") + " · 包管理器 " + (deps.pkgMgr || "无") + (deps.sudo ? " · 有 sudo" : " · 无免密 sudo")}
                </div>
                {deps.allInstalled ? (
                  <div style={{ fontSize: 10.5, color: C.ok, marginBottom: 4 }}>全部组件已就绪 ✓</div>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
                    {(deps.coreMissing || []).map((i: any) => <span key={"c-" + i.bin} style={chip(C.bad, "rgba(239,68,68,0.10)")}><Ic size={10} paths={ICONS.x} />{i.label}（必需）</span>)}
                    {(deps.uiMissing || []).map((i: any) => <span key={"u-" + i.bin} style={chip(C.warn)}><Ic size={10} paths={ICONS.x} />{i.label}（可选）</span>)}
                  </div>
                )}
                {!deps.allInstalled && ((deps.sudo && deps.pkgMgr) || deps.os === "windows" || deps.os === "macos") ? (
                  <button onClick={installDepsBtn} disabled={busy}
                    style={{ ...btn({ color: "#a5b4fc", border: "1px solid rgba(99,102,241,0.4)", background: "rgba(99,102,241,0.12)" }), cursor: busy ? "wait" : "pointer" }}>
                    {busy ? "安装中…（可能需 1-3 分钟）" : "▶ 自动安装缺失组件"}
                  </button>
                ) : null}
                {(deps.manualHints || []).length ? (
                  <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.5, marginTop: 5 }}>
                    {deps.manualHints.map((ht: string, i: number) => <div key={i} style={{ marginTop: 2 }}>{"· " + ht}</div>)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

        </div>
    </>
  );
  // dock v3 分面：float = 遮罩+浮窗壳（保守无 default）；dock = 右栏 tab
  if (floating) {
    return (
      <div onClick={() => setPanelOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div onClick={(e) => e.stopPropagation()}
          data-ext-float="1" data-ext-float-key={UIENV_KEY} data-ext-float-dock="right-panel" data-ext-float-full="1" /* aiti-float 接管拖拽/缩放/持久化 + 小屏自动全屏 */
          style={{
            width: 780, maxWidth: "calc(100vw - 16px)", height: "min(720px, 86vh)", borderRadius: 12,
            background: C.panel, border: "1px solid " + C.border, display: "flex", flexDirection: "column",
            boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden", fontSize: 13, color: C.text,
          }}>
          {uienvContent}
        </div>
      </div>
    );
  }
  return (
    <DockBody itemKey={UIENV_KEY} zone="right-panel" title={t("uiEnv.title")} chrome="tab" zones={["right-panel"]}>
      <div style={{ width: "100%", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: C.panel, color: C.text, overflow: "hidden", fontSize: 13 }}>
        {uienvContent}
      </div>
    </DockBody>
  );
}

function envCard(title: any, info: any, available: boolean, rows: [string, unknown, string?][], extra?: any) {
  const statusColor = available ? C.ok : C.bad;
  return (
    <div style={{ ...card({ marginBottom: 0 }), display: "flex", flexDirection: "column" } as Record<string, unknown>}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }} title={info.error || ""}>
        <span style={dot(statusColor)} />
        <span style={{ fontSize: 12, fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        <span style={{ ...chip(statusColor, undefined), marginLeft: "auto" }}>{available ? "可用" : "不可用"}</span>
      </div>
      {info.error ? <div style={{ fontSize: 10, color: C.warn, marginBottom: 5, lineHeight: 1.5 }}><Ic size={11} paths={ICONS.alert} /> {" "}{info.error}</div> : null}
      {rows.map(([k, v, vColor]) => (
        <div key={k} style={rowStyle}>
          <span style={{ fontSize: 10.5, color: C.dim, flexShrink: 0, width: 74, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</span>
          <span style={{ fontSize: 11, color: vColor || C.text, wordBreak: "break-all", lineHeight: 1.4 }}>{String(v ?? "—")}</span>
        </div>
      ))}
      {extra ? <div style={{ marginTop: "auto", paddingTop: 6 }}>{extra}</div> : null}
    </div>
  );
}

/* ── toolbar 按钮：系统标准（AppShell topbarRowBtnStyle：flex 居中 + fixed 36×36 + hover 变色） ── */
export function ToolbarButton() {
  const open = usePanelOpen();
  return (
    <button
      title={t("uiEnv.title")}
      onClick={() => setPanelOpen(!open)}
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
      {/* lucide monitor：显示环境——与系统内建线条图标同风格 */}
      <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect key="r1" width={20} height={14} x={2} y={3} rx={2} />
        <line key="l1" x1={8} y1={21} x2={16} y2={21} />
        <line key="l2" x1={12} y1={17} x2={12} y2={21} />
      </svg>
    </button>
  );
}

export function UiEnvDialog() {
  return <Dialog />;
}
