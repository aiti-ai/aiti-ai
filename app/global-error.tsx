"use client";
// 全局错误边界（crash-rescue §5.2 场景2）：逃出所有 boundary 的渲染错误冒泡到
// root → Next 渲染本页（替换整个 <html>）。零依赖：不 import 任何应用组件/扩展
// client（崩溃的模块可能就是它们）。极简输入框 → POST /api/emergency → 流式拉取
// AI 输出原样显示（独立会话，含 aiti-configs 工具）。reset 重试渲染。
import { useEffect, useState, type CSSProperties } from "react";

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<{ role: "u" | "a"; text: string }[]>([]);
  const [cur, setCur] = useState("");
  const [busy, setBusy] = useState(false);
  const [sid, setSid] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 模型切换：默认 model 限流时换一个。加载 /api/models → 下拉；失败则兑底手动输入 provider|modelId。
  const [mods, setMods] = useState<{ provider: string; id: string; name: string }[]>([]);
  const [mSel, setMSel] = useState("");       // 下拉选中值 provider|id
  const [mManual, setMManual] = useState(""); // 手动输入 provider|modelId
  const [modelsFailed, setModelsFailed] = useState(false);
  const [mOpen, setMOpen] = useState(false);

  useEffect(() => {
    fetch(BASE_PATH + "/api/models")
      .then((r) => r.json())
      .then((d) => {
        const list = Array.isArray(d?.modelList) ? d.modelList : [];
        setMods(list);
        const dm = d?.defaultModel;
        if (dm?.provider && dm?.modelId) setMSel(dm.provider + "|" + dm.modelId);
        if (list.length === 0) setModelsFailed(true);
      })
      .catch(() => setModelsFailed(true));
  }, []);

  const parseModel = (s: string) => { const i = s.indexOf("|"); if (i < 0) return null; const p = s.slice(0, i).trim(), m = s.slice(i + 1).trim(); return p && m ? { provider: p, modelId: m } : null; };
  // 手动模式(mOpen 或 fetch 失败)用 mManual；否则用下拉 mSel（默认值=默认 model）
  const selModel = (mOpen || modelsFailed) ? parseModel(mManual) : parseModel(mSel);

  const errFull = `[${error?.message || String(error || "unknown error")}]
${error?.stack || "(无堆栈)"}`;
  const copyErr = async () => {
    try { await navigator.clipboard.writeText(errFull); } catch {
      const ta = document.createElement("textarea"); ta.value = errFull; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch {} document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  useEffect(() => {
    try {
      document.body.style.background = "#1a1a1a";
      document.body.style.color = "#e8e8e8";
      document.body.style.margin = "0";
    } catch { /* ignore */ }
  }, []);

  const send = async () => {
    const text = msg.trim();
    if (!text || busy) return;
    setLog((l) => [...l, { role: "u", text }]);
    setMsg("");
    setBusy(true);
    setCur("");
    try {
      const r = await fetch(BASE_PATH + "/api/emergency", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId: sid || undefined,
          ...(selModel ? { model: selModel } : {}),
          // 首轮把页面崩溃错误一并送给 AI（让它知道哪坏了）
          ...(sid ? {} : { errors: [{ message: error?.message || String(error), stack: error?.stack || "", extId: "global-error" }] }),
        }),
      });
      const s = r.headers.get("x-session-id");
      if (s) setSid(s);
      const reader = r.body?.getReader();
      const dec = new TextDecoder();
      let acc = "";
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
          setCur(acc);
        }
        acc += dec.decode();
        setCur(acc);
      }
      setLog((l) => [...l, { role: "a", text: acc || "(无输出)" }]);
      setCur("");
    } catch (e) {
      setLog((l) => [...l, { role: "a", text: `[错误] ${e instanceof Error ? e.message : String(e)}` }]);
      setCur("");
    } finally {
      setBusy(false);
    }
  };

  const pre: CSSProperties = {
    margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word",
    fontSize: 12, lineHeight: 1.5, fontFamily: "monospace",
  };

  return (
    <html lang="zh">
      <body style={{ margin: 0, background: "#1a1a1a", color: "#e8e8e8", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ maxWidth: 640, margin: "0 auto", padding: "32px 20px" }}>
          <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>🚑 页面崩溃 — 急救模式</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
            <p style={{ margin: 0, fontSize: 13, color: "#9ca3af", flex: 1 }}>系统遇到错误，已无法正常渲染界面。下面发指令给后台 AI（独立会话，含 aiti-configs 工具），让它定位/回滚/修复最近的扩展或配置变更。</p>
            <button onClick={copyErr} style={{ padding: "4px 10px", fontSize: 12, background: "#333", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, cursor: "pointer", flexShrink: 0 }}>{copied ? "已复制 ✓" : "复制错误"}</button>
          </div>
          <pre style={{ ...pre, margin: "0 0 16px", padding: 10, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.4)", borderRadius: 8, color: "#f59e0b", maxHeight: 160, overflow: "auto" }}>
            {error?.message || String(error || "unknown error")}
            {error?.stack ? `\n\n${error.stack}` : ""}
          </pre>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12, maxHeight: "50vh", overflowY: "auto" }}>
            {log.map((m, i) => (
              <pre key={i} style={{ ...pre, padding: "6px 8px", borderRadius: 6, borderLeft: `3px solid ${m.role === "u" ? "#444" : "#f59e0b"}`, background: m.role === "u" ? "rgba(255,255,255,0.03)" : "rgba(245,158,11,0.05)" }}>
                {m.text}
              </pre>
            ))}
            {(busy || cur) && (
              <pre style={{ ...pre, padding: "6px 8px", borderRadius: 6, borderLeft: "3px solid #f59e0b", background: "rgba(245,158,11,0.05)" }}>
                {cur || (busy ? "思考中…" : "")}
              </pre>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "#9ca3af", flexShrink: 0 }}>模型:</span>
            {!modelsFailed ? (
              <>
                <select value={mSel} onChange={(e) => setMSel(e.target.value)} style={{ flex: 1, minWidth: 150, padding: "5px 8px", fontSize: 12, background: "#242424", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, outline: "none" }}>
                  <option value="">默认</option>
                  {mods.map((m) => <option key={m.provider + "|" + m.id} value={m.provider + "|" + m.id}>{m.name || m.id}（{m.provider}）</option>)}
                </select>
                <button onClick={() => setMOpen((v) => !v)} style={{ padding: "4px 8px", fontSize: 11, background: "#333", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>{mOpen ? "列表" : "手动"}</button>
              </>
            ) : null}
            {(modelsFailed || mOpen) && (
              <input
                value={mManual}
                onChange={(e) => setMManual(e.target.value)}
                placeholder="provider|modelId（如 openai|gpt-4o）"
                style={{ flex: 1, minWidth: 150, padding: "5px 8px", fontSize: 12, background: "#242424", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, outline: "none" }}
              />
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="急救指令（Enter 发送，可多轮）…"
              disabled={busy}
              style={{ flex: 1, padding: "8px 10px", fontSize: 13, background: "#242424", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, outline: "none" }}
            />
            <button onClick={send} disabled={busy || !msg.trim()} style={{ padding: "8px 16px", fontSize: 13, background: "#f59e0b", color: "#1a1a1a", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
              发送
            </button>
            <button onClick={() => window.location.reload()} style={{ padding: "8px 16px", fontSize: 13, background: "#333", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, cursor: "pointer" }}>
              刷新页面
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
