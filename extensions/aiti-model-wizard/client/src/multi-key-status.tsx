/**
 * 聚合 / 多 key 运行状态（模型向导扩展）
 *
 * 数据源：本扩展 server 的 GET /proxy-status → pi-models-combo 引擎 globalThis
 * 共享状态的 status() 快照（跨 session/模块副本同一套代理）。语义见
 * docs/pi-models-combo-models-plan.md §可观测。
 *
 * 三个出口，同一份渲染：
 *   - MultiKeyStatusRows     会话信息下拉 sessionStats 插槽条目（紧凑；高度自然展开，随宿主面板整体滚动）
 *   - MultiKeyStatusSummary  模型向导「模型聚合」页签头部汇总芯片（几代理/几槽位）
 *   - MultiKeyStatusDialog   点汇总打开的详情弹窗（整窗滚动看具体数据）
 *
 * 刷新时机一律「打开拉一次 + 手动刷新按钮」，零轮询。
 * 显示：每 provider 代理 —— 槽位标识 / 冷却状态（含剩余秒数）/ 进程内累计统计
 * （ok/429/4xx/5xx/timeout + token 流量 ↑输入·↓输出·↻缓存）/ 当前粘住会话数；▶ 标记最近在用槽位。
 *
 * 样式：阶段 A 迁移到自持 amw-* 类（amw-styles.ts；主题跟随 var(--x,兜底)），
 * 动态取值（尺寸/颜色计算）保留少量内联。
 */
import { useEffect, useCallback, useState, Fragment } from "react";
import { api } from "./wizard-lib";
import { t } from "./host-shim";

interface SlotStat {
  ok: number; err429: number; err4xx: number; err5xx: number; timeout: number; other: number;
  /** token 流量累计（旧版引擎可能缺省） */
  tin?: number; tout?: number; tcr?: number; tcw?: number;
  lastUsedAt: number; lastStatus: number;
}
interface SlotStatus {
  name: string; member?: string; model?: string; group?: string; vision?: boolean;
  weight?: number; rpm?: number; minIntervalMs?: number | string; upstream?: string;
  cooldown: {
    kind: "ratelimit" | "error"; secondsLeft: number;
    /** 上游原始 retry-after 秒数（未封顶；429 限流冷却才有）——面板显示「上游给了多少秒」 */
    upstreamSec?: number; capped?: boolean; hint?: string;
  } | null;
  stats: SlotStat;
  pinned: number;
}
interface ProviderStatus {
  provider: string; port: number; upstream: string; api?: string;
  isCombo?: boolean; sticky?: boolean; entries: SlotStatus[];
  /** 懒建 combo 尚未触发（从未被请求过）：status 里无 entries，仅提示存在 */
  built?: boolean; configModels?: number;
  /** 未构建且成员解析失败（如成员 provider 未配置/未注册）：永远无法懒建，需修复配置 */
  configError?: string;
  /** 持续饱和中的池子（combo 分组 / provider 级）：全槽位冷却连续计时时长，超阈值后代理返回终态 400 */
  saturation?: { pool: string; seconds: number }[];
  saturationTerminalMs?: number; retryAfterCapSec?: number;
}
interface StatusData {
  ok: boolean; loaded: boolean; present?: boolean; status: ProviderStatus[]; ts: number;
}

