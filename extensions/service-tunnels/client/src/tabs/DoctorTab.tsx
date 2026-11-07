/**
 * tabs/DoctorTab — P4 网络体检 tab（骨架）。
 *
 * - 事件渲染走共享层 netcheckEventView（ui.doctor.ev.<type> 键，双端同构）
 * - 建议卡走 adviceView（confirmed/untested 角标 + score 排序）
 * - SSE：/api/extensions/service-tunnels/doctor-events（EventSource 自动重连
 *   带 Last-Event-ID，服务端环形缓冲续传）；start/stop job 单例
 * - 能力门控：caps.netcheck=false 时 registry 不注册本 tab；mock 仅
 *   ST_UI_DOCTOR_MOCK=1（服务端 /status 带 doctorMock 标记 → 壳层提示）
 */
import { useEffect, useRef, useState } from "react";
import { apiUrl, copyText } from "../host-shim";
import { adviceView, netcheckEventView, type AdviceCardView } from "../lib-shared";

type T = (key: string, params?: Record<string, string>) => string;

interface DoctorEvent { type: string; [k: string]: unknown }
interface Advice { id?: string; title?: string; score?: number; confidence?: string; confirmed?: boolean; why?: string[]; cmd?: string }

export function DoctorTab({ t }: { t: T }) {
  const [log, setLog] = useState<DoctorEvent[]>([]);
  const [advice, setAdvice] = useState<Advice[]>([]);
  const [report, setReport] = useState<{ text?: string; markdown?: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [mock, setMock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const connect = () => {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(apiUrl("/api/extensions/service-tunnels/doctor-events"));
    es.onmessage = (m) => {
      let ev: DoctorEvent;
      try { ev = JSON.parse(m.data) as DoctorEvent; } catch { return; }
      setLog((prev) => [...prev, ev]);
      if (ev.type === "advice-update" && Array.isArray(ev.advice)) setAdvice(ev.advice as Advice[]);
      if (ev.type === "summary" || ev.type === "done") {
        setReport({ text: typeof ev.text === "string" ? ev.text : undefined, markdown: typeof ev.markdown === "string" ? ev.markdown : undefined });
      }
      if (ev.type === "done" || ev.type === "cancelled" || ev.type === "error") setRunning(false);
    };
    es.onerror = () => { /* 断线由浏览器重连（Last-Event-ID 续传）*/ };
    esRef.current = es;
  };

  useEffect(() => {
    connect();
    return () => { esRef.current?.close(); esRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [log]);

  const start = async () => {
    setError(null);
    setLog([]); setAdvice([]); setReport(null); setRunning(true);
    try {
      const r = await fetch(apiUrl("/api/extensions/service-tunnels/doctor-start"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const d = (await r.json().catch(() => ({}))) as { started?: boolean; mock?: boolean; error?: string };
      if (!r.ok) {
        setError(d.error ?? `HTTP ${r.status}`);
        setRunning(false);
        return;
      }
      if (d.mock) setMock(true);
      if (esRef.current && esRef.current.readyState !== 1) connect();
    } catch (e) {
      setError(String(e));
      setRunning(false);
    }
  };

  const stop = async () => {
    try {
      await fetch(apiUrl("/api/extensions/service-tunnels/doctor-stop"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      setRunning(false);
    } catch (e) { setError(String(e)); }
  };

  const copyReport = () => {
    if (report) copyText(report.markdown || report.text || "").catch(() => {});
  };

  const toneColor = (tone: string) => (tone === "ok" ? "#16a34a" : tone === "bad" ? "var(--danger, #f87171)" : tone === "warn" ? "#d97706" : "var(--text-dim)");

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <button onClick={start} disabled={running} style={{ padding: "5px 14px", background: running ? "var(--bg-hover)" : "var(--accent)", border: "none", borderRadius: 6, color: running ? "var(--text-dim)" : "#fff", cursor: running ? "default" : "pointer", fontSize: 12, fontWeight: 600 }}>
          {t("ui.doctor.start")}
        </button>
        <button onClick={stop} disabled={!running} style={{ padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: running ? "var(--danger, #f87171)" : "var(--text-dim)", cursor: running ? "pointer" : "default", fontSize: 12 }}>
          {t("ui.doctor.stop")}
        </button>
        {running && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("ui.doctor.running")}{mock ? " (mock)" : ""}</span>}
      </div>
      {error && <div style={{ fontSize: 11, color: "var(--danger, #f87171)", marginBottom: 8 }}>{t("services.exposeFailed")}: {error}</div>}

      {/* 事件流（共享层 netcheckEventView 单源渲染） */}
      <div ref={boxRef} style={{ maxHeight: "42vh", overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", background: "var(--bg-panel)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.8 }}>
        {log.length === 0 ? (
          <span style={{ color: "var(--text-dim)" }}>{t("services.loading")}</span>
        ) : (
          log.map((ev, i) => {
            const v = netcheckEventView(ev);
            return (
              <div key={i} style={{ color: toneColor(v.tone) }}>
                {v.icon} {t(v.textKey, v.params)}
              </div>
            );
          })
        )}
      </div>

      {/* 建议卡（adviceView 角标 + score 排序） */}
      {advice.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "2px 0 6px" }}>{t("ui.doctor.advice")}</div>
          {[...advice].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((a) => {
            const v: AdviceCardView = adviceView(a);
            return (
              <div key={v.key || a.title} style={{ border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", padding: "8px 10px", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{a.title || a.id}</span>
                  <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, background: "var(--bg-hover)", color: toneColor(v.tone) }}>{t(v.badgeKey)}</span>
                  <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{a.score}</span>
                </div>
                {a.why && a.why.length > 0 && (
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 3 }}>{a.why.join(" · ")}</div>
                )}
                {a.cmd && (
                  <pre style={{ margin: "4px 0 0", padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, fontSize: 10, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text)" }}>{a.cmd}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 报告卡（summary/done 事件驱动） */}
      {report && (report.markdown || report.text) && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "2px 0 6px" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>{t("ui.doctor.report")}</span>
            <button onClick={copyReport} style={{ padding: "2px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
              {t("ui.doctor.copyMd")}
            </button>
          </div>
          <pre style={{ maxHeight: "26vh", overflow: "auto", margin: 0, padding: "6px 8px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 10, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text)" }}>
            {report.markdown || report.text}
          </pre>
        </div>
      )}
    </div>
  );
}
