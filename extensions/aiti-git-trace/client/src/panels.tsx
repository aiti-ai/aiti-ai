/**
 * aiti-git-trace · 重面板层（懒加载 chunk，薄壳拆分 2026-09-13）
 *
 * 只有用户真的打开关注路径/时间线，或 forkGate 需要回撤对话框时，才由 trace-app.tsx
 * （薄壳）动态 import 本模块——开页不再代价（服务端批量包外置本 chunk）。
 * 依赖方向：panels → common（严禁 common/shell 反向静态 import 本文件）。
 */
import { useState, useEffect, useRef, apiUrl, t, extSvc, appendText, openFile } from "./host-shim";
import { buildAtText, openNewSessionWithExtSvc } from "../../../_shared/new-session-cwd.ts";
import { buildVersionMention, resolveDiffLineInfo } from "./version-mention.ts";
import {
  DockBody, isSidebarDockState, sidebarZoneOf,
  useDockCommands, useDockHeaderState, useDockHeaderStateOf, requestDockCommand,
} from "../../../_shared/ext-float-dock";
import type { DockHeaderAction } from "../../../_shared/ext-float-dock";
import {
  apiGet, apiPost, bindSession, getSessionId, getCwd, useOpenKind, openPanel,
  TIMELINE_KEY, WATCH_KEY,
  panelStyle, btnStyle, chipStyle, inputStyle, scrollLayerStyle, badgeStyle, fmtTime,
} from "./common";

function RefreshSvg() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

// ---------- 关注路径面板（§7.2） ----------

interface WatchPath { path: string; origin: string; repoRoot: string | null; addedAt: number }

// dock v3：两面注册（dialogs 浮窗 / sidebarExplorerDock 左栏）；face 参数保证只有激活面渲染+加载
export function WatchPanelSlot(props?: any): any { return renderWatch(props, "float"); }
export function WatchDockLeft(props?: any): any { return renderWatch(props, "left"); }
export function WatchDockRight(props?: any): any { return renderWatch(props, "right"); }

