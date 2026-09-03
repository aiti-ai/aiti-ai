"use client";
// 全局错误边界（crash-rescue §5.2 场景2）：逃出所有 boundary 的渲染错误冒泡到
// root → Next 渲染本页（替换整个 <html>）。零依赖：不 import 任何应用组件/扩展
// client（崩溃的模块可能就是它们）。极简输入框 → POST /api/emergency → 流式拉取
// AI 输出原样显示（独立会话，含 aiti-configs 工具）。reset 重试渲染。
import { useEffect, useRef, useState, type CSSProperties } from "react";

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<{ role: "u" | "a"; text: string }[]>([]);
  const [cur, setCur] = useState("");
  const [sid, setSid] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // 模型切换：默认 model 限流时换一个。加载 /api/models → 下拉；失败则兑底手动输入 provider|modelId。
  const [mods, setMods] = useState<{ provider: string; id: string; name: string }[]>([]);
  const [mSel, setMSel] = useState("");       // 下拉选中值 provider|id
  const [mManual, setMManual] = useState(""); // 手动输入 provider|modelId
  const [modelsFailed, setModelsFailed] = useState(false);
  const [mOpen, setMOpen] = useState(false);
  // AbortController ref：用于在重连循环里检查用户是否发了新指令 → 主动取消旧请求
  const abortCtrlRef = useRef<AbortController | null>(null);

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
      // 覆盖 globals.css 对 html/body 的 overflow:hidden（供 AppShell 自管理滚动）——全局错误页
      // 必须允许整页滚动，否则小屏内容超出视口时 AI 输出窗/输入框/按钮被裁、无法滚动查看。
      // setProperty(..., important) 强覆盖（shorthand overflow:auto = 横竖都可滚；错误页横向内容窄无副作用）。
      document.body.style.setProperty("overflow", "auto", "important");
      document.documentElement.style.setProperty("overflow", "auto", "important");
    } catch { /* ignore */ }
  }, []);

  // 急救流式拉取：遇到传输中断（HTTP/2 RST / ERR_INTERNET_DISCONNECTED / 空网络错误），
  // 底层 `fetch`/`reader.read()` 会抛——急救页此前直接显示 `[错误] network error` 就停了，
  // 没有重连。这里改成：认出「可重试的中断错误」→ 自动重连（带短暂退避），复用同一个
  // sid 继续分片；真正非网络的错误（4xx/5xx json error）才直接上报。
  const send = async () => {
    const text = msg.trim();
    if (!text) return;
    // 取消上一次还在跑（重连中）的请求/循环，避免双流交叉
    if (abortCtrlRef.current) {
      try { abortCtrlRef.current.abort(); } catch { /* ignore */ }
    }
    const ctrl = new AbortController();
    abortCtrlRef.current = ctrl;
    setLog((l) => [...l, { role: "u", text }]);
    setMsg("");
    setCur("");

    const isRetriableNetworkErr = (e: unknown) => {
      const m = e instanceof Error ? e.message : String(e);
      const lower = m.toLowerCase();
      // 明确的非网络业务错误直接剔除（避免把 4xx/5xx 当网络错误重试）
      const businessErrorPatterns = [
        /^\d{3}\s/,
        /quota exceeded/i,
        /invalid .*model/i,
        /authentication ?failed|unauthorized|forbidden/i,
        /model .* not found|deprecated/i,
        /rate limit exceeded|429/,
      ];
      const isBusinessError = businessErrorPatterns.some(p => p.test(lower));
      if (isBusinessError) return false;
      // 常见网络中断模式
      const networkPatterns = [
        /network\s*error/i,
        /failed to fetch/i,
        /abort/i,
        /ERR_HTTP2_PROTOCOL_ERROR/i,
        /ERR_INTERNET_DISCONNECTED/i,
        /ERR_CONNECTION_RESET/i,
        /ERR_INCOMPLETE_CHUNKED_ENCODING/i,
        /connection ?lost|connection ?closed/i,
        /socket ?error|empty ?response/i,
        /timeout|timed out/i,
        /disconnected|disconnect/i,
      ];
      return networkPatterns.some(p => p.test(lower)) && !isBusinessError;
    };

    const attempt = async (tryNo: number): Promise<void> => {
      // 重连仍复用同一个会话：继续累积到同一段 cur
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
          signal: ctrl.signal,
        });
        const s = r.headers.get("x-session-id");
        if (s) setSid(s);
        if (!r.ok) {
          // 非 2xx：服务端明确出错，不用重连，直接上报
          let emsg = "HTTP " + r.status;
          try { emsg = (await r.json())?.error || emsg; } catch { /* ignore */ }
          throw new Error(emsg);
        }
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
        // 用户发了新指令主动 abort → 静默退出，不重连也不报错
        if (ctrl.signal.aborted) return;
        const retriable = isRetriableNetworkErr(e);
        if (retriable) {
          // 永久重连：间隔 1s，尽最大可能恢复（崩溃恢复模式）
          const wait = 1000;
          setCur((prev) => prev + (prev && !prev.endsWith("\n") ? "\n" : "") + `… 连接中断，永久重连中（间隔 1s）`);
          await new Promise((resolve) => setTimeout(resolve, wait));
          // 重连前再检查一次是否被新指令顶替
          if (ctrl.signal.aborted) return;
          return attempt(tryNo + 1);
        }
        // 非可重试错误：记录错误但保留当前输入，避免「消息停刷」
        const errMsg = e instanceof Error ? e.message : String(e);
        setLog((l) => [...l, { role: "a", text: `[错误] ${errMsg.substring(0, 80)}${errMsg.length > 80 ? "..." : ""}` }]);
        // 不清空 cur，保留已输入的指令，让用户可重试或手动调整
      }
    };

    try {
      await attempt(0);
    } finally {
      // 释放当前 ctrl（但保留重新创建的能力）
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  };

  const pre: CSSProperties = {
    margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", overflowWrap: "break-word",
    maxWidth: "100%", fontSize: 12, lineHeight: 1.5, fontFamily: "monospace",
  };

  return (
    <html lang="zh" style={{ overflowY: "auto", overflowX: "hidden", height: "auto" }}>
      <body style={{ margin: 0, background: "#1a1a1a", color: "#e8e8e8", fontFamily: "system-ui, sans-serif", minHeight: "100vh" }}>
        {/* 强制 html/body 可整页滚动（globals.css 对 html,body 设 overflow:hidden 供 AppShell 自管理滚动；
            全局错误页必须可滚，否则小屏内容超出视口时发送按钮/输入框被裁）。style 是 CSS 非 script，不受
            「React 不执行 script」限制；!important 压过 globals.css 与 Next 错误页内联。 */}
        <style>{`html, body { overflow: auto !important; height: auto !important; min-height: 100vh !important; overflow-x: hidden !important; }`}</style>
        <div style={{ maxWidth: 640, width: "100%", boxSizing: "border-box", margin: "0 auto", padding: "32px 20px 64px" }}>
          <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>🚑 页面崩溃 — 急救模式</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px", flexWrap: "wrap" }}>
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
            {(cur) && (
              <pre style={{ ...pre, padding: "6px 8px", borderRadius: 6, borderLeft: "3px solid #f59e0b", background: "rgba(245,158,11,0.05)" }}>
                {cur || "思考中…"}
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
            {/* 会话 ID 显示 */}
            <span style={{ fontSize: 11, color: "#666", marginLeft: 8, fontFamily: "monospace" }}>sid: {sid || "none"}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="急救指令（Enter 发送，可多轮）…"
              style={{ flex: 1, minWidth: 0, padding: "8px 10px", fontSize: 13, background: "#242424", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, outline: "none" }}
            />
            <button onClick={send} disabled={!msg.trim()} style={{ padding: "8px 16px", fontSize: 13, background: "#f59e0b", color: "#1a1a1a", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
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
