"use client";
// Global error boundary (crash-rescue §5.2 scenario 2): render errors that escape every
// boundary bubble to the root → Next renders this page (replacing the whole <html>).
// Zero dependencies: no app components or extension clients are imported (the crashed module
// may be one of them). Minimal input box → POST /api/emergency → stream the AI output
// verbatim (a standalone session with the configs-extension tools). reset retries the render.
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
  // Model switching: swap to another when the default model is rate-limited. Load /api/models → dropdown; on failure fall back to manual provider|modelId input.
  const [mods, setMods] = useState<{ provider: string; id: string; name: string }[]>([]);
  const [mSel, setMSel] = useState("");       // dropdown selection provider|id
  const [mManual, setMManual] = useState(""); // manual input provider|modelId
  const [modelsFailed, setModelsFailed] = useState(false);
  const [mOpen, setMOpen] = useState(false);
  // AbortController ref: lets the reconnect loop detect that the user issued a new instruction → proactively cancel the old request
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
  // manual mode (mOpen or fetch failure) uses mManual; otherwise the dropdown mSel (default = the default model)
  const selModel = (mOpen || modelsFailed) ? parseModel(mManual) : parseModel(mSel);

  const errFull = `[${error?.message || String(error || "unknown error")}]
${error?.stack || "(no stack)"}`;
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
      // Override globals.css's overflow:hidden on html/body (set for AppShell-managed scrolling) —
      // the global error page must allow full-page scrolling, otherwise on small screens content
      // past the viewport clips the AI output box/input/buttons with no way to scroll to them.
      // setProperty(..., important) forces the override (shorthand overflow:auto = both axes
      // scrollable; error-page content is narrow so the horizontal axis has no side effects).
      document.body.style.setProperty("overflow", "auto", "important");
      document.documentElement.style.setProperty("overflow", "auto", "important");
    } catch { /* ignore */ }
  }, []);

  // Rescue streaming fetch: on transport interruption (HTTP/2 RST / ERR_INTERNET_DISCONNECTED /
  // empty network error) the underlying `fetch`/`reader.read()` throws — the rescue page used to
  // just render the network-error message and stop, with no reconnect. Now: recognize "retriable
  // interruption errors" → auto-reconnect (with a short backoff), reusing the same sid to keep
  // accumulating chunks; only genuinely non-network errors (4xx/5xx json error) surface directly.
  const send = async () => {
    const text = msg.trim();
    if (!text) return;
    // cancel any still-running (reconnecting) request/loop from before, avoiding interleaved streams
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
      // exclude clear non-network business errors (avoid retrying 4xx/5xx as network errors)
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
      // common network-interruption patterns
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
      // reconnects reuse the same session: keep accumulating into the same cur
      try {
        const r = await fetch(BASE_PATH + "/api/emergency", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: text,
            sessionId: sid || undefined,
            ...(selModel ? { model: selModel } : {}),
            // on the first round, send the page-crash error to the AI too (so it knows what broke)
            ...(sid ? {} : { errors: [{ message: error?.message || String(error), stack: error?.stack || "", extId: "global-error" }] }),
          }),
          signal: ctrl.signal,
        });
        const s = r.headers.get("x-session-id");
        if (s) setSid(s);
        if (!r.ok) {
          // non-2xx: the server explicitly failed; no reconnect, surface directly
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
        setLog((l) => [...l, { role: "a", text: acc || "(no output)" }]);
        setCur("");
      } catch (e) {
        // the user issued a new instruction and aborted → exit silently, no reconnect, no error
        if (ctrl.signal.aborted) return;
        const retriable = isRetriableNetworkErr(e);
        if (retriable) {
          // reconnect forever: 1s interval, best-effort recovery (crash-recovery mode)
          const wait = 1000;
          setCur((prev) => prev + (prev && !prev.endsWith("\n") ? "\n" : "") + `… connection lost, reconnecting indefinitely (1s interval)`);
          await new Promise((resolve) => setTimeout(resolve, wait));
          // check once more before reconnecting whether a new instruction took over
          if (ctrl.signal.aborted) return;
          return attempt(tryNo + 1);
        }
        // non-retriable error: record it but keep the current input so the message doesn't just stall
        const errMsg = e instanceof Error ? e.message : String(e);
        setLog((l) => [...l, { role: "a", text: `[Error] ${errMsg.substring(0, 80)}${errMsg.length > 80 ? "..." : ""}` }]);
        // don't clear cur; keep the entered instruction so the user can retry or adjust manually
      }
    };

    try {
      await attempt(0);
    } finally {
      // release the current ctrl (while keeping the ability to create a new one)
      if (abortCtrlRef.current === ctrl) abortCtrlRef.current = null;
    }
  };

  const pre: CSSProperties = {
    margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", overflowWrap: "break-word",
    maxWidth: "100%", fontSize: 12, lineHeight: 1.5, fontFamily: "monospace",
  };

  return (
    <html lang="en" style={{ overflowY: "auto", overflowX: "hidden", height: "auto" }}>
      <body style={{ margin: 0, background: "#1a1a1a", color: "#e8e8e8", fontFamily: "system-ui, sans-serif", minHeight: "100vh" }}>
        {/* Force html/body to scroll as a full page (globals.css sets overflow:hidden on html,body
            for AppShell-managed scrolling; the global error page must be scrollable, otherwise on
            small screens the send button/input get clipped past the viewport). A style tag is CSS,
            not script, so the "React doesn't execute script" limit doesn't apply; !important
            overrides both globals.css and the Next error page inline styles. */}
        <style>{`html, body { overflow: auto !important; height: auto !important; min-height: 100vh !important; overflow-x: hidden !important; }`}</style>
        <div style={{ maxWidth: 640, width: "100%", boxSizing: "border-box", margin: "0 auto", padding: "32px 20px 64px" }}>
          <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>🚑 Page crash — rescue mode</h1>
          <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px", flexWrap: "wrap" }}>
            <p style={{ margin: 0, fontSize: 13, color: "#9ca3af", flex: 1 }}>The app hit an error and can no longer render. Send instructions below to the background AI (independent session, with backup helper tools) to locate / roll back / fix recent extension or config changes.</p>
            <button onClick={copyErr} style={{ padding: "4px 10px", fontSize: 12, background: "#333", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, cursor: "pointer", flexShrink: 0 }}>{copied ? "Copied ✓" : "Copy error"}</button>
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
                {cur || "Thinking…"}
              </pre>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "#9ca3af", flexShrink: 0 }}>Model:</span>
            {!modelsFailed ? (
              <>
                <select value={mSel} onChange={(e) => setMSel(e.target.value)} style={{ flex: 1, minWidth: 150, padding: "5px 8px", fontSize: 12, background: "#242424", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, outline: "none" }}>
                  <option value="">Default</option>
                  {mods.map((m) => <option key={m.provider + "|" + m.id} value={m.provider + "|" + m.id}>{m.name || m.id} ({m.provider})</option>)}
                </select>
                <button onClick={() => setMOpen((v) => !v)} style={{ padding: "4px 8px", fontSize: 11, background: "#333", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>{mOpen ? "List" : "Manual"}</button>
              </>
            ) : null}
            {(modelsFailed || mOpen) && (
              <input
                value={mManual}
                onChange={(e) => setMManual(e.target.value)}
                placeholder="provider|modelId (e.g. openai|gpt-4o)"
                style={{ flex: 1, minWidth: 150, padding: "5px 8px", fontSize: 12, background: "#242424", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, outline: "none" }}
              />
            )}
            {/* session id display */}
            <span style={{ fontSize: 11, color: "#666", marginLeft: 8, fontFamily: "monospace" }}>sid: {sid || "none"}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Rescue instruction (Enter to send, multi-turn)…"
              style={{ flex: 1, minWidth: 0, padding: "8px 10px", fontSize: 13, background: "#242424", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, outline: "none" }}
            />
            <button onClick={send} disabled={!msg.trim()} style={{ padding: "8px 16px", fontSize: 13, background: "#f59e0b", color: "#1a1a1a", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
              Send
            </button>
            <button onClick={() => window.location.reload()} style={{ padding: "8px 16px", fontSize: 13, background: "#333", color: "#e8e8e8", border: "1px solid #444", borderRadius: 6, cursor: "pointer" }}>
              Reload page
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