function renderWatch(props?: any, face?: string): any { bindSession(props);
  const [, setOpen, st] = useOpenKind("watch");
  // face 激活判定（同 renderTimeline）：float=浮窗态；left=docked:sidebar-explorer
  // 三面（本批 P2）：float=浮窗 / right=右栏 tab / left=左栏区块（sidebar 族任意落位）
  const open = face === "float" ? st === "floating"
    : face === "right" ? st === "docked:right-panel"
    : isSidebarDockState(st);
  const [cwd, setCwd] = useState(getCwd());
  const [key, setKey] = useState("");
  const [config, setConfig] = useState<any>(null);
  const [nogit, setNogit] = useState(false);
  const [loose, setLoose] = useState<{ allowed: boolean; reason: string } | null>(null);
  const [addPath, setAddPath] = useState("");
  const [persist, setPersist] = useState(true);
  const [msg, setMsg] = useState("");
  const [cleanupArm, setCleanupArm] = useState(false);
  const [wsRoot, setWsRoot] = useState("");
  const [sessionStores, setSessionStores] = useState<any[] | null>(null); // 本会话识别的 git 仓（§7.2 session 级）

  async function resolve(cwdArg?: string) {
    const c = (cwdArg ?? cwd).trim();
    if (!c) { setMsg("cwd?"); return; }
    const r = await apiPost("/workspace/resolve", { cwd: c, session: getSessionId() || undefined });
    if (!r.ok) { setMsg(r.error || "resolve failed"); return; }
    setKey(r.key); setConfig(r.config); setNogit(!!r.nogit); setLoose(r.loose || null); setWsRoot(r.repoRoot || c); setSessionStores(r.sessionStores || []); setMsg("");
  }
  // 每次打开都自动 resolve：cwd 空时取宿主当前会话 cwd / 注册时 cwd（不再一次性闩锁——那会导致面板永远空白）
  useEffect(() => {
    if (!open) return;
    let c = cwd.trim();
    if (!c) {
      const host = SVC_SESSION?.cwd || CURRENT_SESSION?.cwd || "";
      if (host) { setCwd(host); c = host; }
    }
    if (c) resolve(c);
    else setMsg(t("gt.watch.needCwd"));
  }, [open, props?.currentSession?.id]);

  async function save(next: any) {
    if (!key) return;
    const r = await apiPost("/workspace", { key, ...next });
    if (r.ok) { setConfig(r.config); setMsg(t("gt.watch.saved")); setTimeout(() => setMsg(""), 1500); }
  }
  async function addWatchPath() {
    const p = addPath.trim();
    if (!p || !config) return;
    const r = await apiPost("/watch/resolve", { path: p });
    const entry: WatchPath = {
      path: r.path || p, origin: "user", repoRoot: r.repoRoot || (r.nested && r.nested[0]) || null, addedAt: Date.now(),
    };
    const paths = [...(config.paths || []).filter((x: WatchPath) => x.path !== entry.path), entry];
    setAddPath("");
    await save({ autoDiscover: config.autoDiscover, paths });
  }
  async function delPath(p: string) {
    if (!config) return;
    await save({ autoDiscover: config.autoDiscover, paths: (config.paths || []).filter((x: WatchPath) => x.path !== p) });
  }
  async function toggleAuto() {
    if (!config) return;
    await save({ enabled: config.enabled !== false, autoDiscover: !config.autoDiscover, paths: config.paths || [] });
  }
  // 本工作区文件变更追踪总开关（enabled=false → 引擎彻底不追踪；实时生效，见 gt.watch.traceOffHint）
  async function toggleTrace() {
    if (!config) return;
    await save({ enabled: config.enabled === false, autoDiscover: config.autoDiscover, paths: config.paths || [] });
  }

  // workspace 深清理：删除本工作区全部会话台账 + 追踪仓（运行中会话引擎自愈重建空仓）
  async function doCleanup() {
    if (!wsRoot) return;
    const r = await apiPost("/cleanup", { scope: "workspace", root: wsRoot });
    setCleanupArm(false);
    setMsg(r.ok ? t("gt.watch.cleanupDone") + ` (${t("gt.watch.cleanupSessions")}: ${r.sessions}${r.storeRemoved ? " · " + t("gt.watch.cleanupStore") : ""})` : (r.error || "cleanup failed"));
    resolve();
  }

  // dock 头工具条 v3：仅左栏区块 face 注册命令（刷新 = 重新解析工作区配置）
  const watchDockKey = face === "left" ? WATCH_KEY : undefined;
  const hsWatch = useDockHeaderStateOf(WATCH_KEY);
  useDockCommands(watchDockKey, watchDockKey ? { refresh: () => { void resolve(); } } : null);
  useDockHeaderState(watchDockKey, watchDockKey ? { cwd } : null);

  if (!open) return null;
  const watchFloating = st === "floating";
  const watchContent = (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        {watchFloating && <b>⎇ {t("gt.watch.title")}</b>}
        {watchFloating && <button title={t("gt.common.close")} onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px" }}>×</button>}
      </div>
      <div style={scrollLayerStyle}>
      {nogit && loose?.allowed ? (
        <div style={{ border: "1px solid #2da44e", color: "#1a7f37", background: "var(--bg-subtle)", borderRadius: 6, padding: "6px 10px", marginBottom: 8 }}>
          ⏣ {t("gt.watch.loose")}
        </div>
      ) : nogit ? (
        <div style={{ border: "1px solid #d4a72c", color: "#9a6700", background: "var(--bg-subtle)", borderRadius: 6, padding: "6px 10px", marginBottom: 8 }}>
          ⚠ {loose?.reason === "no-git-oversize" ? t("gt.watch.oversize") : loose?.reason === "no-git-denylist" ? t("gt.watch.denied") : t("gt.watch.nogit")}
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <input style={inputStyle} value={cwd} onChange={(e: any) => setCwd(e.target.value)} placeholder="cwd…" />
        <button style={btnStyle} onClick={resolve}>resolve</button>
      </div>
      {config ? (
        <div>
          <label title={t("gt.watch.traceOffHint")} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, fontWeight: 600 }}>
            <input type="checkbox" checked={config.enabled !== false} onChange={toggleTrace} />
            <span>{t("gt.watch.traceEnabled")}</span>
          </label>
          {config.enabled === false && (
            <div style={{ border: "1px solid #d4a72c", color: "#9a6700", background: "var(--bg-subtle)", borderRadius: 6, padding: "6px 10px", marginBottom: 8 }}>
              ⏸ {t("gt.watch.traceOff")}
            </div>
          )}
          <div style={{ border: "1px dashed var(--border)", opacity: 0.75, borderRadius: 6, padding: "6px 10px", marginBottom: 8, fontSize: 12 }}>
            {t("gt.watch.experimental")}
          </div>
          <label style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
            <input type="checkbox" checked={!!config.autoDiscover} onChange={toggleAuto} />
            <span>{t("gt.watch.auto")}</span>
          </label>
          {(sessionStores || []).length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10.5, opacity: 0.7, marginBottom: 4 }}>{t("gt.watch.sessionRepos")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {sessionStores.map((x: any) => {
                  const pinned = (config.paths || []).some((p: WatchPath) => p.repoRoot === x.root || p.path === x.root);
                  return (
                    <div key={x.root} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                      <span style={{ ...badgeStyle("cross"), cursor: "default", marginLeft: 0 }}>{x.role === "primary" ? t("gt.watch.rolePrimary") : t("gt.watch.roleSecondary")}</span>
                      <span style={{ fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }} title={x.root}>{String(x.root).split("/").pop()}</span>
                      {pinned ? (
                        <span style={{ fontSize: 10.5, opacity: 0.6 }}>{t("gt.watch.pinned")}</span>
                      ) : (
                        <button style={{ ...btnStyle, padding: "2px 8px", fontSize: 11 }} title={t("gt.watch.pinTip")} onClick={() => {
                          const entry: WatchPath = { path: x.root, origin: "user", repoRoot: x.root, addedAt: Date.now() };
                          save({ enabled: config.enabled !== false, autoDiscover: config.autoDiscover, paths: [...(config.paths || []), entry] });
                        }}>+ {t("gt.watch.pin")}</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input style={inputStyle} value={addPath} onChange={(e: any) => setAddPath(e.target.value)}
              placeholder={t("gt.watch.placeholder")} />
            <button style={btnStyle} onClick={addWatchPath}>{t("gt.watch.add")}</button>
          </div>
          {(config.paths || []).length === 0 ? <div style={{ opacity: 0.7 }}>{t("gt.watch.empty")}</div> : null}
          <div style={{ borderTop: "1px solid var(--border,#eee)", paddingTop: 8, marginTop: 4 }}>
            {!cleanupArm ? (
              <button style={{ ...btnStyle, color: "#c62828", borderColor: "rgba(198,40,40,.5)" }} title={t("gt.watch.cleanupTip")} onClick={() => setCleanupArm(true)}>{t("gt.watch.cleanup")}</button>
            ) : (
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#c62828" }}>{t("gt.watch.cleanupConfirm")}</span>
                <button style={{ ...btnStyle, color: "#fff", background: "#c62828", borderColor: "#c62828" }} onClick={doCleanup}>{t("gt.common.confirm")}</button>
                <button style={btnStyle} onClick={() => setCleanupArm(false)}>{t("gt.common.cancel")}</button>
              </div>
            )}
            <div style={{ fontSize: 10.5, opacity: 0.7, marginTop: 4 }}>{t("gt.watch.cleanupTip")}</div>
          </div>
          {(config.paths || []).length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ opacity: 0.7, textAlign: "left" }}>
                <th style={thTd}>{t("gt.watch.origin")}</th><th style={thTd}>{t("gt.watch.repo")}</th><th style={thTd}></th>
              </tr></thead>
              <tbody>
                {(config.paths || []).map((p: WatchPath) => (
                  <tr key={p.path}>
                    <td style={{ ...thTd, wordBreak: "break-all" }}>
                      {p.path} <span style={{ opacity: 0.6 }}>[{p.origin}]</span>
                      {!p.repoRoot ? <span style={badgeStyle("nongit")}>{t("gt.watch.nongit")}</span> : null}
                    </td>
                    <td style={{ ...thTd, opacity: 0.75, whiteSpace: "nowrap" }}>{p.repoRoot ? "✓" : "—"}</td>
                    <td style={thTd}><button style={btnStyle} onClick={() => delPath(p.path)}>{t("gt.watch.del")}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {msg ? <div style={{ marginTop: 6, color: "#1a7f37" }}>{msg}</div> : null}
          <div style={{ marginTop: 8, opacity: 0.65, fontSize: 11 }}>key = {key || "—"}</div>
        </div>
      ) : <div style={{ opacity: 0.7 }}>resolve cwd → …</div>}
      </div>
    </>
  );
  // dock v3 分面：floating = 浮窗壳（仅左栏可选、无 default）；docked:sidebar-explorer = 左栏 section
  if (watchFloating) {
    return (
      <div style={{ ...panelStyle, zIndex: 10060 }} data-ext-float="1" data-ext-float-full="1" data-ext-float-w={460} data-ext-float-h={640} data-ext-float-key={WATCH_KEY} data-ext-float-dock={`${sidebarZoneOf(WATCH_KEY)} right-panel`} data-ext-float-dock-default={sidebarZoneOf(WATCH_KEY)}>
        {watchContent}
      </div>
    );
  }
  const watchZones: any[] = [sidebarZoneOf(WATCH_KEY), "right-panel"];
  const watchInner = (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", color: "var(--text)", fontSize: 12, padding: "8px 10px", boxSizing: "border-box" }}>
      {watchContent}
    </div>
  );
  // 右栏 tab face（chrome="tab"：无头行）
  if (face === "right") {
    return (
      <DockBody itemKey={WATCH_KEY} zone="right-panel" title="关注路径" chrome="tab"
        zones={watchZones} defaultZone={sidebarZoneOf(WATCH_KEY)}>{watchInner}</DockBody>
    );
  }
  const watchActions: DockHeaderAction[] = [
    { id: "refresh", title: t("gt.common.refresh") || "刷新", icon: <RefreshSvg/>, visibility: "always", onClick: () => { requestDockCommand(WATCH_KEY, "refresh"); } },
  ];
  return (
    <DockBody itemKey={WATCH_KEY} title="关注路径" chrome="section" kind="dockable"
      zones={watchZones} defaultZone={sidebarZoneOf(WATCH_KEY)}
      headerActions={watchActions}>
      {watchInner}
    </DockBody>
  );
}
const thTd: any = { padding: "4px 6px", borderBottom: "1px solid var(--border)", textAlign: "left", verticalAlign: "top" };

// ---------- ops 时间线（§8.2） ---------- -->

/** [P1-6 链④] 单文件过滤匹配：绝对路径相等，或相对路径后缀命中（root 拼接比对） */
function fileMatches(e: any, filter: string): boolean {
  const f = String(filter || "");
  if (!f) return true;
  if (e.root && (e.root + "/" + e.path) === f) return true;
  return ("/" + e.path).endsWith("/" + f) || f.endsWith("/" + e.path);
}

// ---------- 文件行操作按钮组（对齐 aiti-doc-center 详情操作范式 §1） ----------
const actBtnStyle = {
  display: "inline-flex", alignItems: "center", gap: 3,
  padding: "2px 8px", borderRadius: 6, fontSize: 10.5,
  cursor: "pointer", border: "1px solid var(--border)",
  background: "transparent", color: "var(--text-muted)",
};
/** 打开按钮高亮（主操作：蓝色背景白字，与 statusColor R/C 同 #0969da） */
const openBtnStyle = { ...actBtnStyle, background: "#0969da", color: "#fff", borderColor: "#0969da" };
/** @ 提及文本：cwd 相对路径（与 doc-center docAtText 同源 buildAtText）。
 *  path 绝对则原样；相对则拼 root。 */
function atTextFor(root: string, path: string): string {
  const p = String(path || "");
  const abs = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) ? p : String(root || "").replace(/\/+$/, "") + "/" + p;
  const cwd = String(getCwd() || "");
  const shown = cwd && abs.startsWith(cwd) ? abs.slice(cwd.length).replace(/^[/\\]+/, "") : abs;
  return buildAtText(shown);
}
/** 复制路径 + 按钮临时反馈（文案「✓ 已复制」1.2s 后恢复；DOM 直改，免 per-row state） */
function copyWithFeedback(text: string, btn: any): void {
  try { navigator.clipboard.writeText(text); } catch { /* ignore */ }
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = "✓ " + t("gt.timeline.copied");
  btn.style.color = "#1a7f37";
  setTimeout(() => { try { btn.textContent = orig; btn.style.color = ""; } catch { /* ignore */ } }, 1200);
}
/** 文件级 @ 到新会话（带版本附文：base..target + 边路仓 show 命令；§3） */
async function atNewSessionFile(f: any, st: any): Promise<void> {
  const text = buildVersionMention({
    path: String(f.path || ""), root: String(f.root || ""),
    base: st?.base || null, target: st?.target || null,
  });
  const abs = String(f.root || "").replace(/\/+$/, "") + "/" + f.path;
  try {
    await openNewSessionWithExtSvc({
      text, targetDir: String(f.root || ""), targetPath: abs,
      currentCwd: getCwd(), apiUrl, extSvc,
    });
  } catch { /* 新会话派发失败不阻塞 */ }
}
/** leaks（外溢）行级 @ 到新会话：无边路 commit，纯路径 @ + 工作区版本附文（§3 无 target 回退） */
async function atNewSessionLeak(l: any): Promise<void> {
  const text = buildVersionMention({ path: String(l.path || ""), root: "" });
  const dir = String(l.path || "").replace(/[/\\][^/\\]+$/, "") || "/";
  try {
    await openNewSessionWithExtSvc({
      text, targetDir: dir, targetPath: String(l.path || ""),
      currentCwd: getCwd(), apiUrl, extSvc,
    });
  } catch { /* 新会话派发失败不阻塞 */ }
}

// ---------- 变更总览（overview 方案 §2/§4：视图迁移 + MiniDiff + 单文件 diff 拉取） ----------

/** 视图状态 v2（§4.2）：旧 key 一次性迁移（tree 保留；file/msg → overview，按文件 tab 已退役 Y4） */
const VIEW_KEY = "aiti-git-trace.timeline.view2";
const VIEW_OLD_KEY = "aiti-git-trace.timeline.view";
function loadInitialView(): string {
  try {
    const v2 = localStorage.getItem(VIEW_KEY);
    if (v2 === "overview" || v2 === "msg" || v2 === "tree") return v2;
    const old = localStorage.getItem(VIEW_OLD_KEY);
    if (old === "tree") { localStorage.setItem(VIEW_KEY, "tree"); return "tree"; }
    if (old === "msg" || old === "file") { localStorage.setItem(VIEW_KEY, "overview"); return "overview"; }
  } catch { /* ignore */ }
  return "overview";
}

const repoBase = (root: string) => { const parts = String(root || "").split("/").filter(Boolean); return parts.length ? parts[parts.length - 1] : String(root || ""); };
const fmtN = (n: any) => Number(n || 0).toLocaleString();
const statusColor = (s: string) => (s === "A" ? "#1a7f37" : s === "D" ? "#cf222e" : (s === "R" || s === "C") ? "#0969da" : "#9a6700");

/** 轻量 unified diff 渲染器（§4.4）：hunk 头灰条 / + 绿底 / − 红底 / 上下文淡色；
 *  max-height 320px 内滚动；增量渲染（Y2）：初渲染 400 行，「显示更多」每批 +400（服务端截断线 2000 行）。 */
function MiniDiff(props: { text: string; truncated: boolean; total?: number; onOpenReview?: () => void;
  root?: string; base?: string | null; target?: string | null; path?: string }): any {
  const [limit, setLimit] = useState(400);
  const lines = String(props.text || "").split("\n");
  const shown = lines.slice(0, limit);
  const rowStyle = (ln: string): any =>
    ln.startsWith("@@") ? { color: "var(--text-dim)", background: "var(--bg-subtle)" }
      : ln.startsWith("+") ? { color: "#1a7f37", background: "rgba(46,160,67,.13)" }
      : ln.startsWith("-") ? { color: "#cf222e", background: "rgba(207,34,46,.10)" }
      : { color: "var(--text-muted)" };
  // 行级 @ 到新会话（§3）：resolveDiffLineInfo 算行号 + buildVersionMention 带边路仓 git 命令
  const canMention = !!(props.root && props.path);
  const onRowMention = (i: number): void => {
    if (!canMention) return;
    const info = resolveDiffLineInfo(lines, i);
    const text = buildVersionMention({
      path: props.path!, root: props.root!,
      base: props.base || null, target: props.target || null,
      line: info.line, lineKind: info.lineKind,
    });
    const abs = String(props.root || "").replace(/\/+$/, "") + "/" + props.path;
    openNewSessionWithExtSvc({
      text, targetDir: props.root!, targetPath: abs,
      currentCwd: getCwd(), apiUrl, extSvc,
    }).catch(() => { /* ignore */ });
  };
  const miniAtBtn = { flexShrink: 0, marginLeft: 4, padding: "0 4px", fontSize: 10, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", borderRadius: 4 } as const;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, marginBottom: 8, overflow: "hidden" }}>
      <div style={{ maxHeight: 320, overflowY: "auto", background: "var(--bg)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, lineHeight: 1.45 }}>
        {shown.map((ln: string, i: number) => (
          <div key={i} style={{ ...rowStyle(ln), padding: "0 8px", display: "flex", alignItems: "center" }}>
            <span style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{ln === "" ? " " : ln}</span>
            {canMention ? <button style={miniAtBtn} title={t("gt.tl.rowMention")} onClick={() => onRowMention(i)}>@</button> : null}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 8px", borderTop: "1px solid var(--border)", fontSize: 11, flexWrap: "wrap" }}>
        {lines.length > limit ? (
          <button style={chipStyle} onClick={() => setLimit((l) => l + 400)}>{t("gt.ov.more")}</button>
        ) : null}
        {props.truncated ? <span style={{ opacity: 0.7 }}>{t("gt.ov.diffTruncated", { n: String(props.total ?? lines.length) })}</span> : null}
        {props.onOpenReview ? <button style={chipStyle} onClick={props.onOpenReview}>{t("gt.ov.openReview")}</button> : null}
      </div>
    </div>
  );
}

/** 单文件区间 diff（§2 展开懒拉 /file-diff；挂载即取，卸载即弃） */
function FileDiffBox(props: { root: string; sid: string; base: string; target: string; path: string; onOpenReview: () => void }): any {
  const [st, setSt] = useState<any>({ loading: true });
  useEffect(() => {
    let dead = false;
    setSt({ loading: true });
    const q = "/file-diff?root=" + encodeURIComponent(props.root)
      + "&session=" + encodeURIComponent(props.sid || "")
      + "&base=" + encodeURIComponent(props.base) + "&target=" + encodeURIComponent(props.target)
      + "&path=" + encodeURIComponent(props.path);
    apiGet(q).then((r: any) => {
      if (dead) return;
      if (r && r.ok) setSt({ loading: false, text: r.text || "", truncated: !!r.truncated, total: r.total || 0 });
      else setSt({ loading: false, error: (r && r.error) || "diff failed" });
    }).catch(() => { if (!dead) setSt({ loading: false, error: "diff failed" }); });
    return () => { dead = true; };
  }, [props.root, props.sid, props.base, props.target, props.path]);
  if (st.loading) return <div style={{ opacity: 0.6, fontSize: 11, padding: "2px 0 6px" }}>{t("gt.ov.loading")}</div>;
  if (st.error) return <div style={{ color: "#cf222e", fontSize: 11, padding: "2px 0 6px" }}>{st.error}</div>;
  if (!String(st.text || "").trim()) return <div style={{ opacity: 0.6, fontSize: 11, padding: "2px 0 6px" }}>{t("gt.ov.noFiles")}</div>;
  return <MiniDiff text={st.text} truncated={st.truncated} total={st.total} onOpenReview={props.onOpenReview} root={props.root} base={props.base} target={props.target} path={props.path} />;
}

// ---------- ops 时间线（§8.2） ----------
// dock v3：同一内容三面注册（dialogs 浮窗 / rightFileDock 右栏 / sidebarExplorerDock 左栏）——
// face 参数保证「只有激活面的实例渲染 + 跑数据加载」，三实例互不重复渲染。

export function TimelineSlot(props?: any): any { return renderTimeline(props, "float"); }
export function TimelineDockRight(props?: any): any { return renderTimeline(props, "right"); }
export function TimelineDockLeft(props?: any): any { return renderTimeline(props, "left"); }

function renderTimeline(props?: any, face?: string): any { bindSession(props);
  const [sessionId, setSessionId] = useState<string>(() => getSessionId());
  // 统一会话服务 active / 宿主 currentSession 晚到：挂载早期 sessionId 为空时补全
  //（去 URL 兑底后初始值可能为空；props 下发与 active 同步）。
  const hostSid = props?.currentSession?.id || "";
  useEffect(() => {
    if (!sessionId && hostSid) setSessionId(hostSid);
  }, [hostSid, sessionId]);
  const [ops, setOps] = useState<any[] | null>(null);
  const [showAll, setShowAll] = useState<boolean>(() => { try { return localStorage.getItem("aiti-git-trace.timeline.showAll") === "1"; } catch { return false; } });
  // 视图模式 v2（§4.2）：overview = 变更总览（新默认）；msg = 按操作；tree = 家谱。
  // 旧 key 一次性迁移（tree 保留，file/msg → overview）；「按文件」tab 已退役（Y4，总览展开区全覆盖）。
  const [view, setView] = useState<string>(loadInitialView);
  const [lineage, setLineage] = useState<any | null>(null); // 家谱（§3.3）：ancestors/self/descendants
  const [expandedFiles, setExpandedFiles] = useState<string[]>([]); // 总览展开行（root\u0000path）
  // 变更总览（§2）：/files 聚合数据 + 轮次过滤（entryIds）+ 手动刷新 tick + 外部自动展开钩子（场景 7）
  const [filesData, setFilesData] = useState<any | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [turnFilter, setTurnFilter] = useState(""); // userEntryId（徽标入口自动定位到该轮，场景 3）
  const [filesTick, setFilesTick] = useState(0); // 手动刷新 / SSE debounce / 回撤后强制重拉 /files
  const [ovRbOpen, setOvRbOpen] = useState(false); // 总览「↩ 回撤记录」折叠条
  const autoExpandRef = useRef<string | null>(null);
  const [selGroups, setSelGroups] = useState<string[]>([]); // 勾选参与跨组评审的 prompt（范围 = 最小~最大组）
  const [wsSessions, setWsSessions] = useState<any[]>([]); // 当前 workspace 全部会话（与左侧列表同源 /api/sessions）
  const [cleanArm, setCleanArm] = useState<null | { beforeOp?: number }>(null); // 清理确认态（§15）
  const [fileFilter, setFileFilter] = useState<string | null>(null); // [P1-6 链④] 单文件过滤（绝对路径或相对路径后缀匹配）
  const [planRel, setPlanRel] = useState<string | null>(null); // [P1-3 意图维 join] 本会话方案绑定（services.plans）
  const externalOpenRef = useRef(false); // [P1-6] 外部指定会话打开：抑制一次宿主会话重同步
  const [, setOpen, st] = useOpenKind("timeline", (d) => {
    if (d?.sessionId) { setSessionId(d.sessionId); externalOpenRef.current = true; }
    // 场景 3：消息徽标带 entryId → 总览自动过滤到该轮（§5 入口映射）
    if (d?.entryId) setTurnFilter(String(d.entryId));
    // 场景 7（Y4 兼容映射）：core FileViewer 的 view:"file" → 总览 + 单文件过滤 + 自动展开（core 零改动）
    if (d?.view === "file") {
      setView("overview");
      try { localStorage.setItem(VIEW_KEY, "overview"); } catch { /* ignore */ }
    }
    if (d?.file != null) { setFileFilter(String(d.file)); autoExpandRef.current = String(d.file); }
  });
  // face 激活判定：只有激活面的实例渲染/加载数据（dialogs=浮窗态；right/left=对应停靠态）
  const open = face === "float" ? st === "floating"
    : face === "right" ? st === "docked:right-panel"
    : face === "left" ? isSidebarDockState(st) : false;

  async function load(sid?: string) {    const s = sid ?? sessionId ?? getSessionId();
    if (!s) return;
    setSessionId(s);
    const r = await apiGet("/ops?session=" + encodeURIComponent(s));
    if (r.ok) { setOps(r.ops || []); setSelGroups([]); setPlanRel(r.plan?.planRel ?? null); }
  }

  // 当前 workspace 全部会话（与左侧列表同源）：以当前会话 projectKey 归组，modified 倒序
  useEffect(() => {
    if (!open) return;
    let dead = false;
    fetch(apiUrl("/api/sessions")).then((r) => r.json()).then((d) => {
      if (dead) return;
      const all = (d && d.sessions) || [];
      const curId = SVC_SESSION?.id || CURRENT_SESSION?.id || sessionId;
      const cur = all.find((x: any) => x.id === curId);
      const pk = cur?.projectKey;
      const cwd = cur?.cwd || SVC_SESSION?.cwd || CURRENT_SESSION?.cwd || "";
      const list = all
        .filter((x: any) => (pk ? x.projectKey === pk : cwd ? (x.cwd || "").startsWith(cwd) : true))
        .sort((a: any, b: any) => (b.modified || 0) - (a.modified || 0));
      setWsSessions(list);
      // 欢迎页（宿主无 currentSession）：自动落到 workspace 最近一个会话
      if (!sessionId && list.length) { setSessionId(list[0].id); load(list[0].id); }
    }).catch(() => {});
    return () => { dead = true; };
  }, [open, sessionId]);
  const sessName = (x: any) => x.name || x.firstMessage || x.id.slice(0, 8);
  // 家谱数据：进 tree 视图 / 切会话时拉取（parent 链聚合，服务端 lineage）
  useEffect(() => {
    if (!open || view !== "tree" || !sessionId) return;
    let dead = false;
    apiGet("/lineage?session=" + encodeURIComponent(sessionId)).then((r: any) => {
      if (!dead && r && r.ok) setLineage(r);
    }).catch(() => {});
    return () => { dead = true; };
  }, [open, view, sessionId]);

  // 变更总览数据（§2/§3.1）：/files 聚合（轮次过滤 = entryIds，切换重算一次）；只读端点
  useEffect(() => {
    if (!open || view !== "overview" || !sessionId) return;
    let dead = false;
    setFilesLoading(true);
    const q = "/files?session=" + encodeURIComponent(sessionId) + (turnFilter ? "&entryIds=" + encodeURIComponent(turnFilter) : "");
    apiGet(q).then((r: any) => {
      if (dead) return;
      const ok = r && r.ok ? r : null;
      setFilesData(ok);
      setFilesLoading(false);
      // 场景 7：外部单文件过滤（view:"file" 映射）→ 自动展开命中文件
      const f = autoExpandRef.current;
      if (f && ok && Array.isArray(ok.files)) {
        const hit = ok.files.find((x: any) => fileMatches(x, f));
        if (hit) {
          const key = hit.root + "\u0000" + hit.path;
          setExpandedFiles((s) => (s.includes(key) ? s : [...s, key]));
        }
        autoExpandRef.current = null;
      }
    }).catch(() => { if (!dead) { setFilesData(null); setFilesLoading(false); } });
    return () => { dead = true; };
  }, [open, view, sessionId, turnFilter, filesTick]);

  // 实时化（§4.6 + Y1）：面板开着时接 /events SSE，当前会话 op 事件 → 800ms trailing debounce
  // 刷新总览与操作视图（事件驱动非轮询，防 op 事件连爆每事件重跑 git diff）；关面板/卸载/换会话即断开。
  useEffect(() => {
    if (!open || !sessionId) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;
    try {
      es = new EventSource(apiUrl(EXT_API + "/events"));
      es.addEventListener("op", (e: any) => {
        try {
          const d = JSON.parse(String(e?.data || "{}"));
          if (d?.sessionId !== sessionId) return;
        } catch { return; }
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (dead) return;
          load(sessionId);
          setFilesTick((x) => x + 1);
        }, 800);
      });
    } catch { /* EventSource 不可用：仅失实时化，手动刷新不受影响 */ }
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      try { es?.close(); } catch { /* ignore */ }
    };
  }, [open, sessionId]);

  // 每次打开都重同步宿主当前会话并重新加载（旧实现 ops===null 一次性条件导致重开显示上一个会话的旧数据）
  useEffect(() => {
    if (!open) return;
    const sid = getSessionId();
    // [P1-6] 外部指定会话打开（⎇/OPEN_EVENT）：不重同步宿主会话——但仍要加载指定会话
    // （2026-09-08 回归修复：此前直接 return，而所有入口 openPanel("timeline",{sessionId}) 都会置位 ref，
    //  导致打开时间线从不加载，ops 恒 null 面板恒空）
    if (externalOpenRef.current) { externalOpenRef.current = false; load(sessionId || sid); return; }
    if (sid && sid !== sessionId) setSessionId(sid); // 换会话：重同步（不清空 ops——加载完成即整体替换，避免竞态空窗）
    load(sid || sessionId); // 每次打开都加载（旧实现 ops===null 一次性条件导致重开显示上一个会话的旧数据）
  }, [open, props?.currentSession?.id]);

  async function rollbackOp(op: any) {
    // [P2-7] 跨仓 op：与 viewDiff 同款选仓策略——优先「before 窗口内实际有增量」的仓，
    // 退而求其次 before≠after 的仓，最后才 stores[0]（跨仓 op 此前一律回滚首仓，
    // 增量在副仓时按钮「成功」却什么都没回滚）
    const stores = op.stores || [];
    const filesN = (x: any) => (x.files ? x.files.M + x.files.A + x.files.D : 0);
    const store = stores.find((x: any) => x.before && filesN(x) > 0)
      || stores.find((x: any) => x.before && x.after && x.before !== x.after) || stores[0];
    if (!store) return;
    // 逐 op patch 式部分回滚（§6.3/M4-1）：只反应用本 op 的文件变更，不整树 reset——
    // 对共享工作区（并行会话/用户手改）更安全；partial 仓（before=null）不可逆向，提示最早可恢复点
    if (!store.before) { (window as any).alert(t("gt.timeline.partialHint") || "该 op 为首触（无 before），最早可恢复点为其 after 提交"); return; }
    if (!(window as any).confirm(t("gt.timeline.confirm"))) return;
    const r = await apiPost("/rollback-partial", {
      storeRoot: store.root, sessionId,
      base: store.before, target: store.after,
      files: store.paths || [], hunkIdx: [],
    });
    if (r && r.ok) load();
    else (window as any).alert((r && r.error) || "rollback failed");
  }
  // 撤销回撤：对回撤行 stores[].before→after（= safety→记账 commit 的回撤净效果）反向 patch，
  // 恢复到回撤前状态；自身也走 trace 记账（方案 §7：回撤全程双向可逆）。
  async function undoLedgerRollback(store: any) {
    if (!store.before || !store.after) { (window as any).alert(t("gt.timeline.partialHint") || "无可逆基线"); return; }
    if (!(window as any).confirm(t("gt.timeline.confirm"))) return;
    const r = await apiPost("/rollback-reversed", {
      storeRoot: store.root, sessionId,
      refs: [{ op: -1, before: store.before, after: store.after }],
    });
    if (r && r.ok) load();
    else (window as any).alert((r && r.error) || "撤销回撤失败");
  }
  function viewDiff(op: any, store?: any, files?: string[]) {
    // 打开 aiti-git-review 的 trace 任务（§6.2/6.3）：优先全局开启器，未挂载则 URL 深链
    // 跨仓 op：优先选「before 窗口内实际有变更」的仓——before=null 基线仓计数再大也不是增量，且无 base 打不开任务
    const stores = op.stores || [];
    const filesN = (x: any) => (x.files ? x.files.M + x.files.A + x.files.D : 0);
    const s = store || stores.find((x: any) => x.before && filesN(x) > 0)
      || stores.find((x: any) => x.before && x.after && x.before !== x.after) || stores[0];
    if (!s || !s.after) { (window as any).alert(t("gt.timeline.empty")); return; }
    if (!s.before) { (window as any).alert(t("gt.timeline.partialHint")); return; } // 纯基线 op：无 before 可看 diff
    const sid = op.sessionId || sessionId || getSessionId();
    const payload: any = { source: "trace", storeRoot: s.root, sessionId: sid, base: s.before, target: s.after };
    if (files && files.length) payload.files = files;
    const opener = extSvc<(o?: any) => void>("aiti-git-review.open") || (window as any).__aitiGitReviewOpen; // DI 方案 P2 双轨
    if (typeof opener === "function") { opener(payload); return; }
    // git-review 客户端未就绪：URL 深链（其客户端挂载时自动 applyOpen；数组序列化为 JSON）
    const q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(payload)) q.set(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
    location.href = location.pathname + "?" + q.toString();
  }

  // prompt（组）范围评审：keys = 选中 msgSeq 组；范围 = 最小~最大组（含中间连续组，台账分支追加式）
  function groupAnchor(op: any) {
    const stores = op.stores || [];
    return stores.find((x: any) => x.before && x.after && x.before !== x.after) || stores[0] || null;
  }
  function reviewGroups(keys: string[], groups: Record<string, any[]>) {
    const nums = keys.map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    if (!nums.length) return;
    const first = String(nums[0]); const last = String(nums[nums.length - 1]);
    const opsA = groups[first] || []; const opsB = groups[last] || opsA;
    const a0 = opsA.map(groupAnchor).find((x: any) => x && (x.before || x.after));
    const bN = [...opsB].reverse().map(groupAnchor).find((x: any) => x && x.after);
    if (!a0 || !bN || !bN.after) { (window as any).alert(t("gt.timeline.empty")); return; }
    const base = a0.before || a0.after;
    if (base === bN.after) { (window as any).alert(t("gt.timeline.empty")); return; }
    const sid = opsA[0]?.sessionId || sessionId || getSessionId();
    const label = nums.length === 1 ? ("prompt #" + first) : ("prompt #" + first + " - #" + last + "（含中间连续组）");
    const payload: any = { source: "trace", storeRoot: a0.root || bN.root, sessionId: sid, base, target: bN.after, label };
    const opener = extSvc<(o?: any) => void>("aiti-git-review.open") || (window as any).__aitiGitReviewOpen; // DI 方案 P2 双轨
    if (typeof opener === "function") { opener(payload); return; }
    const q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(payload)) q.set(k, String(v));
    location.href = location.pathname + "?" + q.toString();
  }
  function toggleSelGroup(k: string) { setSelGroups((s0) => (s0.includes(k) ? s0.filter((x) => x !== k) : [...s0, k])); }

  // 台账清理（§15）：整会话 / 某 op 之前；服务端改写台账，前端本地同步（总览一并刷新）
  async function doClean(beforeOp?: number) {
    if (!sessionId) return;
    const r = await apiPost("/cleanup", beforeOp ? { scope: "session", session: sessionId, beforeOp } : { scope: "session", session: sessionId });
    setCleanArm(null);
    if (r.ok) { setOps(beforeOp ? (ops || []).filter((o: any) => o.op >= beforeOp) : []); setSelGroups([]); setFilesTick((x) => x + 1); }
  }

  // ── 视图切换（v2 key 持久化，§4.2）──
  function switchView(v: string) {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* ignore */ }
  }
  function toggleFile(k: string) { setExpandedFiles((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k])); }
  // 总览「在评审中打开完整 diff」（§2）：文件级区间（服务端解析的 store base/target）→ git-review
  function viewRangeDiff(f: any, st: any) {
    const label = (ovMultiRoot ? repoBase(f.root) + "/" : "") + f.path;
    const payload: any = { source: "trace", storeRoot: f.root, sessionId: sessionId || getSessionId(), base: st.base, target: st.target, label, files: [f.path] };
    const opener = extSvc<(o?: any) => void>("aiti-git-review.open") || (window as any).__aitiGitReviewOpen; // DI 方案 P2 双轨
    if (typeof opener === "function") { opener(payload); return; }
    // git-review 客户端未就绪：URL 深链（files 序列化为 JSON，其客户端挂载时自动 applyOpen）
    const q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(payload)) q.set(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
    location.href = location.pathname + "?" + q.toString();
  }

  // dock 头工具条 v3：仅左栏区块 face 注册命令（刷新 = 重拉变更总览/时间线）
  const tlDockKey = face === "left" ? TIMELINE_KEY : undefined;
  const hsTl = useDockHeaderStateOf(TIMELINE_KEY);
  useDockCommands(tlDockKey, tlDockKey ? { refresh: () => { setFilesTick((v: number) => v + 1); void load(); } } : null);
  useDockHeaderState(tlDockKey, tlDockKey ? { ops: (ops || []).length } : null);

  if (!open) return null;
  // 只认 before→after 窗口内的增量：before=null 是首触全树基线（非增量），不计入 ±N、
  // 不参与默认过滤——否则全仓库文件都会被当成“变更”（并行污染同理被窗口自然排除）
  const filesNOf = (op: any) => (op.stores || []).reduce((a: number, x: any) =>
    a + (x.before && x.files ? (x.files.M || 0) + (x.files.A || 0) + (x.files.D || 0) : 0), 0);
  // 默认只看有文件变更的操作（无变更读类操作噪音大）；开关显示全部——操作视图过滤
  // 回撤记账行（kind:"rollback"）单独抽出来：不进 msgSeq 分组，独立「↩ 回撤记录」区块展示。
  // [P1-1 尾巴] plan-accept/plan-discard（op-less 记账行）同样抽出：独立「📋 方案采认记录」区块。
  const rollbackRows = (ops || []).filter((op: any) => op?.kind === "rollback");
  const planRows = (ops || []).filter((op: any) => op?.kind === "plan-accept" || op?.kind === "plan-discard");
  const visibleOps = (ops || []).filter((op: any) => op?.kind !== "rollback" && op?.kind !== "plan-accept" && op?.kind !== "plan-discard" && (showAll || filesNOf(op) > 0 || (op.leaks || []).length > 0));
  // 分组头：#N + 用户 prompt（一行截断，title 全文；无 prompt 回退 prompt #N）
  const groups: Record<string, any[]> = {};
  for (const op of visibleOps) {
    const k = String(op.msgSeq ?? "?");
    (groups[k] = groups[k] || []).push(op);
  }
  // ── 变更总览派生（§2）：服务端 /files 聚合 → 行/汇总/多仓标注（fileMap/fileIndex 客户端聚合已退役，Y4）──
  const ovFiles: any[] = Array.isArray(filesData?.files) ? filesData.files : [];
  const ovTotals: any = filesData?.totals || null;
  const ovStores: any[] = Array.isArray(filesData?.stores) ? filesData.stores : [];
  const storeByRoot = new Map(ovStores.map((s: any) => [s.root, s]));
  const ovMultiRoot = new Set(ovFiles.map((f: any) => f.root)).size > 1; // 跨仓会话路径带仓根标注消歧
  const ovHits = fileFilter ? ovFiles.filter((f: any) => fileMatches(f, fileFilter)) : ovFiles;
  const ovMissing = ovStores.length > 0 && ovStores.every((s: any) => s.storeMissing);
  const ovPerRoot = (() => {
    const m = new Map<string, { root: string; adds: number; dels: number; files: number }>();
    for (const f of ovFiles) {
      const e = m.get(f.root) || { root: f.root, adds: 0, dels: 0, files: 0 };
      e.adds += f.adds || 0; e.dels += f.dels || 0; e.files += 1;
      m.set(f.root, e);
    }
    return [...m.values()];
  })();
  // 轮次过滤下拉选项（§2）：从台账 prompt 分组构建（徽标入口自动定位到该轮）
  const turnOptions: { id: string; label: string }[] = [];
  {
    const seenT = new Set<string>();
    for (const op of ops || []) {
      const id = String(op?.userEntryId || op?.entryId || "");
      if (!id || seenT.has(id)) continue;
      seenT.add(id);
      turnOptions.push({ id, label: "#" + String(op.msgSeq ?? "?") + " · " + String(op.prompt || t("gt.timeline.group")).slice(0, 40) });
    }
  }
  // 「↩ 回撤记录」区块（总览折叠条与操作视图共用）
  const rollbackRowsBlock = (
    <div style={{ border: "1px solid #f0c674", borderRadius: 6, overflow: "hidden" }}>
      <div style={{ padding: "6px 10px", background: "rgba(212,167,44,.12)", fontWeight: 600, fontSize: 12, color: "#9a6700" }}>↩ {rollbackRows.length} 次回撤记录</div>
      {rollbackRows.map((op: any) => {
        const rb = op.rollback || {};
        const stores = op.stores || [];
        return (
          <div key={String(op.t1) + String(op.summary || "")} style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <b style={{ color: "#9a6700" }}>↩</b>
              <span title={String(op.summary || "")} style={{ opacity: 0.9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{String(op.summary || "")}</span>
              <span style={{ opacity: 0.5, fontSize: 11, flexShrink: 0 }}>{fmtTime(op.t1)}</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
              {(rb.targetOps || []).length ? <span style={{ fontSize: 11, opacity: 0.7 }}>撤销 op：{rb.targetOps.join(",")}</span> : null}
              {stores.slice(0, 2).map((s: any) => (
                <span key={s.root} style={{ fontSize: 11, fontFamily: "monospace", opacity: 0.7 }}>{String(s.root).split("/").pop()}: {s.before?.slice(0, 7)}→{s.after?.slice(0, 7)}</span>
              ))}
              <button style={chipStyle} title={t("gt.timeline.viewdiff")} onClick={() => viewDiff({ stores }, stores[0])}>{t("gt.timeline.viewdiff")}</button>
              <button style={chipStyle} title={t("gt.timeline.rollback")} onClick={() => stores[0] && undoLedgerRollback(stores[0])}>{t("gt.timeline.rollback")}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
  // [P1-1 尾巴] 方案采认/丢弃记账行区块（op-less 行；沙箱采认已入血缘台账，时间线可见可答
  // 「这行是沙箱采认来的」）。样式与回撤区块同构（紫调区分）。
  const planRowsBlock = (
    <div style={{ border: "1px solid #b6a6e8", borderRadius: 6, overflow: "hidden" }}>
      <div style={{ padding: "6px 10px", background: "rgba(122,98,220,.10)", fontWeight: 600, fontSize: 12, color: "#5b45b8" }}>{planRows.length} 条方案采认记录</div>
      {planRows.map((op: any, i: number) => (
        <div key={String(op.t) + String(i)} style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <b style={{ color: op.kind === "plan-accept" ? "#0a7d33" : "#9a6700", flexShrink: 0 }}>{op.kind === "plan-accept" ? "采认" : "丢弃"}</b>
            <span title={String(op.summary || "")} style={{ opacity: 0.9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{String(op.summary || "")}</span>
            <span style={{ opacity: 0.5, fontSize: 11, flexShrink: 0 }}>{fmtTime(op.t)}</span>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
            {(op.files || []).length ? <span style={{ fontSize: 11, opacity: 0.7 }} title={(op.files || []).join("\n")}>{op.files.length} 文件</span> : null}
            {op.mission ? <span style={{ fontSize: 11, fontFamily: "monospace", opacity: 0.6 }}>mission {String(op.mission).slice(0, 8)}</span> : null}
            {op.sandbox ? <span style={{ fontSize: 11, fontFamily: "monospace", opacity: 0.5 }} title={String(op.sandbox)}>sandbox</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
  const panelW = view === "overview" ? 640 : 560; // §4.3 总览视图加宽
  const floating = face === "float";
  const panelContent = (
    <>
      {/* 行 1（§4.1）：标题 + 会话选择器（flex 拉伸）+ ↻ + 🧹 + 📋 方案绑定 + 关注路径 + ×（✕/标题仅浮窗态——停靠 chrome 已带） */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        {floating && <b style={{ flexShrink: 0 }}>⎇ {t("gt.timeline.title")}</b>}
        <select
          value={sessionId}
          onChange={(e: any) => { setSessionId(e.target.value); setTurnFilter(""); load(e.target.value); }}
          title={sessionId}
          style={{ ...inputStyle, flex: 1, minWidth: 0, cursor: "pointer" }}
        >
          {sessionId && !wsSessions.some((x: any) => x.id === sessionId) && (
            <option value={sessionId}>{sessionId.slice(0, 8) + "…"}</option>
          )}
          {wsSessions.map((x: any) => (
            <option key={x.id} value={x.id}>{sessName(x).slice(0, 40) + " · " + new Date(x.modified || 0).toLocaleString()}</option>
          ))}
        </select>
        <button style={btnStyle} title={t("gt.timeline.load")} onClick={() => { load(); if (view === "overview") setFilesTick((x) => x + 1); }}>↻</button>
        <button style={btnStyle} title={t("gt.tl.cleanAllTip")} onClick={() => setCleanArm({})}><svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/></svg></button>
        {planRel && (
          <span title={"方案绑定：" + planRel} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 8px", borderRadius: 6, background: "rgba(245,158,11,.12)", color: "#f59e09", border: "1px solid rgba(245,158,11,.35)", whiteSpace: "nowrap", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", flexShrink: 0 }}>
            {planRel}
          </span>
        )}
        <button title={t("gt.watch.title")} aria-label={t("gt.watch.title")} onClick={() => openPanel("watch")} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "0 4px", lineHeight: 1, display: "flex", alignItems: "center", flexShrink: 0 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        </button>
        {floating && <button title={t("gt.common.close")} onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 4px", flexShrink: 0 }}>×</button>}
      </div>
      {/* 行 2（§4.1）：视图分段 tab + 轮次过滤（总览）/ showAll（操作视图）/ 文件过滤 chip / 跨组评审（操作视图） */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div title={t("gt.timeline.viewTip2")} style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
          {["overview", "msg", "tree"].map((v: string) => (
            <button key={v} onClick={() => switchView(v)}
              style={{ ...chipStyle, border: "none", borderRadius: 0, marginLeft: 0,
                background: view === v ? "var(--bg-hover)" : "transparent",
                fontWeight: view === v ? 600 : 400, opacity: view === v ? 1 : 0.6 }}>
              {v === "overview" ? t("gt.timeline.viewOverview") : v === "msg" ? t("gt.timeline.viewMsg") : t("gt.timeline.viewTree")}
            </button>
          ))}
        </div>
        {view === "overview" && (
          <select value={turnFilter} onChange={(e: any) => setTurnFilter(e.target.value)}
            title={t("gt.timeline.turnFilter")} style={{ ...inputStyle, width: "auto", maxWidth: 280, minWidth: 120, cursor: "pointer", flexShrink: 1 }}>
            <option value="">⏱ {t("gt.timeline.allTurns")}</option>
            {turnOptions.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        )}
        {view === "msg" && (
          <label title={t("gt.timeline.showAll")} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, opacity: 0.8, cursor: "pointer", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={showAll} onChange={(e: any) => { setShowAll(e.target.checked); try { localStorage.setItem("aiti-git-trace.timeline.showAll", e.target.checked ? "1" : "0"); } catch { /* ignore */ } }} />
            {t("gt.timeline.showAll")}
          </label>
        )}
        {view === "overview" && fileFilter && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 8px", borderRadius: 6, background: "rgba(245,158,11,.12)", color: "#f59e09", border: "1px solid rgba(245,158,11,.35)", whiteSpace: "nowrap", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
            📄 {fileFilter.split("/").pop()}
            <button onClick={() => setFileFilter(null)} title="清除单文件过滤" style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: 0, fontWeight: 700 }}>×</button>
          </span>
        )}
        {view === "msg" && selGroups.length > 0 && (
          <button style={btnStyle} title={t("gt.timeline.reviewSelTip")} onClick={() => reviewGroups(selGroups, groups)}>
            📋 {t("gt.timeline.reviewSel") + " (" + selGroups.length + ")"}
          </button>
        )}
      </div>
      <div style={scrollLayerStyle}>
      {cleanArm && (
        <div style={{ border: "1px solid #c62828", color: "#c62828", borderRadius: 6, padding: "6px 10px", marginBottom: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 11.5, flex: 1, minWidth: 0 }}>{cleanArm.beforeOp ? t("gt.tl.cleanBefore", { n: cleanArm.beforeOp }) : t("gt.tl.cleanAll")}</span>
          <button style={{ ...btnStyle, color: "#fff", background: "#c62828", borderColor: "#c62828" }} onClick={() => doClean(cleanArm.beforeOp)}>{t("gt.common.confirm")}</button>
          <button style={btnStyle} onClick={() => setCleanArm(null)}>{t("gt.common.cancel")}</button>
        </div>
      )}
      {view === "tree" ? (
        lineage && (lineage.ancestors.length + lineage.descendants.length > 0 || lineage.self.opCount > 0) ? (
        <div>
          <div style={{ fontSize: 10.5, opacity: 0.7, marginBottom: 10 }}>
            {t("gt.timeline.treeSummary").replace("{n}", String(lineage.ancestors.length + 1 + lineage.descendants.length))}
          </div>
          {[
            ...lineage.ancestors.map((n: any, i: number) => ({ n, gen: i, kind: "ancestor" })),
            { n: lineage.self, gen: lineage.ancestors.length, kind: "self" },
            ...lineage.descendants.map((n: any, i: number) => ({ n, gen: n.gen, kind: "descendant" })),
          ].map(({ n, gen, kind }: any) => {
            const ws = wsSessions.find((x: any) => x.id === n.id);
            const name = ws ? sessName(ws) : (n.id.slice(0, 8) + "…");
            const isCur = kind === "self";
            const time = n.t1 ? new Date(n.t1).toLocaleString() : "";
            return (
              <div key={n.id}
                onClick={() => { if (!isCur) { setSessionId(n.id); load(n.id); } }}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", paddingLeft: 8 + gen * 18, marginBottom: 2, borderRadius: 6,
                  cursor: isCur ? "default" : "pointer",
                  background: isCur ? "var(--bg-selected,rgba(25,118,210,.12))" : "transparent",
                  border: isCur ? "1px solid var(--border)" : "1px solid transparent" }}
                title={n.id + (n.cwd ? " · " + n.cwd : "")}>
                <span style={{ flexShrink: 0 }}>{kind === "self" ? "⭐" : kind === "ancestor" ? "📄" : "🌿"}</span>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1, fontWeight: isCur ? 700 : 500 }}>
                  {name}{isCur ? `（${t("gt.timeline.treeCurrent")}）` : ""}
                </span>
                {n.planRel && <span title={"方案绑定：" + n.planRel} style={{ fontSize: 10.5, flexShrink: 0, color: "#f59e09" }}>📋</span>}
                <span style={{ fontSize: 10.5, opacity: 0.65, flexShrink: 0 }}>{n.opCount} ops{time ? " · " + time : ""}</span>
                {!isCur && (
                  <button style={{ ...chipStyle, flexShrink: 0 }} title={t("gt.timeline.treeOpen")}
                    onClick={(e: any) => { e.stopPropagation(); setSessionId(n.id); load(n.id); }}>{t("gt.timeline.treeOpen")}</button>
                )}
                {!isCur && (
                  <button style={{ ...chipStyle, flexShrink: 0 }} title="跳转到该会话的消息流"
                    onClick={(e: any) => { e.stopPropagation(); try { window.dispatchEvent(new CustomEvent("pi-web:open-session", { detail: { id: n.id } })); } catch { /* noop */ } }}>💬</button>
                )}
              </div>
            );
          })}
          <div style={{ fontSize: 10.5, opacity: 0.6, marginTop: 8 }}>{t("gt.timeline.treeTip")}</div>
        </div>
        ) : (
          <div style={{ opacity: 0.7 }}>{t("gt.timeline.treeEmpty")}</div>
        )
      ) : view === "overview" ? (
        <>
        {filesLoading && !filesData ? <div style={{ opacity: 0.6 }}>{t("gt.ov.loading")}</div> : null}
        {/* 汇总条（§2）：N 次操作 · M 个文件 · +A −B 行 · ↩R 次回撤（+绿/−红）；leaks chip 点击切按操作视图 */}
        {ovTotals ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", marginBottom: 8, fontSize: 12 }}>
            <span><b>{fmtN(ovTotals.ops)}</b> {t("gt.ov.ops")}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span><b>{fmtN(ovTotals.files)}</b> {t("gt.ov.files")}</span>
            <span style={{ opacity: 0.4 }}>·</span>
            <span style={{ color: "#1a7f37", fontWeight: 600 }}>+{fmtN(ovTotals.adds)}</span>
            <span style={{ color: "#cf222e", fontWeight: 600 }}>−{fmtN(ovTotals.dels)}</span>
            {ovTotals.rollbacks > 0 ? (<><span style={{ opacity: 0.4 }}>·</span><span style={{ color: "#9a6700" }}>↩ {fmtN(ovTotals.rollbacks)} {t("gt.ov.rollbacks")}</span></>) : null}
            {ovTotals.binary > 0 ? (<><span style={{ opacity: 0.4 }}>·</span><span style={{ opacity: 0.6, fontSize: 11 }}>{t("gt.ov.binary")} {fmtN(ovTotals.binary)}</span></>) : null}
            {ovTotals.leaks > 0 ? (
              <span style={{ ...badgeStyle("leak"), marginLeft: 0, cursor: "pointer" }} title={t("gt.timeline.leak")} onClick={() => switchView("msg")}>{t("gt.timeline.leak")} {fmtN(ovTotals.leaks)}</span>
            ) : null}
            <span style={{ flex: 1 }} />
            <span style={{ opacity: 0.55, fontSize: 10.5 }}>{t("gt.ov.netNote")}</span>
          </div>
        ) : null}
        {filesData?.filesTruncated ? <div style={{ color: "#9a6700", fontSize: 11, marginBottom: 6 }}>{t("gt.ov.filesTruncated")}</div> : null}
        {/* 跨仓会话：按仓分列小标（§2） */}
        {ovPerRoot.length > 1 ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {ovPerRoot.map((r) => (
              <span key={r.root} style={chipStyle} title={r.root}>
                {repoBase(r.root)}: <span style={{ color: "#1a7f37" }}>+{fmtN(r.adds)}</span> <span style={{ color: "#cf222e" }}>−{fmtN(r.dels)}</span> · {r.files} {t("gt.ov.files")}
              </span>
            ))}
          </div>
        ) : null}
        {/* 空态三文案（§4.5）：仅在加载完成且数据已返回后展示，避免与加载提示同时出现。 */}
        {filesLoading || !filesData ? null : !ops || ops.length === 0 ? <div style={{ opacity: 0.7 }}>{t("gt.timeline.empty")}</div>
          : ovMissing ? <div style={{ opacity: 0.7 }}>{t("gt.ov.storeMissing")}</div>
          : ovHits.length === 0 ? <div style={{ opacity: 0.7 }}>{t("gt.ov.noFiles")}</div>
          : ovHits.map((f: any) => {
          const key = f.root + "\u0000" + f.path;
          const expanded = expandedFiles.includes(key);
          const st = storeByRoot.get(f.root);
          const hasRange = !!(st && st.base && st.target && st.base !== st.target && !st.storeMissing && !st.rejected);
          return (
            <div key={key} style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
              {/* 文件行（整行可点 = 展开/收起）：状态 A绿/M珀/D红/R蓝 · 路径 · 触达 ops 数 · ±行数 · 最后触达 */}
              <div onClick={() => toggleFile(key)} title={t("gt.timeline.fileExpand")}
                style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", cursor: "pointer" }}>
                <span style={{ ...chipStyle, flexShrink: 0, padding: "0 4px" }}>{expanded ? "▾" : "▸"}</span>
                <span title={f.status + (f.renamedFrom ? " ← " + f.renamedFrom : "")} style={{ color: statusColor(f.status), fontWeight: 700, fontSize: 11.5, flexShrink: 0 }}>{f.status}</span>
                <span title={f.root + "/" + f.path} style={{ fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", flex: 1, minWidth: 0 }}>
                  {f.path}{ovMultiRoot ? <span style={{ opacity: 0.55 }}> · {repoBase(f.root)}</span> : null}
                </span>
                <span style={{ ...badgeStyle("dim"), marginLeft: 0, flexShrink: 0 }} title={t("gt.timeline.fileTouch")}>{f.touches.length + " " + t("gt.timeline.fileTouch")}</span>
                <span style={{ color: "#1a7f37", fontSize: 11, flexShrink: 0 }}>+{fmtN(f.adds)}</span>
                <span style={{ color: "#cf222e", fontSize: 11, flexShrink: 0 }}>−{fmtN(f.dels)}</span>
                <span style={{ opacity: 0.5, fontSize: 11, flexShrink: 0 }}>{fmtTime(f.lastT)}</span>
                <span style={{ display: "inline-flex", gap: 3, flexShrink: 0, flexWrap: "wrap" }} onClick={(e: any) => e.stopPropagation()}>
                  {f.status !== "D" ? (
                    <button style={openBtnStyle} title={t("gt.timeline.openFileTip") + " · " + f.root + "/" + f.path}
                      onClick={() => openFile(f.root + "/" + f.path, String(f.path || "").split("/").pop() || f.path)}>{t("gt.timeline.openFile")}</button>
                  ) : null}
                  <button style={actBtnStyle} title={t("gt.timeline.atRefTip")} onClick={() => appendText(atTextFor(f.root, f.path))}><b style={{ fontWeight: 700 }}>@</b>{t("gt.timeline.atRef")}</button>
                  <button style={actBtnStyle} title={t("gt.timeline.atNewTip")} onClick={() => atNewSessionFile(f, st)}><b style={{ fontWeight: 700 }}>@</b>{t("gt.timeline.atNew")}</button>
                  <button style={actBtnStyle} title={t("gt.timeline.copyPathTip")} onClick={(e: any) => copyWithFeedback(f.root + "/" + f.path, e.currentTarget)}>{t("gt.timeline.copyPath")}</button>
                </span>
              </div>
              {expanded ? (
                <div style={{ margin: "4px 0 0 24px" }}>
                  {/* 内嵌轻量 diff（懒拉 /file-diff；截断保护 + 一键跳评审） */}
                  {hasRange ? (
                    <FileDiffBox root={f.root} sid={sessionId} base={st.base} target={st.target} path={f.path}
                      onOpenReview={() => viewRangeDiff(f, st)} />
                  ) : (
                    <div style={{ opacity: 0.6, fontSize: 11, padding: "2px 0 6px" }}>{t("gt.timeline.partialHint")}</div>
                  )}
                  {/* 触达 op 时间线（原按文件视图细节保留在此）+ 单文件回滚 */}
                  {f.touches.map((x: any) => (
                    <div key={String(x.op) + String(x.t1) + String(x.kind || "")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", flexWrap: "wrap" }}>
                      <span style={{ opacity: 0.6, fontSize: 11, flexShrink: 0 }}>#{x.msgSeq ?? "?"} · {fmtTime(x.t1)}</span>
                      {x.kind === "rollback" ? <span title={t("gt.fork.title")} style={{ color: "#9a6700", fontWeight: 600, flexShrink: 0 }}>↩</span> : null}
                      <b>#{x.op ?? "—"}</b>
                      <span title={x.summary || ""} style={{ opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>{x.tool}: {String(x.summary || "").slice(0, 60)}</span>
                      {x.partial ? <span style={badgeStyle("partial")}>{t("gt.timeline.partial")}</span> : null}
                      {x.truncated ? <span title={t("gt.timeline.truncTip")} style={{ opacity: 0.6, fontSize: 11 }}>…</span> : null}
                      <button style={chipStyle} title={t("gt.timeline.viewdiff")} onClick={() => viewDiff({ stores: [{ root: f.root, before: x.before, after: x.after }] }, { root: f.root, before: x.before, after: x.after }, [f.path])}>{t("gt.timeline.viewdiff")}</button>
                      {x.kind === "rollback"
                        ? <button style={chipStyle} title={t("gt.timeline.rollback")} onClick={() => undoLedgerRollback({ root: f.root, before: x.before, after: x.after })}>{t("gt.timeline.rollback")}</button>
                        : <button style={chipStyle} title={t("gt.timeline.rollback")} onClick={() => rollbackOp({ stores: [{ root: f.root, before: x.before, after: x.after, paths: [f.path] }] })}>{t("gt.timeline.rollback")}</button>}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {/* ↩ 回撤记录（折叠条；点开见回撤区块，§2） */}
        {rollbackRows.length > 0 ? (
          <div style={{ marginTop: 10 }}>
            <div onClick={() => setOvRbOpen((o) => !o)} style={{ padding: "6px 10px", background: "rgba(212,167,44,.12)", fontWeight: 600, fontSize: 12, color: "#9a6700", border: "1px solid #f0c674", borderRadius: 6, cursor: "pointer" }}>
              {ovRbOpen ? "▾" : "▸"} ↩ {rollbackRows.length} 次回撤记录
            </div>
            {ovRbOpen ? <div style={{ marginTop: 8 }}>{rollbackRowsBlock}</div> : null}
          </div>
        ) : null}
        {/* 📋 方案采认记录（P1-1 尾巴：沙箱采认/丢弃已入台账，总览可见） */}
        {planRows.length > 0 ? <div style={{ marginTop: 10 }}>{planRowsBlock}</div> : null}
        </>
      ) : !ops || ops.length === 0 ? <div style={{ opacity: 0.7 }}>{t("gt.timeline.empty")}</div> : (
        <>
        {rollbackRowsBlock}
        {planRows.length > 0 ? <div style={{ marginTop: 8 }}>{planRowsBlock}</div> : null}
        {Object.keys(groups).map((k) => (
          <div key={k} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <input type="checkbox" checked={selGroups.includes(k)} onChange={() => toggleSelGroup(k)} style={{ margin: 0, flexShrink: 0 }} title={t("gt.timeline.selGroup")} />
              <div title={groups[k][0]?.prompt || ""} style={{ opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600, flex: 1, minWidth: 0 }}>
                #{k} · {groups[k][0]?.prompt || t("gt.timeline.group")}
              </div>
              <button style={chipStyle} onClick={() => reviewGroups([k], groups)} title={t("gt.timeline.reviewGroup")}>{t("gt.timeline.review")}</button>
            </div>
            {groups[k].map((op: any) => {
              const filesN = filesNOf(op);
              const cross = (op.stores || []).length > 1;
              const leak = (op.leaks || []).length > 0;
              const partial = (op.stores || []).some((x: any) => x.partial);
              return (
                <div key={String(op.op) + String(op.t1)} style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <b>#{op.op}</b>
                    <span style={{ opacity: 0.85 }}>{op.tool}: {String(op.summary || "").slice(0, 60)}</span>
                    <span style={{ opacity: 0.6 }} title={(op.stores || []).some((x: any) => x.before && x.pathsTruncated) ? t("gt.timeline.truncTip") : undefined}>±{filesN}</span>
                    {cross ? <span style={badgeStyle("cross")} title={t("gt.timeline.cross")}>{t("gt.timeline.cross")}</span> : null}
                    {leak ? <span style={badgeStyle("leak")} title={t("gt.timeline.leak")}>{t("gt.timeline.leak")} {op.leaks.length}</span> : null}
                    {partial ? <span style={badgeStyle("partial")}>{t("gt.timeline.partial")}</span> : null}
                    {op.suspect ? <span style={badgeStyle("leak")} title="疑似并行污染：非核心写工具的 op，变更可能是并行会话所为（已照记、回滚可用；绑定向导已忽略）">👻</span> : null}
                    <span style={{ flex: 1 }}></span>
                    {(op.stores || []).filter((x: any) => x.before && (x.files ? x.files.M + x.files.A + x.files.D : 0) > 0).length > 1
                      ? (op.stores || []).filter((x: any) => x.before && (x.files ? x.files.M + x.files.A + x.files.D : 0) > 0).map((x: any) => (
                        <button key={x.root} style={{ ...chipStyle, color: "#0a7d33", borderColor: "rgba(10,125,51,.5)" }} title={x.root} onClick={() => viewDiff(op, x)}>{t("gt.timeline.viewdiff")}·{String(x.root).split("/").pop()}</button>
                      ))
                      : <button style={chipStyle} onClick={() => viewDiff(op)}>{t("gt.timeline.viewdiff")}</button>}
                    <button style={chipStyle} onClick={() => rollbackOp(op)}>{t("gt.timeline.rollback")}</button>
                    {/* op→AI 回复入口（lineage P3-②）：跳产生该操作的消息流——载荷带 entryId/userEntryId，
                        宿主支持 entryId 精确定位前退化为会话级打开（与树视图 💬 同通道） */}
                    {(op.entryId || op.userEntryId) ? (
                      <button style={chipStyle} title={"跳转到产生该操作的消息流（entry " + String(op.entryId || op.userEntryId) + "）"}
                        onClick={() => { try { window.dispatchEvent(new CustomEvent("pi-web:open-session", { detail: { id: sessionId, entryId: op.entryId || op.userEntryId || undefined } })); } catch { /* noop */ } }}>💬</button>
                    ) : null}
                    <button style={chipStyle} title={t("gt.tl.cleanBeforeTip")} onClick={() => setCleanArm({ beforeOp: op.op })}>⌫</button>
                  </div>
                  {leak ? (
                    <div style={{ opacity: 0.85, fontSize: 11, marginTop: 2, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      {op.leaks.map((l: any, i: number) => (
                        <span key={String(l.path) + i} style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                          <span title={l.path} style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{l.path}</span>
                          <span style={{ display: "inline-flex", gap: 3, flexShrink: 0, flexWrap: "wrap" }}>
                            <button style={openBtnStyle} title={t("gt.timeline.openFile")}
                              onClick={() => openFile(l.path, String(l.path || "").split("/").pop() || l.path)}>{t("gt.timeline.openFile")}</button>
                            <button style={actBtnStyle} title={t("gt.timeline.atRefTip")} onClick={() => appendText(atTextFor("", l.path))}><b style={{ fontWeight: 700 }}>@</b>{t("gt.timeline.atRef")}</button>
                            <button style={actBtnStyle} title={t("gt.timeline.atNewTip")} onClick={() => atNewSessionLeak(l)}><b style={{ fontWeight: 700 }}>@</b>{t("gt.timeline.atNew")}</button>
                            <button style={actBtnStyle} title={t("gt.timeline.copyPathTip")} onClick={(e: any) => copyWithFeedback(l.path, e.currentTarget)}>{t("gt.timeline.copyPath")}</button>
                          </span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
        </>
      )}
      </div>
    </>
  );
  // dock v3 分面：active 的 face 才会走到这里——float 出浮窗壳，right/left 出对应 DockBody
  if (floating) {
    return (
      <div style={{ ...panelStyle, left: 18, right: "auto", top: 64, width: panelW }} data-ext-float="1" data-ext-float-full="1" data-ext-float-w={panelW} data-ext-float-h={480} data-ext-float-key={TIMELINE_KEY} data-ext-float-dock={`${sidebarZoneOf(TIMELINE_KEY)} right-panel`} data-ext-float-dock-default="right-panel">
        {panelContent}
      </div>
    );
  }
  const tlZones: any[] = [sidebarZoneOf(TIMELINE_KEY), "right-panel"];
  const tlInner = (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%", color: "var(--text)", padding: "8px 10px", boxSizing: "border-box" }}>
      {panelContent}
    </div>
  );
  if (face === "left") {
    const tlActions: DockHeaderAction[] = [
      { id: "refresh", title: "刷新", icon: <RefreshSvg/>, visibility: "always", onClick: () => { requestDockCommand(TIMELINE_KEY, "refresh"); } },
    ];
    return (
      <DockBody itemKey={TIMELINE_KEY} title="时间线" chrome="section" kind="dockable"
        count={typeof hsTl.ops === "number" && hsTl.ops > 0 ? hsTl.ops : undefined}
        zones={tlZones} defaultZone="right-panel" headerActions={tlActions}>{tlInner}</DockBody>
    );
  }
  return (
    <DockBody itemKey={TIMELINE_KEY} zone="right-panel" title="时间线" chrome="tab" zones={tlZones} defaultZone="right-panel">{tlInner}</DockBody>
  );
}

// ---------- 回撤三选项对话框（§5.2，全局 Promise API） ----------

let forkResolve: ((v: any) => void) | null = null;

// ── fork 弹窗请求 store（shell 的 forkGate 调用；组件挂载时机与请求到达时机解耦）──
let pendingFork: { params: { sessionId: string; entryId: string; cutUserEntryIds: string[] }; resolve: (v: any) => void } | null = null;
const forkSubs = new Set<() => void>();
export function requestForkDialog(params: any): Promise<any> {
  return new Promise((resolve) => {
    pendingFork = {
      params: {
        sessionId: String(params?.sessionId || ""),
        entryId: String(params?.entryId || ""),
        cutUserEntryIds: Array.isArray(params?.cutUserEntryIds) ? params.cutUserEntryIds.map(String).filter(Boolean) : [],
      },
      resolve,
    };
    for (const cb of [...forkSubs]) { try { cb(); } catch { /* noop */ } }
  });
}

/** op 的已追踪文件变更数（只认 before→after 增量口径，与时间线/徽标一致） */
const forkFilesN = (o: any) => (o.stores || []).reduce((a: number, x: any) =>
  a + (x.before && x.files ? (x.files.M || 0) + (x.files.A || 0) + (x.files.D || 0) : 0), 0);

/** 是否有 gap（无基线 before=null）且有文件变更的 store——这类 op 无法自动撤销，须在弹窗明示 */
const forkHasGap = (o: any) => (o.stores || []).some((x: any) =>
  !x.before && x.files && (x.files.M || 0) + (x.files.A || 0) + (x.files.D || 0) > 0);

/** 按轮（prompt/userEntryId）分组，供弹窗列表用：组 [{ msgSeq, prompt, ops }]。
 *  按组内最小 op 序排序（反映会话执行顺序；entryId 字符串序 ≠ 时间序）。 */
function groupOpsByTurn(ops: any[]): any[] {
  const m = new Map<string, any>();
  for (const op of ops) {
    const k = String(op.userEntryId || op.msgSeq || "?");
    if (!m.has(k)) m.set(k, { key: k, prompt: op.prompt || "", msgSeq: op.msgSeq, ops: [] });
    m.get(k).ops.push(op);
  }
  const minOp = (g: any) => (g.ops || []).reduce((a: number, o: any) => Math.min(a, Number(o.op) || 0), Infinity);
  return [...m.values()].sort((a, b) => minOp(a) - minOp(b));
}

/** 该轮组触达文件数（场景 8：每轮组头「M 文件」小标；从 ops stores 窗口增量聚合，无需行数） */
function turnFilesOf(g: any): number {
  const s = new Set<string>();
  for (const o of g.ops || []) {
    for (const st of o.stores || []) {
      if (!st.before) continue;
      for (const p of st.paths || []) s.add(st.root + "\u0000" + p);
    }
  }
  return s.size;
}

/** 把失败现场组装成完整 prompt，注入 AI 输入框让当前会话 AI 接手收尾（方案 §3.4/§6）。
 *  roots = 涉及仓根列表（真实路径，AI 定位 store 必需）；sid 短 16 = 会话分支名。 */
function buildRollbackFailPrompt(p: any): string {
  const sid = p.sessionId || "";
  const shortSid = String(sid).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 16) || "s";
  const roots = Array.isArray(p.roots) && p.roots.length ? p.roots : ["<repoRoot:未提供>"];
  const rootLines = roots.map((r: string) => `- ${r}/.aiti-trace`).join("\n");
  const refs = (p.refs || []).map((r: any) => `#${r.op}  ${r.before ? r.before.slice(0, 8) : "(无基线)"} → ${r.after ? r.after.slice(0, 8) : ""}`).join("\n");
  const failed = p.failed ? `- 失败于 #${p.failed.op}：${p.failed.before?.slice(0, 8)} → ${p.failed.after?.slice(0, 8)}
  git apply 报错：${p.failed.stderr || "(无)"}` : "";
  return `【请处理一次未完成的「从这里编辑」回撤】

上下文：会话 ${sid || "?"} 里，用户「从这里编辑」；随后选择撤销被裁轮次的文件变更，但逐操作反向 patch 中途失败，剩余变更未能撤销。请你接手收尾。

已成功撤销：${p.applied} 个操作；跳过（无基线 gap）：${(p.skipped || []).join(",") || "无"}。
${failed}

涉及的 trace store（hermetic，别动用户 .git）：
- store 目录（每仓）：
${rootLines}
- 会话分支：refs/heads/aiti/${shortSid}
- safety commit（回撤前完整现状，可整树还原）：${p.safety || "?"}
- 已生成的回撤记账 commit：${p.rollback || "?"}
- 回撤目标 op：${p.targetOps ? p.targetOps.join(",") : "?"}；每 op 快照对：
${refs}

细看要求：
1. 用 \`git --git-dir=<repoRoot>/.aiti-trace --work-tree=<repoRoot> diff <before> <after> | git apply -R --whitespace=nowarn\` 逆序逐 op 撤销（<repoRoot> 用上方真实路径，先 \`git status\` 确认位置）；失败加 \`--3way\` 三方兜底。
2. 只移除这些被裁 op 引入的变更，保留用户手工改动与其他来源。
3. 完成后 \`git status\`（用户仓）核对：应只剩未被撤除的合法残留；如仍冲突，先说明冲突文件与原因再请示。
4. 红线：绝不动用户仓 .git，只用 <repoRoot>/.aiti-trace；任何一步先看 safety commit 上下文。`;
}

export function ForkDialogSlot(): any {
  const [st, setSt] = useState<{ visible: boolean; ops: any[]; busy: string; fail: any; refs: any[]; sessionId: string; roots: string[]; totals: any }>({ visible: false, ops: [], busy: "", fail: null, refs: [], sessionId: "", roots: [], totals: null });
  // 打开即默认最大化（aiti-float 全局 API；面板增强完成后调用）。hooks 必须在顶层无条件调用。
  const forkPanelRef = useRef<any>(null);
  useEffect(() => {
    const el = forkPanelRef.current;
    if (!el) return;
    const t = window.setTimeout(() => {
      try { (window as any).__piweFloat?.setMax?.(el, true); } catch { /* float 未就绪时跳过 */ }
    }, 100);
    return () => window.clearTimeout(t);
  }, [st.visible]);

  // 懒加载对接：shell（forkGate）经 requestForkDialog 投递请求——挂载前/后都能消费；
  // 组件未挂载时请求驻留 pendingFork，挂载 effect 立即消费。
  useEffect(() => {
    const consume = () => {
      if (!pendingFork) return;
      const req = pendingFork;
      pendingFork = null;
      void (async () => {
        let r: any = null;
        const { sessionId, entryId, cutUserEntryIds } = req.params;
        // 方案 §3.2：优先按被裁轮集合精确圈定（含被编辑轮）；core 旧版无 cutUserEntryIds → 降级 GET 单 entryId
        const ids = Array.isArray(cutUserEntryIds) ? cutUserEntryIds.map(String).filter(Boolean) : [];
        try {
          r = ids.length
            ? await apiPost("/fork-preview", { session: sessionId || "", entryIds: ids })
            : await apiGet("/fork-preview?session=" + encodeURIComponent(sessionId || "") + "&entryId=" + encodeURIComponent(entryId || ""));
        } catch { r = null; }
        // 只列出有文件变更的操作（±0 的纯读/无增量 op 不进处置清单）；
        // gap（无基线）op 即使 ±0 也进清单——变更无法自动撤销，须让用户看到并知情。
        // 满足条件的操作为 0 时不弹窗，直接放行（keep = 不回滚，无需用户处置）。
        const ops = ((r && r.ops) || []).filter((o: any) => forkFilesN(o) > 0 || forkHasGap(o));
        if (ops.length === 0) { req.resolve({ action: "keep" }); return; }
        forkResolve = req.resolve;
        // R4：汇总行数据来自 fork-preview 响应附带的 files/totals 聚合（不另发 /files）
        setSt({ visible: true, ops, busy: "", fail: null, refs: [], sessionId: sessionId || "", roots: [], totals: (r && r.totals) || null });
      })();
    };
    consume();
    forkSubs.add(consume);
    return () => { forkSubs.delete(consume); };
  }, []);
  // 兼容旧全局入口（外部脚本）：转调模块级 requestForkDialog
  useEffect(() => {
    (window as any).__aitiGitTraceForkDialog = (p: any) => requestForkDialog(p);
    return () => { try { delete (window as any).__aitiGitTraceForkDialog; } catch { /* noop */ } };
  }, []);

  // 从预览 ops 收集「按仓分组、组内升序」的 refs；
  // gap store（before=null）也传（服务端 skip 并计入 skipped）——其变更无法自动撤销，撤销后明示。
  function collectRefs(): { storeRoot: string; refs: any[] }[] {
    const byStore = new Map<string, any[]>();
    for (const o of st.ops) for (const s of (o.stores || [])) {
      if (!byStore.has(s.root)) byStore.set(s.root, []);
      byStore.get(s.root).push({ op: o.op, before: s.before || null, after: s.after || null });
    }
    return [...byStore.entries()].map(([storeRoot, refs]) => ({ storeRoot, refs: refs.sort((a, b) => a.op - b.op) }));
  }

  async function doRollback() {
    const groups = collectRefs();
    if (groups.length === 0) { (window as any).alert("no restorable baseline"); return; }
    setSt({ ...st, busy: "rollback", fail: null });
    let applied = 0; let failed: any = null; const skipped: any[] = []; let safety: string = ""; let rollback: string = "";
    for (const g of groups) {
      const rr = await apiPost("/rollback-reversed", { storeRoot: g.storeRoot, sessionId: getSessionId(), refs: g.refs });
      if (rr && rr.failed) { failed = rr.failed; }
      if (rr && rr.safety) safety = rr.safety;
      if (rr && rr.rollback) rollback = rr.rollback;
      applied += (rr && rr.applied) || 0;
      if (Array.isArray(rr && rr.skipped)) for (const sk of rr.skipped) skipped.push(sk);
      if (rr && rr.failed) break; // 一仓失败：停止后再交给用户处置
    }
    if (failed) {
      setSt({ ...st, busy: "", fail: { failed, applied, skipped, safety, rollback, refs: groups.flatMap((g) => g.refs) }, refs: groups.flatMap((g) => g.refs), roots: groups.map((g) => g.storeRoot), sessionId: st.sessionId });
      return;
    }
    if (skipped.length) {
      // 方案 §7：成功回撤但跳过 gap（无基线）op 时明示，避免用户误以为全部撤净
      (window as any).alert(t("gt.fork.skippedHint", { n: String(skipped.length) }));
    }
    resolveFork({ action: "rollback", done: t("gt.fork.done") });
  }

  function resolveFork(v: any) {
    setSt({ visible: false, ops: [], busy: "", fail: null, refs: [], sessionId: "", roots: [], totals: null });
    try { forkResolve && forkResolve(v); } catch {}
    forkResolve = null;
  }

  // 失败处置：交给 AI → 组装 prompt 注入输入框，放行编辑；忽略 → 保留现状，放行编辑
  function resolveFail(v: any) {
    if (v.action === "ai") {
      const prompt = buildRollbackFailPrompt({ sessionId: st.sessionId, roots: st.roots, refs: st.refs, applied: st.fail?.applied, skipped: st.fail?.skipped, failed: st.fail?.failed, safety: st.fail?.safety, rollback: st.fail?.rollback, targetOps: st.fail?.refs ? st.fail.refs.map((r: any) => r.op) : [] });
      appendText(prompt);
    }
    resolveFork({ action: "keep" });
  }

  const groups = groupOpsByTurn(st.ops);
  if (!st.visible) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 10060, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        ref={forkPanelRef}
        style={{ ...panelStyle, position: "static", width: 720, maxWidth: "94vw", maxHeight: "86vh", padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
        data-ext-float="1" data-ext-float-full="1" data-ext-float-w={720} data-ext-float-h={560}
      >
        {/* 标题栏 = 拖拽把手（面板第一个子元素）；关闭 ✕ = 取消 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, cursor: "move" }}>
          <b style={{ fontSize: 13 }}>{t("gt.fork.title")}</b>
          <button
            type="button"
            title={t("gt.fork.cancel")}
            aria-label={t("gt.fork.cancel")}
            onClick={() => resolveFork({ action: "cancel" })}
            style={{ ...btnStyle, border: "none", background: "transparent", padding: "2px 8px", fontSize: 14, lineHeight: 1 }}
          >✕</button>
        </div>
        <div style={scrollLayerStyle}>
          {st.fail ? (
            <div style={{ padding: "12px 14px 0" }}>
              <div style={{ color: "#cf222e", fontWeight: 600, marginBottom: 8 }}>{t("gt.fork.failTitle")}</div>
              <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>{t("gt.fork.failDetail", { applied: String(st.fail.applied), skipped: (st.fail.skipped || []).map((s: any) => "#" + s.op).join(",") || "—", op: String(st.fail.failed.op), err: String(st.fail.failed.stderr || "").slice(0, 120) })}</div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 6, marginBottom: 10, padding: "6px 10px", fontSize: 12, fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 140, overflow: "auto", opacity: 0.9 }}>{buildRollbackFailPrompt({ sessionId: st.sessionId, roots: st.roots, refs: st.refs, applied: st.fail.applied, skipped: st.fail.skipped, failed: st.fail.failed, safety: st.fail.safety, rollback: st.fail.rollback, targetOps: st.refs.map((r: any) => r.op) })}</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>{t("gt.fork.failHint")}</div>
            </div>
          ) : (
            <div style={{ padding: "12px 14px 0" }}>
              <div style={{ opacity: 0.8, marginBottom: 10 }}>{t("gt.fork.desc")}</div>
              {/* 场景 8（R4）：顶部汇总条「N 次操作 · M 个文件 · +A −B」（服务端 fork-preview 附带聚合） */}
              {st.totals ? (
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", marginBottom: 10, fontSize: 12 }}>
                  <span><b>{fmtN(st.totals.ops)}</b> {t("gt.ov.ops")}</span>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span><b>{fmtN(st.totals.files)}</b> {t("gt.ov.files")}</span>
                  <span style={{ opacity: 0.4 }}>·</span>
                  <span style={{ color: "#1a7f37", fontWeight: 600 }}>+{fmtN(st.totals.adds)}</span>
                  <span style={{ color: "#cf222e", fontWeight: 600 }}>−{fmtN(st.totals.dels)}</span>
                </div>
              ) : null}
              {groups.map((g) => (
                <div key={g.key} style={{ border: "1px solid var(--border)", borderRadius: 6, marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border)", fontSize: 12, fontWeight: 600 }}>
                    <span title={g.prompt || ""} style={{ opacity: 0.9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0 }}>🗣 {String(g.prompt || "").slice(0, 60) || "(无 prompt)"}</span>
                    {turnFilesOf(g) > 0 ? <span style={{ fontSize: 11, opacity: 0.65, flexShrink: 0, whiteSpace: "nowrap" }}>{t("gt.fork.turnFiles", { n: String(turnFilesOf(g)) })}</span> : null}
                  </div>
                  {g.ops.map((op: any) => (
                    <div key={String(op.op) + String(op.t1)} style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
                      <b>#{op.op}</b> <span>{op.tool}: {String(op.summary || "").slice(0, 70)}</span>
                      <span style={{ opacity: 0.6 }}> · ±{forkFilesN(op)}</span>
                      {forkHasGap(op) ? <span title={t("gt.fork.gapTip")} style={{ color: "#9a6700", border: "1px solid #f0c674", borderRadius: 4, padding: "0 5px", fontSize: 11, marginLeft: 4 }}>⏭ {t("gt.fork.gap")}</span> : null}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {st.busy ? <div style={{ padding: "0 14px 4px", opacity: 0.7 }}>{st.busy}…</div> : null}
        </div>
        {/* 底部操作区：固定不随内容滚动，始终可见 */}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", padding: "10px 14px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          {st.fail ? (
            <>
              <button style={btnStyle} disabled={!!st.busy} onClick={() => resolveFail({ action: "ai" })}>🤖 {t("gt.fork.aiTakeover")}</button>
              <button style={btnStyle} disabled={!!st.busy} onClick={() => resolveFail({ action: "ignore" })}>{t("gt.fork.ignore")}</button>
            </>
          ) : (
            <>
              <button style={btnStyle} disabled={!!st.busy} onClick={() => doRollback()}>↩ {t("gt.fork.rollback")}</button>
              <button style={btnStyle} disabled={!!st.busy} onClick={() => resolveFork({ action: "keep" })}>{t("gt.fork.keep")}</button>
              <button style={btnStyle} disabled={!!st.busy} onClick={() => resolveFork({ action: "cancel" })}>{t("gt.fork.cancel")}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

