/**
 * schedule-app.tsx —— ⏰调度 管理弹窗（JSX 版，方案 §7）
 *
 * 入口：顶栏 ⏰ 线图按钮（toolbar 槽）→ 弹窗（pages 槽渲染，data-ext-float 规范面板）。
 * 其他扩展委托：window.__aitiAiScheduleOpen(prefill?) 预填新建（prompt 收藏/cmd 行内 ⏰）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, extSvc, t } from "./host-shim";
// dock v3（P3 批）：显隐收口展示状态机 + 右栏停靠 face；v4 对齐分组：+ 左栏区块 face（上对齐组）
import { usePresent, DockBody, openFloat, closePanel, seedDockDefault, isSidebarDockState, sidebarZoneOf } from "../../../_shared/ext-float-dock";
// dock 头工具条 v3（方案 pi-web-dock-header-toolbar-plan §2.3/§2.5）：face 声明按钮、
// 内容实现命令 + 汇报状态；未挂载时点击自动展开并排队补跑。
import {
  useDockCommands, useDockHeaderState, useDockHeaderStateOf, requestDockCommand, writeBlockCollapsed,
} from "../../../_shared/ext-float-dock";
import type { DockHeaderAction } from "../../../_shared/ext-float-dock";
import { uiAlert, uiConfirm } from "../../../_shared/ui-dialogs";

/** 面板 itemKey（= rightFileDock 注册复合 id "aiti-ai-schedule:panel"） */
export const SCHED_KEY = "aiti-ai-schedule:panel";

const API = (p: string) => apiUrl("/api/extensions/aiti-ai-schedule" + p);

// ---------- 线图 icon（与系统内建 lucide 线条风格一致） ----------
const ICONS: Record<string, string[]> = {
  clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z", "M12 7v5l3 3"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  maximize: ["M8 3H5a2 2 0 0 0-2 2v3", "M16 3h3a2 2 0 0 1 2 2v3", "M21 16v3a2 2 0 0 1-2 2h-3", "M3 16v3a2 2 0 0 0 2 2h3"],
  restore: ["M8 3v3a2 2 0 0 1-2 2H3", "M21 8h-3a2 2 0 0 1-2-2V3", "M3 16v3a2 2 0 0 0 2 2h3", "M16 21v-3a2 2 0 0 1 2-2h3"],
  history: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2"],
  plus: ["M5 12h14", "M12 5v14"],
  refresh: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  check: ["M20 6 9 17l-5-5"],
  play: ["M8 5v14l11-7z"],
  pause: ["M9 4v16", "M15 4v16"],
};
function Ic({ size, paths }: { size: number; paths: string[] }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

// ---------- 小工具 ----------
async function loadPlans(): Promise<any[]> {
  const r = await fetch(API("/plans"));
  const d = await r.json();
  return d.plans || [];
}
function fmtTime(ts?: number | null): string {
  if (!ts || ts === Number.MAX_SAFE_INTEGER) return "—";
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toTimeString().slice(0, 5);
  return sameDay ? "今天 " + hm : `${d.getMonth() + 1}/${d.getDate()} ` + hm;
}
function relTime(ts?: number | null): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60e3) return Math.max(1, Math.round(diff / 1e3)) + "s 前";
  if (diff < 3600e3) return Math.round(diff / 60e3) + "m 前";
  if (diff < 86400e3) return Math.round(diff / 3600e3) + "h 前";
  return Math.round(diff / 86400e3) + "d 前";
}
function statusBadge(t: any): [string, string] {
  if (!t.triggerEnabled && t.enabled) return ["待触发(调度关)", "#f59e0b"];
  if (!t.enabled) return t.autoApprove === false ? ["待确认", "#f59e0b"] : ["已停用", "#8a8a8a"];
  if (t.running) return ["执行中…", "#3b82f6"];
  return ["启用", "#10b981"];
}
function scheduleHuman(t: any): string { return Array.isArray(t.schedule) ? t.schedule.join(" · ") : String(t.schedule); }
const btnStyle = (bg: string, color: string): React.CSSProperties => ({
  padding: "2px 10px", borderRadius: 6, fontSize: 11.5, cursor: "pointer",
  background: bg, border: "1px solid var(--border)", color,
});
// 头部按钮：icon 与文字必须水平并列——显式 inline-flex + 不换行 + 不被 flex 压缩
const headBtn = (bg: string, color: string): React.CSSProperties => ({
  ...btnStyle(bg, color), display: "inline-flex", alignItems: "center", gap: 4,
  whiteSpace: "nowrap", flexShrink: 0,
});
const inputStyle: React.CSSProperties = {
  padding: "4px 8px", borderRadius: 6, fontSize: 12.5, border: "1px solid var(--border)",
  background: "var(--bg)", color: "var(--text)", width: "100%", boxSizing: "border-box",
};

// ---------- IANA 时区列表（带 GMT 偏移，供下拉选择） ----------
const TIMEZONE_OPTIONS: { value: string; label: string }[] = (() => {
  let supported: string[] | undefined;
  try {
    supported = (Intl as any).supportedValuesOf?.("timeZone") as string[] | undefined;
  } catch { /* 老环境不认 timeZone key */ }
  if (!Array.isArray(supported) || supported.length === 0) return [];
  const now = Date.now();
  return supported.map((tz) => {
    let offset = "";
    try {
      // 必须按目标时区格式化，否则全是本机偏移
      const dtf = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" });
      const part = dtf.formatToParts(now).find((p) => p.type === "timeZoneName");
      offset = part?.value || "";
    } catch { /* 忽略个别解析失败 */ }
    return { value: tz, label: offset && offset !== tz ? `${tz} (${offset})` : tz };
  });
})();
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
const TZ_GROUPS = [...new Set(TIMEZONE_OPTIONS.map((o) => (o.value.includes("/") ? o.value.slice(0, o.value.indexOf("/")) : "其他")))].sort();

