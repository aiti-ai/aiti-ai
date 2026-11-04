/**
 * 语音（ASR）流量统计报表 —— 形态对齐 aiti-ai-usage（KPI 卡 + 按天趋势 + 明细 + 金额估算），
 * 但零依赖：手写 SVG 堆叠柱，数据来自本扩展的 `GET /asr/usage/series`（一次拉全，不分块多请求）。
 *
 * 三面注册（同 ASR 面板）：`UsageReportSlot`（浮窗）/ `UsageDockLeft`（左栏区块）/ `UsageDockRight`（右栏 tab）。
 * ⚠ 禁轮询：刷新只走按钮与打开时的一次拉取。
 */
import { useEffect, useState } from "react";
import { DockBody, isSidebarDockState, sidebarZoneOf, usePresent } from "../../../_shared/ext-float-dock";
import { apiUrl } from "./host-shim";
// 键与开关的唯一所有 = entry 薄壳（薄壳拆分 §5.2：usageOpenSet/一次性清理收编 entry，
// register 期偏好修正不依赖本懒 chunk 加载）
import { USAGE_KEY, usageOpenSet } from "./entry";



interface ModeRow { requests: number; seconds: number }
interface DayRow { requests: number; seconds: number; errors: number; byMode?: Record<string, ModeRow> }
interface SeriesView {
  ok?: boolean; today?: string;
  days?: Array<{ day: string; providers: Record<string, DayRow> }>;
  totals?: Record<string, DayRow>;
  price?: Record<string, number>;
  lastAt?: Record<string, number>;
}

