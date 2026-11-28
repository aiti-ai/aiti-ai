/**
 * aiti-channels · TabChat (v2 P2) — real-time chat view, the native admin
 * ChatView's counterpart in our panel:
 *   - left: project + session list (mgmt GET /projects/{p}/sessions)
 *   - right: history (GET /projects/{p}/sessions/{id}?history_limit) + live
 *     stream (SSE /chat-stream → bridge frames) + input (POST /chat-send →
 *     bridge WS, session_key = bridge:web-admin:<project> by default — the
 *     SAME session the original admin chat uses, so history stays shared)
 *
 * No polling: history loads on selection, live updates arrive via SSE, sends
 * are user-initiated. Streaming deltas for the active session_key append to a
 * draft bubble finalized on reply completion.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { apiUrl, t } from "./host-shim";
import { btnStyle, cardStyle, inp, sectionTitle, chip } from "./channels-app";

const API = (p: string) => apiUrl(p);

type SessionRow = {
  id: string; session_key: string; name: string; platform: string; active: boolean;
  updated_at: string; history_count: number;
  last_message?: { role: string; content: string; timestamp: string } | null;
};
type HistoryMsg = { role: string; content: string; timestamp: string };

/** Very light markdown-ish rendering: fenced code blocks + inline backticks +
 *  pre-wrap text. Full MD rendering belongs to the host chat, not this panel. */
