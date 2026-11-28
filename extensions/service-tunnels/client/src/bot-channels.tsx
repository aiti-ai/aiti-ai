/**
 * BotChannelsColumn —— 「Open on phone」卡右栏：全量平台 + 绑定 bots。
 *
 * 从 aiti-channels bot-meta API 拉取全部平台（21 种动态清单）+ 绑定 bots。
 * 点平台 = 面板向导预选该平台（openBots）；点绑定 bot = 面板管理。
 * aiti-channels 缺席 → 整栏隐藏。
 */
import { useState, useEffect } from "react";
import { useI18n, apiUrl, extSvc } from "./host-shim";

type BotRow = { name: string; platforms: string[]; bound: boolean };

export function BotChannelsColumn() {
  const { t } = useI18n();
  const [state, setState] = useState<{ phase: "loading" | "absent" | "ready"; bots: BotRow[]; platforms: string[] }>({ phase: "loading", bots: [], platforms: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [rBots, rMeta] = await Promise.all([
          fetch(apiUrl("/api/extensions/aiti-channels/bots"), { cache: "no-store", signal: AbortSignal.timeout(6000) }),
          fetch(apiUrl("/api/extensions/aiti-channels/bot-meta"), { cache: "no-store", signal: AbortSignal.timeout(6000) }).catch(() => null),
        ]);
        if (!alive) return;
        const dBots = await rBots.json();
        if (!alive || !dBots.ok) { if (alive) setState({ phase: "absent", bots: [], platforms: [] }); return; }
        const bots: BotRow[] = [...(dBots.bots || []), ...(dBots.configOnly || [])].map((b: any) => ({
          name: b.name, platforms: b.platforms || [], bound: !!b.bound,
        }));
        let platformTypes: string[] = [];
        try {
          const dMeta = rMeta ? await rMeta.json() : null;
          platformTypes = Array.isArray(dMeta?.platforms) ? dMeta.platforms : [];
        } catch { /* platforms listing unavailable */ }
        if (alive) setState({ phase: "ready", bots, platforms: platformTypes });
      } catch { if (alive) setState({ phase: "absent", bots: [], platforms: [] }); }
    })();
    return () => { alive = false; };
  }, []);

  /** open aiti-channels panel with the wizard preselected for this platform */
  const openBots = (platform?: string) => {
    const svc = extSvc<{ openBots?: (platform?: string) => void }>("aiti-channels.ui");
    if (svc && typeof svc.openBots === "function") { svc.openBots(platform); return; }
    // fallback: dispatch the present command (panel opens but no tab control)
    try { window.dispatchEvent(new CustomEvent("piwe-float-present-command", { detail: { key: "aiti-channels:panel", mode: "float" } })); } catch { /* ignore */ }
  };

  const doAddPlatform = async (project: string, platform: string) => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-channels/bot-create-token"), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, type: platform, options: {}, agent_type: "piweb" }),
        signal: AbortSignal.timeout(30000),
      });
      const d = await r.json();
      if (!d.ok && d.status !== 201) throw new Error(d.error || `HTTP ${r.status}`);
      setMsg(`${project} + ${platform} ✓`);
      await refreshBots();
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  if (state.phase === "loading") {
    return <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "10px 0" }}>{t("mobile.botsLoading")}</div>;
  }
  if (state.phase === "absent") return null;

  const btn: React.CSSProperties = { padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", fontSize: 12, cursor: "pointer", textAlign: "left" };
  const chip: React.CSSProperties = { ...btn, fontSize: 11, padding: "5px 9px", textAlign: "center" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, height: "100%" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{t("mobile.botChannels")}</div>
      {err && <div style={{ fontSize: 11, color: "#ef4444", wordBreak: "break-all" }}>{err}</div>}
      {msg && <div style={{ fontSize: 11, color: "#16a34a" }}>{msg}</div>}

      {/* bound bots */}
      {state.bots.filter((b) => b.bound).map((b) => (
        <button key={b.name} type="button" style={{ ...btn, display: "flex", alignItems: "center", gap: 6 }}
          onClick={() => openBots()}>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {b.platforms.join("/") || "—"}
            {" · "}{b.name}
          </span>
          <span style={{ fontSize: 10, color: "#16a34a", flexShrink: 0 }}>✓</span>
        </button>
      ))}

      {/* platform chips — all cc-connect platforms, tap = open panel wizard preselected */}
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("mobile.createBotOn")}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 220, overflowY: "auto" }}>
        {state.platforms.map((p) => (
          <button key={p} type="button" style={{ ...chip }}
            onClick={() => openBots(p)}>{p}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {state.bots.filter((b) => !b.bound).map((b) => (
          <button key={b.name} type="button" style={{ ...chip, fontSize: 10 }}
            onClick={() => void doAddPlatform(b.name, b.platforms[0] || "telegram")}>{`+ ${b.name}`}</button>
        ))}
      </div>
    </div>
  );
}