const CARD: Record<string, string> = {
  background: "var(--bg-hover,#f5f5f5)", border: "1px solid var(--border,#e0e0e0)",
  borderRadius: 10, padding: "8px 12px", minWidth: 104, flex: 1,
};
const KPI_LABEL: Record<string, string> = { fontSize: 11, color: "var(--text-muted,#767676)" };
const KPI_VALUE: Record<string, string> = { fontSize: 17, fontWeight: 600, marginTop: 2 };
const PALETTE = ["#2563eb", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
const MODE_LABEL: Record<string, string> = { quick: "分句快识（quick）", final: "整段精修（final）", vad: "真流式会话（vad）", other: "其它/旧数据" };

const mins = (s?: number) => (s || 0) / 60;
const fmtMin = (s?: number) => `${mins(s).toFixed(1)} 分钟`;
const fmtYuan = (v?: number) => (v === undefined ? "—" : `¥${v.toFixed(2)}`);
const cost = (r: DayRow | undefined, price?: number) => (r && price ? mins(r.seconds) * price : undefined);

function sumRows(rows: Array<DayRow | undefined>): DayRow {
  const out: DayRow = { requests: 0, seconds: 0, errors: 0, byMode: {} };
  for (const r of rows) {
    if (!r) continue;
    out.requests += r.requests || 0;
    out.seconds += r.seconds || 0;
    out.errors += r.errors || 0;
    for (const [m, mr] of Object.entries(r.byMode || {})) {
      const t = out.byMode![m] ||= { requests: 0, seconds: 0 };
      t.requests += mr.requests || 0;
      t.seconds += mr.seconds || 0;
    }
  }
  return out;
}

/** 近 30 天按引擎堆叠柱（纯 SVG，无库） */
function TrendBars({ days, ids, colorOf, hidden }: {
  days: Array<{ day: string; providers: Record<string, DayRow> }>;
  ids: string[]; colorOf: (id: string) => string; hidden: Set<string>;
}) {
  const W = 300, H = 84, PAD = 2;
  const max = Math.max(1, ...days.map((d) => ids.filter((i) => !hidden.has(i)).reduce((n, i) => n + mins(d.providers[i]?.seconds), 0)));
  const bw = Math.max(1, (W - PAD * 2) / Math.max(1, days.length) - 1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="近 30 天语音识别时长">
      {days.map((d, di) => {
        let acc = 0;
        const x = PAD + di * (bw + 1);
        return (
          <g key={d.day}>
            {ids.filter((i) => !hidden.has(i)).map((id) => {
              const v = mins(d.providers[id]?.seconds);
              const h = (v / max) * (H - 12);
              const y = H - 10 - acc - h;
              acc += h;
              if (h <= 0) return null;
              return <rect key={id} x={x} y={y} width={bw} height={h} fill={colorOf(id)}>
                <title>{`${d.day} · ${id} · ${v.toFixed(1)} 分钟`}</title>
              </rect>;
            })}
          </g>
        );
      })}
      <line x1={0} y1={H - 10} x2={W} y2={H - 10} stroke="var(--border,#e0e0e0)" strokeWidth={1} />
    </svg>
  );
}

function renderUsageReport(face?: string) {
  const st0 = usePresent(USAGE_KEY);
  const open = face === "float" ? st0 === "floating"
    : face === "right" ? st0 === "docked:right-panel"
      : isSidebarDockState(st0);
  const [data, setData] = useState<SeriesView | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string>("");
  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-ai-input/asr/usage/series?days=30"));
      setData((await r.json().catch(() => null)) as SeriesView | null);
    } catch { setData(null); }
    setLoading(false);
  };
  useEffect(() => { if (open) void load(); }, [open]);
  // ⚠ 必须早退：否则三面常驻渲染（关不掉 + 默认就显示）——所有 hook 都在这之前调用，顺序稳定
  if (!open) return null;

  const onReset = async () => {
    const r = await fetch(apiUrl("/api/extensions/aiti-ai-input/asr/usage"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reset" }),
    });
    await r.json().catch(() => null);
    setMsg("用量已清空");
    setTimeout(() => setMsg(""), 2000);
    void load();
  };
  const onPrice = async (pid: string, v: string) => {
    const n = Number(String(v).trim());
    await fetch(apiUrl("/api/extensions/aiti-ai-input/asr/usage"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ price: { [pid]: Number.isFinite(n) && n >= 0 ? n : 0 } }),
    }).catch(() => null);
    void load();
  };

  const days = data?.days || [];
  const totals = data?.totals || {};
  const ids = Object.keys(totals);
  const colorOf = (id: string) => PALETTE[Math.max(0, ids.indexOf(id)) % PALETTE.length];
  const today = days.length ? days[days.length - 1] : undefined;
  const todayAll = sumRows(today ? Object.values(today.providers) : []);
  const week = sumRows(days.slice(-7).flatMap((d) => Object.values(d.providers)));
  const all = sumRows(Object.values(totals));
  // 费用 = Σ（该引擎分钟数 × 该引擎单价）；没填单价的引擎不计入
  const costOf = (perProvider: Record<string, DayRow>): number | undefined => {
    let c = 0, any = false;
    for (const [pid, r] of Object.entries(perProvider)) {
      const p = data?.price?.[pid];
      if (!p) continue;
      any = true;
      c += mins(r.seconds) * p;
    }
    return any ? c : undefined;
  };
  const weekPer: Record<string, DayRow> = {};
  for (const d of days.slice(-7)) {
    for (const [pid, r] of Object.entries(d.providers)) {
      const acc = weekPer[pid] ||= { requests: 0, seconds: 0, errors: 0, byMode: {} };
      acc.requests += r.requests || 0;
      acc.seconds += r.seconds || 0;
      acc.errors += r.errors || 0;
    }
  }

  const floating = face === "float";
  const title = floating ? null : "语音流量统计";
  const head = !floating ? null : (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexShrink: 0,
      padding: "10px 14px", borderBottom: "1px solid var(--border,#e0e0e0)", background: "var(--bg-subtle,#f5f5f5)",
    }}>
      <b style={{ fontSize: 14 }}>语音流量统计</b>
      {/* ✕ 关闭：aiti-float 契约下关闭由本按钮负责；aria-label="close" 是全局 AI 按钮 🤖 的注入锚点 */}
      <button onClick={() => usageOpenSet(false)} title="关闭" aria-label="close"
        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted,#767676)", fontSize: 15, lineHeight: 1 }}>✕</button>
    </div>
  );
  const body = (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "10px 12px", fontSize: 13, overflow: "auto", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <b style={{ fontSize: 13 }}>{title}</b>
        <button onClick={() => void load()} disabled={loading} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted,#767676)", fontSize: 12 }}>
          {loading ? "刷新中…" : "⟳ 刷新"}
        </button>
        {msg ? <span style={{ fontSize: 12, color: "var(--accent,#2563eb)" }}>{msg}</span> : null}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={CARD}><div style={KPI_LABEL}>今日</div><div style={KPI_VALUE}>{todayAll.requests} 次</div><div style={KPI_LABEL}>{fmtMin(todayAll.seconds)}</div></div>
        <div style={CARD}><div style={KPI_LABEL}>近 7 天</div><div style={KPI_VALUE}>{week.requests} 次</div><div style={KPI_LABEL}>{fmtMin(week.seconds)}</div></div>
        <div style={CARD}><div style={KPI_LABEL}>累计</div><div style={KPI_VALUE}>{all.requests} 次</div><div style={KPI_LABEL}>{fmtMin(all.seconds)}</div></div>
        <div style={CARD}><div style={KPI_LABEL}>估算费用（累计）</div><div style={KPI_VALUE}>{fmtYuan(costOf(totals))}</div><div style={KPI_LABEL}>今日 {fmtYuan(costOf(today?.providers || {}))} ｜ 7 天 {fmtYuan(costOf(weekPer))}</div></div>
      </div>

      <div style={{ border: "1px solid var(--border,#e0e0e0)", borderRadius: 10, padding: "8px 10px", background: "var(--bg-subtle,#f5f5f5)" }}>
        <div style={{ ...KPI_LABEL, marginBottom: 4 }}>近 30 天音频时长（分钟/天）</div>
        {days.length ? <TrendBars days={days} ids={ids} colorOf={colorOf} hidden={hidden} /> : <span style={KPI_LABEL}>暂无数据</span>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          {ids.map((id) => (
            <button key={id} onClick={() => setHidden((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
              style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11.5, color: hidden.has(id) ? "var(--text-muted,#999)" : "var(--text,#1a1a1a)", display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf(id), opacity: hidden.has(id) ? 0.3 : 1 }} />{id}
            </button>
          ))}
        </div>
      </div>

      {ids.length ? (
        <div style={{ border: "1px solid var(--border,#e0e0e0)", borderRadius: 10, padding: "8px 10px", background: "var(--bg-subtle,#f5f5f5)" }}>
          <div style={{ ...KPI_LABEL, marginBottom: 4 }}>按引擎（累计 · 今日 · 单价元/分钟 · 估算费用）</div>
          {ids.map((pid) => {
            const t = totals[pid];
            const d = today?.providers[pid];
            const p = data?.price?.[pid];
            return (
              <div key={pid} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, padding: "3px 0", borderTop: "1px dashed var(--border,#e0e0e0)" }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf(pid), flexShrink: 0 }} />
                <span style={{ minWidth: 66 }}>{pid}</span>
                <span style={{ flex: 1, color: "var(--text-muted,#767676)" }}>
                  {t.requests} 次 · {fmtMin(t.seconds)} · 错 {t.errors} ｜ 今日 {d?.requests ?? 0} 次
                </span>
                <input defaultValue={p ? String(p) : ""} placeholder="0" spellCheck={false}
                  onBlur={(e) => void onPrice(pid, e.target.value)}
                  style={{ width: 46, padding: "1px 4px", fontSize: 11.5, background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", border: "1px solid var(--border,#e0e0e0)", borderRadius: 4 }} />
                <span style={{ minWidth: 54, textAlign: "right" }}>{fmtYuan(cost(t, p))}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {Object.keys(all.byMode || {}).length ? (
        <div style={{ border: "1px solid var(--border,#e0e0e0)", borderRadius: 10, padding: "8px 10px", background: "var(--bg-subtle,#f5f5f5)" }}>
          <div style={{ ...KPI_LABEL, marginBottom: 4 }}>按链路模式（累计）</div>
          {Object.entries(all.byMode || {}).map(([m, r]) => (
            <div key={m} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, padding: "2px 0" }}>
              <span>{MODE_LABEL[m] || m}</span>
              <span style={{ color: "var(--text-muted,#767676)" }}>{r.requests} 次 · {fmtMin(r.seconds)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button onClick={() => void onReset()} style={{
          padding: "4px 10px", border: "1px solid var(--border,#e0e0e0)", borderRadius: 8,
          background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", cursor: "pointer", fontSize: 12,
        }}>🗑 清空用量</button>
        <span style={{ ...KPI_LABEL, fontSize: 11 }}>时长按 16k/16bit 估算；数据存 state 层，只保留 90 天</span>
      </div>
    </div>
  );

  if (face === "float") {
    return (
      <div style={{
        display: "flex", flexDirection: "column", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)",
        border: "1px solid var(--border,#e0e0e0)", borderRadius: 16, boxShadow: "0 16px 64px rgba(0,0,0,.25)",
        width: 520, maxWidth: "94vw", maxHeight: "86vh", fontSize: 13, overflow: "hidden", zIndex: 2147483101,
      }} data-ext-float="1" data-ext-float-key={USAGE_KEY} data-ext-float-w="520" data-ext-float-full="1" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="语音流量统计">
        {head}
        {body}
      </div>
    );
  }
  if (face === "right") {
    return (
      <DockBody itemKey={USAGE_KEY} zone="right-panel" title="语音流量" chrome="tab"
        zones={[sidebarZoneOf(USAGE_KEY), "right-panel"]} defaultZone={sidebarZoneOf(USAGE_KEY)}>
        <div style={{ position: "relative", display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontSize: 13 }}>{body}</div>
      </DockBody>
    );
  }
  return (
    <DockBody itemKey={USAGE_KEY} title="语音流量" chrome="section" kind="dockable"
      zones={[sidebarZoneOf(USAGE_KEY), "right-panel"]} defaultZone={sidebarZoneOf(USAGE_KEY)}>
      <div style={{ position: "relative", display: "flex", flexDirection: "column", minHeight: 0, height: "100%", background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontSize: 13 }}>{body}</div>
    </DockBody>
  );
}

export function UsageReportSlot() { return renderUsageReport("float"); }
export function UsageDockRight() { return renderUsageReport("right"); }
