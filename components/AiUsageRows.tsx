"use client";
import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/base-path";

interface AiUsageData {
  totals?: { in: number; out: number; cacheRead: number; cacheWrite: number; calls: number };
  byCaller?: Record<string, number>;
  /** ?session= 查询时附带：进程存活期内全部会话累计（区分口径，防误读为当前会话） */
  global?: { in: number; out: number; cacheRead: number; cacheWrite: number; calls: number };
}

/**
 * AI 用量行（core invokeAI 集中记账；按场景分：续写 / 语音修正）。
 * 独立组件自持 state + 15s 轮询：数据更新只重渲染本组件。
 *
 * 口径：传 sessionId 时明细/合计 = 本会话；另附一行「全部会话累计」（进程级，重启清零）。
 * 不传 sessionId 时退化为全局累计（旧行为）。
 *
 * 性能背景：原实现把 aiUsage state 放 AppShell，每 15s setAiUsage 新对象 →
 * AppShell 全树重渲染（ChatWindow + SessionSidebar + 消息列表），
 * Performance trace 显示每 15s 一次 280-300ms 主线程尖峰（React Scheduler 占满）。
 * 下沉后轮询只在「会话统计面板」打开时挂载，关闭即停止。
 */
export function AiUsageRows({ locale, sessionId }: { locale: string; sessionId?: string | null }) {
  const [aiUsage, setAiUsage] = useState<AiUsageData | null>(null);
  useEffect(() => {
    let alive = true;
    const url = apiUrl(sessionId
      ? `/api/chat/ai-usage?session=${encodeURIComponent(sessionId)}`
      : "/api/chat/ai-usage");
    const load = () => fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setAiUsage({ totals: d.totals, byCaller: d.byCaller, global: d.global }); })
      .catch(() => {});
    load();
    const t = setInterval(load, 15000); // 轻量轮询（仅面板打开期间）
    return () => { alive = false; clearInterval(t); };
  }, [sessionId]);

  const bc = aiUsage?.byCaller || {};
  const rows: string[][] = [];
  const sceneLabel = (k: string) => k.includes("/voice-fix") ? "AI 语音修正" : k.includes("/complete") ? "AI 续写" : k;
  for (const [k, v] of Object.entries(bc)) {
    if (!k.startsWith("aiti-ai-input")) continue; // 只展示本扩展（补全/语音）场景
    rows.push([sceneLabel(k), `${v.toLocaleString(locale)} in`]);
  }
  if (aiUsage?.totals?.calls) {
    const t = aiUsage.totals;
    rows.push([sessionId ? "本会话合计" : "AI 合计", `${t.in.toLocaleString(locale)} in / ${t.out.toLocaleString(locale)} out · ${t.calls} 次`]);
  } else if (sessionId) {
    rows.push(["本会话合计", "本会话暂无 AI 调用"]);
  }
  if (rows.length === 0) return null;
  const g = aiUsage?.global;
  const fmtCalls = (n: number) => `${n.toLocaleString(locale)} 次`;

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>AI 用量</div>
      <div style={{ display: "grid", gridTemplateColumns: "max-content max-content", columnGap: 14, rowGap: 4, justifyContent: "start" }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
            <div style={{ color: "var(--text-muted)", minWidth: 0, overflowWrap: "normal", textAlign: "right", whiteSpace: "nowrap" }}>{value}</div>
          </div>
        ))}
        {g && g.calls > 0 && (
          <div style={{ display: "contents" }}>
            <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>全部会话累计</div>
            <div style={{ color: "var(--text-dim)", minWidth: 0, textAlign: "right", whiteSpace: "nowrap", fontSize: 10.5 }}>{g.in.toLocaleString(locale)} in · {fmtCalls(g.calls)}（进程级）</div>
          </div>
        )}
      </div>
    </div>
  );
}