function ChatBubble({ role, text }: { role: string; text: string }) {
  const isUser = role === "user";
  const parts = text.split(/```/);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", gap: 2 }}>
      <div style={{
        maxWidth: "92%", padding: "7px 11px", borderRadius: 12, fontSize: 12.5, lineHeight: 1.65,
        whiteSpace: "pre-wrap", wordBreak: "break-word",
        background: isUser ? "rgba(99,102,241,0.14)" : "var(--bg-hover, rgba(127,127,127,0.08))",
        border: "1px solid var(--border, rgba(127,127,127,0.15))",
      }}>
        {parts.length > 1
          ? parts.map((seg, i) => i % 2 === 1
            ? <pre key={i} style={{ background: "rgba(0,0,0,0.06)", borderRadius: 8, padding: "6px 8px", margin: "4px 0", overflowX: "auto", fontSize: 11.5, fontFamily: "ui-monospace, monospace" }}>{seg.replace(/^\w*\n/, "")}</pre>
            : <span key={i}>{seg}</span>)
          : text}
      </div>
    </div>
  );
}

export function TabChat({ instance, projects }: { instance: string; projects?: string[] }) {
  const projList = projects || [];
  const [project, setProject] = useState(projList[0] || "");
  useEffect(() => { if (projList.length && !projList.includes(project)) setProject(projList[0]); }, [projList.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selKey, setSelKey] = useState<string>("");
  const [selId, setSelId] = useState<string>("");
  const [history, setHistory] = useState<HistoryMsg[]>([]);
  const [live, setLive] = useState<{ text: string } | null>(null);
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState("");
  const [relayOk, setRelayOk] = useState<{ registered: boolean; error: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const activeKeyRef = useRef<string>("");

  const scrollToBottom = () => { requestAnimationFrame(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }); };

  // session list per project
  const loadSessions = useCallback(async (pj: string) => {
    if (!pj) return;
    try {
      const r = await fetch(API(`/api/extensions/aiti-channels/mgmt/projects/${encodeURIComponent(pj)}/sessions?instance=${encodeURIComponent(instance)}`), { cache: "no-store" });
      const d = await r.json();
      const det = d && d.data ? d.data : d;
      setSessions(Array.isArray(det?.sessions) ? det.sessions : []);
    } catch (e: any) { setErr(e.message); }
  }, [instance]);

  // relay status + SSE stream (re-established per project change)
  useEffect(() => {
    if (!project) return;
    let alive = true;
    fetch(API(`/api/extensions/aiti-channels/chat-relay-status?instance=${encodeURIComponent(instance)}`)).then(r => r.json()).then(d => { if (alive) setRelayOk({ registered: !!d.relay?.registered, error: d.relay?.error || null }); }).catch(() => {});
    const es = new EventSource(API(`/api/extensions/aiti-channels/chat-stream?instance=${encodeURIComponent(instance)}&project=${encodeURIComponent(project)}`));
    esRef.current = es;
    es.onmessage = (evt) => {
      if (!alive) return;
      let f: any;
      try { f = JSON.parse(evt.data); } catch { return; }
      if (f.type === "relay_ready") { setRelayOk({ registered: !!f.registered, error: f.error || null }); return; }
      const sk = String(f.session_key || "");
      if (sk && sk !== activeKeyRef.current) return; // only the open conversation
      if (f.type === "reply_stream") {
        setLive({ text: String(f.full_text ?? f.delta ?? "") });
        setTyping(false);
        scrollToBottom();
      } else if (f.type === "reply") {
        setLive(null);
        setHistory((h) => [...h, { role: "assistant", content: String(f.content || ""), timestamp: new Date().toISOString() }]);
        scrollToBottom();
        void loadSessions(project);
      } else if (f.type === "typing_start") {
        setTyping(true); scrollToBottom();
      } else if (f.type === "typing_stop") {
        setTyping(false);
      } else if (f.type === "card" || f.type === "buttons") {
        setHistory((h) => [...h, { role: "assistant", content: String(f.content || "[card message]"), timestamp: new Date().toISOString() }]);
        scrollToBottom();
      }
    };
    es.onerror = () => { /* EventSource auto-reconnects; relay_ready refreshes state */ };
    return () => { alive = false; es.close(); esRef.current = null; };
  }, [instance, project, loadSessions]);

  // history for the selected session (history API takes the session id, not the key)
  useEffect(() => {
    activeKeyRef.current = selKey;
    setLive(null); setTyping(false);
    if (!project || !selId) { setHistory([]); return; }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(API(`/api/extensions/aiti-channels/mgmt/projects/${encodeURIComponent(project)}/sessions/${encodeURIComponent(selId)}?history_limit=100&instance=${encodeURIComponent(instance)}`), { cache: "no-store" });
        const d = await r.json();
        const det = d && d.data ? d.data : d;
        if (alive) { setHistory(Array.isArray(det?.history) ? det.history : []); scrollToBottom(); }
      } catch (e: any) { if (alive) setErr(e.message); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [project, selId, instance]);

  useEffect(() => { void loadSessions(project); }, [project, loadSessions]);

  const send = async () => {
    const content = input.trim();
    if (!project || !content) return;
    const sessionKey = selKey || `bridge:web-admin:${project}`;
    setInput("");
    setHistory((h) => [...h, { role: "user", content, timestamp: new Date().toISOString() }]);
    scrollToBottom();
    try {
      const r = await fetch(API(`/api/extensions/aiti-channels/chat-send?instance=${encodeURIComponent(instance)}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project, session_key: sessionKey, content }) });
      const d = await r.json();
      if (!d.ok) setErr(d.error || "send failed");
      if (!selKey) { setSelKey(sessionKey); void loadSessions(project); }
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, height: "100%" }}>
      {/* header: project select + relay state */}
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{t("Chat")}</span>
        <select value={project} onChange={(e) => { setProject(e.target.value); setSelKey(""); }} style={{ ...inp, flex: "0 0 200px", cursor: "pointer" }}>
          {projList.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {relayOk && (
          relayOk.registered
            ? <span style={chip("rgba(34,197,94,0.15)", "#16a34a")}>{t("Bridge connected")}</span>
            : <span style={chip("rgba(245,158,11,0.18)", "#d97706")} title={relayOk.error || ""}>{t("Bridge not connected")}</span>
        )}
        <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => { void loadSessions(project); }}>{t("Refresh")}</button>
      </div>
      {projList.length === 0 && <div style={{ ...cardStyle, fontSize: 12, color: "#6b7280" }}>{t("No projects yet (create one in Bots/Config first)")}</div>}
      {project && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 240px) 1fr", gap: 10, flex: 1, minHeight: 0 }}>
          {/* sessions */}
          <div style={{ ...cardStyle, overflowY: "auto", maxHeight: "60vh", display: "flex", flexDirection: "column", gap: 6 }}>
            {sessions.length === 0 && <div style={{ fontSize: 11, color: "#6b7280" }}>{t("No sessions — sending a message creates one (bridge:web-admin mode)")}</div>}
            {sessions.map((s) => (
              <div key={s.id || s.session_key} onClick={() => { setSelKey(s.session_key || s.id); setSelId(s.id || s.session_key); }}
                style={{ padding: "7px 9px", borderRadius: 9, cursor: "pointer", fontSize: 12,
                  background: selKey === (s.session_key || s.id) ? "rgba(99,102,241,0.1)" : "transparent",
                  border: selKey === (s.session_key || s.id) ? "1px solid #6366f1" : "1px solid transparent" }}>
                <div style={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                  {s.name || s.chat_name || s.session_key.slice(0, 24)}
                  {s.active && <span style={chip("rgba(34,197,94,0.15)", "#16a34a")}>{t("active")}</span>}
                </div>
                <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>{`${s.platform || "im"} · ${s.history_count ?? 0} msgs`}</div>
              </div>
            ))}
            {/* web-admin session shortcut */}
            {!sessions.some((s) => s.session_key === `bridge:web-admin:${project}`) && (
              <div onClick={() => { setSelKey(`bridge:web-admin:${project}`); setSelId(""); }}
                style={{ padding: "7px 9px", borderRadius: 9, cursor: "pointer", fontSize: 12, border: "1px dashed var(--border, rgba(127,127,127,0.3))", color: "#6b7280" }}>
                {"+ " + t("Web-admin session (bridge:web-admin)")}
              </div>
            )}
          </div>
          {/* chat window */}
          <div style={{ ...cardStyle, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div ref={scroller} style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, minHeight: 220, maxHeight: "52vh", padding: "4px 2px" }}>
              {!selKey && <div style={{ fontSize: 11.5, color: "#6b7280" }}>{t("Pick a session on the left, or just type below (defaults to the web-admin session)")}</div>}
              {loading && <div style={{ fontSize: 11, color: "#6366f1" }}>{t("Loading history…")}</div>}
              {history.map((m, i) => <ChatBubble key={i} role={m.role} text={m.content} />)}
              {live && <ChatBubble role="assistant" text={live.text} />}
              {typing && <div style={{ fontSize: 11, color: "#6366f1" }}>{t("typing…")}</div>}
            </div>
            <div style={{ display: "flex", gap: 8, borderTop: "1px solid var(--border, rgba(127,127,127,0.15))", paddingTop: 8 }}>
              <input value={input} placeholder={`${t("Send to")} ${selKey || `bridge:web-admin:${project}`}`}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                style={inp} />
              <button style={{ ...btnStyle, background: "rgba(99,102,241,0.16)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.4)" }}
                disabled={!input.trim() || !project} onClick={() => void send()}>{t("Send")}</button>
            </div>
            {err && <div style={{ fontSize: 11.5, color: "#ea580c", marginTop: 4 }}>{t("Failed: ") + err}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChatTabSlot({ instance, projects }: { instance: string; projects?: string[] }) {
  return <TabChat instance={instance} projects={projects} />;
}