// ---------- 时区选择器：搜索 + 按区域分组的树形下拉 ----------
function TimezonePicker({ value, onChange }: { value: string; onChange: (tz: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [rect, setRect] = useState<{ top?: number; left: number; width: number; bottom?: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 下方空间不足（面板约 260px 高）则向上翻
    const flip = r.bottom + 264 > window.innerHeight && r.top > 264;
    setRect(flip ? { bottom: window.innerHeight - r.top + 4, left: r.left, width: Math.max(r.width, 280) }
      : { top: r.bottom + 4, left: r.left, width: Math.max(r.width, 280) });
  }, []);

  // 点外部关闭（触发框 + 面板都不在内才关；面板已 portal 到 fixed 定位、不在 wrap 内）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // 打开时测量定位；滚动/缩窗跟随重算（fixed 定位不随祖先滚动）
  useEffect(() => {
    if (!open) return;
    measure();
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("scroll", measure, opts);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, opts);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  // 打开时：默认只展开本机/当前值所在区域，其余折叠
  useEffect(() => {
    if (!open) return;
    const keep = [LOCAL_TZ.split("/")[0], value.split("/")[0]].filter(Boolean);
    setCollapsed(new Set(TZ_GROUPS.filter((g) => !keep.includes(g))));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const map = new Map<string, { value: string; leaf: string; suffix: string }[]>();
    for (const o of TIMEZONE_OPTIONS) {
      if (q && !o.value.toLowerCase().includes(q)) continue;
      const slash = o.value.indexOf("/");
      const group = slash === -1 ? "其他" : o.value.slice(0, slash);
      const leaf = slash === -1 ? o.value : o.value.slice(slash + 1);
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push({ value: o.value, leaf, suffix: o.label.slice(o.value.length) });
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [q]);

  const hasExact = q.length > 0 && TIMEZONE_OPTIONS.some((o) => o.value.toLowerCase() === q);
  const pick = (tz: string) => { onChange(tz); setOpen(false); setQuery(""); };
  const curLabel = value
    ? TIMEZONE_OPTIONS.find((o) => o.value === value)?.label || value
    : `缺省（本机${LOCAL_TZ ? ` · ${LOCAL_TZ}` : ""}`;

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <style>{`.tz-row:hover{background:var(--bg-hover)}`}</style>
      <div role="button" tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "Enter") setOpen(!open); }}
        style={{ ...inputStyle, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{curLabel}{!value && "）"}</span>
        <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && rect && (
        <div ref={panelRef} style={{ position: "fixed", zIndex: 2147483300,
          top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width,
          background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
          boxShadow: "0 8px 24px rgba(0,0,0,.3)" }}>
          <input autoFocus placeholder="搜索时区，如 shanghai / york / utc"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { setOpen(false); return; }
              if (e.key !== "Enter") return;
              if (hasExact) {
                pick(TIMEZONE_OPTIONS.find((o) => o.value.toLowerCase() === q)!.value);
              } else if (q) {
                pick(query.trim()); // 自定义 IANA 名兜底
              }
            }}
            style={{ ...inputStyle, border: "none", borderBottom: "1px solid var(--border)", borderRadius: "6px 6px 0 0" }} />
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {/* 首项：缺省 */}
            <div className="tz-row" onClick={() => pick("")}
              style={{ padding: "4px 8px", fontSize: 12, cursor: "pointer", color: "var(--text-muted)", fontWeight: !value ? 600 : undefined }}>
              缺省（本机{LOCAL_TZ ? ` · ${LOCAL_TZ}` : ""}）
            </div>
            {/* 编辑旧任务存了列表外的值——保底展示 */}
            {value && !TIMEZONE_OPTIONS.some((o) => o.value === value) && (
              <div className="tz-row" onClick={() => pick(value)}
                style={{ padding: "4px 8px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                {value}（当前）
              </div>
            )}
            {groups.map(([group, items]) => {
              const isOpen = q.length > 0 || !collapsed.has(group);
              return (
                <div key={group}>
                  <div className="tz-row" onClick={() => setCollapsed((s) => { const n = new Set(s); isOpen ? n.add(group) : n.delete(group); return n; })}
                    style={{ padding: "4px 8px", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
                      color: "var(--text-muted)", display: "flex", gap: 4, alignItems: "center",
                      borderTop: "1px solid var(--border)" }}>
                    <span style={{ fontSize: 9 }}>{isOpen ? "▾" : "▸"}</span>
                    <span style={{ flex: 1 }}>{group}</span>
                    <span style={{ opacity: 0.6 }}>{items.length}</span>
                  </div>
                  {isOpen && items.map((it) => (
                    <div key={it.value} className="tz-row" onClick={() => pick(it.value)}
                      style={{ padding: "4px 8px 4px 22px", fontSize: 12, cursor: "pointer",
                        fontWeight: value === it.value ? 600 : undefined }}>
                      {it.leaf}<span style={{ color: "var(--text-muted)", marginLeft: 6 }}>{it.suffix}</span>
                    </div>
                  ))}
                </div>
              );
            })}
            {groups.length === 0 && (
              <div style={{ padding: "8px", fontSize: 12, color: "var(--text-muted)" }}>
                无匹配 —— 按 Enter 使用自定义值「{query.trim()}」
              </div>
            )}
          </div>
          {!hasExact && q.length > 0 && (
            <div className="tz-row" onClick={() => pick(query.trim())}
              style={{ padding: "5px 8px", fontSize: 11.5, cursor: "pointer", color: "var(--text-muted)",
                borderTop: "1px solid var(--border)", borderRadius: "0 0 6px 6px" }}>
              ↵ 使用自定义值「{query.trim()}」
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 调度输入即时校验工具（本地逐行镜像 parseSchedules/parseCron 语义；服务端 /plans/validate 权威兜底） ----------
const SCHED_DOW_ALIAS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const SCHED_SEGS: string[] = ["秒", "分", "时", "日", "月", "周"];
function schedDowNum(v: string): number {
  const t = v.trim().toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return SCHED_DOW_ALIAS[t.slice(0, 3)] ?? NaN;
}
function schedFieldOk(field: string, min: number, max: number): string | null {
  for (const part of field.split(",")) {
    let p = part.trim();
    let step = 1;
    const slash = p.indexOf("/");
    if (slash >= 0) {
      step = parseInt(p.slice(slash + 1), 10);
      if (!Number.isFinite(step) || step <= 0) return "步进 / 需为正整数";
      p = p.slice(0, slash);
    }
    if (!p) return "空字段";
    if (p === "*") continue;
    let lo: number, hi: number;
    const dash = p.indexOf("-");
    if (dash >= 0) { lo = schedDowNum(p.slice(0, dash)); hi = schedDowNum(p.slice(dash + 1)); }
    else { lo = hi = schedDowNum(p); if (slash >= 0) hi = max; } // "5/" = 从 5 起步进
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      return "取值需在 " + min + "-" + max + " 内";
    }
  }
  return null;
}
/** 单行调度本地校验：null=通过，否则返回错误描述（与服务端 parseSchedule 语义对齐） */
function validateSchedRow(row: string): string | null {
  const s = row.trim();
  if (!s) return null;                        // 空行忽略
  if (/^\+\s*\d+\s*[smhd]$/i.test(s)) return null; // 相对一次性 +30m/+2h
  if (/^\d+\s*[smhd]?$/i.test(s)) return null;      // 间隔 30m/2h/90s
  if (schedIsIso(s)) return null;                     // ISO 一次性 2026-09-10 09:00:00
  const seg = s.split(/\s+/);
  if (seg.length !== 5 && seg.length !== 6) return "需 5 段（分 时 日 月 周）或 6 段（秒开头），当前 " + seg.length + " 段";
  const six = seg.length === 6;
  const ranges: [number, number][] = six ? [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] : [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  for (let i = 0; i < seg.length; i++) {
    const e = schedFieldOk(seg[i], ranges[i][0], ranges[i][1]);
    if (e) return "第 " + (i + 1) + " 段（" + SCHED_SEGS[i + (six ? 0 : 1)] + "）：" + e;
  }
  return null;
}
/** 一次性 ISO 时间（严格形态，与服务端 parseSchedule 对齐）：2026-09-10 / 2026-09-10 09:00:00 等 */
function schedIsIso(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}(:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s.trim());
}
/** rawSchedule 归一还原为多行文本（对象形态 → 可读字符串，杜绝 String(对象) 出现 "[object Object]"） */
function scheduleToText(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map((x) => scheduleToText(x)).filter(Boolean).join("\n");
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const o = raw as any;
    if (typeof o.expr === "string") return o.expr;                                        // {type:"cron",expr} / {expr}
    const sec = o.everySec || o.intervalSec;
    if (sec !== undefined && sec !== null && sec !== "") return String(sec) + "s";        // {type:"interval",everySec} / {everySec}
    if (o.type === "once" || o.at !== undefined) {                                        // {type:"once",at} / {at}
      const at = typeof o.at === "number" ? o.at : Date.parse(String(o.at));
      if (Number.isFinite(at)) {
        const d = new Date(at);
        const pad = (n: number) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      }
      return String(o.at);
    }
  }
  return String(raw ?? "");
}

// ---------- 调度语法帮助浮层（调度行 ? 按钮：点外关闭 + 上下翻转，说明 cron/多行） ----------
const SH_ROW: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center" };
const SH_K: React.CSSProperties = { width: 78, flexShrink: 0, fontFamily: "monospace", background: "var(--bg-subtle, rgba(0,0,0,.05))", borderRadius: 4, padding: "0 6px", textAlign: "center", color: "var(--text)" };
const SH_V: React.CSSProperties = { flex: 1, color: "var(--text-muted)" };
function SchedHelp() {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top?: number; left: number; bottom?: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const flip = r.bottom + 380 > window.innerHeight && r.top > 380;
    setRect(flip ? { bottom: window.innerHeight - r.top + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 460)) }
      : { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 460)) });
  }, []);

  // 点外部关闭（触发按钮 + 面板都不在内才关；面板 fixed 定位不在按钮内）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  // 打开时测量定位；滚动/缩窗跟随重算
  useEffect(() => {
    if (!open) return;
    measure();
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("scroll", measure, opts);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, opts);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  return (
    <>
      <button ref={btnRef} type="button" title={t("sh.titleAttr")}
        onClick={() => setOpen(!open)}
        style={{ width: 20, height: 20, borderRadius: 999, border: "1px solid var(--border)",
          background: "var(--bg-subtle, transparent)", color: "var(--text-muted)", cursor: "pointer",
          fontSize: 11.5, lineHeight: 1, padding: 0, flexShrink: 0, marginTop: 1 }}>?</button>
      {open && rect && (
        <div ref={panelRef} style={{ position: "fixed", zIndex: 2147483300,
          top: rect.top, bottom: rect.bottom, left: rect.left, width: 476, maxWidth: "92vw",
          background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
          boxShadow: "0 8px 24px rgba(0,0,0,.3)", padding: 10, fontSize: 12, lineHeight: 1.55,
          display: "flex", flexDirection: "column", gap: 6, color: "var(--text)" }}>
          <div style={{ fontWeight: 600, fontSize: 12.5 }}>{t("sh.title")}</div>
          <div style={{ color: "var(--text-muted)" }}>
            {t("sh.cronHead")}
            <div style={SH_ROW}><span style={SH_K}>分</span><span style={SH_V}>{t("sh.f.min")}</span></div>
            <div style={SH_ROW}><span style={SH_K}>时</span><span style={SH_V}>{t("sh.f.hour")}</span></div>
            <div style={SH_ROW}><span style={SH_K}>日</span><span style={SH_V}>{t("sh.f.day")}</span></div>
            <div style={SH_ROW}><span style={SH_K}>月</span><span style={SH_V}>{t("sh.f.month")}</span></div>
            <div style={SH_ROW}><span style={SH_K}>周</span><span style={SH_V}>{t("sh.f.dow")}</span></div>
            <div style={{ marginTop: 2 }}>{t("sh.symbols")}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ color: "var(--text-muted)" }}>{t("sh.examples")}</span>
            <div style={SH_ROW}><span style={SH_K}>0 9 * * *</span><span style={SH_V}>{t("sh.ex.9am")}</span></div>
            <div style={SH_ROW}><span style={SH_K}>*/5 * * * *</span><span style={SH_V}>{t("sh.ex.5m")}</span></div>
            <div style={SH_ROW}><span style={SH_K}>30 6,18 * * *</span><span style={SH_V}>{t("sh.ex.twice")}</span></div>
            <div style={SH_ROW}><span style={SH_K}>0 9 * * 1-5</span><span style={SH_V}>{t("sh.ex.workday")}</span></div>
            <div style={SH_ROW}><span style={SH_K}>0 10 * * 0,6</span><span style={SH_V}>{t("sh.ex.weekend")}</span></div>
          </div>
          <div style={{ color: "var(--text-muted)" }}>{t("sh.others")}</div>
          <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6, color: "var(--text-muted)" }}>{t("sh.multi")}</div>
        </div>
      )}
    </>
  );
}

