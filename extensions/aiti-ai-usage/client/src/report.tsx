/**
 * aiti-ai-usage · 报表面板（总览/模型/Keys/维度/会话 标签页；provider/model 全局筛选栏）。
 * 数据源：本扩展 /api/extensions/aiti-ai-usage/*；图表为手写 SVG（零依赖）。
 */
import { useState, useEffect, useMemo, useRef } from "react";
import { t, apiUrl, extSvc } from "./host-shim";
import { fmtUsdCny, fxNote, isCnyBillingProvider, useMoneyTick } from "./money";
// aiti-float dock v3（position-picker-plan §3.2 P1）：面板接停靠状态机——浮窗 face 走
// useGate 门控；打开/关闭收口 openFloat/closePanel；右栏停靠 face 用 DockBody 包同一内容。
import { useGate, DockBody, openFloat, closePanel, seedDockDefault } from "../../../_shared/ext-float-dock";

/** 状态机 itemKey（= rightFileDock 注册复合 id "aiti-ai-usage:report"） */
export const REPORT_KEY = "aiti-ai-usage:report";

/** 渲染前按 key 去重（防御）：用量数据源来自 SQL 聚合（GROUP BY provider, model / provider, key_name），
 *  正常情况下已唯一；但 keyName 与模型 id 可能同名（如某 provider 的 key 名恰等于某模型 id），
 *  一旦上游/历史数据出现同 key 两行，列表行 key 用 `${provider}/${model}`（或 `/keyName`）会触发
 *  React "two children with the same key" 告警并重复渲染。这里先按 key 去重只保一条，零回归。 */
