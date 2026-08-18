"use client";
import { useEffect, useState } from "react";
import { apiUrl } from "@/lib/base-path";

interface AiUsageData {
  totals?: { in: number; out: number; cacheRead: number; cacheWrite: number; calls: number };
  byCaller?: Record<string, number>;
}

/**
 * AI 用量行（core invokeAI 集中记账；按场景分：续写 / 语音修正）。
 * 独立组件自持 state + 15s 轮询：数据更新只重渲染本组件。
 *
 * 性能背景：原实现把 aiUsage state 放 AppShell，每 15s setAiUsage 新对象 →
 * AppShell 全树重渲染（ChatWindow + SessionSidebar + 消息列表），
 * Performance trace 显示每 15s 一次 280-300ms 主线程尖峰（React Scheduler 占满）。
 * 下沉后轮询只在「会话统计面板」打开时挂载，关闭即停止。
 */
export function AiUsageRows({ locale }: { locale: string }) {
  const [aiUsage, setAiUsage] = useState<AiUsageData | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch(apiUrl("/api/chat/ai-usage"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d) setAiUsage({ totals: d.totals, byCaller: d.byCaller }); })
      .catch(() => {});
    load();
    const t = setInterval(load, 15000); // 轻量轮询（仅面板打开期间）
    return () => { alive = false; clearInterval(t); };
  }, []);

  const bc = aiUsage?.byCaller || {};
  const rows: string[][] = [];
  const sceneLabel = (k: string) => k.includes("/voice-fix") ? "AI 语音修正" : k.includes("/complete") ? "AI 续写" : k;
  for (const [k, v] of Object.entries(bc)) {
    if (!k.startsWith("aiti-ai-input")) continue; // 只展示本扩展（补全/语音）场景
    rows.push([sceneLabel(k), `${v.toLocaleString(locale)} in`]);
  }
  if (aiUsage?.totals?.calls) {
    const t = aiUsage.totals;
    rows.push(["AI 合计", `${t.in.toLocaleString(locale)} in / ${t.out.toLocaleString(locale)} out · ${t.calls} 次`]);
  }
  if (rows.length === 0) return null;

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
      </div>
    </div>
  );
}