const ZERO_STAT: SlotStat = { ok: 0, err429: 0, err4xx: 0, err5xx: 0, timeout: 0, other: 0, tin: 0, tout: 0, tcr: 0, tcw: 0, lastUsedAt: 0, lastStatus: 0 };
const fmtN = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
/** token 紧凑格式：1.2k / 3.4M */
const fmtTok = (n: number) => (n >= 1e6 ? `${n >= 1e7 ? Math.round(n / 1e6) : Math.round(n / 1e5) / 10}M` : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
const ago = (t0: number) => {
  if (!t0) return "";
  const s = Math.max(0, Math.round((Date.now() - t0) / 1000));
  if (s < 60) return t("mw.st.ago.sec", { s });
  if (s < 3600) return t("mw.st.ago.min", { m: Math.floor(s / 60) });
  return t("mw.st.ago.hour", { h: Math.floor(s / 3600) });
};
/** 相对剩余（参照 aiti-model-check 的 fmtPredict 相对部分）：<1分→"约 N 秒后"；<1时→"约 N 分 M 秒后"；<1天→"约 N 小时 M 分后"；否则→"约 N 天 M 小时 [K 分] 后" */
const fmtEta = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return t("mw.st.eta.sec", { s });
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? t("mw.st.eta.minSec", { m, s: rs }) : t("mw.st.eta.min", { m });
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? t("mw.st.eta.hourMin", { h, m: rm }) : t("mw.st.eta.hour", { h });
  return rm
    ? t("mw.st.eta.dayMin", { d: Math.floor(h / 24), h: h % 24, m: rm })
    : t("mw.st.eta.day", { d: Math.floor(h / 24), h: h % 24 });
};
/** 绝对日期时间 MM-DD HH:mm（参照 aiti-model-check 的 fmtPredict local 部分），鼠标提示用 */
const fmtClock = (ts: number) => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
};
/** 防御性脱敏显示 host：丢弃 userinfo（引擎已脱敏，这里兜底防旧副本回归）。 */
const hostOf = (u: string) => {
  let s = String(u || "");
  try {
    const url = new URL(s);
    if (url.username || url.password) { url.username = ""; url.password = ""; s = url.toString(); }
  } catch {}
  return s.replace(/^https?:\/\//, "").split("/")[0] || u;
};

const flatStats = (e: SlotStatus): SlotStat => e.stats ?? ZERO_STAT;
const reqsOf = (st: SlotStat) => st.ok + st.err429 + st.err4xx + st.err5xx + st.timeout + st.other;

/** 槽位健康态：cooling=冷却窗口内；failing=近期全 429；stale=观测过时（无新数据≠正常，不画绿点）；ok=正常。 */
const RECENT_MS = 10 * 60_000; // 统计为进程内累计：超过此时长无新观测 → stale（旧观测不能冒充当前状态）
function slotHealth(e: SlotStatus): "cooling" | "failing" | "stale" | "ok" {
  if (e.cooldown) return "cooling";
  const st = flatStats(e);
  const ts = st.lastUsedAt;
  if (!ts) return "ok"; // 从未用过 = 真·无历史
  if (Date.now() - ts >= RECENT_MS) return "stale"; // 无新数据：既不标红也不画绿点
  if (st.ok === 0 && st.err429 > 0) return "failing";
  if (st.lastStatus === 429 && st.err429 > st.ok * 3) return "failing";
  return "ok";
}

/** 联动键 = host + 裸 key 名：同一把物理 key（同上游账户）在聚合 / 多key代理间的观测互通。
 *  槽位级 upstream 只有 combo 成员才带；普通多key槽位缺省 → 回退 provider 级 upstream。 */
const keyOf = (e: SlotStatus, providerUpstream?: string): string => {
  const host = hostOf(String(e.upstream || providerUpstream || ""));
  const bare = e.name.includes("/") ? e.name.split("/").pop()! : e.name;
  return `${host}::${bare}`;
};
interface KeyObs { health: "cooling" | "failing" | "stale" | "ok"; cooldown: SlotStatus["cooldown"]; ts: number }
/** 按 host+key 归并所有代理的观测：**按时间覆盖**——每个联动键只保留观测时间（lastUsedAt）最新的一条，
 *  无观测（req=0）不参与，旧观测不覆盖新观测。 */
function buildKeyIndex(status: ProviderStatus[]): Map<string, KeyObs> {
  const idx = new Map<string, KeyObs>();
  for (const p of status) for (const e of p.entries) {
    const st = flatStats(e);
    if (!st.lastUsedAt) continue; // 无观测：不参与联动，也不覆盖别人
    const k = keyOf(e, p.upstream);
    const prev = idx.get(k);
    if (!prev || st.lastUsedAt >= prev.ts) idx.set(k, { health: slotHealth(e), cooldown: e.cooldown, ts: st.lastUsedAt });
  }
  return idx;
}
const SEV = { ok: 0, stale: 1, cooling: 2, failing: 3 } as const;
/** 槽位有效状态 = 自己的观测 ⊕ 同 key 最新联动观测（按时间覆盖，同刻取更严重）。 */
function mergedSlot(e: SlotStatus, providerUpstream: string | undefined, idx: Map<string, KeyObs>): { health: "cooling" | "failing" | "stale" | "ok"; cooldown: SlotStatus["cooldown"]; linked: boolean } {
  const own = slotHealth(e);
  const ownTs = flatStats(e).lastUsedAt;
  const obs = idx.get(keyOf(e, providerUpstream));
  if (!obs) return { health: own, cooldown: e.cooldown, linked: false };
  if (!ownTs) return { health: obs.health, cooldown: obs.cooldown, linked: true }; // 自己从没用过 → 跟随最新联动观测
  if (obs.ts > ownTs) return { health: obs.health, cooldown: obs.cooldown, linked: true };
  if (obs.ts < ownTs) return { health: own, cooldown: e.cooldown, linked: false };
  if (SEV[own] >= SEV[obs.health]) return { health: own, cooldown: e.cooldown, linked: false };
  return { health: obs.health, cooldown: obs.cooldown, linked: true };
}
/** 汇总：代理数 / 槽位数 / 成功数 / 请求总数 / token 流量（输入含缓存读+写单列） */
const summaryOf = (d: StatusData | null) => {
  if (!d) return null;
  let slots = 0, ok = 0, reqs = 0, tin = 0, tout = 0, tcr = 0, tcw = 0;
  for (const p of d.status) {
    slots += p.entries?.length ?? 0;
    for (const e of p.entries ?? []) {
      const st = flatStats(e);
      ok += st.ok; reqs += reqsOf(st);
      tin += st.tin ?? 0; tout += st.tout ?? 0; tcr += st.tcr ?? 0; tcw += st.tcw ?? 0;
    }
  }
  return { proxies: d.status.length, slots, ok, reqs, tin, tout, tcr, tcw };
};
/** 头部用：token 流量片段（有流量才显示） */
const tokSummary = (s: ReturnType<typeof summaryOf>) => {
  if (!s) return "";
  const cache = s.tcr + s.tcw;
  if (s.tin + s.tout + cache === 0) return "";
  return ` · ↑${fmtTok(s.tin)}↓${fmtTok(s.tout)}${cache > 0 ? `↻${fmtTok(cache)}` : ""}`;
};
/** 槽位行用：该槽 token 流量片段（无流量返回空） */
const tokOf = (st: SlotStat) => {
  const tin = st.tin ?? 0, tout = st.tout ?? 0, cache = (st.tcr ?? 0) + (st.tcw ?? 0);
  if (tin + tout + cache === 0) return null;
  return { text: `↑${fmtTok(tin)}↓${fmtTok(tout)}${cache > 0 ? `↻${fmtTok(cache)}` : ""}`, cache };
};
const emptyText = (d: StatusData) =>
  d.loaded
    ? t("mw.st.emptyLoaded")
    : d.present
      ? t("mw.st.emptyPresent")
      : t("mw.st.emptyNotLoaded");

/** 打开时拉一次 + 🔄 手动刷新（零轮询） */
function useProxyStatus() {
  const [data, setData] = useState<StatusData | null>(null);
  const [spin, setSpin] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setSpin(true);
    api("/proxy-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && d.ok) { setData(d); setFailed(false); } else setFailed(true); })
      .catch(() => setFailed(true))
      .finally(() => setSpin(false));
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { data, spin, failed, load };
}

function RefreshBtn({ load, spin, size = 11 }: { load: () => void; spin: boolean; size?: number }) {
  return (
    <button
      type="button"
      onClick={load}
      title={t("mw.st.refresh")}
      className="amw-refresh"
      style={{ width: size + 9, height: size + 9 }}
    >
      {spin ? (
        <span style={{ fontSize: size, lineHeight: 1 }}>…</span>
      ) : (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
        </svg>
      )}
    </button>
  );
}

/** 共享渲染：provider 卡片列表（下拉压缩版 / 弹窗整窗版共用）。外层决定滚动容器。 */
function StatusProviders({ status }: { status: ProviderStatus[] }) {
  const keyIdx = buildKeyIndex(status); // 同 key 跨代理联动（按时间覆盖）
  return (
    <>
      {status.map((p) => {
        const used = p.entries.filter((e) => flatStats(e).lastUsedAt > 0)
          .sort((a, b) => flatStats(b).lastUsedAt - flatStats(a).lastUsedAt);
        const current = used[0];
        return (
          <div key={p.provider} className="amw-st-block">
            <div className="amw-st-head">
              <span style={{ whiteSpace: "nowrap" }}>{p.provider}</span>
              <span className={"amw-chip " + (p.isCombo ? "is-combo" : "is-key")}>
                {p.isCombo ? t("mw.st.pillCombo") : t("mw.st.pillKey")}
              </span>
              <span className="amw-st-sub">
                {p.isCombo && p.built === false ? (
                  p.configError ? t("mw.st.configError") : t("mw.st.unbuilt")
                ) : (
                  <>{hostOf(String(p.upstream || ""))} ·:{p.port}{p.sticky === false ? ` · ${t("mw.st.stickyOff")}` : ""}</>
                )}
              </span>
            </div>
            {(p.saturation ?? []).filter((s) => s.seconds >= 0).map((s) => {
              const terminal = p.saturationTerminalMs ?? 180_000;
              const near = s.seconds * 1000 >= terminal - 30_000;
              return (
                <div key={s.pool} className={"amw-chip " + (near ? "is-err" : "is-warn")}
                  style={{ display: "inline-flex", margin: "2px 0", fontSize: 11 }}
                  title={t("mw.st.satTitle")}>
                  {t("mw.st.satChip", { s: s.seconds })}{near ? ` · ${t("mw.st.satNear")}` : ""}
                </div>
              );
            })}
            {p.isCombo && p.built === false ? (
              <div className="amw-hint" style={{ padding: "4px 2px" }}
                title={p.configError ? t("mw.st.memberFailTitle", { err: p.configError }) : undefined}>
                {p.configError
                  ? t("mw.st.unbuildable", { err: p.configError })
                  : t("mw.st.virtualModels", { n: p.configModels ?? 0 })}
              </div>
            ) : (
            <div className="amw-st-grid">
              {(() => {
                // combo 多 key 同成员：label 带 key 后缀区分；member 相同才加
                const memberCount = new Map<string, number>();
                for (const e of p.entries) { const k = e.member ?? e.name; memberCount.set(k, (memberCount.get(k) ?? 0) + 1); }
                return p.entries.map((e) => {
                  const st = flatStats(e);
                  const m = mergedSlot(e, p.upstream, keyIdx);
                  const isCur = e === current;
                  const errs = st.err4xx + st.err5xx + st.timeout;
                  const label = e.member
                    ? (memberCount.get(e.member)! > 1 ? `${e.member} · ${e.name.includes("/") ? e.name.split("/").pop() : e.name}` : e.member)
                    : e.name;
                  const mivTxt = e.minIntervalMs ? (e.minIntervalMs === "auto" ? t("mw.st.intervalAuto") : t("mw.st.intervalS", { s: Math.round(Number(e.minIntervalMs) / 100) / 10 })) : "";
                  const suffix = [e.rpm ? `rpm${e.rpm}` : "", mivTxt, e.weight && e.weight !== 10 ? `w${e.weight}` : ""].filter(Boolean).join(" ");
                  // 同一 provider 单 apiKey 被同一聚合的多个成员复用时槽位同名（如 freeds4 的两个 modelscope 成员都是 modelscope/primary）——key 拼成员/模型保唯一
                  return (
                    <Fragment key={`${e.name}|${e.member ?? ""}|${e.model ?? ""}`}>
                      <div className={"amw-st-slot" + (isCur ? " is-cur" : "")}>
                        <span>{isCur ? "▶" : ""}</span>
                        <span className="amw-st-label" title={suffix ? `${label} ${suffix}` : label}>{label}{suffix ? <span style={{ opacity: 0.7, marginLeft: 2 }}>{suffix}</span> : null}</span>
                        {e.pinned > 0 && <span title={t("mw.st.pinnedTitle")} style={{ fontSize: 10, color: "var(--accent,#2563eb)", opacity: 0.9, flexShrink: 0 }}>{t("mw.st.pinned", { n: e.pinned })}</span>}
                      </div>
                      <div className="amw-st-stats">
                        {m.cooldown ? (() => {
                          const isRl = m.cooldown.kind === "ratelimit";
                          const up = isRl ? m.cooldown.upstreamSec : undefined;
                          const tip = isRl
                            ? (up
                              ? t("mw.st.coolUpstream", { up, clock: fmtClock(Date.now() + up * 1000), eta: fmtEta(up) })
                                + (m.cooldown.capped ? " · " + t("mw.st.coolCapped") : "")
                                + (m.cooldown.hint ? " · " + m.cooldown.hint : "")
                              : t("mw.st.coolNoRetryAfter", { s: m.cooldown.secondsLeft }))
                            : t("mw.st.coolError");
                          return (
                            <span className={"amw-chip " + (isRl ? "is-warn" : "is-err")} title={tip}>
                              🧊{isRl ? t("mw.st.429cool") : t("mw.st.errCool")}{up ? " · " + fmtEta(up) + (m.cooldown.capped ? "⚠" : "") : m.cooldown.secondsLeft + "s"}{m.linked ? t("mw.st.linked") : ""}
                            </span>
                          );
                        })() : m.health === "failing" ? (
                          <span className="amw-chip is-err" title={m.linked ? t("mw.st.failLinkedTitle") : t("mw.st.failTitle")}>{t("mw.st.all429")}{m.linked ? t("mw.st.linked") : ""}</span>
                        ) : m.health === "stale" ? (
                          <span className="amw-chip" style={{ background: "rgba(148,163,184,.14)", color: "var(--text-dim,#9ca3af)" }} title={t("mw.st.staleTitle", { ago: ago(st.lastUsedAt) })}>
                            {t("mw.st.unobserved")}{m.linked ? t("mw.st.linked") : ""}
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 3 }}><span className="amw-dot" />{t("mw.st.normal")}</span>
                        )}
                        <span style={{ marginLeft: 4 }}>req {fmtN(reqsOf(st))}</span>
                        {st.ok > 0 && <span> · ✓{fmtN(st.ok)}</span>}
                        {st.err429 > 0 && <span style={{ color: "var(--warn, #d97706)" }}> · 429×{fmtN(st.err429)}</span>}
                        {errs > 0 && <span style={{ color: "var(--danger, #dc2626)" }}> · ⚠{fmtN(errs)}</span>}
                        {(() => {
                          const tok = tokOf(st);
                          if (!tok) return null;
                          return <span title={t("mw.st.tokTitle") + (tok.cache > 0 ? " · " + t("mw.st.tokCache") : "")}
                            style={{ color: "var(--accent,#2563eb)", opacity: 0.85 }}> · {tok.text}</span>;
                        })()}
                        {isCur && st.lastUsedAt > 0 && <span style={{ color: "var(--text-dim)" }}> · {ago(st.lastUsedAt)}</span>}
                      </div>
                    </Fragment>
                  );
                });
              })()}
            </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ------------------------------------------------------------------
// ① 会话信息下拉条目（sessionStats 插槽）——紧凑；不限高，随宿主面板滚动条整体滚动
// ------------------------------------------------------------------
export function MultiKeyStatusRows(props: Record<string, unknown>) {
  const { data, spin, failed, load } = useProxyStatus();
  const sum = summaryOf(data);
  return (
    <div className="amw-st-rows">
      <div className="amw-st-head-row">
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>{t("mw.st.title")}</span>
        <RefreshBtn load={load} spin={spin} />
        {data && (
          <span className="amw-hint" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
            {t("mw.st.proxiesSlots", { proxies: sum!.proxies, slots: sum!.slots })}{sum!.reqs > 0 ? ` · ${fmtN(sum!.ok)}✓/${fmtN(sum!.reqs)}` : ""}{tokSummary(sum!)}
          </span>
        )}
      </div>

      {failed && (
        <div className="amw-chip is-err">{t("mw.st.readFailed")}</div>
      )}
      {!failed && !data && <div className="amw-hint">…</div>}

      {!failed && data && (
        data.status.length === 0 ? (
          <div className="amw-hint">{emptyText(data)}</div>
        ) : (
          <div className="amw-st-scroll">
            <StatusProviders status={data.status} />
          </div>
        )
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// ② 模型向导「模型聚合」页签头部汇总芯片——点击打开详情弹窗
// ------------------------------------------------------------------
export function MultiKeyStatusSummary({ onOpen, style }: { onOpen: () => void; style?: Record<string, string | number> }) {
  const { data, failed } = useProxyStatus();
  const sum = summaryOf(data);
  let bg = "rgba(148,163,184,.12)", fg = "var(--text-dim,#9ca3af)", txt = t("mw.st.sum.ready");
  if (failed) { bg = "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)"; fg = "var(--danger, #dc2626)"; txt = t("mw.st.sum.failed"); }
  else if (data) {
    const keyIdx = buildKeyIndex(data.status);
    const anyFailing = data.status.some((p) =>
      (p.saturation?.length ?? 0) > 0) || [...keyIdx.values()].some((o) => o.health === "failing");
    const anyCooling = [...keyIdx.values()].some((o) => o.health === "cooling");
    if (data.status.length > 0 && anyFailing) {
      bg = "color-mix(in srgb, var(--danger, #ef4444) 14%, transparent)"; fg = "var(--danger, #dc2626)";
      txt = t("mw.st.sum.failing", { proxies: sum!.proxies });
    } else if (data.status.length > 0 && anyCooling) {
      bg = "color-mix(in srgb, var(--warn, #f59e0b) 14%, transparent)"; fg = "var(--warn, #b45309)";
      txt = t("mw.st.sum.cooling", { proxies: sum!.proxies });
    } else if (data.status.length > 0) {
      bg = "color-mix(in srgb, var(--ok, #22c55e) 12%, transparent)"; fg = "var(--ok, #16a34a)";
      txt = (sum!.slots ? t("mw.st.proxiesSlots", { proxies: sum!.proxies, slots: sum!.slots }) : t("mw.st.proxies", { proxies: sum!.proxies })) + (sum!.reqs > 0 ? ` · ${fmtN(sum!.ok)}✓/${fmtN(sum!.reqs)}` : "");
    } else if (data.loaded) { txt = t("mw.st.sum.empty"); }
    else if (data.present) { bg = "color-mix(in srgb, var(--warn, #f59e0b) 14%, transparent)"; fg = "var(--warn, #b45309)"; txt = t("mw.st.sum.old"); }
    else { txt = t("mw.st.sum.notLoaded"); }
  }
  return (
    <button
      type="button"
      title={t("mw.st.sumTitle")}
      onClick={onOpen}
      className="amw-sum-chip"
      style={{ background: bg, color: fg, ...(style || {}) }}
    >
      ● {txt}  ›
    </button>
  );
}

// ------------------------------------------------------------------
// ③ 详情弹窗——整窗滚动看具体信息
// ------------------------------------------------------------------
export function MultiKeyStatusDialog({ onClose }: { onClose: () => void }) {
  const { data, spin, failed, load } = useProxyStatus();
  const sum = summaryOf(data);
  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // aiti-float 契约：与其他弹层一致，可拖拽/缩放/小屏全屏（float 扫描 [data-ext-float] 自动增强）
  const floatProps: any = { "data-ext-float": "1", "data-ext-float-w": 760, "data-ext-float-autoh": "1", "data-ext-float-full": "1" };
  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="amw-overlay amw-overlay-top"
    >
      <div {...floatProps} className="amw-float-panel" style={{ width: "min(760px, 94vw)", maxHeight: "min(76vh, 660px)" }}>
        <div className="amw-st-dlg-head">
          <span style={{ fontWeight: 700, fontSize: 13 }}>{t("mw.st.titleDlg")}</span>
          <RefreshBtn load={load} spin={spin} />
          {data && (
            <span className="amw-hint" style={{ fontSize: 11 }}>
              {t("mw.st.proxiesSlots", { proxies: sum!.proxies, slots: sum!.slots })}{sum!.reqs > 0 ? ` · ${fmtN(sum!.ok)}✓/${fmtN(sum!.reqs)} req` : ""}{tokSummary(sum!)} · {t("mw.st.cumulative")}
            </span>
          )}
          <button
            type="button"
            title={t("mw.st.close")}
            onClick={onClose}
            className="amw-close"
            style={{ marginLeft: "auto", fontSize: 15, lineHeight: 1, padding: "2px 4px" }}
          >✕</button>
        </div>
        <div className="amw-st-dlg-body">
          {failed && <div className="amw-note is-err">{t("mw.st.readFailed")}</div>}
          {!failed && !data && <div className="amw-hint-lg">…</div>}
          {!failed && data && (
            data.status.length === 0
              ? <div className="amw-hint-lg" style={{ padding: "8px 0" }}>{emptyText(data)}</div>
              : <StatusProviders status={data.status} />
          )}
        </div>
        <div className="amw-st-legend">
          {t("mw.st.legend")}
        </div>
      </div>
    </div>
  );
}