// ---------- 模型下拉选择器（对齐 pi-web ModelSelector「新建 session 同款」：provider 分组 + 搜索过滤 + 缺省/默认模型 + 可用性提示点） ----------
const AVAIL_DOT: Record<string, [string, string]> = {
  ok: ["#10b981", "可用"],
  rl: ["#f59e0b", "限流(429)"],
  err: ["#ef4444", "不可用"],
  unprobed: ["#9ca3af", "未探测"],
};
function ModelDot({ avail }: { avail?: string }) {
  if (!avail || !AVAIL_DOT[avail]) return null;
  const [color, tip] = AVAIL_DOT[avail];
  return <span title={tip} style={{ width: 7, height: 7, borderRadius: 999, background: color, flexShrink: 0, display: "inline-block" }} />;
}

function ModelPicker({ value, onChange, cwd }: { value: string; onChange: (v: string) => void; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [list, setList] = useState<{ id: string; name: string; provider: string; avail?: string }[] | null>(null);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [err, setErr] = useState("");
  const [rect, setRect] = useState<{ top?: number; left: number; width: number; bottom?: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const loadedCwdRef = useRef<string | null>(null);

  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const flip = r.bottom + 304 > window.innerHeight && r.top > 304;
    setRect(flip ? { bottom: window.innerHeight - r.top + 4, left: r.left, width: Math.max(r.width, 340) }
      : { top: r.bottom + 4, left: r.left, width: Math.max(r.width, 340) });
  }, []);

  // 打开时按 cwd 拉模型列表（pi-web 前台 POST /api/models，返回全量 modelList 含 provider/name/avail；同 cwd 缓存，换 cwd 重拉）
  useEffect(() => {
    if (!open) return;
    const key = cwd ?? "";
    if (list !== null && loadedCwdRef.current === key) return;
    let alive = true;
    setErr("");
    fetch(apiUrl("/api/models"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(key ? { cwd: key } : {}),
    }).then((r) => r.json()).then((d) => {
      if (!alive) return;
      if (Array.isArray(d.modelList)) {
        setList(d.modelList.map((m: any) => ({ id: m.id, name: m.name, provider: m.provider, avail: m.avail })));
        setDefaultModel(d.defaultModel ? `${d.defaultModel.provider}/${d.defaultModel.modelId}` : "");
        loadedCwdRef.current = key;
      } else {
        setErr(String(d.error || "模型列表加载失败"));
      }
    }).catch((e) => { if (alive) setErr(String(e?.message || e)); });
    return () => { alive = false; };
  }, [open, cwd, list]);

  // 点外部关闭（触发框 + 面板都不在内才关；面板 fixed 定位不在 wrap 内）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  // 打开时测量定位；滚动/缩窗跟随重算
  useEffect(() => {
    if (!open) return;
    measure();
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("scroll", measure, opts);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, opts);
      window.removeEventListener("resize", measure);
    };
  }, [open, measure]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const map = new Map<string, { id: string; name: string; provider: string; avail?: string }[]>();
    for (const m of list || []) {
      if (q && !`${m.name}\u0000${m.id}\u0000${m.provider}`.toLowerCase().includes(q)) continue;
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider)!.push(m);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [list, q]);
  const showSearch = (list?.length ?? 0) > 8;

  // 同名模型出现在多个 provider（如多个 provider 都列同名 id）——名称后追加 provider 小字防点错（对齐 ModelSelector ambiguous 标注）
  const ambiguous = useMemo(() => {
    const byName = new Map<string, Set<string>>();
    for (const m of list || []) {
      if (!byName.has(m.name)) byName.set(m.name, new Set());
      byName.get(m.name)!.add(m.provider);
    }
    const out = new Set<string>();
    for (const [n, ps] of byName) if (ps.size > 1) out.add(n);
    return out;
  }, [list]);

  const pick = (v: string) => { onChange(v); setOpen(false); setQuery(""); };
  const cur = list?.find((m) => `${m.provider}/${m.id}` === value);
  const labelOf = (m: { id: string; name: string; provider: string }) => (m.name && m.name !== m.id ? m.name : m.id);
  const defaults = defaultModel ? `缺省（默认 ${defaultModel}）` : "缺省（默认模型）";

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <style>{`.mp-row:hover{background:var(--bg-hover)}`}</style>
      <div role="button" tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "ArrowDown") setOpen(true); }}
        title={value || defaults}
        style={{ ...inputStyle, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {value ? (cur ? labelOf(cur) : value) : defaults}
        </span>
        {value && (
          <span title="清除（用默认模型）" onClick={(e) => { e.stopPropagation(); onChange(""); }}
            style={{ color: "var(--text-muted)", flexShrink: 0, cursor: "pointer", fontSize: 11, lineHeight: 1 }}>✕</span>
        )}
        <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && rect && (
        <div ref={panelRef} style={{ position: "fixed", zIndex: 2147483300,
          top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width,
          background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
          boxShadow: "0 8px 24px rgba(0,0,0,.3)", display: "flex", flexDirection: "column" }}>
          {showSearch && (
            <input autoFocus placeholder="搜索模型（名称 / id / provider）" value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
              style={{ ...inputStyle, border: "none", borderBottom: "1px solid var(--border)", borderRadius: "6px 6px 0 0", flexShrink: 0 }} />
          )}
          <div style={{ maxHeight: 264, overflowY: "auto" }}>
            {list === null && !err && <div style={{ padding: 8, fontSize: 12, color: "var(--text-muted)" }}>加载中…</div>}
            {err && <div style={{ padding: 8, fontSize: 12, color: "#ef4444" }}>{err}</div>}
            {list !== null && (
              <>
                <div className="mp-row" onClick={() => pick("")}
                  style={{ padding: "5px 8px", fontSize: 12, cursor: "pointer", color: "var(--text-muted)",
                    fontWeight: !value ? 600 : undefined }}>
                  {defaults}
                </div>
                {value && !cur && (
                  <div className="mp-row" onClick={() => pick(value)} title={value}
                    style={{ padding: "5px 8px", fontSize: 12, cursor: "pointer", fontWeight: 600, borderTop: "1px solid var(--border)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {value}（当前，已不在列表）
                  </div>
                )}
                {groups.map(([provider, items]) => (
                  <div key={provider}>
                    <div style={{ padding: "4px 8px", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
                      {provider}
                    </div>
                    {items.map((m) => (
                      <div key={`${m.provider}/${m.id}`} className="mp-row" onClick={() => pick(`${m.provider}/${m.id}`)}
                        title={`${m.provider}/${m.id}`}
                        style={{ padding: "3px 8px 3px 16px", fontSize: 12, cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
                          fontWeight: value === `${m.provider}/${m.id}` ? 600 : undefined }}>
                        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {labelOf(m)}
                          {ambiguous.has(m.name) && <span style={{ color: "var(--text-muted)", fontSize: 10, fontWeight: 400 }}> · {m.provider}</span>}
                        </span>
                        {m.name !== m.id && (
                          <span style={{ color: "var(--text-muted)", fontSize: 10.5, flexShrink: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "40%" }}>{m.id}</span>
                        )}
                        <ModelDot avail={m.avail} />
                      </div>
                    ))}
                  </div>
                ))}
                {groups.length === 0 && (
                  <div style={{ padding: 8, fontSize: 12, color: "var(--text-muted)" }}>
                    {q ? "无匹配模型" : "未发现可用模型（可在 models.json 启用）"}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 搜索选择浮层（引用区通用；交互模式与 TimezonePicker 同款：fixed 定位 + 点外关闭 + 上下翻转） ----------
export interface PickerItem { key: string; main: string; sub?: string; title?: string }

function RefPicker({ anchor, placeholder, loadItems, onPick, onClose }: {
  anchor: React.RefObject<HTMLElement | null>;
  placeholder: string;
  loadItems: (q: string) => Promise<PickerItem[]>;
  onPick: (it: PickerItem) => void;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<{ top?: number; left: number; bottom?: number } | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<PickerItem[] | null>(null);
  const [err, setErr] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 浮层宽 420、最大高约 300：下方空间不足则向上翻
    const flip = r.bottom + 304 > window.innerHeight && r.top > 304;
    setRect(flip ? { bottom: window.innerHeight - r.top + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 436)) }
      : { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 436)) });
  }, [anchor]);

  // 点外关闭 / 滚动缩窗跟随
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose, anchor]);
  useEffect(() => {
    measure();
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("scroll", measure, opts);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, opts);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  // 防抖加载（doc-center 走服务端 FTS；prompts/cmd 本地过滤也走同接口）
  useEffect(() => {
    let alive = true;
    setErr("");
    const t = setTimeout(() => {
      loadItems(query).then((its) => { if (alive) setItems(its); })
        .catch((e) => { if (alive) { setItems([]); setErr(String(e?.message || e)); } });
    }, 180);
    return () => { alive = false; clearTimeout(t); };
  }, [query, loadItems]);

  const pick = (it: PickerItem) => { onPick(it); onClose(); };
  return (
    <div ref={panelRef} style={{ position: "fixed", zIndex: 2147483300,
      top: rect?.top, bottom: rect?.bottom, left: rect?.left ?? 8, width: 420, maxWidth: "92vw",
      background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
      boxShadow: "0 8px 24px rgba(0,0,0,.3)", display: "flex", flexDirection: "column" }}>
      <style>{`.ref-row:hover{background:var(--bg-hover)}`}</style>
      <input autoFocus placeholder={placeholder} value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { onClose(); return; }
          if (e.key === "Enter" && items && items.length > 0) pick(items[0]);
        }}
        style={{ ...inputStyle, border: "none", borderBottom: "1px solid var(--border)", borderRadius: "6px 6px 0 0", flexShrink: 0 }} />
      <div style={{ maxHeight: 264, overflowY: "auto" }}>
        {items === null && <div style={{ padding: 8, fontSize: 12, color: "var(--text-muted)" }}>加载中…</div>}
        {err && items !== null && items.length === 0 && <div style={{ padding: 8, fontSize: 12, color: "#ef4444" }}>{err}</div>}
        {!err && items !== null && items.length === 0 && (
          <div style={{ padding: 8, fontSize: 12, color: "var(--text-muted)" }}>无匹配</div>
        )}
        {items !== null && items.map((it) => (
          <div key={it.key} className="ref-row" onClick={() => pick(it)}
            title={it.title || it.main}
            style={{ padding: "5px 8px", fontSize: 12, cursor: "pointer", display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.main}</span>
            {it.sub && <span style={{ fontSize: 10.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.sub}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- cc-connect 通道两级选择器（集成方案 §4.4：数据源走同源 /cc/* 代理，禁直连 9820） ----------
function CcChannelPicker({ anchor, onPick, onClose }: {
  anchor: React.RefObject<HTMLElement | null>;
  onPick: (project: string, sessionKey: string, label: string) => void;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<{ top?: number; left: number; bottom?: number } | null>(null);
  const [projects, setProjects] = useState<any[] | null>(null);
  const [project, setProject] = useState("");
  const [sessions, setSessions] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const flip = r.bottom + 320 > window.innerHeight && r.top > 320;
    setRect(flip ? { bottom: window.innerHeight - r.top + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 492)) }
      : { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 492)) });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose, anchor]);
  useEffect(() => {
    measure();
    const opts = { capture: true } as AddEventListenerOptions;
    window.addEventListener("scroll", measure, opts);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, opts);
      window.removeEventListener("resize", measure);
    };
  }, [measure]);

  useEffect(() => {
    fetch(API("/cc/projects")).then((r) => r.json()).then((d) => {
      if (d.ok) setProjects(d.projects || []);
      else setErr(String(d.error || "项目列表加载失败"));
    }).catch((e) => setErr(String(e?.message || e)));
  }, []);
  useEffect(() => {
    if (!project) return;
    setSessions(null);
    fetch(API("/cc/sessions?project=" + encodeURIComponent(project))).then((r) => r.json()).then((d) => {
      if (d.ok) setSessions(d.sessions || []);
      else setErr(String(d.error || "会话列表加载失败"));
    }).catch((e) => setErr(String(e?.message || e)));
  }, [project]);

  const projBtn = (name: string) => ({
    padding: "2px 10px", borderRadius: 999, fontSize: 11.5, cursor: "pointer",
    border: "1px solid " + (project === name ? "#3b82f6" : "var(--border)"),
    background: project === name ? "rgba(59,130,246,.12)" : "transparent",
    color: project === name ? "#60a5fa" : "var(--text-muted)",
  });
  const sessionLabel = (s: any) => [s.platform, s.user_name, s.chat_name].filter(Boolean).join(" · ");
  return (
    <div ref={panelRef} style={{ position: "fixed", zIndex: 2147483300,
      top: rect?.top, bottom: rect?.bottom, left: rect?.left ?? 8, width: 480, maxWidth: "92vw",
      background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
      boxShadow: "0 8px 24px rgba(0,0,0,.3)", display: "flex", flexDirection: "column", gap: 6, padding: 8 }}>
      <style>{`.ref-row:hover{background:var(--bg-hover)}`}</style>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>项目（cc-connect）</div>
      {err && <div style={{ fontSize: 11.5, color: "#ef4444" }}>{err}</div>}
      {projects === null && !err && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>加载中…</div>}
      {projects !== null && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {projects.map((p: any) => (
            <button key={p.name} style={projBtn(p.name)} onClick={() => setProject(p.name)}>
              {p.name}{p.sessions_count ? ` (${p.sessions_count})` : ""}
            </button>
          ))}
          {projects.length === 0 && <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>无项目——检查 cc-connect 是否在运行</span>}
        </div>
      )}
      <div style={{ fontSize: 11, color: "var(--text-muted)", borderTop: "1px solid var(--border)", paddingTop: 6 }}>
        会话{project ? " · " + project : ""}（只列出 cc-connect 已知会话）
      </div>
      <div style={{ maxHeight: 210, overflowY: "auto" }}>
        {!project && <div style={{ padding: 4, fontSize: 12, color: "var(--text-muted)" }}>← 先选项目</div>}
        {project && sessions === null && <div style={{ padding: 4, fontSize: 12, color: "var(--text-muted)" }}>加载中…</div>}
        {project && sessions !== null && sessions.length === 0 && (
          <div style={{ padding: 4, fontSize: 12, color: "var(--text-muted)" }}>该项目暂无会话</div>
        )}
        {project && sessions !== null && sessions.map((s: any) => (
          <div key={s.session_key} className="ref-row"
            onClick={() => onPick(project, s.session_key, sessionLabel(s))}
            title={s.session_key}
            style={{ padding: "5px 8px", fontSize: 12, cursor: "pointer", display: "flex", flexDirection: "column", gap: 1, borderBottom: "1px solid var(--border)" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
              {s.active && <span style={{ width: 6, height: 6, borderRadius: 999, background: "#10b981", flexShrink: 0 }} />}
              <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sessionLabel(s)}</span>
            </span>
            {s.last_message?.content && (
              <span style={{ fontSize: 10.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {String(s.last_message.content).slice(0, 80)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 编辑表单（新建/编辑共用；initial 来自列表条目或预填） ----------
function EditForm({ initial, onDone }: { initial: any; onDone: (saved: boolean) => void }) {
  const [name, setName] = useState<string>(initial?.name || "");
  const [sched, setSched] = useState<string>(scheduleToText(initial?.rawSchedule ?? ""));
  const [schedErr, setSchedErr] = useState<string>("");
  const schedTimer = useRef<any>(null);
  // 失焦即时校验：本地逐行给即时反馈（含行号），本地全过再调服务端权威兜底（防抖）
  const checkSched = useCallback(() => {
    const lines = sched.split("\n").map((x) => x.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const e = validateSchedRow(lines[i]);
      if (e) { setSchedErr("第 " + (i + 1) + " 行：" + e); return; }
    }
    if (lines.length === 0) { setSchedErr(""); return; }
    clearTimeout(schedTimer.current);
    schedTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(API("/plans/validate"), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ schedule: lines.length === 1 ? lines[0] : lines }),
        });
        const d = await r.json();
        setSchedErr(d.ok ? "" : String(d.error || "校验失败") + "（保存前请修正）");
      } catch { /* 网络异常静默——保存时服务端仍会兜底 */ }
    }, 300);
  }, [sched]);
  const [prompt, setPrompt] = useState<string>(initial?.prompt || "");
  const [mode, setMode] = useState<string>(initial?.mode || "auto");
  const [cwd, setCwd] = useState<string>(initial?.cwd || "");
  const [model, setModel] = useState<string>(initial?.model || "");
  const [notify, setNotify] = useState<boolean>(initial?.notify === true);
  const [maxRuns, setMaxRuns] = useState<string>(initial?.maxRuns ? String(initial.maxRuns) : "");
  const [dailyCap, setDailyCap] = useState<string>(initial?.dailyCap ? String(initial.dailyCap) : "");
  const [timezone, setTimezone] = useState<string>(initial?.timezone || "");
  // 引用区（集成方案 §4.1）：📌 收藏 / ⚡ 命令 / 📄 文档 搜索选择浮层
  const [picker, setPicker] = useState<null | "prompt" | "cmd" | "doc">(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const refBtnRef = useRef<HTMLButtonElement>(null);
  const ccBtnRef = useRef<HTMLButtonElement>(null);
  const promptsCache = useRef<any[] | null>(null);
  const cmdsCache = useRef<any[] | null>(null);
  // 结果送达（集成方案 §4.2）：cc 两级选择 + 邮箱 + 发送条件
  const [ccProject, setCcProject] = useState<string>(initial?.cc?.project || "");
  const [ccSessionKey, setCcSessionKey] = useState<string>(initial?.cc?.sessionKey || "");
  const [ccLabel, setCcLabel] = useState<string>("");
  const [ccOpen, setCcOpen] = useState(false);
  const [mailTo, setMailTo] = useState<string>(initial?.mailTo || "");
  const [sendOn, setSendOn] = useState<string>(initial?.sendOn || "all");
  const [busy, setBusy] = useState(false);

  // ---- 引用插入（光标处；插入后补一个空格）----
  function insertAtCursor(text: string) {
    const el = promptRef.current;
    if (!el || !prompt) { setPrompt((p) => (p || "") + text + " "); return; }
    const s = el.selectionStart ?? prompt.length;
    const e = el.selectionEnd ?? s;
    setPrompt(prompt.slice(0, s) + text + prompt.slice(e));
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = s + text.length; });
  }
  const loadPrompts = useCallback(async (q: string): Promise<PickerItem[]> => {
    if (!promptsCache.current) {
      const d = await fetch(apiUrl("/api/extensions/aiti-prompts/prompts")).then((r) => r.json());
      promptsCache.current = d.prompts || [];
    }
    const lq = q.trim().toLowerCase();
    return (promptsCache.current || [])
      .filter((p: any) => !lq || p.name?.toLowerCase().includes(lq) || p.text?.toLowerCase().includes(lq) || (p.tags || []).some((t: string) => t.toLowerCase().includes(lq)))
      .map((p: any) => ({ key: p.id, main: p.name, sub: String(p.text || "").split("\n")[0].slice(0, 80), title: p.text }));
  }, []);
  const loadCmds = useCallback(async (q: string): Promise<PickerItem[]> => {
    if (!cmdsCache.current) {
      const d = await fetch(apiUrl("/api/extensions/aiti-cmd/commands")).then((r) => r.json());
      cmdsCache.current = d.commands || [];
    }
    const lq = q.trim().toLowerCase();
    return (cmdsCache.current || [])
      .filter((c: any) => !lq || c.name?.toLowerCase().includes(lq) || c.cmd?.toLowerCase().includes(lq) || (c.tags || []).some((t: string) => t.toLowerCase().includes(lq)))
      .map((c: any) => ({ key: c.id, main: c.name, sub: "$ " + c.cmd, title: c.cmd }));
  }, []);
  const loadDocs = useCallback(async (q: string): Promise<PickerItem[]> => {
    const d = await fetch(apiUrl("/api/extensions/aiti-doc-center/docs?q=" + encodeURIComponent(q) + "&limit=20")).then((r) => r.json());
    return (d.items || []).map((it: any) => ({
      key: it.id, main: it.title || it.relpath,
      sub: (it.root + "/" + it.relpath) + ((it.tags || []).length ? " · " + it.tags.join(",") : ""),
      title: it.root + "/" + it.relpath,
    }));
  }, []);
  const pickRef = (kind: "prompt" | "cmd" | "doc") => (it: PickerItem) => {
    if (kind === "prompt") {
      const text = it.title || it.main;
      if (!prompt.trim()) setPrompt(text);
      else insertAtCursor(text);
      fetch(apiUrl("/api/extensions/aiti-prompts/prompts/" + encodeURIComponent(it.key) + "/touch"), { method: "POST" }).catch(() => { /* 计数失败不阻断 */ });
    } else if (kind === "cmd") {
      // 命令以「$ cmd」追加到提示词末尾（{xxx} 占位符原样保留，AI 执行时理解并填参）
      setPrompt((p) => p.replace(/\s+$/, "") + (p.trim() ? "\n" : "") + "$ " + it.title);
    } else {
      insertAtCursor("@" + it.title);
    }
  };

  async function save() {
    setBusy(true);
    try {
      // 多调度：每行一个，非空行 → 数组；单行 → 字符串（向后兼容存储形态）
      const schedLines = sched.split("\n").map((x) => x.trim()).filter(Boolean);
      const body: any = { name, schedule: schedLines.length === 1 ? schedLines[0] : schedLines, prompt, mode, notify };
      if (cwd.trim()) body.cwd = cwd.trim();
      if (model.trim()) body.model = model.trim();
      if (maxRuns) body.maxRuns = Number(maxRuns);
      if (dailyCap) body.dailyCap = Number(dailyCap);
      if (timezone.trim()) body.timezone = timezone.trim();
      // 结果送达（§4.2）：总是回传（null=清除），服务端白名单校验
      body.cc = ccSessionKey && ccProject ? { project: ccProject, sessionKey: ccSessionKey } : null;
      body.mailTo = mailTo.trim() || null;
      if (body.cc || body.mailTo) body.sendOn = sendOn;
      const isEdit = initial?.id && initial?.kind === "ai";
      const r = await fetch(API("/plans" + (isEdit ? "/" + initial.id : "")), {
        method: isEdit ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.ok) void uiAlert({ message: "保存失败：" + (d.error || r.status), kind: "error" });
      onDone(!!d.ok);
    } finally { setBusy(false); }
  }

  const row = (label: any, el: any) => (
    <label style={{ display: "grid", gridTemplateColumns: "52px 1fr", gap: 8, alignItems: "start", fontSize: 12 }}>
      <span style={{ color: "var(--text-muted)", paddingTop: 6 }}>{label}</span>{el}
    </label>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 0" }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{initial?.id ? "编辑计划 · " + initial.name : "新建计划"}</div>
      {row("名称", <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：每日9点项目日报" style={inputStyle} />)}
      {row((
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          调度<SchedHelp />
        </span>
      ), (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <textarea value={sched} onChange={(e) => { setSched(e.target.value); setSchedErr(""); }} onBlur={checkSched} rows={2}
            placeholder={t("sh.placeholder")}
            title={t("sh.textareaTitle")}
            style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit", ...(schedErr ? { borderColor: "#ef4444" } : {}) }} />
          {schedErr && <div style={{ fontSize: 11, color: "#ef4444", lineHeight: 1.4 }}>⚠ {schedErr}</div>}
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[["每 5 分钟", "*/5 * * * *"], ["每小时", "0 * * * *"], ["每天 9 点", "0 9 * * *"], ["工作日 18 点", "0 18 * * 1-5"], ["30 分钟", "30m"], ["一次性 +1h", "+1h"]].map(([label, val]) => (
          <button key={val} style={btnStyle("var(--bg-hover)", "var(--text-muted)")} onClick={() => { setSched(val); setSchedErr(""); }}>{label}</button>
        ))}
      </div>
      {row("提示词", (
        <div>
          <textarea ref={promptRef} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5}
            placeholder="目标 + 验收标准（给到点执行的 AI 看的完整指令）"
            style={{ ...inputStyle, resize: "vertical", fontFamily: "inherit" }} />
          <div ref={refBtnRef} style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
            <button style={btnStyle("var(--bg-hover)", "var(--text-muted)")} onClick={() => setPicker(picker === "prompt" ? null : "prompt")}>📌 收藏</button>
            <button style={btnStyle("var(--bg-hover)", "var(--text-muted)")} onClick={() => setPicker(picker === "cmd" ? null : "cmd")}>⚡ 命令</button>
            <button style={btnStyle("var(--bg-hover)", "var(--text-muted)")} onClick={() => setPicker(picker === "doc" ? null : "doc")}>📄 文档</button>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>插入到提示词光标处</span>
          </div>
          {picker && (
            <RefPicker anchor={refBtnRef}
              placeholder={picker === "prompt" ? "搜索收藏（名称/内容/标签）" : picker === "cmd" ? "搜索常用命令（{参数} 占位符原样插入）" : "搜索文档中心（服务端全文检索）"}
              loadItems={picker === "prompt" ? loadPrompts : picker === "cmd" ? loadCmds : loadDocs}
              onPick={pickRef(picker)}
              onClose={() => setPicker(null)} />
          )}
        </div>
      ))}
      {row("模式", (
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={inputStyle}>
          <option value="auto">auto（有活会话注入，否则新会话）</option>
          <option value="invokeAI">invokeAI（轻量问答，无工具）</option>
          <option value="session">session（总是新建全功能会话）</option>
        </select>
      ))}
      {row("目录", <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="可选，默认创建时会话 cwd" style={inputStyle} />)}
      {row("模型", <ModelPicker value={model} onChange={setModel} cwd={cwd.trim()} />)}
      {row("限次", <input value={maxRuns} onChange={(e) => setMaxRuns(e.target.value.replace(/\D/g, ""))} placeholder="可选，累计跑 N 次自停" style={inputStyle} />)}
      {row("每日上限", <input value={dailyCap} onChange={(e) => setDailyCap(e.target.value.replace(/\D/g, ""))} placeholder="可选，每天最多自动执行 N 次（预算）" style={inputStyle} />)}
      {row("时区", <TimezonePicker value={timezone} onChange={setTimezone} />)}
      {row("送达IM", (
        <div style={{ position: "relative" }}>
          <div role="button" tabIndex={0} ref={ccBtnRef}
            onClick={() => setCcOpen(!ccOpen)}
            onKeyDown={(e) => { if (e.key === "Enter") setCcOpen(!ccOpen); }}
            style={{ ...inputStyle, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: ccSessionKey ? undefined : "var(--text-muted)" }}>
              {ccSessionKey ? `💬 ${ccProject} · ${ccLabel || ccSessionKey.slice(0, 28) + "…"}` : "不发送（点选 cc-connect 通道）"}
            </span>
            {ccSessionKey && (
              <span role="button" title="清除"
                onClick={(e) => { e.stopPropagation(); setCcProject(""); setCcSessionKey(""); setCcLabel(""); }}
                style={{ color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}>✕</span>
            )}
            <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{ccOpen ? "▾" : "▸"}</span>
          </div>
          {ccOpen && (
            <CcChannelPicker anchor={ccBtnRef} onClose={() => setCcOpen(false)}
              onPick={(p, k, label) => { setCcProject(p); setCcSessionKey(k); setCcLabel(label); setCcOpen(false); }} />
          )}
        </div>
      ))}
      {row("送达邮箱", <input value={mailTo} onChange={(e) => setMailTo(e.target.value)}
        placeholder="可选，逗号分隔多个，如 a@x.com, b@y.com（经 aiti-mail 发送）" style={inputStyle} />)}
      {(ccSessionKey || mailTo.trim()) && row("发送条件", (
        <div style={{ display: "flex", gap: 6 }}>
          {[["all", "都发"], ["ok", "仅成功"], ["error", "仅失败"]].map(([v, label]) => (
            <button key={v} style={btnStyle(sendOn === v ? "rgba(59,130,246,.15)" : "var(--bg-hover)", sendOn === v ? "#60a5fa" : "var(--text-muted)")}
              onClick={() => setSendOn(v)}>{label}</button>
          ))}
        </div>
      ))}
      {(ccSessionKey || mailTo.trim()) && mode === "auto" && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", paddingLeft: 60 }}>
          注：auto 模式注入活会话时，送达的是「已注入通知」而非任务结果（真实结果随活会话异步产生）——需要真结果送达请选 invokeAI 或 session（总是新会话）模式
        </div>
      )}
      {row("通知", (
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12.5, cursor: "pointer", paddingTop: 4 }}>
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> 完成后浏览器通知
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button style={btnStyle("transparent", "var(--text-muted)")} onClick={() => onDone(false)}>取消</button>
        <button disabled={busy || !name.trim() || !sched.trim() || !prompt.trim() || !!schedErr}
          style={{ ...btnStyle("#3b82f6", "#fff"), opacity: busy || !name.trim() || !sched.trim() || !prompt.trim() || !!schedErr ? 0.5 : 1 }}
          onClick={save}>{busy ? "保存中…" : "保存"}</button>
      </div>
    </div>
  );
}

// ---------- 运行历史（弹窗体内覆盖层） ----------
const tdStyle: React.CSSProperties = { padding: "4px 8px", borderBottom: "1px solid var(--border)", verticalAlign: "top" };
function RunsPanel({ onClose }: { onClose: () => void }) {
  const [runs, setRuns] = useState<any[] | null>(null);
  useEffect(() => { fetch(API("/runs?limit=150")).then((r) => r.json()).then((d) => setRuns(d.runs || [])).catch(() => setRuns([])); }, []);
  return (
    <div style={{ position: "absolute", inset: 0, background: "var(--bg,#fff)", zIndex: 20, overflowY: "auto", padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}><Ic size={13} paths={ICONS.history} />运行历史</div>
        <button onClick={onClose} aria-label="关闭" title="关闭"
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px", flexShrink: 0 }}>✕</button>
      </div>
      {runs === null ? <div style={{ color: "var(--text-muted)", fontSize: 12 }}>加载中…</div> : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead>
            <tr>{["时间", "任务", "状态", "耗时", "详情"].map((th) => (
              <th key={th} style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>{th}</th>
            ))}</tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              // 送达备注（集成方案 §4.5）：ccSent/mailSent = "ok" | "error: …"
              const ccOk = r.ccSent === "ok";
              const mailOk = r.mailSent === "ok";
              return (
                <tr key={r.id}>
                  <td style={tdStyle} title={r.at}>{new Date(r.at).toLocaleString()}</td>
                  <td style={tdStyle}>{r.name}</td>
                  <td style={{ ...tdStyle, color: r.status === "ok" ? "#10b981" : r.status === "error" ? "#ef4444" : r.status === "missed" ? "#f59e0b" : "inherit" }}>
                    {r.status}{r.retry ? "·重试" : ""}
                  </td>
                  <td style={tdStyle}>{r.ms != null ? r.ms + "ms" : ""}</td>
                  <td style={{ ...tdStyle, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={r.error || r.text || ""}>
                    {r.error ? "⚠ " + r.error : (r.text || "")}
                    {r.ccSent && (
                      <span style={{ color: ccOk ? "#10b981" : "#ef4444", marginLeft: 6 }}
                        title={ccOk ? "IM 已送达" : "IM 送达失败：" + r.ccSent}>{ccOk ? "💬已送达" : "💬送达失败"}</span>
                    )}
                    {r.mailSent && (
                      <span style={{ color: mailOk ? "#10b981" : "#ef4444", marginLeft: 6 }}
                        title={mailOk ? "邮件已送达" : "邮件送达失败：" + r.mailSent}>{mailOk ? "✉已送达" : "✉送达失败"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- 弹窗主体（data-ext-float 规范面板：aiti-float 接管拖拽/缩放/小屏全屏） ----------
function ScheduleDialog({ onClose, initialEditing, embedded, dockItemKey }: { onClose: () => void; initialEditing?: any; embedded?: boolean; dockItemKey?: string }) {
  // 最大化按钮由 aiti-float 自动注入（⛶/❐，小屏全屏态自动隐藏）——不再自备
  const [tasks, setTasks] = useState<any[] | null>(null);
  const [editing, setEditing] = useState<any | undefined>(initialEditing); // undefined=关 | null=新建 | object=预填/编辑
  const [showRuns, setShowRuns] = useState(false);
  const [config, setConfig] = useState<any>(null);
  const [refreshDone, setRefreshDone] = useState(false);
  const liveRef = useRef(true);
  const doneTimerRef = useRef<number | null>(null);
  /** 头行刷新按钮绿勾 2s（与文件夹区块同款语义）。 */
  const markRefreshDone = useCallback(() => {
    setRefreshDone(true);
    if (doneTimerRef.current) window.clearTimeout(doneTimerRef.current);
    doneTimerRef.current = window.setTimeout(() => setRefreshDone(false), 2000);
  }, []);
  useEffect(() => () => { if (doneTimerRef.current) window.clearTimeout(doneTimerRef.current); }, []);

  const refresh = useCallback(async () => {
    try {
      const [ts, cfg] = await Promise.all([loadPlans(), fetch(API("/config")).then((r) => r.json())]);
      if (!liveRef.current) { console.warn("[aiti-ai-schedule] refresh 后到（unmounted），丢弃"); return; }
      console.log("[aiti-ai-schedule] refresh ok · tasks=", ts.length);
      setTasks(ts); setConfig(cfg);
    } catch (e) {
      console.warn("[aiti-ai-schedule] refresh 失败:", e);
      if (liveRef.current) setTasks([]);
    }
  }, []);
  useEffect(() => {
    liveRef.current = true; // StrictMode 双挂载：cleanup 置 false 后需复位
    refresh();
    // SSE 实时刷新（禁轮询）+ 浏览器通知：单连接双职责
    if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission();
    // 通知正文（总线帧与旧 SSE 帧同构：{status,name,error,targetId,...}）
    const notifyRun = (m: any) => {
      try {
        if (m.type === "run" && m.notify && typeof Notification !== "undefined" && Notification.permission === "granted") {
          const ok = m.status === "ok";
          new Notification((ok ? "✅ " : "❌ ") + "定时任务 · " + m.name, {
            body: ok ? "执行完成" : String(m.error || "执行失败").slice(0, 120), tag: m.targetId,
          });
        }
      } catch { /* 非 JSON 帧 */ }
    };
    // 事件总线 topics 唯一（2026-09-09 拍板）：白名单 sched:*（服务端 SSE 层过滤，帧前缀通配）；
    // 禁止任何兜底——全帧订阅/core route/自建 SSE 均已删除（兜底 = 保留复杂度 = 保留错误之源）。
    // topics 服务缺席（event-bus 未启用）→ 不订阅，列表靠打开时 refresh() 一次性拉取。
    const topicsSvc = extSvc<((h: (f: any) => void, types: string[]) => { off: () => void }) | undefined>("aiti-event-bus.subscribe-topics");
    let busOff: (() => void) | null = null;
    if (topicsSvc) {
      busOff = topicsSvc((f: any) => {
        if (!f || typeof f.type !== "string" || !f.type.startsWith("sched:")) return;
        refresh();
        notifyRun({ ...f, type: f.type.slice(6) });
      }, ["sched:*"]).off;
    }
    return () => { liveRef.current = false; busOff?.(); };
  }, [refresh]);

  async function act(path: string, method = "POST") {
    await fetch(API(path), { method, headers: { "content-type": "application/json" } });
    refresh();
  }

  // ── dock 头工具条 v3：仅左栏区块 face 传 dockItemKey（内容实现命令 + 汇报状态）──
  // 按钮定义由 face 声明（未挂载也可见）；未挂载时点击由 store 展开区块并排队补跑。
  const dockKey = typeof dockItemKey === "string" && dockItemKey ? dockItemKey : undefined;
  const dockHoist = Boolean(dockKey);
  useDockCommands(dockKey, dockKey ? {
    plus: () => {
      try { writeBlockCollapsed(dockKey, false); } catch { /* ignore */ }
      setEditing(null); // null = 新建计划
    },
    refresh: () => { void refresh().then(markRefreshDone); },
    history: () => {
      try { writeBlockCollapsed(dockKey, false); } catch { /* ignore */ }
      setShowRuns(true);
    },
    trigger: () => { void act("/config"); }, // 运行时触发开关（env 门控不变）
  } : null);
  useDockHeaderState(dockKey, dockKey ? { showRuns, refreshDone, triggerActive: config?.active === true } : null);

  const dlgRoot: React.CSSProperties = embedded
    ? { position: "relative", width: "100%", height: "100%", flex: 1, minHeight: 0,
        display: "flex", flexDirection: "column",
        background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontFamily: "inherit", overflow: "hidden" }
    : {
    position: "fixed", right: 18, bottom: 70, width: 920, maxWidth: "94vw", maxHeight: "80vh",
    display: "flex", flexDirection: "column", zIndex: 2147483101,
    background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)",
    border: "1px solid var(--border,#e0e0e0)", borderRadius: 16,
    boxShadow: "0 16px 64px rgba(0,0,0,.25)", fontFamily: "inherit", overflow: "hidden",
  };
  const head: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
    borderBottom: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f5f5f5)", flexShrink: 0,
    // 左栏区块（v4）：窄容器 ~260px——标题/状态/按钮放不下换行，不挤成一字一行
    flexWrap: "wrap", rowGap: 6,
  };
  const body: React.CSSProperties = { position: "relative", flex: 1, minHeight: 0, overflowY: "auto", padding: 12 };

  return (
    // 浮窗壳声明（v4 对齐分组）：data-ext-float-key 缺失时 aiti-float 不接管此面板
    // （无拖拽持久化/不注入 ⇱——浮窗切出来后没有任何回去左栏/右栏的入口，用户反馈
    // 2026-09-16）；data-ext-float-dock 声明双位 + 默认左栏，⇱ 菜单据此渲染。
    <div {...(embedded ? {} : {
      "data-ext-float": "1", "data-ext-float-key": SCHED_KEY,
      "data-ext-float-w": 920, "data-ext-float-h": 620, "data-ext-float-full": "1",
      "data-ext-float-dock": `${sidebarZoneOf(SCHED_KEY)} right-panel`,
      "data-ext-float-dock-default": sidebarZoneOf(SCHED_KEY),
    })} style={dlgRoot}>
      {/* 标题栏（首子元素 = aiti-float 拖拽把手）。dock 区块模式（dockItemKey）整行移除——
          按钮与触发开关全部上提 dock 头行（头工具条 v3 §2.8 单行化，与文件夹区块同款）。 */}
      {!dockHoist && (
      <div style={head}>
        <span style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <Ic size={15} paths={ICONS.clock} />定时任务与计划
        </span>
        {config && (
          <span style={{ fontSize: 11.5, color: config.active ? "#10b981" : "#f59e0b", cursor: "pointer", marginLeft: 4 }}
            onClick={() => act("/config")} title="点击切换运行时暂停（env 门控不变）">
            {config.active ? "● 触发开" : "● 已暂停"}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button style={headBtn("transparent", "var(--text-muted)")} onClick={() => setShowRuns(true)} title="运行历史">
          <Ic size={13} paths={ICONS.history} /> 历史
        </button>
        <button style={{ ...headBtn("#3b82f6", "#fff") }} onClick={() => setEditing(null)} title="新建计划">
          <Ic size={12} paths={ICONS.plus} /> 新建计划
        </button>
        {!embedded && (
          <button style={btnStyle("transparent", "var(--text-muted)")} onClick={onClose} aria-label="关闭" title="关闭 (ESC)">
            <Ic size={12} paths={ICONS.x} />
          </button>
        )}
      </div>
      )}

      {/* 弹窗体 */}
      <div style={body}>
        {tasks === null && <div style={{ padding: 24, color: "var(--text-muted)" }}>加载中…</div>}
        {tasks !== null && tasks.length === 0 && (
          <div style={{ padding: "40px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            暂无任务——右上角新建，或在对话里让 AI「每天早上9点总结 git 提交」
          </div>
        )}
        {tasks !== null && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {tasks.map((task) => {
              const [badgeText, badgeColor] = statusBadge(task);
              const isAi = task.kind === "ai";
              return (
                <div key={task.key} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "10px 14px", opacity: task.enabled ? 1 : 0.55 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                      <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 5, background: isAi ? "rgba(59,130,246,.15)" : "rgba(122,122,122,.15)", color: isAi ? "#60a5fa" : "var(--text-muted)" }}>
                        {isAi ? (task.createdBy === "agent" ? "🤖 AI计划" : "AI计划") : "扩展任务"}
                      </span>
                      <strong style={{ fontSize: 13.5 }}>{task.name}</strong>
                      <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 5, background: badgeColor + "22", color: badgeColor }}>{badgeText}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      {isAi && task.autoApprove === false && task.enabled === false && (
                        <button style={btnStyle("rgba(16,185,129,.15)", "#10b981")} onClick={() => act("/plans/" + task.id + "/approve")} title="批准该 AI 创建的计划生效">✓ 批准</button>
                      )}
                      <button style={btnStyle("var(--bg-hover)", "var(--text)")}
                        onClick={() => act(isAi ? "/plans/" + task.id + "/run" : "/schedules/" + encodeURIComponent(task.id) + "/run")}
                        disabled={task.running}>{task.running ? "…" : "▶ 执行"}</button>
                      {isAi && <button style={btnStyle("transparent", "var(--text-muted)")} onClick={() => act("/plans/" + task.id + "/" + (task.enabled ? "disable" : "enable"))}>{task.enabled ? "暂停" : "启用"}</button>}
                      {isAi && <button style={btnStyle("transparent", "var(--text-muted)")} onClick={() => setEditing(task)}>编辑</button>}
                      {isAi && <button style={btnStyle("transparent", "#ef4444")} onClick={async () => { if (await uiConfirm({ message: "删除计划「" + task.name + "」？", danger: true })) act("/plans/" + task.id, "DELETE"); }}>删除</button>}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 14, marginTop: 6, fontSize: 11.5, color: "var(--text-muted)", flexWrap: "wrap" }}>
                    <span>⏱ {scheduleHuman(task)}</span>
                    <span>下次 {!task.enabled ? "—" : fmtTime(task.nextRunAt)}</span>
                    <span>上次 {task.lastRunAt ? fmtTime(task.lastRunAt) + " (" + relTime(task.lastRunAt) + ")" : "未跑"}</span>
                    <span>已跑 {task.runCount || 0} 次{task.maxRuns ? "/" + task.maxRuns : ""}</span>
                    {isAi && task.dailyCap && <span title="今日已自动执行/每日上限">日预算 {task.todayCount || 0}/{task.dailyCap}</span>}
                    {isAi && task.timezone && <span title="cron 按此时区计算">🌍 {task.timezone}</span>}
                    {isAi && <span>模式 {task.mode}</span>}
                    {isAi && task.cc && <span title={"结果送达 IM：" + task.cc.project + " · " + task.cc.sessionKey}>💬</span>}
                    {isAi && task.mailTo && <span title={"结果送达邮箱：" + task.mailTo}>✉</span>}
                    {task.model && <span>{task.model}</span>}
                    {task.cwd && <span title={task.cwd}>📂 {task.cwd.split("/").slice(-1)[0] || task.cwd}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {showRuns && <RunsPanel onClose={() => setShowRuns(false)} />}
      </div>

      {/* 新建/编辑浮层（盖过弹窗本体） */}
      {editing !== undefined && (
        <div style={{ position: "fixed", inset: 0, zIndex: 2147483200, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) setEditing(undefined); }}>
          <div style={{ background: "var(--bg,#fff)", borderRadius: 12, padding: "6px 22px 16px", width: "min(560px, 92vw)", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 8px 32px rgba(0,0,0,.25)" }}>
            <EditForm initial={editing || null} onDone={(saved) => { setEditing(undefined); if (saved) refresh(); }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 插槽组件 ----------
/** dock v3（P3 批）：双面 face 参数化——pages 槽=float 浮窗，rightFileDock=右栏 tab；
 *  只有激活面渲染/订阅（事件入口保持对外事件名不变）。
 *  v4 对齐分组：+ sidebarExplorerDock 槽=左栏区块 face（gate = sidebar 族任意落位；
 *  任务（定时任务）=核心区块上对齐，session-manager 编排器负责物化后显式 dock 入栈）。 */
export function SchedulePageSlot() { return renderScheduleSlot("float"); }
export function ScheduleDockRight() { return renderScheduleSlot("dock"); }
export function ScheduleDockSidebar() { return renderScheduleSlot("sidebar"); }

function renderScheduleSlot(face?: string) {
  const st = usePresent(SCHED_KEY);
  // 头行按钮状态（内容经 store 上报；hook 必须在早退前调用）
  const hs = useDockHeaderStateOf(SCHED_KEY);
  const open = face === "float" ? st === "floating"
    : face === "sidebar" ? isSidebarDockState(st)
    : st === "docked:right-panel";
  const floating = face === "float";
  const setOpen = (v: boolean) => { if (v) openFloat(SCHED_KEY); else closePanel(SCHED_KEY); };
  const [prefill, setPrefill] = useState<any>(undefined);
  useEffect(() => {
    const l = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setOpen(true);
      setPrefill(detail && typeof detail === "object" ? detail : undefined);
    };
    window.addEventListener("aiti-ai-schedule:open", l);
    return () => window.removeEventListener("aiti-ai-schedule:open", l);
  }, []);
  useEffect(() => {
    if (!open || !floating) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, floating]);
  if (!open) return null;
  const initial = prefill
    ? { name: String(prefill.name || ""), prompt: String(prefill.prompt || ""), cwd: prefill.cwd || "", mode: prefill.mode || "auto", rawSchedule: "" }
    : undefined;
  const dialog = <ScheduleDialog key={initial ? "prefill:" + initial.name : "blank"} onClose={() => { setOpen(false); setPrefill(undefined); }} initialEditing={initial} embedded={!floating} dockItemKey={face === "sidebar" ? SCHED_KEY : undefined} />;
  if (floating) return dialog;
  // 左栏区块 face（v4 对齐分组 + 头工具条 v3）：统一头行 = 标题 + 业务按钮 + ⇱ detach + ⋮
  // （位置组已收编进 ⇱；⋮ 仅区块操作）。按钮由本 face 声明，动作经 store 派发到内容命令。
  if (face === "sidebar") {
    const triggerActive = hs.triggerActive === true;
    const actions: DockHeaderAction[] = [
      { id: "plus", title: "新建计划", icon: <Ic size={12} paths={ICONS.plus} />, visibility: "always", onClick: () => { requestDockCommand(SCHED_KEY, "plus"); } },
      { id: "refresh", title: "刷新", icon: hs.refreshDone === true ? <Ic size={12} paths={ICONS.check} /> : <Ic size={12} paths={ICONS.refresh} />, done: hs.refreshDone === true, visibility: "always", onClick: () => { requestDockCommand(SCHED_KEY, "refresh"); } },
      { id: "history", title: "运行历史", icon: <Ic size={12} paths={ICONS.history} />, active: hs.showRuns === true, visibility: "always", onClick: () => { requestDockCommand(SCHED_KEY, "history"); } },
      { id: "trigger", title: triggerActive ? "运行时触发已开启（点击暂停）" : "运行时触发已暂停（点击开启）", icon: <Ic size={12} paths={triggerActive ? ICONS.pause : ICONS.play} />, active: triggerActive, visibility: "always", onClick: () => { requestDockCommand(SCHED_KEY, "trigger"); } },
    ];
    return (
      <DockBody itemKey={SCHED_KEY} title="任务" chrome="section" kind="dockable"
        zones={[sidebarZoneOf(SCHED_KEY), "right-panel"]} defaultZone={sidebarZoneOf(SCHED_KEY)}
        headerActions={actions}>
        {dialog}
      </DockBody>
    );
  }
  return (
    <DockBody itemKey={SCHED_KEY} zone="right-panel" title="任务" chrome="tab" zones={[sidebarZoneOf(SCHED_KEY), "right-panel"]} defaultZone={sidebarZoneOf(SCHED_KEY)}>
      {dialog}
    </DockBody>
  );
}