const dedupeBy = <T,>(arr: T[], key: (t: T) => string): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of arr) {
    const k = key(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
};

// ---------------------------------------------------------------- store

// 显隐收口到 aiti-float 展示状态机（dock 方案红线：gate 是唯一渲染开关）。
// panel 对象保留原形状（入口按钮调用点零改动），内部改写状态机。
export const panel = {
  open() { openFloat(REPORT_KEY); },
  close() { closePanel(REPORT_KEY); },
};

// ---------------------------------------------------------------- 图标（lucide 线条风）

const ICONS: Record<string, string[]> = {
  chart: ["M3 3v18h18", "M8 17v-6", "M13 17V7", "M18 17v-3"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  max: ["M8 3H5a2 2 0 0 0-2 2v3", "M21 8V5a2 2 0 0 0-2-2h-3", "M3 16v3a2 2 0 0 0 2 2h3", "M16 21h3a2 2 0 0 0 2-2v-3"],
  min: ["M8 3v3a2 2 0 0 1-2 2H3", "M21 8h-3a2 2 0 0 1-2-2V3", "M3 16h3a2 2 0 0 1 2 2v3", "M16 21v-3a2 2 0 0 1 2-2h3"],
  refresh: ["M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "M21 3v5h-5", "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "M8 16H3v5"],
  search: ["M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z", "m21 21-4.34-4.34"],
};

function Ic({ size = 14, paths }: { size?: number; paths: string[] }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

// ---------------------------------------------------------------- utils

function fmtN(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "0";
  if (Math.abs(v) >= 1e12) return (v / 1e12).toFixed(v % 1e12 === 0 ? 0 : 1) + "T";
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(v % 1e9 === 0 ? 0 : 1) + "G";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(Math.abs(v) >= 1e8 ? 0 : 1) + "M";
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + "k";
  return String(v);
}
function fmtCost(n: number | null | undefined): string {
  return fmtUsdCny(n, 2);
}
function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function relTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return Math.round(s) + "s 前";
  if (s < 3600) return Math.round(s / 60) + "m 前";
  if (s < 86400) return Math.round(s / 3600) + "h 前";
  return Math.round(s / 86400) + "d 前";
}

const PALETTE = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#a78bfa", "#f472b6", "#84cc16", "#fb923c", "#38bdf8"];
function colorFor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** 与 git-review/extman 同款小屏判定。 */
export const SMALL_MQ = "(max-width: 640px)";

async function apiGet(path: string): Promise<any> {
  const res = await fetch(apiUrl(`/api/extensions/aiti-ai-usage${path}`), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- 样式常量

const card = {
  background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 10,
  padding: "10px 14px", minWidth: 120,
} as const;
const kpiLabel = { fontSize: 11, color: "var(--text-dim)" } as const;
const kpiValue = { fontSize: 18, fontWeight: 600, marginTop: 2 } as const;
const ghostBtn = {
  padding: "3px 10px", borderRadius: 7, fontSize: 11, cursor: "pointer",
  background: "transparent", border: "1px solid var(--border)", color: "var(--text-muted)",
} as const;
const iconBtn = {
  width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center",
  borderRadius: 7, border: "1px solid var(--border)", background: "transparent",
  color: "var(--text-muted)", cursor: "pointer", flexShrink: 0,
} as const;
const th: React.CSSProperties = {
  textAlign: "left", fontSize: 11, color: "var(--text-dim)", fontWeight: 500,
  padding: "6px 8px", borderBottom: "1px solid var(--border)", whiteSpace: "nowrap",
} as const;
const dateInputStyle = {
  padding: "2px 6px", borderRadius: 7, fontSize: 11, border: "1px solid var(--border)",
  background: "var(--bg-panel)", color: "inherit", colorScheme: "dark light",
} as const;
const td: React.CSSProperties = {
  fontSize: 12, padding: "6px 8px", borderBottom: "1px solid var(--border)",
  whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums",
} as const;

// ---------------------------------------------------------------- 数据 hooks

type RangeKey = "today" | "7d" | "30d" | "month" | "all" | "custom";
interface CustomRange { from: string; to: string }
/** 本地时区 YYYY-MM-DD（offset 为相对今天的天数）。 */
function dayStr(offset = 0): string {
  const d = new Date(Date.now() + offset * 86400000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 范围 → query 串；custom 未选完整（或 from > to）时返回 null（调用方提示补选）。 */
function rangeQuery(r: RangeKey, c?: CustomRange): string | null {
  switch (r) {
    case "today": return `?day=${dayStr(0)}`;
    case "7d": return "?days=7";
    case "30d": return "?days=30";
    case "month": return `?month=${dayStr(0).slice(0, 7)}`;
    case "custom":
      return c?.from && c?.to && c.from <= c.to ? `?from=${c.from}&to=${c.to}` : null;
    default: return "";
  }
}

// ---------------------------------------------------------------- provider/model/agent 筛选

interface Filters { provider: string; model: string; agent: string }
const EMPTY_FILTERS: Filters = { provider: "", model: "", agent: "" };

/** 范围 + 筛选 → 完整 query；范围未选完整时 null。 */
function buildQuery(r: RangeKey, c: CustomRange | undefined, f?: Filters): string | null {
  const base = rangeQuery(r, c);
  if (base === null) return null;
  const sp = new URLSearchParams(base.slice(1));
  if (f?.provider) sp.set("provider", f.provider);
  if (f?.model) sp.set("model", f.model);
  if (f?.agent) sp.set("agent", f.agent);
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

const selectStyle = {
  padding: "2px 6px", borderRadius: 7, fontSize: 11, border: "1px solid var(--border)",
  background: "var(--bg-panel)", color: "inherit", minWidth: 96, maxWidth: 170,
} as const;

/**
 * 自绘下拉。为什么不用原生 <select>：本面板叠了 aiti-float 托管 + 多扩展全局监听，
 * 原生弹层（浏览器窗口级）极易被焦点扰动瞬关/误选，且无法滚动浏览。
 * 自绘列表 = 面板内绝对定位普通 DOM：点开 → 滚动 → 悬停 → 点击选择，行为完全可控。
 */
function Dropdown({ value, options, onChange, ariaLabel }: {
  value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void; ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(-1);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const openAtRef = useRef(0);
  // 点外关闭 + Esc 关闭（捕获阶段；列表是普通 DOM，不会像原生弹层那样被焦点抢走干扰）
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const cur = options.find((o) => o.value === value);
  return (
    <span ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button aria-label={ariaLabel} aria-expanded={open ? "true" : "false"}
        onClick={(e) => {
          // 只认单击：部分环境（远餐/触控板抖动）会把一次点击注册成双击，第二击会立刻把列表又关上
          if (e.detail > 1) return;
          openAtRef.current = Date.now();
          setHover(-1); // 重开时清掉上次悬停高亮
          setOpen((v) => !v);
        }}
        style={{ ...selectStyle, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", textAlign: "left" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cur ? cur.label : (options[0]?.label ?? "")}</span>
        <span style={{ opacity: 0.6, flexShrink: 0 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <span style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 60, display: "block",
          minWidth: "100%", width: "max-content", maxWidth: 320, maxHeight: 320,
          overflowY: "auto", overscrollBehavior: "contain",
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 9,
          boxShadow: "0 10px 32px rgba(0,0,0,0.35)", padding: 3,
        }}>
          {options.map((o, i) => (
            <span key={o.value || `opt-${i}`}
              title={o.label}
              onClick={(e) => {
                // 双保险防误选：① 双击第二击不算；② 刚展开 250ms 内的幽灵点击不算（人不可能看清列表就选中）
                if (e.detail > 1 || Date.now() - openAtRef.current < 250) return;
                onChange(o.value);
                setOpen(false);
              }}
              onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? -1 : h))}
              style={{
                display: "block", padding: "4px 9px", fontSize: 11, cursor: "pointer",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", borderRadius: 6,
                fontWeight: o.value === value ? 600 : undefined,
                background: hover === i || o.value === value ? "var(--bg-hover)" : "transparent",
              }}>
              {o.label}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** provider/model/agent 筛选栏：选项来自 /facets；换 provider 时联动刷新 model 列表并清空已选 model。 */
function FilterBar({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const { data } = useFetch<any>("/facets", []);
  // 未选 provider 时 model 选项直接复用同一次 /facets 响应，避免重复请求；选了才按 provider 拉取
  const needModelsFetch = !!filters.provider;
  const { data: mdData } = useFetch<any>(
    needModelsFetch ? `/facets?provider=${encodeURIComponent(filters.provider)}` : null, []);
  const providers: string[] = data?.providers ?? [];
  const models: string[] = (needModelsFetch ? mdData?.models : data?.models) ?? [];
  const agents: string[] = data?.agents ?? [];
  const hasFilter = !!(filters.provider || filters.model || filters.agent);
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 11, color: "var(--text-dim)" }}>
      <span>{t("au.filter")}</span>
      <Dropdown ariaLabel={t("au.filter.allAgents")} value={filters.agent}
        options={[{ value: "", label: t("au.filter.allAgents") }, ...agents.map((a) => ({ value: a, label: a }))]}
        onChange={(v) => onChange({ ...filters, agent: v })} />
      <Dropdown ariaLabel={t("au.filter.allProviders")} value={filters.provider}
        options={[{ value: "", label: t("au.filter.allProviders") }, ...providers.map((p) => ({ value: p, label: p }))]}
        onChange={(v) => onChange({ provider: v, model: "", agent: filters.agent })} />
      <Dropdown ariaLabel={t("au.filter.allModels")} value={filters.model}
        options={[{ value: "", label: t("au.filter.allModels") }, ...models.map((m) => ({ value: m, label: m }))]}
        onChange={(v) => onChange({ ...filters, model: v })} />
      {hasFilter && (
        <button onClick={() => onChange(EMPTY_FILTERS)} title={t("au.filter.clear")}
          aria-label="clear-filters" style={{ ...ghostBtn, padding: "1px 6px" }}>×</button>
      )}
    </span>
  );
}

function useFetch<T>(path: string | null, deps: unknown[]): { data: T | null; err: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setErr("");
    apiGet(path)
      .then((d) => { if (alive) setData(d); })
      .catch((e) => { if (alive) setErr(e?.message ?? String(e)); });
    return () => { alive = false; };
  }, [path, tick, ...deps]);
  return { data, err, reload: () => setTick((v) => v + 1) };
}

// ---------------------------------------------------------------- 趋势：数据模型（图表/表格共用）

interface SeriesPoint { bucket: string; provider: string; tokens: number }

interface TrendModel {
  keys: string[];
  providers: string[];
  buckets: Map<string, Map<string, number>>;
}

function useTrendModel(points: SeriesPoint[]): TrendModel {
  return useMemo(() => {
    const buckets = new Map<string, Map<string, number>>();
    const totals = new Map<string, number>();
    for (const p of points) {
      if (!buckets.has(p.bucket)) buckets.set(p.bucket, new Map());
      const b = buckets.get(p.bucket)!;
      b.set(p.provider, (b.get(p.provider) ?? 0) + Number(p.tokens || 0));
      totals.set(p.provider, (totals.get(p.provider) ?? 0) + Number(p.tokens || 0));
    }
    const providers = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 8);
    const keys = [...buckets.keys()].sort();
    return { keys, providers, buckets };
  }, [points]);
}

// ---------------------------------------------------------------- 堆叠柱状图

/**
 * 按天/月堆叠柱：与趋势折线同套交互 —— 图例点击隐藏/显示、hover 高亮联动、
 * 柱段 hover 自绘 tooltip（值 + 占比 + 时间）、反选批量显隐。
 * 柱段/顶标只画 Top-8 provider；合计与 maxTotal 含未进 Top-8 的长尾（与表格同口径），隐藏的 provider 除外。
 */
function StackedBars({ points }: { points: SeriesPoint[] }) {
  const { keys, providers, buckets } = useTrendModel(points);
  // ⚠ hooks 全部置于条件 return 之前
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; bucket: string; provider: string; value: number; share: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const model = useMemo(() => {
    // 可见 provider 合计（含长尾、排除隐藏）——隐藏某段后柱子按剩余量重新缩放（同折线图隐藏线时 Y 缩放）
    const sumOf = (k: string) => [...(buckets.get(k)?.entries() ?? [])]
      .reduce((s, [p2, v2]) => (hidden.has(p2) ? s : s + v2), 0);
    const visProviders = providers.filter((p) => !hidden.has(p));
    const maxTotal = Math.max(1, ...keys.map(sumOf));
    return { keys, visProviders, maxTotal };
  }, [keys, providers, buckets, hidden]);

  if (model.keys.length === 0) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("au.empty")}</div>;
  }
  const W = 1000, H = 220, padL = 46, padB = 24, padT = 10;
  const bw = Math.min(48, (W - padL - 10) / model.keys.length - 6);
  const allHidden = providers.length > 0 && providers.every((p) => hidden.has(p));
  const focusing = focusKey !== null;
  const toggle = (p: string) => setHidden((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p); else n.add(p);
    return n;
  });
  const onSegMove = (k: string, p: string, v: number, barTotal: number) => (e: React.MouseEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const sp = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const share = barTotal > 0 ? Math.round((100 * v) / barTotal) : 0;
    setTip({ x: sp.x, y: sp.y, bucket: k, provider: p, value: v, share });
  };
  // 自绘 tooltip：svg 内定位 + 出界翻转
  const tipLines = tip ? [
    { text: tip.provider, bold: true, color: colorFor(tip.provider) },
    { text: `${fmtN(tip.value)} tokens · ${tip.share}% · ${tip.bucket}`, bold: false, color: "var(--text)" },
  ] : null;
  const tipW = tipLines ? Math.max(...tipLines.map((l) => l.text.length)) * 6.3 + 22 : 0;
  const tipH = tipLines ? tipLines.length * 15 + 10 : 0;
  const tipX = tip ? (tip.x + 14 + tipW > W - 8 ? tip.x - 14 - tipW : tip.x + 14) : 0;
  const tipY = tip ? (tip.y + 14 + tipH > H - padB ? tip.y - 14 - tipH : tip.y + 14) : 0;

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8, alignItems: "center" }}>
        {providers.map((p) => {
          const on = !hidden.has(p);
          return (
            <span key={p}
              onClick={() => toggle(p)}
              onMouseEnter={() => setFocusKey(p)}
              onMouseLeave={() => setFocusKey((x) => (x === p ? null : x))}
              title={`${on ? t("au.trend.hide") : t("au.trend.show")}：${p}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-dim)",
                cursor: "pointer", userSelect: "none", borderRadius: 6, padding: "2px 6px",
                background: focusKey === p ? "var(--bg-hover)" : "transparent",
                opacity: on ? 1 : 0.45, textDecoration: on ? undefined : "line-through" }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: colorFor(p), display: "inline-block" }} />
              {p}
            </span>
          );
        })}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
          <button onClick={() => setHidden((s) => new Set(providers.filter((p) => !s.has(p))))}
            title={t("au.trend.invertTitle")}
            style={{ ...ghostBtn, padding: "1px 8px" }}>
            {t("au.trend.invert")}
          </button>
        </span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - 6} y1={padT + (H - padT - padB) * f} y2={padT + (H - padT - padB) * f}
              stroke="var(--border)" strokeWidth={1} />
            <text x={padL - 6} y={padT + (H - padT - padB) * f + 4} textAnchor="end" fontSize={10} fill="var(--text-dim)">
              {fmtN(model.maxTotal * (1 - f))}
            </text>
          </g>
        ))}
        {allHidden && (
          <text x={(W + padL) / 2} y={(H + padT) / 2} textAnchor="middle" fontSize={12} fill="var(--text-dim)">
            {t("au.trend.allHiddenHint")}
          </text>
        )}
        {model.keys.map((k, i) => {
          const cx = padL + 10 + i * ((W - padL - 20) / model.keys.length);
          let y = H - padB;
          // 可见 provider 合计（含未进 Top-8 的长尾，排除隐藏）——与表格「合计」同口径
          const total = [...(buckets.get(k)?.entries() ?? [])]
            .reduce((s, [p2, v2]) => (hidden.has(p2) ? s : s + v2), 0);
          return (
            <g key={k}>
              {model.visProviders.map((p) => {
                const v = buckets.get(k)?.get(p) ?? 0;
                if (v <= 0) return null;
                const hh = Math.max(1, (v / model.maxTotal) * (H - padT - padB));
                y -= hh;
                const dimmed = focusing && focusKey !== p;
                return (
                  <rect key={p} x={cx} y={y} width={bw} height={hh} rx={2}
                    fill={colorFor(p)} opacity={dimmed ? 0.18 : 1}
                    onMouseEnter={() => setFocusKey(p)}
                    onMouseMove={onSegMove(k, p, v, total)}
                    onMouseLeave={() => { setFocusKey((x) => (x === p ? null : x)); setTip(null); }}>
                    <title>{`${k} · ${p}\n${fmtN(v)} tokens`}</title>
                  </rect>
                );
              })}
              <text x={cx + bw / 2} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--text-dim)">
                {k.length === 7 ? k : k.slice(5)}
              </text>
              {total > 0 && (
                <text x={cx + bw / 2} y={y - 4} textAnchor="middle" fontSize={10} fill="var(--text-dim)">
                  {fmtN(total)}
                </text>
              )}
            </g>
          );
        })}
        {tip && tipLines && (
          <g transform={`translate(${tipX}, ${tipY})`} pointerEvents="none">
            <rect x={-9} y={-6} width={tipW} height={tipH} rx={6} fill="var(--bg-panel)" stroke="var(--border)" opacity={0.98} />
            {tipLines.map((l, i) => (
              <text key={i} x={0} y={i * 15} fontSize={10.5} fontWeight={l.bold ? 700 : 400} fill={l.color}>{l.text}</text>
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- 趋势卡片（图 / 表切换）

function TrendTable({ points }: { points: SeriesPoint[] }) {
  const { keys, providers, buckets } = useTrendModel(points);
  if (keys.length === 0) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("au.empty")}</div>;
  }
  // 最新在上一行，方便扫读
  const rows = [...keys].reverse();
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>
          <th style={th}>{(rows[0]?.length ?? 0) > 7 ? t("au.trend.date") : t("au.trend.month")}</th>
          {providers.map((p) => (
            <th key={p} style={{ ...th, textAlign: "right" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colorFor(p), display: "inline-block" }} />{p}
              </span>
            </th>
          ))}
          <th style={{ ...th, textAlign: "right" }} title={t("au.trend.totalNote")}>{t("au.trend.total")}</th>
        </tr></thead>
        <tbody>
          {rows.map((k) => {
            // 全 provider 总和（含未进 Top-8 的长尾），与图表柱顶标签同口径
            const total = [...(buckets.get(k)?.values() ?? [])].reduce((s, x) => s + x, 0);
            return (
              <tr key={k}>
                <td style={td}>{k}</td>
                {providers.map((p) => {
                  const v = buckets.get(k)?.get(p) ?? 0;
                  return <td key={p} style={{ ...td, textAlign: "right", color: v > 0 ? undefined : "var(--text-dim)" }}>{v > 0 ? fmtN(v) : "—"}</td>;
                })}
                <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmtN(total)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TrendCard({ months, points, view, onViewChange }: {
  months: boolean; points: SeriesPoint[];
  view: "chart" | "table"; onViewChange: (v: "chart" | "table") => void;
}) {
  return (
    <div style={{ ...card, padding: "12px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>
          {months ? t("au.trend.byMonth") : t("au.trend.byDay")}
          {view === "chart" ? `（${t("au.trend.stackNote")}）` : ""}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["chart", "table"] as const).map((v) => (
            <button key={v} onClick={() => onViewChange(v)}
              style={{ ...ghostBtn, ...(view === v ? { background: "var(--bg-hover)", color: "var(--text)", fontWeight: 600 } : {}) }}>
              {v === "chart" ? t("au.trend.chart") : t("au.trend.table")}
            </button>
          ))}
        </div>
      </div>
      {view === "chart"
        ? <StackedBars points={points} />
        : <TrendTable points={points} />}
    </div>
  );
}

// ---------------------------------------------------------------- 标签页：总览

function OverviewTab({ range, custom, trendView, onTrendViewChange, filters }: {
  range: RangeKey; custom: CustomRange; trendView: "chart" | "table"; onTrendViewChange: (v: "chart" | "table") => void; filters: Filters;
}) {
  const q = buildQuery(range, custom, filters);
  const { data, err } = useFetch<any>(q === null ? null : `/overview${q}`, [range, q]);
  if (q === null) return <PickHint />;
  if (err) return <Err msg={err} />;
  if (!data) return <Loading />;
  const f = data.fixed ?? {};
  const caliberSession = t("au.caliber.session");
  return (
    <div style={{ overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
      {/* 固定窗口统一卡：今天 / 近7天 / 近30天 / 全部（tokens/cost/msgs 会话口径 + reqs 代理口径，同构） */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {(["today", "week", "days30", "all"] as const).map((k) => {
          const labels = { today: t("au.range.today"), week: t("au.range.7d"), days30: t("au.range.30d"), all: t("au.all") };
          const w = (f as any)[k] ?? {};
          return (
            <div key={k} style={{ ...card, minWidth: 150 }}>
              <div style={kpiLabel}>{labels[k]}</div>
              <div style={kpiValue}>{fmtN(w.tokens)}</div>
              <div style={kpiLabel} title={fxNote() ? `${caliberSession}（${fxNote()}）` : caliberSession}>{fmtCost(w.cost)} · {fmtN(w.msgs)} {t("au.msgs")}</div>
              <div style={kpiLabel} title={t("au.input.note")}>{fmtN(w.userMsgs)} {t("au.input.short")}{Number(w.userQuoted) > 0 ? ` · ${fmtN(w.userQuoted)} ${t("au.input.quotedShort")}` : ""}</div>
              <div style={kpiLabel} title={t("au.caliber.proxy")}>{fmtN(w.reqs)} {t("au.requests")}{Number(w.err429) > 0 ? ` · ${fmtN(w.err429)} ${t("au.rateLimit")}` : ""}</div>
            </div>
          );
        })}
      </div>

      {/* 趋势粒度跟随实际 bucket（自定义跨度 >60 天时后端返回月粒度） */}
      <TrendCard months={(data.series ?? []).some((s: any) => String(s.bucket ?? "").length === 7)}
        points={(data.series ?? []).map((s: any) => ({ bucket: s.bucket, provider: s.provider, tokens: s.tokens }))}
        view={trendView} onViewChange={onTrendViewChange} />

      <div style={{ ...card, padding: "12px 16px" }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Top 模型</div>
        {(data.topModels ?? []).length === 0 ? <Empty /> :
          dedupeBy(data.topModels ?? [], (m: any) => `${m.agent}/${m.provider}/${m.model}`).map((m: any) => (
            <div key={`${m.agent}/${m.provider}/${m.model}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12 }}>
              {m.agent !== "pi" && <span style={{ color: "var(--accent)", fontSize: 10, border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px", whiteSpace: "nowrap" }}>{m.agent}</span>}
              <span style={{ color: "var(--text-dim)", width: 110, overflow: "hidden", textOverflow: "ellipsis" }}>{m.provider}</span>
              <span style={{ fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{m.model}</span>
              <span style={{ color: "var(--text-dim)" }}>{fmtN(m.msgs)} msgs</span>
              <span style={{ width: 70, textAlign: "right" }}>{fmtN(m.tokens)}</span>
              <span style={{ width: 64, textAlign: "right" }}>{fmtCost(m.cost)}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 标签页：用户输入

/** 每日柱：全高 = 消息数，深色段 = 含引用消息（hover 显示数字）。 */
function InputBars({ points }: { points: Array<{ bucket: string; msgs: number; quoted: number }> }) {
  const W = 860, H = 170, padL = 38, padB = 20, padT = 8;
  const max = Math.max(1, ...points.map((p) => Number(p.msgs)));
  const n = Math.max(1, points.length);
  const step = (W - padL - 8) / n;
  const bw = Math.max(2, step - 2);
  const y = (v: number) => H - padB - (v / max) * (H - padB - padT);
  const ticks = [0.5, 1].map((f) => Math.round(max * f));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 170 }}>
      {ticks.map((tv, i) => (
        <g key={i}>
          <line x1={padL} x2={W - 6} y1={y(tv)} y2={y(tv)} stroke="var(--border)" strokeDasharray="3 4" />
          <text x={padL - 5} y={y(tv) + 3} fontSize={9} fill="var(--text-dim)" textAnchor="end">{fmtN(tv)}</text>
        </g>
      ))}
      {points.map((p, i) => {
        const x = padL + i * step;
        const hAll = Math.max(1, H - padB - y(p.msgs));
        const hQ = Math.max(0, H - padB - y(p.quoted));
        return (
          <g key={p.bucket}>
            <title>{`${p.bucket}: ${p.msgs} (quoted ${p.quoted})`}</title>
            <rect x={x} y={y(p.msgs)} width={bw} height={hAll} rx={2} fill="var(--border)" />
            {hQ > 0 && <rect x={x} y={y(p.quoted)} width={bw} height={hQ} rx={2} fill="#6366f1" />}
          </g>
        );
      })}
      {points.length > 0 && (
        <>
          <text x={padL} y={H - 6} fontSize={9} fill="var(--text-dim)">{points[0].bucket}</text>
          <text x={W - 6} y={H - 6} fontSize={9} fill="var(--text-dim)" textAnchor="end">{points[points.length - 1].bucket}</text>
        </>
      )}
    </svg>
  );
}

/**
 * 标签页：用户输入（userstat 端点）。
 * 口径：会话 JSONL 的 role=user 消息（fork 副本按消息 id 去重）；kind=human 为主口径，
 * 自动会话（subagent/扩展注入）与导入会话单独计数。引用格式识别见 lib/user-quotes.ts。
 */
function InputTab({ range, custom }: { range: RangeKey; custom: CustomRange }) {
  const q = rangeQuery(range, custom);
  const { data, err } = useFetch<any>(q === null ? null : `/userstat${q}`, [range, q]);
  if (q === null) return <PickHint />;
  if (err) return <Err msg={err} />;
  if (!data) return <Loading />;
  const totals = data.totals ?? {};
  const series: Array<{ bucket: string; msgs: number; quoted: number }> = data.series ?? [];
  const byKind: Record<string, number> = Object.fromEntries(
    (data.byKind ?? []).map((r: any) => [String(r.kind), Number(r.msgs)]));
  const kindLabel: Record<string, string> = {
    human: t("au.input.human"), agent: t("au.input.agent"), external: t("au.input.external"),
  };
  const quoteKinds: Array<{ kind: string; msgs: number }> = data.quoteKinds ?? [];
  const workspaces: Array<{ cwd: string; msgs: number; quoted: number }> = data.workspaces ?? [];
  const maxKind = Math.max(1, ...quoteKinds.map((k) => Number(k.msgs)));
  const kpis: Array<{ label: string; value: string; sub: string }> = [
    { label: t("au.input.total"), value: fmtN(totals.msgs), sub: `${fmtN(totals.sessions)} ${t("au.input.sessions")}` },
    { label: t("au.input.quoted"), value: fmtN(totals.quoted), sub: `${Math.round(100 * Number(totals.quoteRate ?? 0))}% ${t("au.input.quoteRate")}` },
    { label: t("au.input.quoteLines"), value: fmtN(totals.quoteLines), sub: quoteKinds.length ? `${quoteKinds.length} ${t("au.input.kinds")}` : "—" },
    { label: t("au.input.avgChars"), value: fmtN(totals.avgChars), sub: `${fmtN(totals.chars)} ${t("au.input.chars")}` },
  ];
  return (
    <div style={{ overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {kpis.map((k) => (
          <div key={k.label} style={{ ...card, minWidth: 150 }}>
            <div style={kpiLabel}>{k.label}</div>
            <div style={kpiValue}>{k.value}</div>
            <div style={kpiLabel}>{k.sub}</div>
          </div>
        ))}
        <div style={{ ...card, minWidth: 150 }}>
          <div style={kpiLabel}>{`${t("au.input.human")} / ${t("au.input.agent")} / ${t("au.input.external")}`}</div>
          <div style={{ ...kpiValue, fontSize: 14 }}>
            {["human", "agent", "external"].map((k) => `${fmtN(byKind[k] ?? 0)}`).join(" / ")}
          </div>
          <div style={kpiLabel}>{`${kindLabel.human} / ${kindLabel.agent} / ${kindLabel.external}`}</div>
        </div>
      </div>

      <div style={{ ...card, padding: "12px 16px" }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
          {t("au.input.byDay")}
          <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 10, color: "var(--text-dim)" }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "#6366f1", marginRight: 3 }} />
            {t("au.input.quoted")} · <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: "var(--border)", margin: "0 3px 0 8px" }} />{t("au.input.total")}
          </span>
        </div>
        {series.length === 0 ? <Empty /> : <InputBars points={series} />}
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div style={{ ...card, flex: 1, minWidth: 280 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t("au.input.kinds")}</div>
          {quoteKinds.length === 0 ? <Empty /> : quoteKinds.map((k) => (
            <div key={k.kind} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12 }}>
              <span style={{ width: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t(`au.quote.${k.kind}`)}
              </span>
              <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
                <div style={{ width: `${(Number(k.msgs) / maxKind) * 100}%`, height: "100%", background: colorFor(k.kind) }} />
              </div>
              <span style={{ width: 44, textAlign: "right", color: "var(--text-dim)" }}>{fmtN(k.msgs)}</span>
            </div>
          ))}
        </div>
        <div style={{ ...card, flex: 1, minWidth: 280 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{t("au.input.workspaces")}</div>
          {workspaces.length === 0 ? <Empty /> : workspaces.map((w) => (
            <div key={w.cwd} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12 }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)" }} title={w.cwd}>
                {w.cwd}
              </span>
              <span>{fmtN(w.msgs)}</span>
              {Number(w.quoted) > 0 && <span style={{ color: "#6366f1", fontSize: 10 }}>↩{fmtN(w.quoted)}</span>}
            </div>
          ))}
        </div>
      </div>

      <div style={{ fontSize: 10, color: "var(--text-dim)", lineHeight: 1.6 }}>{t("au.input.note")}</div>
    </div>
  );
}

// ---------------------------------------------------------------- 标签页：模型

function ModelsTab({ range, custom, filters }: { range: RangeKey; custom: CustomRange; filters: Filters }) {
  const q = buildQuery(range, custom, filters);
  const { data, err } = useFetch<any>(q === null ? null : `/models${q}`, [range, q]);
  // 条形列双口径：compare=与最大值比（对比），share=占总计百分比（占比）；列头点击切换
  const [ratioMode, setRatioMode] = useState<"compare" | "share">("compare");
  if (q === null) return <PickHint />;
  if (err) return <Err msg={err} />;
  if (!data) return <Loading />;
  const rows = data.rows ?? [];
  const maxTok = Math.max(1, ...rows.map((r: any) => r.totalTokens));
  const sumTok = Math.max(1, rows.reduce((s: number, r: any) => s + Number(r.totalTokens || 0), 0));
  const denom = ratioMode === "compare" ? maxTok : sumTok;
  return (
    <div style={{ overflowY: "auto", padding: "8px 16px" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>
          <th style={th}>agent</th><th style={th}>provider</th><th style={th}>model</th>
          <th style={{ ...th, textAlign: "right" }}>{t("au.msgs")}</th>
          <th style={{ ...th, textAlign: "right" }}>input</th>
          <th style={{ ...th, textAlign: "right" }}>output</th>
          <th style={{ ...th, textAlign: "right" }}>cacheRead</th>
          <th style={{ ...th, textAlign: "right" }}>{t("au.tokens")}</th>
          <th
            style={{ ...th, textAlign: "right", cursor: "pointer" }}
            onClick={() => setRatioMode((m) => (m === "compare" ? "share" : "compare"))}
            title="对比 = 相对最大值；占比 = 占所有模型总计的百分比（点击切换）"
          >
            <span style={{ display: "inline-flex", gap: 2 }}>
              <span style={ratioMode === "compare" ? { color: "var(--text)", fontWeight: 700 } : { opacity: 0.55 }}>对比</span>
              <span style={{ opacity: 0.55 }}>/</span>
              <span style={ratioMode === "share" ? { color: "var(--text)", fontWeight: 700 } : { opacity: 0.55 }}>占比</span>
            </span>
          </th>
          <th style={{ ...th, textAlign: "right" }}>{t("au.cost")}</th>
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={10} style={{ ...td, textAlign: "center", color: "var(--text-dim)" }}>{t("au.empty")}</td></tr>}
          {dedupeBy(rows, (r: any) => `${r.agent}/${r.provider}/${r.model}`).map((r: any) => (
            <tr key={`${r.agent}/${r.provider}/${r.model}`}>
              <td style={{ ...td, color: "var(--text-dim)" }}>{r.agent}</td>
              <td style={{ ...td, color: "var(--text-dim)" }}>
                {r.provider}
                {isCnyBillingProvider(r.provider) && <span title={t("au.cnyBilling")} style={{ marginLeft: 4, padding: "0 4px", borderRadius: 4, fontSize: 9, background: "rgba(234,179,8,0.15)", color: "#d97706", fontWeight: 700 }}>¥</span>}
              </td>
              <td style={{ ...td, fontWeight: 500 }}>{r.model}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtN(r.msgs)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtN(r.input)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtN(r.output)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtN(r.cacheRead)}</td>
              <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmtN(r.totalTokens)}</td>
              <td style={{ ...td, width: 140 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
                    <div style={{ width: `${(r.totalTokens / denom) * 100}%`, height: "100%", background: colorFor(`${r.provider}/${r.model}`) }} />
                  </div>
                  <span style={{ fontSize: 10, color: "var(--text-dim)", width: 34 }}>{Math.round(100 * r.totalTokens / denom)}%</span>
                </div>
              </td>
              <td style={{ ...td, textAlign: "right" }}>{fmtCost(r.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- 标签页：Keys

function KeysTab({ range, custom, filters }: { range: RangeKey; custom: CustomRange; filters: Filters }) {
  const q = buildQuery(range, custom, filters);
  const { data, err } = useFetch<any>(q === null ? null : `/keys${q}`, [range, q]);
  if (q === null) return <PickHint />;
  if (err) return <Err msg={err} />;
  if (!data) return <Loading />;
  const rows = data.rows ?? [];
  const maxReq = Math.max(1, ...rows.map((r: any) => r.reqs));
  return (
    <div style={{ overflowY: "auto", padding: "8px 16px" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", margin: "4px 0 8px" }}>
        代理口径：仅统计经 pi-models-combo 多 key 轮转代理的请求；sessions 列经 client token 归因。
      </div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>
          <th style={th}>provider</th><th style={th}>key</th>
          <th style={{ ...th, textAlign: "right" }}>{t("au.requests")}</th>
          <th style={{ ...th, textAlign: "right" }}>ok</th>
          <th style={{ ...th, textAlign: "right" }}>{t("au.rateLimit")}</th>
          <th style={{ ...th, textAlign: "right" }}>{t("au.rateLimitPct")}</th>
          <th style={{ ...th, textAlign: "right" }}>input</th>
          <th style={{ ...th, textAlign: "right" }}>output</th>
          <th style={{ ...th, textAlign: "right" }}>cacheRead</th>
          <th style={{ ...th, textAlign: "right" }}>会话数</th>
        </tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={10} style={{ ...td, textAlign: "center", color: "var(--text-dim)" }}>{t("au.empty")}</td></tr>}
          {dedupeBy(rows, (r: any) => `${r.provider}/${r.keyName}`).map((r: any) => (
            <tr key={`${r.provider}/${r.keyName}`}>
              <td style={{ ...td, color: "var(--text-dim)" }}>{r.provider}</td>
              <td style={{ ...td, fontWeight: 500 }}>{r.keyName || "(direct)"}</td>
              <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmtN(r.reqs)}</td>
              <td style={{ ...td, textAlign: "right" }}>{fmtN(r.ok)}</td>
              <td style={{ ...td, textAlign: "right", color: r.err429 > 0 ? "#f59e0b" : undefined }}>{fmtN(r.err429)}</td>
              <td style={{ ...td, textAlign: "right" }}>{r.reqs ? Math.round(100 * r.err429 / r.reqs) : 0}%</td>
              <td style={{ ...td, textAlign: "right" }}>{r.input != null ? fmtN(r.input) : "—"}</td>
              <td style={{ ...td, textAlign: "right" }}>{r.output != null ? fmtN(r.output) : "—"}</td>
              <td style={{ ...td, textAlign: "right" }}>{r.cacheRead != null ? fmtN(r.cacheRead) : "—"}</td>
              <td style={{ ...td, textAlign: "right" }}>{r.sessions || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- 标签页：维度透视

type PivotDim = "workspace" | "provider" | "model" | "agent" | "key" | "hour" | "day";
const PIVOT_DIMS: PivotDim[] = ["workspace", "provider", "model", "agent", "key", "hour", "day"];
const dimLabel = (d: PivotDim | "") => (d ? t(`au.dim.${d}`) : t("au.pivot.none"));

/** cwd 全路径 → 显示名（末段）；空 → (未知)。 */
function baseName(p: string): string {
  if (!p) return "(未知)";
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
const dimText = (dim: string, v: string): string =>
  dim === "workspace" ? baseName(v) : dim === "hour" ? String(parseInt(v, 10) || 0) : v;
// 自然序维度：hour 按数值 0-23、day 按日期；其余（workspace/provider/model/key）按值大小排
const isNatDim = (d: string) => d === "hour" || d === "day";
const natCmp = (dim: string) => (a: string, b: string) => {
  const ka = dim === "hour" ? parseInt(a, 10) || 0 : a;
  const kb = dim === "hour" ? parseInt(b, 10) || 0 : b;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};
const metricVal = (row: any, metric: string): number => Number(row?.[metric] ?? 0);
function fmtMetric(v: number, metric: string): string {
  return metric === "cost" ? fmtCost(v) : fmtN(v);
}
type MatrixRow = Record<string, any>;

/** 单序列垂直柱图（hour 0-23 时段分布用）。 */
function HourBars({ values, metric }: { values: number[]; metric: string }) {
  const max = Math.max(1, ...values);
  const W = 1000, H = 190, padL = 46, padB = 22, padT = 10;
  const bw = (W - padL - 14) / 24 - 6;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={padL} x2={W - 6} y1={padT + (H - padT - padB) * f} y2={padT + (H - padT - padB) * f}
            stroke="var(--border)" strokeWidth={1} />
          <text x={padL - 6} y={padT + (H - padT - padB) * f + 4} textAnchor="end" fontSize={10} fill="var(--text-dim)">
            {fmtMetric(max * (1 - f), metric)}
          </text>
        </g>
      ))}
      {values.map((v, h) => {
        const x = padL + 8 + h * ((W - padL - 20) / 24);
        const hh = Math.max(v > 0 ? 1 : 0, (v / max) * (H - padT - padB));
        return (
          <g key={h}>
            <rect x={x} y={H - padB - hh} width={bw} height={hh} rx={2} fill={colorFor(String(h))} opacity={v > 0 ? 1 : 0.25}>
              <title>{`${h}:00–${h + 1}:00 · ${fmtMetric(v, metric)}`}</title>
            </rect>
            {h % 3 === 0 && (
              <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--text-dim)">{h}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** 横条占比列表（单维，非 hour）。 */
function HBarList({ items, metric }: { items: Array<{ label: string; full: string; value: number }>; metric: string }) {
  const total = items.reduce((s, it) => s + it.value, 0);
  const max = Math.max(1, ...items.map((it) => it.value));
  return (
    <div>
      {items.map((it) => (
        <div key={it.full} title={it.full !== it.label ? it.full : undefined}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 12 }}>
          <span style={{ width: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>{it.label}</span>
          <div style={{ flex: 1, height: 10, borderRadius: 5, background: "var(--border)", overflow: "hidden" }}>
            <div style={{ width: `${(it.value / max) * 100}%`, height: "100%", background: colorFor(it.full) }} />
          </div>
          <span style={{ width: 64, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtMetric(it.value, metric)}</span>
          <span style={{ width: 44, textAlign: "right", color: "var(--text-dim)", fontSize: 11 }}>
            {total > 0 ? Math.round((100 * it.value) / total) : 0}%
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 交叉热力表（N 维泛化）：行 = 前 N-1 维组合（"a · b"），列 = 最后一维
 * （Top 12 + 其他；最后一维为 hour 时补全 0-23）；行/列合计 + 单元格热力着色。指标取单值。
 */
function MatrixTable({ rows, dims, metric }: {
  rows: MatrixRow[]; dims: string[]; metric: string;
}) {
  const last = dims.length - 1;
  const rowKeyOf = (r: MatrixRow) => dims.slice(0, last).map((_, i) => String(r[`d${i + 1}`] ?? "")).join("\u0001");
  const rowLabelOf = (r: MatrixRow) => dims.slice(0, last).map((_, i) => dimText(dims[i], String(r[`d${i + 1}`] ?? ""))).join(" · ");
  const model = useMemo(() => {
    const cells = new Map<string, Map<string, number>>();
    const rowMeta = new Map<string, { label: string; full: string[] }>();
    const colTot = new Map<string, number>();
    let max = 0;
    for (const r of rows) {
      const v = metricVal(r, metric);
      const rk = rowKeyOf(r);
      if (!cells.has(rk)) {
        cells.set(rk, new Map());
        rowMeta.set(rk, { label: rowLabelOf(r), full: dims.slice(0, last).map((_, i) => String(r[`d${i + 1}`] ?? "")) });
      }
      const col = String(r[`d${last + 1}`] ?? "");
      cells.get(rk)!.set(col, (cells.get(rk)!.get(col) ?? 0) + v);
      colTot.set(col, (colTot.get(col) ?? 0) + v);
      if (v > max) max = v;
    }
    // 列维度：hour 补全 0-23、day 按日期自然序；其余按列合计取 Top 12，剩余归「其他」
    let cols: string[];
    let others: string[] = [];
    if (dims[last] === "hour") {
      cols = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
    } else {
      const sorted = [...colTot.entries()].sort((a, b) => b[1] - a[1]);
      cols = sorted.slice(0, 12).map(([c]) => c);
      if (dims[last] === "day") cols.sort(natCmp("day"));
      others = sorted.slice(12).map(([c]) => c);
    }
    const rowEntries = [...cells.entries()]
      .map(([rk, m]) => [rk, [...m.values()].reduce((s, v) => s + v, 0)] as const)
      .sort((a, b) => b[1] - a[1]);
    // 单行维度且为 hour/day 时按自然序（0-23 / 日期升序），其余组合行按合计降序
    if (last === 1 && isNatDim(dims[0])) rowEntries.sort((a, b) => natCmp(dims[0])(a[0], b[0]));
    const rowKeys = rowEntries.map(([rk]) => rk);
    return { cells, rowMeta, cols, others, rowKeys, max };
  }, [rows, dims, metric]);

  if (model.rowKeys.length === 0) return <Empty />;
  const heat = (v: number): string | undefined =>
    v <= 0 ? undefined : `rgba(99,102,241,${(0.08 + 0.42 * (v / model.max)).toFixed(3)})`;
  const cellOf = (rk: string, col: string): number => model.cells.get(rk)?.get(col) ?? 0;
  const sum = (rk: string): number => [...(model.cells.get(rk)?.values() ?? [])].reduce((s, v) => s + v, 0);
  const colSum = (col: string): number => model.rowKeys.reduce((s, rk) => s + cellOf(rk, col), 0);
  const grand = model.rowKeys.reduce((s, rk) => s + sum(rk), 0);
  const headLabel = dims.slice(0, last).map((d) => dimLabel(d as PivotDim)).join(" / ");
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>
          <th style={{ ...th, position: "sticky", left: 0, background: "var(--bg-panel)" }}>{`${headLabel} \ ${dimLabel(dims[last] as PivotDim)}`}</th>
          {model.cols.map((c) => <th key={c} style={{ ...th, textAlign: "right" }}>{dimText(dims[last], c)}</th>)}
          {model.others.length > 0 && <th style={{ ...th, textAlign: "right" }} title={model.others.map((c) => dimText(dims[last], c)).join("\n")}>{`${t("au.pivot.other")}(${model.others.length})`}</th>}
          <th style={{ ...th, textAlign: "right" }}>{t("au.trend.total")}</th>
        </tr></thead>
        <tbody>
          {model.rowKeys.map((rk) => {
            const meta = model.rowMeta.get(rk)!;
            const othersSum = model.others.reduce((s, c) => s + cellOf(rk, c), 0);
            return (
              <tr key={rk}>
                <td style={{ ...td, position: "sticky", left: 0, background: "var(--bg-panel)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}
                  title={meta.full.filter((f) => f).join("\n")}>{meta.label}</td>
                {model.cols.map((c) => {
                  const v = cellOf(rk, c);
                  return (
                    <td key={c} style={{ ...td, textAlign: "right", background: heat(v), color: v <= 0 ? "var(--text-dim)" : undefined }}
                      title={`${meta.label} × ${dimText(dims[last], c)}`}>{v > 0 ? fmtMetric(v, metric) : "—"}</td>
                  );
                })}
                {model.others.length > 0 && (
                  <td style={{ ...td, textAlign: "right", background: heat(othersSum), color: othersSum <= 0 ? "var(--text-dim)" : undefined }}>
                    {othersSum > 0 ? fmtMetric(othersSum, metric) : "—"}
                  </td>
                )}
                <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmtMetric(sum(rk), metric)}</td>
              </tr>
            );
          })}
          <tr>
            <td style={{ ...td, position: "sticky", left: 0, background: "var(--bg-panel)", fontWeight: 600 }}>{t("au.trend.total")}</td>
            {model.cols.map((c) => <td key={c} style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmtMetric(colSum(c), metric)}</td>)}
            {model.others.length > 0 && <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmtMetric(model.others.reduce((s, c) => s + colSum(c), 0), metric)}</td>}
            <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{fmtMetric(grand, metric)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** 扁平明细表：所有维度列 × 选中指标列，点列头排序；大结果集截断提示。 */
function FlatTable({ rows, dims, metrics }: { rows: MatrixRow[]; dims: string[]; metrics: string[] }) {
  const [sortRaw, setSort] = useState<{ k: string; dir: 1 | -1 }>({ k: `m:${metrics[0]}`, dir: -1 });
  // 口径/指标变化后 sortRaw.k 可能指向已不存在的列 —— 派生时回落到第一个指标，避免排序失效
  const validKeys = new Set([...dims.map((_, i) => `d${i + 1}`), ...metrics.map((m) => `m:${m}`)]);
  const sort = validKeys.has(sortRaw.k) ? sortRaw : { k: `m:${metrics[0]}`, dir: -1 as 1 | -1 };
  const cols: Array<{ key: string; label: string; kind: "dim" | "metric"; name: string; idx?: number }> = [
    ...dims.map((d, i) => ({ key: `d${i + 1}`, label: dimLabel(d as PivotDim), kind: "dim" as const, name: d, idx: i + 1 })),
    ...metrics.map((m) => ({ key: `m:${m}`, label: t(`au.metric.${m}`), kind: "metric" as const, name: m })),
  ];
  const sorted = useMemo(() => {
    const arr = [...rows];
    const { k, dir } = sort;
    arr.sort((a, b) => {
      if (k.startsWith("d")) {
        const i = +k.slice(1);
        return String(a[`d${i}`] ?? "").localeCompare(String(b[`d${i}`] ?? ""), undefined, { numeric: true }) * dir;
      }
      return (metricVal(a, k.slice(2)) - metricVal(b, k.slice(2))) * dir;
    });
    return arr;
  }, [rows, sort]);
  const LIMIT = 500;
  const shown = sorted.slice(0, LIMIT);
  const clickSort = (c: typeof cols[number]) =>
    setSort((s) => (s.k === c.key ? { k: c.key, dir: (s.dir * -1) as 1 | -1 } : { k: c.key, dir: c.kind === "dim" ? 1 : -1 }));
  if (rows.length === 0) return <Empty />;
  return (
    <div style={{ overflowX: "auto" }}>
      {sorted.length > LIMIT && (
        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "2px 4px 6px" }}>
          {`${t("au.pivot.rowsTruncated")}（${LIMIT}/${sorted.length}）`}
        </div>
      )}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>
          {cols.map((c) => (
            <th key={c.key} onClick={() => clickSort(c)}
              style={{ ...th, textAlign: c.kind === "dim" ? "left" : "right", cursor: "pointer", userSelect: "none" }}
              title={`${c.label}（${t("au.pivot.sort")}）`}>
              {c.label}{sort.k === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
            </th>
          ))}
        </tr></thead>
        <tbody>
          {shown.map((r, ri) => (
            <tr key={ri}>
              {cols.map((c) => c.kind === "dim" ? (
                <td key={c.key} style={{ ...td, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}
                  title={String(r[`d${c.idx}`] ?? "")}>{dimText(c.name, String(r[`d${c.idx}`] ?? ""))}</td>
              ) : (
                <td key={c.key} style={{ ...td, textAlign: "right", fontWeight: c.name === metrics[0] ? 600 : undefined }}>
                  {fmtMetric(metricVal(r, c.name), c.name)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- 桑基图（手写 SVG，零依赖）

const SANKEY_TOP_N = 10;
const OTHER_KEY = "\u0002other";
/** 桑基显示文本：「其他」聚合节点用 i18n 名，其余走 dimText。 */
const sankeyText = (dim: string, k: string) => (k === OTHER_KEY ? t("au.pivot.other") : dimText(dim, k));

/**
 * 桑基图：维度链 d1 → d2 → … → dn，节点 = 各维 TopN 值（其余归「其他」），
 * 边流量 = 选中指标聚合。hover 显示数值。
 */
function Sankey({ rows, dims, metric }: { rows: MatrixRow[]; dims: string[]; metric: string }) {
  const L = dims.length;
  const model = useMemo(() => {
    if (L < 2 || rows.length === 0) return null;
    // 1) 每层节点聚合 → 自然序维度（hour 全 24 / day ≤31）全量保留，其余 TopN + 其他
    const layerTot: Array<Map<string, number>> = dims.map((_, i) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const k = String(r[`d${i + 1}`] ?? "");
        m.set(k, (m.get(k) ?? 0) + metricVal(r, metric));
      }
      return m;
    });
    const NAT_LIMIT: Record<string, number> = { hour: 24, day: 31 };
    const topKeys = layerTot.map((m, i) => {
      const all = [...m.entries()];
      if (isNatDim(dims[i])) {
        if (all.length <= NAT_LIMIT[dims[i]]) {
          all.sort((a, b) => natCmp(dims[i])(a[0], b[0]));
          return all.map(([k]) => k);
        }
        // 超上限（如 all 范围的多年 day）仍按值截断
        return all.sort((a, b) => b[1] - a[1]).slice(0, SANKEY_TOP_N).map(([k]) => k);
      }
      return all.sort((a, b) => b[1] - a[1]).slice(0, SANKEY_TOP_N).map(([k]) => k);
    });
    const norm = (i: number, k: string) => (topKeys[i].includes(k) ? k : OTHER_KEY);
    // 2) 相邻层 links 聚合（分隔符用控制字符，避免维度值含 | 时错位）
    const linkTot = new Map<string, number>();
    for (let i = 0; i + 1 < L; i++) {
      for (const r of rows) {
        const v = metricVal(r, metric);
        if (v <= 0) continue;
        const key = `${i}\u0001${norm(i, String(r[`d${i + 1}`] ?? ""))}\u0001${norm(i + 1, String(r[`d${i + 2}`] ?? ""))}`;
        linkTot.set(key, (linkTot.get(key) ?? 0) + v);
      }
    }
    // 3) 布局
    const W = 1000, H = 430, nodeW = 12, gap = 4, padT = 16, padX = 56;
    const totals = layerTot.map((m) => [...m.values()].reduce((s, v) => s + v, 0));
    const unit = (H - padT * 2 - (SANKEY_TOP_N + 1) * gap) / Math.max(1, ...totals);
    const nodes = dims.map((_, i) => {
      const items = topKeys[i].map((k) => ({ key: k, label: dimText(dims[i], k), value: layerTot[i].get(k) ?? 0 }));
      // hour/day 层内按自然序（时段 0→23 / 日期升序），其余按值降序（topKeys 已序）
      if (isNatDim(dims[i])) items.sort((a, b) => natCmp(dims[i])(a.key, b.key));
      const otherV = totals[i] - items.reduce((s, it) => s + it.value, 0);
      if (otherV > 0) items.push({ key: OTHER_KEY, label: t("au.pivot.other"), value: otherV });
      let y = padT;
      const x = padX + (i * (W - padX * 2 - nodeW)) / Math.max(1, L - 1);
      return items.map((it) => {
        const h = Math.max(2, it.value * unit);
        const node = { ...it, x, y0: y, y1: y + h };
        y += h + gap;
        return node;
      });
    });
    const posOf = (i: number, k: string) => nodes[i].find((n) => n.key === k);
    // 4) 边两端 offset：source 侧按 target y 序，target 侧按 source y 序
    type Edge = { i: number; sk: string; tk: string; v: number; sy0: number; sy1: number; ty0: number; ty1: number };
    const edges: Edge[] = [];
    const bySrc = new Map<string, Edge[]>();
    const byDst = new Map<string, Edge[]>();
    for (const [k, v] of linkTot) {
      const [i, sk, tk] = k.split("\u0001");
      const e: Edge = { i: +i, sk, tk, v, sy0: 0, sy1: 0, ty0: 0, ty1: 0 };
      edges.push(e);
      const ks = `${e.i}|${e.sk}`, kd = `${e.i + 1}|${e.tk}`;
      if (!bySrc.has(ks)) bySrc.set(ks, []);
      if (!byDst.has(kd)) byDst.set(kd, []);
      bySrc.get(ks)!.push(e);
      byDst.get(kd)!.push(e);
    }
    for (const [ks, es] of bySrc) {
      const [i, sk] = ks.split("|");
      const node = posOf(+i, sk);
      if (!node) continue;
      es.sort((a, b) => (posOf(+i + 1, a.tk)?.y0 ?? 0) - (posOf(+i + 1, b.tk)?.y0 ?? 0));
      let y = node.y0;
      for (const e of es) { e.sy0 = y; y += e.v * unit; e.sy1 = y; }
    }
    for (const [kd, es] of byDst) {
      const [i, tk] = kd.split("|");
      const node = posOf(+i, tk);
      if (!node) continue;
      es.sort((a, b) => (posOf(+i - 1, a.sk)?.y0 ?? 0) - (posOf(+i - 1, b.sk)?.y0 ?? 0));
      let y = node.y0;
      for (const e of es) { e.ty0 = y; y += e.v * unit; e.ty1 = y; }
    }
    return { nodes, edges, W, H, nodeW, maxTotal: Math.max(1, ...totals) };
  }, [rows, dims, metric]);

  if (!model) return <Empty />;
  const { nodes, edges, W, H, nodeW } = model;
  return (
    <div style={{ ...card, padding: "12px 16px" }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        {dims.map((d) => dimLabel(d as PivotDim)).join(" → ")}
        <span style={{ fontWeight: 400, color: "var(--text-dim)", marginLeft: 8 }}>{`· ${t("au.metric." + metric)}`}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
        {edges.map((e, ei) => {
          const sn = nodes[e.i].find((n) => n.key === e.sk);
          const tn = nodes[e.i + 1].find((n) => n.key === e.tk);
          if (!sn || !tn) return null;
          const x0 = sn.x + nodeW, x1 = tn.x, mx = (x0 + x1) / 2;
          return (
            <path key={ei}
              d={`M ${x0} ${e.sy0} C ${mx} ${e.sy0} ${mx} ${e.ty0} ${x1} ${e.ty0} L ${x1} ${e.ty1} C ${mx} ${e.ty1} ${mx} ${e.sy1} ${x0} ${e.sy1} Z`}
              fill={colorFor(e.sk === OTHER_KEY ? "__other__" : e.sk)} opacity={0.22}
              onMouseEnter={(ev) => { (ev.currentTarget as SVGPathElement).style.opacity = "0.5"; }}
              onMouseLeave={(ev) => { (ev.currentTarget as SVGPathElement).style.opacity = "0.22"; }}>
              <title>{`${sankeyText(dims[e.i], e.sk)} → ${sankeyText(dims[e.i + 1], e.tk)}\n${fmtMetric(e.v, metric)}`}</title>
            </path>
          );
        })}
        {nodes.map((layer, i) => layer.map((n) => (
          <g key={`${i}:${n.key}`}>
            <rect x={n.x} y={n.y0} width={nodeW} height={Math.max(2, n.y1 - n.y0)} rx={2}
              fill={colorFor(n.key === OTHER_KEY ? "__other__" : n.key)}>
              <title>{`${dimLabel(dims[i] as PivotDim)}: ${n.label}\n${fmtMetric(n.value, metric)}`}</title>
            </rect>
            <text x={i === nodes.length - 1 ? n.x - 5 : n.x + nodeW + 5}
              y={n.y0 + (n.y1 - n.y0) / 2 + 3}
              textAnchor={i === nodes.length - 1 ? "end" : "start"}
              fontSize={9} fill="var(--text-dim)">
              {n.label}{n.value >= model.maxTotal * 0.03 ? ` · ${fmtMetric(n.value, metric)}` : ""}
            </text>
          </g>
        )))}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- CSV 导出

function exportCsv(rows: MatrixRow[], dims: string[], metrics: string[], label: string) {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = [...dims.map((d) => t(`au.dim.${d}`)), ...metrics.map((m) => t(`au.metric.${m}`))];
  const lines = [head.map(esc).join(",")];
  for (const r of rows) {
    lines.push([...dims.map((_, i) => esc(String(r[`d${i + 1}`] ?? ""))),
      ...metrics.map((m) => String(metricVal(r, m)))].join(","));
  }
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `aiti-usage-${dims.join("_")}-${label.replace(/[^\w.-]+/g, "_")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const SESSION_METRICS = ["tokens", "cost", "msgs", "input", "output", "cacheRead"];
const PROXY_METRICS = ["reqs", "err429", "ok", "tokens", "input", "output"];

function PivotTab({ range, custom, filters }: { range: RangeKey; custom: CustomRange; filters: Filters }) {
  const [dims, setDims] = useState<PivotDim[]>(["workspace"]);
  const [metricSel, setMetricSel] = useState<string[]>([]);
  const [view, setView] = useState<"matrix" | "table" | "sankey">("matrix");
  const proxy = dims.includes("key");
  const availMetrics: string[] = proxy ? PROXY_METRICS : SESSION_METRICS;
  const selMetrics = metricSel.filter((m) => availMetrics.includes(m));
  const effMetrics = selMetrics.length ? selMetrics : [availMetrics[0]];

  const spanQ = rangeQuery(range, custom);
  const qs = useMemo(() => {
    const u = new URLSearchParams(spanQ === null ? "" : spanQ.slice(1));
    u.set("dims", dims.join(","));
    if (filters.provider) u.set("provider", filters.provider);
    if (filters.model) u.set("model", filters.model);
    return u.toString();
  }, [spanQ, dims, filters]);
  const { data, err } = useFetch<any>(spanQ === null ? null : `/matrix?${qs}`, [qs]);
  if (spanQ === null) return <PickHint />;

  const setDimAt = (i: number, v: PivotDim) => setDims((arr) => arr.map((d, j) => (j === i ? v : d)));
  const removeDimAt = (i: number) => setDims((arr) => (arr.length <= 1 ? arr : arr.filter((_, j) => j !== i)));
  const addDim = () => setDims((arr) => {
    const free = PIVOT_DIMS.find((d) => !arr.includes(d));
    return free ? [...arr, free] : arr;
  });
  const toggleMetric = (m: string) => setMetricSel((arr) => {
    const cur = arr.filter((x) => availMetrics.includes(x));
    const next = cur.includes(m) ? cur.filter((x) => x !== m) : [...cur, m];
    return next.length ? next : arr; // 不允许全部取消
  });

  const rows: MatrixRow[] = data?.rows ?? [];
  const selStyle = {
    padding: "3px 8px", borderRadius: 7, fontSize: 11, border: "1px solid var(--border)",
    background: "var(--bg-panel)", color: "inherit",
  } as const;
  const caliberNote = data?.caliber === "proxy" ? t("au.caliber.proxy") : data ? t("au.caliber.session") : "";
  const multi = dims.length >= 2;

  // 控制区（两行）：维度链（不限数，去重）+ 视图/导出；指标多选 chips —— 常驻，加载/出错也可重试
  const ctrl = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 11, color: "var(--text-dim)" }}>
        {dims.map((d, i) => (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
            {i > 0 && <span style={{ margin: "0 3px" }}>{view === "sankey" ? "→" : "×"}</span>}
            <select value={d} onChange={(e) => setDimAt(i, e.target.value as PivotDim)} style={selStyle}>
              {PIVOT_DIMS.filter((x) => x === d || !dims.includes(x)).map((x) => (
                <option key={x} value={x}>{t(`au.dim.${x}`)}</option>
              ))}
            </select>
            {dims.length > 1 && (
              <button onClick={() => removeDimAt(i)} aria-label="remove-dim" title={t("au.pivot.removeDim")}
                style={{ ...ghostBtn, padding: "1px 6px" }}>×</button>
            )}
          </span>
        ))}
        {dims.length < PIVOT_DIMS.length && (
          <button onClick={addDim} style={{ ...ghostBtn, color: "var(--accent)" }}>＋ {t("au.pivot.addDim")}</button>
        )}
        <span style={{ width: 1, height: 16, background: "var(--border)", margin: "0 2px" }} />
        {(["matrix", "table", "sankey"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)} disabled={!multi && v !== "table"}
            title={!multi && v !== "table" ? t("au.pivot.needTwoDims") : undefined}
            style={{ ...ghostBtn, ...(!multi && v !== "table" ? { opacity: 0.4, cursor: "not-allowed" } : {}),
              ...(multi && view === v ? { background: "var(--bg-hover)", color: "var(--text)", fontWeight: 600 } : {}) }}>
            {t(`au.pivot.view.${v}`)}
          </button>
        ))}
        <button onClick={() => data && exportCsv(rows, (data.dims as string[]) ?? dims, effMetrics, String(data.label))}
          disabled={!data} style={{ ...ghostBtn, ...(!data ? { opacity: 0.4 } : {}) }}>
          ⬇ {t("au.pivot.export")}
        </button>
        {data && (
          <span style={{ marginLeft: "auto" }} title={caliberNote}>
            {`${data.label} · ${caliberNote} · ${rows.length} ${t("au.pivot.rows")}`}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", fontSize: 11 }}>
        <span style={{ color: "var(--text-dim)", marginRight: 2 }}>{t("au.pivot.metric")}</span>
        {availMetrics.map((m) => (
          <button key={m} onClick={() => toggleMetric(m)}
            title={multi && view === "matrix" && selMetrics.length > 1 && m !== effMetrics[0]
              ? `${t("au.pivot.matrixSingle")}${t("au.metric." + effMetrics[0])}` : undefined}
            style={{ ...ghostBtn, ...(selMetrics.includes(m) ? { background: "var(--bg-hover)", color: "var(--text)", fontWeight: 600 } : {}) }}>
            {t(`au.metric.${m}`)}
          </button>
        ))}
        <button onClick={() => setMetricSel(availMetrics)}
          style={{ ...ghostBtn, ...(selMetrics.length === availMetrics.length ? { color: "var(--text)", fontWeight: 600 } : {}) }}>
          {t("au.pivot.allMetrics")}
        </button>
        {multi && view === "matrix" && selMetrics.length > 1 && (
          <span style={{ color: "var(--text-dim)", marginLeft: 4 }}>
            {`${t("au.pivot.matrixSingle")}${t("au.metric." + effMetrics[0])}`}
          </span>
        )}
      </div>
    </div>
  );

  const body = () => {
    if (!data) return <Loading />;
    if (err) return <Err msg={err} />;
    if (rows.length === 0) return <Empty />;
    if (dims.length === 1) {
      const d = dims[0];
      if (d === "hour") {
        return (
          <div style={{ ...card, padding: "12px 16px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{`${t("au.dim.hour")}（0–23 · ${t("au.pivot.localTime")}）`}</div>
            <HourBars metric={effMetrics[0]}
              values={Array.from({ length: 24 }, (_, h) => metricVal(rows.find((r) => r.d1 === String(h).padStart(2, "0")), effMetrics[0]))} />
          </div>
        );
      }
      // day 单维按日期升序；其余类别维度按值降序（后端已排序）
      const listRows = d === "day" ? [...rows].sort((a, b) => natCmp("day")(a.d1, b.d1)) : rows;
      return (
        <div style={{ ...card, padding: "12px 16px" }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>{dimLabel(d)}</div>
          <HBarList metric={effMetrics[0]} items={listRows.map((r) => ({ label: dimText(d, r.d1), full: r.d1, value: metricVal(r, effMetrics[0]) }))} />
        </div>
      );
    }
    if (view === "matrix") return <MatrixTable rows={rows} dims={dims} metric={effMetrics[0]} />;
    if (view === "table") return <FlatTable rows={rows} dims={dims} metrics={effMetrics} />;
    return <Sankey rows={rows} dims={dims} metric={effMetrics[0]} />;
  };

  // 截断说明（底部小字）：仅在实际发生截断时出现
  const notes: string[] = [];
  if (data && rows.length > 0 && dims.length >= 2) {
    if (view === "matrix") {
      const lastDim = dims[dims.length - 1];
      if (lastDim !== "hour") { // hour 永不截断；day 虽为自然序但也按值取 Top12，需提示
        const distinct = new Set(rows.map((r) => r[`d${dims.length}`])).size;
        if (distinct > 12) notes.push(`${t("au.pivot.truncCols")}（${t(`au.dim.${lastDim}`)}：${distinct} → 12）`);
      }
    }
    if (view === "sankey") {
      const parts = dims.map((d, i) => ({ d, i }))
        .filter(({ d, i }) => !isNatDim(d) && new Set(rows.map((r) => r[`d${i + 1}`])).size > SANKEY_TOP_N)
        .map(({ d }) => t(`au.dim.${d}`));
      if (parts.length) notes.push(`${t("au.pivot.truncSankey")}（${parts.join("、")}）`);
    }
    if (view === "table" && rows.length > 500) notes.push(`${t("au.pivot.rowsTruncated")}（500/${rows.length}）`);
  }

  return (
    <div style={{ overflowY: "auto", padding: "10px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
      {ctrl}
      {body()}
      {notes.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", padding: "0 4px" }}>
          {notes.map((n, i) => <div key={i}>{`※ ${n}`}</div>)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 标签页：趋势（自选维度 + 值 → 折线图）

type TrendDim = "provider" | "model" | "agent" | "workspace" | "key";
const TREND_DIMS: TrendDim[] = ["provider", "model", "agent", "workspace", "key"];
const TREND_MAX_VALUES = 12;
const UNKNOWN_WS = "(未知)";

interface TrendSeries {
  key: string;
  total: number;
  points: Array<{ bucket: string; value: number }>;
}

/** 值多选弹层：搜索 + 复选列表 + 全选/清除；cap 上限防图表爆炸。 */
function ValueMultiSelect({ options, selected, onChange }: {
  options: string[]; selected: string[]; onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const openAtRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      if (rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  const ql = q.toLowerCase();
  const filtered = options.filter((o) => o.toLowerCase().includes(ql));
  const toggle = (o: string) =>
    onChange(selected.includes(o)
      ? selected.filter((x) => x !== o)
      : selected.length >= TREND_MAX_VALUES ? selected : [...selected, o]);
  const label = selected.length
    ? `${t("au.trend.selected")} ${selected.length}${selected.length <= 2 ? `：${selected.join("、")}` : ""}`
    : t("au.trend.valuesHint");
  return (
    <span ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={(e) => {
          if (e.detail > 1) return;
          openAtRef.current = Date.now();
          setQ("");
          setOpen((v) => !v);
        }}
        title={t("au.trend.pickValues")}
        style={{ ...selectStyle, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", textAlign: "left", minWidth: 132 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <span style={{ opacity: 0.6, flexShrink: 0 }}>{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <span style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 60, display: "block",
          width: "max-content", minWidth: 240, maxWidth: 340,
          background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 9,
          boxShadow: "0 10px 32px rgba(0,0,0,0.35)", padding: 5,
        }}>
          <input value={q} onChange={(e) => setQ((e.target as HTMLInputElement).value)}
            placeholder={t("au.trend.search")}
            style={{ width: "100%", boxSizing: "border-box", padding: "4px 8px", borderRadius: 6,
              border: "1px solid var(--border)", background: "var(--bg-hover)", color: "inherit", fontSize: 11, outline: "none" }} />
          <div style={{ maxHeight: 240, overflowY: "auto", overscrollBehavior: "contain", marginTop: 4 }}>
            {filtered.map((o) => {
              const on = selected.includes(o);
              return (
                <label key={o} title={o}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 6px", borderRadius: 6,
                    cursor: "pointer", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden" }}>
                  <input type="checkbox" checked={on} onChange={() => toggle(o)}
                    style={{ accentColor: colorFor(o), flexShrink: 0 }} />
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: colorFor(o), flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: on ? 600 : undefined }}>{o}</span>
                </label>
              );
            })}
            {filtered.length === 0 && <div style={{ padding: 8, color: "var(--text-dim)" }}>{t("au.trend.noMatch")}</div>}
          </div>
          <div style={{ display: "flex", gap: 6, paddingTop: 5, borderTop: "1px solid var(--border)", marginTop: 5, alignItems: "center" }}>
            <button onClick={() => onChange(filtered.slice(0, TREND_MAX_VALUES))} style={{ ...ghostBtn, padding: "2px 8px" }}>{t("au.trend.selectAll")}</button>
            <button onClick={() => onChange([])} style={{ ...ghostBtn, padding: "2px 8px" }}>{t("au.trend.clear")}</button>
            <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-dim)" }}>
              {`${selected.length}/${options.length}`}{selected.length >= TREND_MAX_VALUES ? `（${t("au.trend.maxValues")}）` : ""}
            </span>
          </div>
        </span>
      )}
    </span>
  );
}

/** 折线趋势图：X = 时间 bucket，Y = 指标；一条线/维度值（缺失 bucket 断线）。
 *  图例点击隐藏/显示、hover 高亮联动曲线、曲线/数据点 hover 自绘 tooltip、反选批量显隐。 */
function TrendLines({ series, metric, granularity, hidden, onToggle, onInvert }: {
  series: TrendSeries[]; metric: string; granularity: string;
  hidden: Set<string>; onToggle: (k: string) => void;
  onInvert: () => void;
}) {
  // ⚠ hooks 必须全部在条件 return 之前（否则 bucket<2 分支触发时 hooks 数不一致 → React 崩溃）
  const valMaps = useMemo(
    () => new Map(series.map((s) => [s.key, new Map(s.points.map((p) => [p.bucket, p.value]))])),
    [series]);
  const model = useMemo(() => {
    const buckets = [...new Set(series.flatMap((s) => s.points.map((p) => p.bucket)))].sort();
    const vis = series.filter((s) => !hidden.has(s.key));
    const max = Math.max(1, ...vis.flatMap((s) => s.points.map((p) => p.value)));
    return { buckets, vis, max };
  }, [series, hidden]);
  const [focusKey, setFocusKey] = useState<string | null>(null); // hover 图例/曲线 → 高亮该线、淡化其余
  const [tip, setTip] = useState<{ x: number; y: number; key: string; bucket: string; value: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  if (!series.length) return <Empty />;
  if (model.buckets.length < 2) {
    return <div style={{ padding: 30, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("au.trend.needTwo")}</div>;
  }
  const W = 1000, H = 240, padL = 56, padR = 14, padT = 14, padB = 28;
  const n = model.buckets.length;
  const step = (W - padL - padR) / Math.max(1, n - 1);
  const x = (i: number) => padL + i * step;
  const y = (v: number) => padT + (1 - v / model.max) * (H - padT - padB);
  const pathOf = (s: TrendSeries) => {
    const m = valMaps.get(s.key)!;
    let d = "";
    let pen = false;
    for (let i = 0; i < n; i++) {
      const v = m.get(model.buckets[i]);
      if (v === undefined) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    }
    return d;
  };
  const day = granularity === "day";
  const yearDiff = day && n > 1 && model.buckets[0].slice(0, 4) !== model.buckets[n - 1].slice(0, 4);
  const xLabel = (b: string) => (b.length === 7 ? b.slice(2) : yearDiff ? b : b.slice(5));
  const labelStep = Math.max(1, Math.ceil(n / 9));
  const focusing = focusKey !== null;
  const lineOpacity = (k: string) => (focusing ? (focusKey === k ? 0.95 : 0.12) : 0.9);
  const lineWidth = (k: string) => (focusKey === k ? 3 : 2);
  // 曲线任意位置 hover → 按鼠标 x 反查最近 bucket 点，snap 到数据点 y 显示 tooltip
  const onLineMove = (s: TrendSeries) => (e: React.MouseEvent<SVGPathElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const sp = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const i = Math.round((sp.x - padL) / step);
    if (i < 0 || i >= n) { setTip(null); return; }
    const b = model.buckets[i];
    const v = valMaps.get(s.key)?.get(b);
    if (v === undefined) { setTip(null); return; }
    setTip({ x: sp.x, y: y(v), key: s.key, bucket: b, value: v });
  };
  // 自绘 tooltip：svg 内定位 + 出界翻转
  const tipLines = tip ? [
    { text: tip.key, bold: true, color: colorFor(tip.key) },
    { text: `${fmtMetric(tip.value, metric)} · ${tip.bucket}`, bold: false, color: "var(--text)" },
  ] : null;
  const tipW = tipLines ? Math.max(...tipLines.map((l) => l.text.length)) * 6.3 + 22 : 0;
  const tipH = tipLines ? tipLines.length * 15 + 10 : 0;
  const tipX = tip ? (tip.x + 14 + tipW > W - padR ? tip.x - 14 - tipW : tip.x + 14) : 0;
  const tipY = tip ? (tip.y + 14 + tipH > H - padB ? tip.y - 14 - tipH : tip.y + 14) : 0;
  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6, alignItems: "center" }}>
        {series.map((s) => {
          const on = !hidden.has(s.key);
          return (
            <span key={s.key}
              onClick={() => onToggle(s.key)}
              onMouseEnter={() => setFocusKey(s.key)}
              onMouseLeave={() => setFocusKey((k) => (k === s.key ? null : k))}
              title={`${on ? t("au.trend.hide") : t("au.trend.show")}：${s.key} · ${fmtMetric(s.total, metric)}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11,
                cursor: "pointer", userSelect: "none", borderRadius: 6, padding: "2px 6px",
                background: focusKey === s.key ? "var(--bg-hover)" : "transparent",
                color: "var(--text-dim)", opacity: on ? 1 : 0.45, textDecoration: on ? undefined : "line-through" }}>
              <span style={{ width: 16, height: 3, borderRadius: 2, background: colorFor(s.key), display: "inline-block" }} />
              <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{s.key}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMetric(s.total, metric)}</span>
            </span>
          );
        })}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 4 }}>
          <button onClick={onInvert}
            title={t("au.trend.invertTitle")}
            style={{ ...ghostBtn, padding: "1px 8px" }}>
            {t("au.trend.invert")}
          </button>
        </span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }}>
        {[0, 0.25, 0.5, 0.75, 1].map((fr) => (
          <g key={fr}>
            <line x1={padL} x2={W - padR} y1={y(model.max * fr)} y2={y(model.max * fr)} stroke="var(--border)" strokeWidth={1} />
            <text x={padL - 6} y={y(model.max * fr) + 4} textAnchor="end" fontSize={10} fill="var(--text-dim)">
              {fmtMetric(model.max * fr, metric)}
            </text>
          </g>
        ))}
        {model.buckets.map((b, i) => (
          i % labelStep === 0
            ? <text key={b} x={x(i)} y={H - 9} textAnchor="middle" fontSize={9} fill="var(--text-dim)">{xLabel(b)}</text>
            : null
        ))}
        {model.vis.map((s) => (
          <path key={s.key} d={pathOf(s)} fill="none" stroke={colorFor(s.key)}
            strokeWidth={lineWidth(s.key)} strokeLinejoin="round" strokeLinecap="round"
            opacity={lineOpacity(s.key)}
            onMouseEnter={() => setFocusKey(s.key)}
            onMouseMove={onLineMove(s)}
            onMouseLeave={() => { setFocusKey((k) => (k === s.key ? null : k)); setTip(null); }}>
            <title>{`${s.key}\n${fmtMetric(s.total, metric)}`}</title>
          </path>
        ))}
        {model.vis.map((s) => {
          const m = valMaps.get(s.key)!;
          return (
            <g key={`pts-${s.key}`} opacity={lineOpacity(s.key)}>
              {model.buckets.map((b, i) => {
                const v = m.get(b);
                if (v === undefined) return null;
                return (
                  <circle key={b} cx={x(i)} cy={y(v)} r={focusKey === s.key ? 4 : 2.6}
                    fill="var(--bg-panel)" stroke={colorFor(s.key)} strokeWidth={focusKey === s.key ? 2.2 : 1.6}
                    onMouseEnter={() => { setFocusKey(s.key); setTip({ x: x(i), y: y(v), key: s.key, bucket: b, value: v }); }}
                    onMouseLeave={() => setTip(null)}>
                    <title>{`${s.key} · ${b}\n${fmtMetric(v, metric)}`}</title>
                  </circle>
                );
              })}
            </g>
          );
        })}
        {tip && tipLines && (
          <g transform={`translate(${tipX}, ${tipY})`} pointerEvents="none">
            <rect x={-9} y={-6} width={tipW} height={tipH} rx={6} fill="var(--bg-panel)" stroke="var(--border)" opacity={0.98} />
            {tipLines.map((l, i) => (
              <text key={i} x={0} y={i * 15} fontSize={10.5} fontWeight={l.bold ? 700 : 400} fill={l.color}>{l.text}</text>
            ))}
          </g>
        )}
      </svg>
    </div>
  );
}

/** 趋势明细表：行 = 时间 bucket（新→旧），列 = 所选维度值。 */
function TrendSeriesTable({ series, metric, granularity }: {
  series: TrendSeries[]; metric: string; granularity: string;
}) {
  const model = useMemo(() => {
    const buckets = [...new Set(series.flatMap((s) => s.points.map((p) => p.bucket)))].sort();
    const maps = new Map(series.map((s) => [s.key, new Map(s.points.map((p) => [p.bucket, p.value]))]));
    return { buckets, maps };
  }, [series]);
  if (!series.length) return <Empty />;
  const rows = [...model.buckets].reverse();
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr>
          <th style={th}>{granularity === "day" ? t("au.trend.date") : t("au.trend.month")}</th>
          {series.map((s) => (
            <th key={s.key} style={{ ...th, textAlign: "right" }} title={s.key}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colorFor(s.key), display: "inline-block" }} />
                <span style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{s.key}</span>
              </span>
            </th>
          ))}
          <th style={{ ...th, textAlign: "right" }}>{t("au.trend.total")}</th>
        </tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b}>
              <td style={td}>{b}</td>
              {series.map((s) => {
                const v = model.maps.get(s.key)?.get(b) ?? 0;
                return <td key={s.key} style={{ ...td, textAlign: "right", color: v > 0 ? undefined : "var(--text-dim)" }}>{v > 0 ? fmtMetric(v, metric) : "—"}</td>;
              })}
              <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>
                {fmtMetric(series.reduce((sum, s) => sum + (model.maps.get(s.key)?.get(b) ?? 0), 0), metric)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrendTab({ range, custom, filters }: { range: RangeKey; custom: CustomRange; filters: Filters }) {
  const [dim, setDim] = useState<TrendDim>("provider");
  const [values, setValues] = useState<string[]>([]);
  const [metric, setMetric] = useState<string>("tokens");
  const [view, setView] = useState<"chart" | "table">("chart");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const proxy = dim === "key";
  const availMetrics = proxy ? PROXY_METRICS : SESSION_METRICS;
  const effMetric = availMetrics.includes(metric) ? metric : availMetrics[0];

  const spanQ = rangeQuery(range, custom);
  const qs = useMemo(() => {
    const u = new URLSearchParams(spanQ === null ? "" : spanQ.slice(1));
    u.set("dim", dim);
    if (values.length) u.set("values", values.join(","));
    u.set("metric", effMetric);
    if (filters.provider) u.set("provider", filters.provider);
    if (filters.model) u.set("model", filters.model);
    return u.toString();
  }, [spanQ, dim, values, effMetric, filters]);
  const { data, err } = useFetch<any>(spanQ === null ? null : `/trend?${qs}`, [qs]);

  // 值选项：facets（header provider 过滤联动 → 模型列表只看该 provider）
  const facetQ = filters.provider ? `?provider=${encodeURIComponent(filters.provider)}` : "";
  const { data: facets } = useFetch<any>(`/facets${facetQ}`, [facetQ]);
  const options = useMemo(() => {
    const src = facets ?? {};
    if (dim === "provider") return src.providers ?? [];
    if (dim === "model") return src.modelCombos ?? [];
    if (dim === "workspace") return [...(src.workspaces ?? []), UNKNOWN_WS];
    return src.keys ?? [];
  }, [facets, dim]);
  // 选项变化后清掉已失效的选中值（如 header provider 过滤收窄）
  useEffect(() => {
    if (options.length && values.some((v) => !options.includes(v))) {
      setValues((cur) => cur.filter((v) => options.includes(v)));
    }
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  if (spanQ === null) return <PickHint />;
  const changeDim = (d: TrendDim) => { setDim(d); setValues([]); setHidden(new Set()); };
  const toggleHidden = (k: string) => setHidden((s) => {
    const n = new Set(s);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });
  const series: TrendSeries[] = data?.series ?? [];
  const granularity = String(data?.granularity ?? "day");
  const caliberNote = proxy ? t("au.caliber.proxy") : t("au.caliber.session");

  const ctrl = (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 11, color: "var(--text-dim)" }}>
        <span>{t("au.trend.dim")}</span>
        <Dropdown value={dim}
          options={TREND_DIMS.map((d) => ({ value: d, label: t(`au.dim.${d}`) }))}
          onChange={(v) => changeDim(v as TrendDim)} ariaLabel={t("au.trend.dim")} />
        <ValueMultiSelect options={options} selected={values} onChange={setValues} />
        {values.length > 0 && (
          <button onClick={() => setValues([])} title={t("au.filter.clear")} style={{ ...ghostBtn, padding: "1px 6px" }}>×</button>
        )}
        <span style={{ width: 1, height: 16, background: "var(--border)", margin: "0 2px" }} />
        {(["chart", "table"] as const).map((v) => (
          <button key={v} onClick={() => setView(v)}
            style={{ ...ghostBtn, ...(view === v ? { background: "var(--bg-hover)", color: "var(--text)", fontWeight: 600 } : {}) }}>
            {v === "chart" ? t("au.trend.chart") : t("au.trend.table")}
          </button>
        ))}
        {data && (
          <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}>
            {`${data.label} · ${caliberNote} · ${series.length} ${t("au.trend.lines")}`}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", fontSize: 11 }}>
        <span style={{ color: "var(--text-dim)", marginRight: 2 }}>{t("au.pivot.metric")}</span>
        {availMetrics.map((m) => (
          <button key={m} onClick={() => setMetric(m)}
            style={{ ...ghostBtn, ...(effMetric === m ? { background: "var(--bg-hover)", color: "var(--text)", fontWeight: 600 } : {}) }}>
            {t(`au.metric.${m}`)}
          </button>
        ))}
        {values.length === 0 && <span style={{ color: "var(--text-dim)", marginLeft: 4 }}>{t("au.trend.autoTop")}</span>}
      </div>
    </div>
  );

  const body = () => {
    if (!data) return <Loading />;
    if (err) return <Err msg={err} />;
    if (series.length === 0) return <Empty />;
    return (
      <div style={{ ...card, padding: "12px 16px" }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          {`${dimLabel(dim)} · ${t("au.metric." + effMetric)}`}
          <span style={{ fontWeight: 400, color: "var(--text-dim)", marginLeft: 8 }}>
            {granularity === "day" ? t("au.trend.byDay") : t("au.trend.byMonth")}
          </span>
        </div>
        {view === "chart"
          ? <TrendLines series={series} metric={effMetric} granularity={granularity} hidden={hidden} onToggle={toggleHidden}
              onInvert={() => setHidden((s) => new Set(series.map((x) => x.key).filter((k) => !s.has(k))))} />
          : <TrendSeriesTable series={series} metric={effMetric} granularity={granularity} />}
      </div>
    );
  };

  return (
    <div style={{ overflowY: "auto", padding: "10px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
      {ctrl}
      {body()}
    </div>
  );
}

// ---------------------------------------------------------------- 标签页：会话

const STATE_COLOR: Record<string, string> = {
  running: "#10b981", active: "#6366f1", idle: "#f59e0b", ended: "#6b7280", forked: "#a78bfa", archived: "#6b7280",
};

function SessionsTab() {
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(id);
  }, [q]);
  const query = useMemo(() => {
    const sp = new URLSearchParams();
    if (debouncedQ) sp.set("q", debouncedQ);
    if (state) sp.set("state", state);
    sp.set("limit", "200");
    return `/sessions?${sp.toString()}`;
  }, [debouncedQ, state]);
  const { data, err } = useFetch<any>(query, []);
  if (err) return <Err msg={err} />;
  if (!data) return <Loading />;
  const rows = data.rows ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: 8, padding: "10px 16px 6px", alignItems: "center" }}>
        <input
          value={q} onChange={(e) => setQ((e.target as HTMLInputElement).value)}
          placeholder="搜索标题 / 目录 / id…"
          style={{ flex: 1, maxWidth: 320, padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "inherit", fontSize: 12 }}
        />
        {["", "running", "active", "idle", "ended", "archived"].map((s) => (
          <button key={s || "all"} onClick={() => setState(s)}
            style={{ ...ghostBtn, ...(state === s ? { background: "var(--bg-hover)", color: "var(--text)" } : {}) }}>
            {s ? t(`au.state.${s}`) : t("au.all")}
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-dim)" }}>{data.total} 个会话</span>
      </div>
      <div style={{ overflowY: "auto", padding: "0 16px 12px", flex: 1 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={th}></th>
            <th style={th}>标题 / id</th>
            <th style={th}>目录</th>
            <th style={{ ...th, textAlign: "right" }}>{t("au.msgs")}</th>
            <th style={{ ...th, textAlign: "right" }}>{t("au.tokens")}</th>
            <th style={{ ...th, textAlign: "right" }}>{t("au.cost")}</th>
            <th style={{ ...th, textAlign: "right" }}>最后活动</th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} style={{ ...td, textAlign: "center", color: "var(--text-dim)" }}>{t("au.empty")}</td></tr>}
            {rows.map((s: any) => (
              <tr key={s.id}>
                <td style={{ ...td, width: 22 }}>
                  <span title={s.state + (s.endReason ? ` (${s.endReason})` : "")}
                    style={{ display: "inline-block", width: 8, height: 8, borderRadius: 99, background: STATE_COLOR[s.state] ?? "#6b7280" }} />
                </td>
                <td style={{ ...td, maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis" }} title={s.id}>
                  {s.title || s.id.slice(0, 12)}
                </td>
                <td style={{ ...td, color: "var(--text-dim)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{s.cwd}</td>
                <td style={{ ...td, textAlign: "right" }}>{fmtN(s.msgs)}</td>
                <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{fmtN(s.totalTokens)}</td>
                <td style={{ ...td, textAlign: "right" }}>{fmtCost(s.cost)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--text-dim)" }} title={fmtTime(s.lastTs)}>{relTime(s.lastTs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 小件

const Loading = () => <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>…</div>;
const Empty = () => <div style={{ padding: 20, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("au.empty")}</div>;
const Err = ({ msg }: { msg: string }) => <div style={{ padding: 24, color: "#f87171", fontSize: 12 }}>{msg}</div>;
const PickHint = () => <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("au.range.pick")}</div>;

// ---------------------------------------------------------------- 主面板

/** 报表内容（头行工具栏 + 六标签体）：浮窗/停靠两面共用。inDock=true 时隐藏自身关闭钮
 *  （右栏 tab 形态 TabBar 已有 ✕，防双 ✕，dock 方案 §2-D）。切形态 remount，tab/筛选等
 *  useState 丢失 = §7 状态自管语义（可接受，与 demo 一致）。 */
function ReportBody({ inDock = false }: { inDock?: boolean }) {
  useMoneyTick(); // 汇率到位/切语言时重渲染（fmtCost 双币显示）
  const [tab, setTab] = useState<"overview" | "models" | "keys" | "pivot" | "trend" | "sessions" | "input">("overview");
  const [range, setRange] = useState<RangeKey>("30d");
  const [custom, setCustom] = useState<CustomRange>(() => ({ from: dayStr(-30), to: dayStr(0) }));
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS); // provider/model 筛选（总览/模型/Keys/维度四页共用）
  const [trendView, setTrendView] = useState<"chart" | "table">("chart");
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);
  // 小屏全屏与最大化按钮都由 aiti-float 托管（data-ext-float-full + 自动注入 ⛶/❐）
  const reloadAll = () => force((v) => v + 1);

  // 小屏全屏（data-ext-float-full）与最大化按钮（⛶/❐ 自动注入）都由 aiti-float 托管
  const tabs: Array<[typeof tab, string]> = [
    ["overview", t("au.tabOverview")], ["models", t("au.tabModels")],
    ["keys", t("au.tabKeys")], ["pivot", t("au.tabPivot")], ["trend", t("au.tabTrend")], ["input", t("au.tabInput")], ["sessions", t("au.tabSessions")],
  ];
  const ranges: Array<[RangeKey, string]> = [
    ["today", t("au.range.today")], ["7d", t("au.range.7d")], ["30d", t("au.range.30d")],
    ["month", t("au.range.month")], ["all", t("au.range.all")], ["custom", t("au.range.custom")],
  ];
  const setCustomField = (k: keyof CustomRange) => (e: any) =>
    setCustom((c) => ({ ...c, [k]: String(e.target.value ?? "") }));

  const rescan = async () => {
    setBusy(true);
    try { await fetch(apiUrl("/api/extensions/aiti-ai-usage/sync"), { method: "POST" }); reloadAll(); }
    finally { setBusy(false); }
  };

  return (
    <>
      {/* header：小屏两行换行，关闭按钮恒在右上角 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "10px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <strong style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Ic size={15} paths={ICONS.chart} />{t("au.title")}
        </strong>
        <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
          {tabs.map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              style={{ ...ghostBtn, ...(tab === id ? { background: "var(--bg-hover)", color: "var(--text)", fontWeight: 600 } : {}) }}>
              {label}
            </button>
          ))}
        </div>
        <span style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
        {tab !== "sessions" && tab !== "input" && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
            {ranges.map(([id, label]) => (
              <button key={id} onClick={() => setRange(id)}
                style={{ ...ghostBtn, ...(range === id ? { background: "var(--bg-hover)", color: "var(--text)" } : {}) }}>
                {label}
              </button>
            ))}
            {range === "custom" && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-dim)" }}>
                <input type="date" value={custom.from} max={custom.to || undefined} onChange={setCustomField("from")}
                  aria-label={t("au.range.from")} title={t("au.range.from")} style={dateInputStyle} />
                <span>~</span>
                <input type="date" value={custom.to} min={custom.from || undefined} onChange={setCustomField("to")}
                  aria-label={t("au.range.to")} title={t("au.range.to")} style={dateInputStyle} />
              </span>
            )}
            <span style={{ width: 1, height: 16, background: "var(--border)", margin: "0 2px" }} />
            <FilterBar filters={filters} onChange={setFilters} />
          </div>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          <button onClick={rescan} disabled={busy} title={t("au.sync")} style={{ ...iconBtn, opacity: busy ? 0.5 : 1 }}>
            <Ic size={13} paths={ICONS.search} />
          </button>
          <button onClick={reloadAll} aria-label="refresh" title={t("au.refresh")} style={iconBtn}>
            <Ic size={13} paths={ICONS.refresh} />
          </button>
          {/* 关闭按钮：aria-label="close" —— aiti-helper 全局 AI 按钮（🤖）的注入锚点，自动出现在本按钮左边；
              停靠形态不渲染（TabBar ✕ 已有，防双 ✕） */}
          {!inDock && (
            <button onClick={() => panel.close()} aria-label="close" title={t("au.close")}
              style={{ ...iconBtn, color: "var(--text)" }}>
              <Ic size={13} paths={ICONS.x} />
            </button>
          )}
        </span>
      </div>
      {/* body */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "overview" && <OverviewTab key={`ov-${range}-${custom.from}~${custom.to}`} range={range} custom={custom} trendView={trendView} onTrendViewChange={setTrendView} filters={filters} />}
        {tab === "models" && <ModelsTab key={`md-${range}-${custom.from}~${custom.to}`} range={range} custom={custom} filters={filters} />}
        {tab === "keys" && <KeysTab key={`ky-${range}-${custom.from}~${custom.to}`} range={range} custom={custom} filters={filters} />}
        {tab === "pivot" && <PivotTab range={range} custom={custom} filters={filters} />}
        {tab === "trend" && <TrendTab key={`td-${range}-${custom.from}~${custom.to}`} range={range} custom={custom} filters={filters} />}
        {tab === "input" && <InputTab key={`in-${range}-${custom.from}~${custom.to}`} range={range} custom={custom} />}
        {tab === "sessions" && <SessionsTab />}
      </div>
    </>
  );
}

/** 浮窗 face（dialogs item）：仅 floating 态渲染（useGate 门控，dock 方案红线） */
export function UsageReport() {
  const open = useGate(REPORT_KEY, "float");
  if (!open) return null;
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 292, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={() => panel.close()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-ext-float="1" data-ext-float-full="1" data-ext-float-w={1040} data-ext-float-h={780}
        data-ext-float-key={REPORT_KEY}
        data-ext-float-dock="right-panel"
        data-ext-float-dock-default="right-panel"
        style={{
          width: "min(1040px, 95vw)", height: "min(84vh, 800px)", borderRadius: 14,
          display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)", overflow: "hidden",
          boxShadow: "0 18px 60px rgba(0,0,0,0.4)",
        }}
      >
        <ReportBody />
      </div>
    </div>
  );
}

/** 停靠 face（rightFileDock item）：仅 docked:right-panel 态渲染；同内容进 DockBody */
export function ReportDockFace() {
  const docked = useGate(REPORT_KEY, { dock: "right-panel" });
  if (!docked) return null;
  return (
    <DockBody itemKey={REPORT_KEY} zone="right-panel" title={t("au.title")} chrome="tab"
      zones={["right-panel"]} defaultZone="right-panel">
      <ReportBody inDock />
    </DockBody>
  );
}

// ---------------------------------------------------------------- slot 入口组件

/** 会话统计下拉（宿主 sessionStats 插槽）内的「用量报表」入口按钮：扩展自己渲染、自己调起。 */
export function SessionStatsEntry() {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <button
        onClick={() => {
          // 本按钮渲染在宿主会话信息顶栏面板内：不先收面板，小屏上旧面板会盖住报表
          // （只剩 tab 头可见）。closeTopPanels 是宿主 pi-web.ui 服务成员（2026-09-19 起），
          // 旧宿主缺席则跳过——桌面端点外即收，无此问题。
          try {
            const close = (extSvc("pi-web.ui") as { get?: (n: string) => unknown } | undefined)
              ?.get?.("closeTopPanels") as (() => void) | undefined;
            if (typeof close === "function") close();
          } catch { /* 服务缺席/未就绪——照常开报表 */ }
          panel.open();
        }}
        title={t("au.title")}
        style={{
          display: "inline-flex", alignItems: "center", gap: 5,
          padding: "3px 9px", borderRadius: 7,
          border: "1px solid var(--border)", background: "transparent",
          color: "var(--text-muted)", fontSize: 11, cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "var(--text)";
          e.currentTarget.style.borderColor = "var(--accent)";
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "var(--text-muted)";
          e.currentTarget.style.borderColor = "var(--border)";
          e.currentTarget.style.background = "transparent";
        }}
      ><Ic size={12} paths={ICONS.chart} />{t("au.entry")}</button>
    </div>
  );
}

export function ToolbarEntry() {
  return (
    <button
      onClick={() => panel.open()}
      title={t("au.title")}
      aria-label={t("au.title")}
      style={{
        width: 36, height: 36, display: "inline-flex", alignItems: "center", justifyContent: "center",
        borderRadius: 8, border: "none", background: "transparent", color: "var(--text-muted)",
        fontSize: 16, cursor: "pointer",
      }}
    ><Ic size={17} paths={ICONS.chart} /></button>
  );
}
