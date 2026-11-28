/**
 * aiti-channels · bots surface (v2 P0) — ZCode-style bot management:
 *   - TabBots: list (bots aggregate API) + detail (scan-to-create via cc-connect
 *     setup save / token+form via add-platform / card_mode / work_dir / delete)
 *   - RemoteDialogSlot: mobile remote control dialog (scan-to-open deep link via
 *     the service-tunnels.mobile client service, inline QR as the degraded render;
 *     Bot Channel quick list with per-channel protocol source lines)
 *   - BotsDialogSlot: the same TabBots content in a float dialog
 *
 * Channel list = ALL platforms cc-connect supports (dynamic via GET bot-meta
 * /agents when the instance runs; PLATFORM_SCHEMAS + PLATFORM_SRC as the static
 * fallback). The weixin channel goes through the ilink gateway shared with the
 * OpenClaw openclaw-weixin plugin — the scan confirm page will show OpenClaw
 * branding, which is EXPECTED; both the list row and the wizard say so.
 */
import { useState, useEffect, useRef } from "react";
import { apiUrl, t, extSvc } from "./host-shim";
import { openFloat, closePanel, usePresent } from "@aiti-ai/ext-shared/ext-float-dock";
import { PLATFORM_SCHEMAS, platformSchema } from "../../lib/platform-schema.ts";
import { qrDataUrl } from "./qr";
import { btnStyle, cardStyle, inp, sectionTitle, chip } from "./channels-app";

const API = (p: string) => apiUrl(p);

// ---- per-platform protocol source lines (transparency; weixin carries the
// OpenClaw note — same gateway, expected branding on the scan page) ----
export const PLATFORM_SRC: Record<string, { name: string; src: string }> = {
  weixin: { name: "WeChat", src: "ilink gateway long-polling (ilinkai.weixin.qq.com) · unofficial channel, a burner account is recommended" },
  feishu: { name: "Feishu (CN)", src: "Feishu Open Platform official device flow · WS long connection, no public IP" },
  lark: { name: "Lark (Global)", src: "Lark Open Platform (device flow auto-detects the domain) · WS long connection" },
  telegram: { name: "Telegram", src: "create a bot via @BotFather · Bot API long-polling (proxy needed in CN)" },
  dingtalk: { name: "DingTalk", src: "DingTalk Open Platform · Stream mode, no public IP" },
  discord: { name: "Discord", src: "Developer Portal · Gateway WS" },
  slack: { name: "Slack", src: "Socket Mode, no public IP" },
  qq: { name: "QQ (OneBot)", src: "self-hosted NapCat/Lagrange forward WS" },
  qqbot: { name: "QQ Bot", src: "QQ Open Platform" },
  wecom: { name: "WeCom", src: "admin console app · callback mode needs a public endpoint" },
  line: { name: "LINE", src: "Messaging API · public webhook required" },
  matrix: { name: "Matrix", src: "homeserver bot account access_token" },
  webex: { name: "Webex", src: "developer.webex.com · WebSocket" },
  "wps-xiezuo": { name: "WPS Docs", src: "WPS Open Platform" },
  "wps-agentspace": { name: "WPS AgentSpace", src: "WPS Open Platform" },
  yuanbao: { name: "Tencent Yuanbao", src: "closed-beta channel" },
  googlechat: { name: "Google Chat", src: "service account + pubsub" },
  weibo: { name: "Weibo", src: "Weibo Open Platform" },
};
export const OPENCLAW_NOTE = "The scan confirm page will show OpenClaw wording — this channel uses the ilink gateway, the same one as the OpenClaw openclaw-weixin plugin; expected behavior, not a mis-click.";
const SCAN_PLATFORMS = ["feishu", "lark", "weixin"]; // direct-create via setup save
const RICH_CARD_PLATFORMS = ["feishu", "lark"]; // card_mode=rich: only these two

const pfIcon = (type: string) => ({ weixin: "💬", wechat: "💬", feishu: "🪽", lark: "🪽", telegram: "✈️", dingtalk: "🐜", slack: "🪟", discord: "🎮" } as Record<string, string>)[type] || "🔗";
const pfName = (type: string) => t(PLATFORM_SRC[type]?.name || platformSchema(type)?.label || type); // t(): host i18n lookup (English keys pass through)

// ---------- shared bots data ----------
type BotRow = {
  name: string; agent_type: string | null; platforms: string[]; sessions_count: number | null;
  bound: boolean; card_mode: string; work_dir: string | null; allow_from: string | null;
};
let botsCache: { bots: BotRow[]; configOnly?: BotRow[]; running: boolean; version: string | null; mgmtReachable: boolean; mgmtError?: string | null } | null = null;

async function fetchBots(instance: string) {
  const r = await fetch(API(`/api/extensions/aiti-channels/bots?instance=${encodeURIComponent(instance)}`), { cache: "no-store" });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || "bots fetch failed");
  botsCache = d;
  return d as NonNullable<typeof botsCache>;
}

/** Shared scan wizard (device flow, OAuth protocol-required interval polling):
 *  begin → QR → poll → completed(app_id/app_secret | bot_token…) → save. */
type WizardState = {
  phase: "idle" | "loading" | "scanning" | "saving" | "done" | "error";
  platform: string;
  qrUrl?: string;
  qrImg?: string;
  fallbackUrl?: string;
  deviceCode?: string;
  qrKey?: string;
  err?: string;
};
function useScanWizard(instance: string, onDone: () => void) {
  const [wiz, setWiz] = useState<WizardState | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const device = useRef<any>(null);
  const pendingWorkDir = useRef<string>("");
  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  useEffect(() => stop, []);
  const setup = async (platform: string, project: string, workDir: string) => {
    stop();
    pendingWorkDir.current = workDir;
    setWiz({ phase: "loading", platform });
    try {
      const begin = await fetch(API(`/api/extensions/aiti-channels/setup/${platform}/begin`), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const bd = await begin.json();
      const dd = bd.data?.data || bd.data || {};
      if (!bd.ok || (!dd.qr_url && !dd.qr_key)) { setWiz({ phase: "error", platform, err: bd.error || dd.error || "begin failed (instance not running?)" }); return; }
      let qrImg: string | undefined;
      try { if (dd.qr_url) qrImg = await qrDataUrl(dd.qr_url, { size: 160 }); } catch { /* qrcode unavailable → link fallback */ }
      device.current = dd;
      setWiz({
        phase: "scanning", platform,
        qrUrl: dd.qr_url, qrImg,
        deviceCode: dd.device_code, qrKey: dd.qr_key,
        fallbackUrl: dd.qr_url,
      });
      const isWeixin = platform === "weixin";
      const tick = async () => {
        try {
          const body = isWeixin ? { qr_key: device.current?.qr_key } : { device_code: device.current?.device_code, base_url: device.current?.base_url };
          const pr = await fetch(API(`/api/extensions/aiti-channels/setup/${platform}/poll`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const pd = await pr.json();
          const s = pd.data?.data || pd.data || {};
          if (isWeixin) {
            if (s.status === "confirmed" && s.bot_token) {
              stop(); setWiz((w) => (w ? { ...w, phase: "saving" } : w));
              await finish(platform, project, { token: s.bot_token, base_url: s.base_url, ilink_bot_id: s.ilink_bot_id, ilink_user_id: s.ilink_user_id });
              return;
            }
            if (s.status === "expired") { stop(); setWiz({ phase: "error", platform, err: "QR code expired — scan again" }); return; }
          } else if (s.status === "completed" && s.app_id) {
            stop(); setWiz((w) => (w ? { ...w, phase: "saving" } : w));
            await finish(platform, project, { app_id: s.app_id, app_secret: s.app_secret, platform_type: s.platform || platform, owner_open_id: s.owner_open_id });
            return;
          } else if (s.status === "denied" || s.status === "expired" || s.status === "error") {
            stop(); setWiz({ phase: "error", platform, err: s.status + (s.error ? ": " + s.error : "") }); return;
          }
        } catch { /* network jitter → next tick */ }
      };
      const interval = Math.max((Number(dd.interval) || 5) * 1000, 3000);
      timer.current = setInterval(tick, interval);
    } catch (e: any) { setWiz({ phase: "error", platform, err: e.message }); }
  };
  const finish = async (platform: string, project: string, creds: Record<string, unknown>) => {
    const r = await fetch(API(`/api/extensions/aiti-channels/setup/${platform}/save`), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, work_dir: pendingWorkDir.current.trim() || workDirOf(), agent_type: "piweb", ...creds }),
    });
    const d = await r.json();
    if (!d.ok) { setWiz({ phase: "error", platform, err: d.error || "save failed" }); return; }
    setWiz({ phase: "done", platform });
    onDone();
  };
  return { wiz, setup, stop };
}
function workDirOf(): string | undefined {
  // default = current workbench cwd when the page URL carries ?cwd= (restored
  // tabs strip cwd from the URL); otherwise leave undefined (cc-connect default)
  try {
    const cwd = new URLSearchParams(window.location.search).get("cwd");
    return cwd || undefined;
  } catch { return undefined; }
}

// ---------- TabBots ----------
/** Cross-dialog handoff: the remote dialog's Configure button opens the bots dialog with a
 *  preselected platform (consumed once on TabBots mount, then cleared). */
let autoNewPlatform: string | null = null;
export function openBotsNew(platform?: string) {
  autoNewPlatform = platform || null;
  openFloat(BOTS_KEY);
}

export function TabBots({ instance }: { instance: string }) {
  const preselect = autoNewPlatform; // consumed once per mount (remote-dialog Configure handoff)
  autoNewPlatform = null;
  const [bots, setBots] = useState<BotRow[]>(() => botsCache?.bots || []);
  const [meta, setMeta] = useState<{ running: boolean; version: string | null; mgmtReachable: boolean; mgmtError?: string | null }>(() => botsCache || { running: false, version: null, mgmtReachable: false, mgmtError: null });
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(!!preselect);
  const [form, setForm] = useState<{ project: string; type: string; workDir: string; fields: Record<string, string> }>({ project: "", type: preselect || "telegram", workDir: "", fields: {} });
  const { wiz, setup, stop: stopWiz } = useScanWizard(instance, () => { void reload(); });
  const sch = platformSchema(form.type);

  const reload = async () => {
    try {
      const d = await fetchBots(instance);
      setBots([...(d.bots || []), ...(d.configOnly || [])]);
      setMeta({ running: d.running, version: d.version, mgmtReachable: d.mgmtReachable, mgmtError: d.mgmtError });
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { void reload(); }, [instance]);

  const selBot = bots.find((b) => b.name === sel) || null;
  const call = async (action: string, body?: any) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await fetch(API(`/api/extensions/aiti-channels/${action}?instance=${encodeURIComponent(instance)}`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
      const d = await r.json();
      if (!d.ok && d.status !== 201) setErr(d.error || (d.data && d.data.message) || `${action} failed`);
      else setMsg((d.data && (d.data.message || d.data.note)) || d.note || "done");
      await reload();
      return d;
    } catch (e: any) { setErr(e.message); return null; }
    finally { setBusy(false); }
  };

  const startCreate = (type: string) => {
    setCreating(true); setSel(null);
    setForm({ project: "", type, workDir: "", fields: {} });
  };
  const submitCreate = async () => {
    if (!form.project.trim()) { setErr("bot name required"); return; }
    const need = (sch?.fields || []).filter((f) => f.required && !form.fields[f.key]);
    if (SCAN_PLATFORMS.includes(form.type)) {
      // scan-to-create: save writes project+platform itself
      await setup(form.type, form.project.trim(), form.workDir.trim());
      return;
    }
    if (need.length) { setErr(`Missing required: ${need.map((f) => f.label).join(", ")}`); return; }
    await call("bot-create-token", { project: form.project.trim(), type: form.type, options: form.fields, work_dir: form.workDir.trim() || undefined, agent_type: "piweb" });
    setCreating(false);
  };

  const granSupported = selBot ? selBot.platforms.some((p) => RICH_CARD_PLATFORMS.includes(p)) : false;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* header */}
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{t("Bots")}</span>
        <span style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{`${meta.version || t("unknown")} · ${meta.running ? t("running") : t("not running")}`}</span>
        {!meta.mgmtReachable && meta.mgmtError && <span style={{ fontSize: 11, color: "#ea580c" }}>{meta.mgmtError}</span>}
        <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => void reload()}>{t("Refresh")}</button>
      </div>

      {/* bot list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {bots.length === 0 && <div style={{ ...cardStyle, color: "#6b7280", fontSize: 12 }}>{t("No bots yet — click “New bot” to start")}</div>}
        {bots.map((b) => (
          <div key={b.name} onClick={() => { setSel(sel === b.name ? null : b.name); setCreating(false); stopWiz(); }}
            style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 10, cursor: "pointer", ...(sel === b.name ? { border: "1px solid #6366f1" } : {}) }}>
            <span style={{ fontSize: 16 }}>{pfIcon(b.platforms[0] || "")}</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{b.name}</span>
            {b.platforms.map((p) => <span key={p} style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{pfName(p)}</span>)}
            <span style={chip(b.bound ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.18)", b.bound ? "#16a34a" : "#d97706")}>{b.bound ? t("Bound") : t("Unbound")}</span>
            <span style={chip("rgba(127,127,127,0.12)", "#6b7280")}>{b.card_mode}</span>
            {b.sessions_count != null && <span style={{ fontSize: 11, color: "#6b7280" }}>{`${t("Sessions")} ${b.sessions_count}`}</span>}
            <span style={{ marginLeft: "auto", fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>{b.work_dir || ""}</span>
          </div>
        ))}
      </div>

      {/* create / wizard */}
      {creating && (
        <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={sectionTitle}>{t("New bot")}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, fields: {} })} style={{ ...inp, flex: "0 0 200px", cursor: "pointer" }}>
              {PLATFORM_SCHEMAS.map((p) => <option key={p.type} value={p.type}>{`${pfIcon(p.type)} ${pfName(p.type)}${SCAN_PLATFORMS.includes(p.type) ? " · " + t("scan-to-create") : ""}`}</option>)}
            </select>
            <input placeholder={t("Bot name (= cc-connect project name)")} value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} style={inp} />
            <input placeholder={`${t("work_dir (defaults to the current workspace)")}`} value={form.workDir} onChange={(e) => setForm({ ...form, workDir: e.target.value })} style={inp} />
          </div>
          {/* channel source line + guide */}
          <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.6 }}>
            {"Channel: " + t(PLATFORM_SRC[form.type]?.src || sch?.note || "—")}
          </div>
          {form.type === "weixin" && (
            <div style={{ fontSize: 11, color: "#92400e", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "7px 10px", lineHeight: 1.6 }}>
              {"⚠️ " + t(OPENCLAW_NOTE)}
            </div>
          )}
          {sch && (
            <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.7 }}>
              {sch.guide.steps.map((s, i) => <div key={i}>{`${i + 1}. ${s}`}</div>)}
              {sch.guide.link && <div><a href={sch.guide.link.url} target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>{sch.guide.link.label} ↗</a></div>}
            </div>
          )}
          {/* credential fields (scan platforms keep the button instead) */}
          {sch && !SCAN_PLATFORMS.includes(form.type) && sch.fields.map((f) => (
            <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 10, color: "#6b7280" }}>{`${f.label}${f.required ? " *" : ""}`}</span>
              <input type={f.secret ? "password" : "text"} placeholder={f.ph || ""} value={form.fields[f.key] || ""}
                onChange={(e) => setForm({ ...form, fields: { ...form.fields, [f.key]: e.target.value } })} style={inp} />
            </div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            {SCAN_PLATFORMS.includes(form.type)
              ? <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }} disabled={busy || wiz?.phase === "scanning"} onClick={() => void submitCreate()}>{wiz?.phase === "scanning" ? t("Waiting for scan confirmation…") : "📱 " + t("Scan & create")}</button>
              : <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }} disabled={busy} onClick={() => void submitCreate()}>{t("Create (add-platform; applies after restart)")}</button>}
            <button style={btnStyle} onClick={() => { setCreating(false); stopWiz(); }}>{t("Cancel")}</button>
          </div>
          {/* wizard live area: QR + status */}
          {wiz && wiz.phase !== "idle" && (
            <div style={{ background: "var(--bg-hover, rgba(127,127,127,0.08))", borderRadius: 10, padding: 12, display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
              {wiz.qrImg && <img src={wiz.qrImg} alt="QR" width={160} height={160} style={{ borderRadius: 8, background: "#fff" }} />}
              <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.8, flex: 1, minWidth: 200 }}>
                {wiz.phase === "loading" && <span>{t("Fetching QR code…")}</span>}
                {wiz.phase === "scanning" && <>
                  <div>{`${t("Scan with")} ${pfName(wiz.platform)} ${t("and confirm")}`}</div>
                  {wiz.fallbackUrl && <div><a href={wiz.fallbackUrl} target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>{t("Cannot scan? Open the link on your phone")}</a></div>}
                  <div style={{ color: "#6366f1" }}>{t("Waiting for phone confirmation… (device-flow polling, interval from the server)")}</div>
                </>}
                {wiz.phase === "saving" && <div style={{ color: "#6366f1" }}>{t("Authorized — saving credentials and creating the project…")}</div>}
                {wiz.phase === "done" && <div style={{ color: "#16a34a" }}>{t("Bot created (restart-cc to connect the platform)")}</div>}
                {wiz.phase === "error" && <div style={{ color: "#ea580c" }}>{(t("Failed: ") + (wiz.err || ""))}</div>}
                {wiz.platform === "weixin" && wiz.phase === "scanning" && (
                  <div style={{ marginTop: 6, fontSize: 11, color: "#92400e", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "6px 8px", lineHeight: 1.6 }}>
                    {"⚠️ " + t(OPENCLAW_NOTE)}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* detail (selected bot) */}
      {selBot && !creating && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* scan re-bind */}
          {selBot.platforms.some((p) => SCAN_PLATFORMS.includes(p)) && (
            <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{t("Link bot")}</div>
                <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, lineHeight: 1.6 }}>
                  {selBot.platforms.includes("weixin") ? t("WeChat scan signs in via the ilink gateway (OpenClaw wording on the confirm page is expected) — rescan to switch accounts.") : t("Feishu/Lark official device flow — rescan to switch apps.")}
                </div>
              </div>
              <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }}
                onClick={() => { setCreating(true); setForm({ project: selBot.name, type: selBot.platforms.find((p) => SCAN_PLATFORMS.includes(p)) || "feishu", workDir: selBot.work_dir || "", fields: {} }); }}>
                {"▣ " + t("Rescan")}
              </button>
            </div>
          )}
          {/* granularity */}
          <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{t("Reply granularity")}</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, lineHeight: 1.6 }}>
                {granSupported ? t("Feishu/Lark supports streaming cards (Card JSON 2.0); tool calls show as collapsed summaries.") : t("This platform only supports standard replies (card_mode=legacy).")}
              </div>
            </div>
            <select value={granSupported ? selBot.card_mode : "legacy"} disabled={!granSupported || busy}
              onChange={(e) => void call("bot-cardmode", { project: selBot.name, mode: e.target.value })}
              style={{ ...inp, flex: "0 0 140px", cursor: granSupported ? "pointer" : "not-allowed", opacity: granSupported ? 1 : 0.5 }}>
              <option value="legacy">{t("Standard")}</option>
              {granSupported && <option value="rich">{t("Streaming card")}</option>}
            </select>
          </div>
          {/* work_dir */}
          <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{t("Project access scope")}</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2, fontFamily: "monospace", wordBreak: "break-all" }}>{selBot.work_dir || t("(not set; instance default applies)")}</div>
            </div>
            <button style={btnStyle} onClick={() => {
              const v = window.prompt(t("work_dir (bot ↔ project 1:1)"), selBot.work_dir || "");
              if (v && v.trim()) void call("bot-update", { project: selBot.name, patch: { work_dir: v.trim() } });
            }}>{t("Edit")}</button>
          </div>
          {/* delete */}
          <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", borderColor: "rgba(239,68,68,0.35)" }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{t("Delete bot")}</div>
              <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>{t("Remove this bot (DELETE project; applies after instance restart).")}</div>
            </div>
            <button style={{ ...btnStyle, color: "#dc2626", borderColor: "rgba(239,68,68,0.4)" }} disabled={busy}
              onClick={() => { if (window.confirm(`${t("Confirm bot deletion")} "${selBot.name}"?`)) { void call("bot-delete", { project: selBot.name }); setSel(null); } }}>
              {t("🗑 Delete bot")}
            </button>
          </div>
        </div>
      )}

      {(msg || err) && <div style={{ fontSize: 12, color: err ? "#ea580c" : "#16a34a", padding: "0 2px" }}>{err ? (t("Failed: ") + err) : msg}</div>}
    </div>
  );
}

// ---------- remote control dialog ----------
export const REMOTE_KEY = "aiti-channels:remote";
export const BOTS_KEY = "aiti-channels:bots";

export function openRemote() { openFloat(REMOTE_KEY); }

export function RemoteDialogSlot() {
  const st = usePresent(REMOTE_KEY);
  if (st !== "floating") return null;
  return <RemoteDialogBody />;
}

function RemoteDialogBody() {
  const [qr, setQr] = useState<string | null>(null);
  const deepLink = (() => { try { return window.location.href; } catch { return ""; } })();
  useEffect(() => {
    let alive = true;
    qrDataUrl(deepLink, { size: 200 }).then((d) => { if (alive) setQr(d); }).catch(() => {});
    return () => { alive = false; };
  }, [deepLink]);
  const openPhoneCard = () => {
    // service-tunnels.mobile extension point (Open-on-Phone card with its
    // reachability/auth options); absent → clipboard copy (the inline QR above
    // is the primary render and always works).
    const svc = extSvc<(o: { url: string; title?: string }) => void>("service-tunnels.mobile");
    if (typeof svc === "function") svc({ url: deepLink, title: t("Mobile remote control") });
    else void navigator.clipboard?.writeText?.(deepLink).catch(() => {});
  };
  const copy = () => { void navigator.clipboard?.writeText?.(deepLink).catch(() => {}); };
  const gotoBots = (p?: string) => { closePanel(REMOTE_KEY); openBotsNew(p); };
  const quick = ["weixin", "feishu", "lark", "telegram"];
  const dlgBox = {
    width: "min(880px, 94vw)", maxHeight: "90vh", overflow: "auto", display: "flex", flexDirection: "column",
    background: "var(--bg, #fff)", border: "1px solid var(--border, rgba(127,127,127,0.2))", borderRadius: 12,
  } as Record<string, string>;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", padding: 12 }}>
      <div data-ext-float="1" data-ext-float-key={REMOTE_KEY} data-ext-float-w={880} data-ext-float-h={520} data-ext-float-full="1" style={dlgBox}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px 10px" }}>
          <span style={{ fontSize: 20 }}>📱</span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{t("Mobile remote control")}</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{t("Scan or open the link on your phone to control this workspace remotely.")}</div>
          </div>
          <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => closePanel(REMOTE_KEY)}>{t("Close")}</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, padding: "6px 20px 20px" }}>
          {/* left: scan to open */}
          <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{"📱 " + t("Scan to connect")}</div>
            <div style={{ fontSize: 11.5, color: "#6b7280", lineHeight: 1.6 }}>{t("Scan with your phone camera to open this workspace on mobile (sign in to take over the current session).")}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, background: "#22c55e" }} />
              <span style={{ fontSize: 12 }}>{t("Ready") + " · " + t("scan or copy the link")}</span>
              <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={copy}>{"📋 " + t("Copy link")}</button>
            </div>
            <div style={{ background: "#fff", borderRadius: 12, width: 216, height: 216, margin: "8px auto", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {qr ? <img src={qr} alt="QR" width={188} height={188} style={{ borderRadius: 6 }} /> : <span style={{ color: "#9ca3af", fontSize: 11 }}>{t("Generating QR…")}</span>}
            </div>
            <div style={{ fontSize: 10.5, color: "#6b7280", textAlign: "center", lineHeight: 1.6, wordBreak: "break-all" }}>{deepLink}</div>
            <button style={{ ...btnStyle }} onClick={openPhoneCard}>{t("Open the phone access card (service-tunnels)")}</button>
          </div>
          {/* right: bot channel */}
          <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{"🤖 " + t("Use Bot Channel")}</div>
            <div style={{ fontSize: 11.5, color: "#6b7280", lineHeight: 1.6 }}>{t("Connect a chat bot for longer-running mobile access.")}</div>
            {quick.map((p) => (
              <div key={p} style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--bg-hover, rgba(127,127,127,0.06))", borderRadius: 10, padding: "8px 10px" }}>
                <span style={{ fontSize: 15 }}>{pfIcon(p)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{pfName(p)}</div>
                  <div style={{ fontSize: 10.5, color: "#6b7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t(PLATFORM_SRC[p]?.src || "")}</div>
                </div>
                <button style={{ ...btnStyle, color: "#4f46e5" }} onClick={() => gotoBots(p)}>{t("Configure")}</button>
              </div>
            ))}
            <div style={{ fontSize: 10.5, color: "#6b7280", lineHeight: 1.6, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 8, padding: "6px 8px" }}>
              {t("Channel sources: all channels connect via cc-connect through official platform APIs; the OpenClaw wording on the WeChat scan page = the ilink gateway shared with the OpenClaw plugin — expected behavior.")}
            </div>
            <button style={{ ...btnStyle, marginTop: "auto" }} onClick={() => gotoBots()}>{"🤖 " + t("Bot management")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- bots dialog (same content as the tab, float chrome) ----------
export function BotsDialogSlot({ instance }: { instance?: string }) {
  const st = usePresent(BOTS_KEY);
  if (st !== "floating") return null;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", padding: 12 }}>
      <div data-ext-float="1" data-ext-float-key={BOTS_KEY} data-ext-float-w={960} data-ext-float-h={640} data-ext-float-full="1"
        style={{ width: "min(960px, 94vw)", maxHeight: "90vh", overflow: "auto", display: "flex", flexDirection: "column", background: "var(--bg, #fff)", border: "1px solid var(--border, rgba(127,127,127,0.2))", borderRadius: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px 6px" }}>
          <span style={{ fontSize: 20 }}>🤖</span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{t("Bots")}</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{t("Connect external chat tools to your aiti bots (each bot = one cc-connect project).")}</div>
          </div>
          <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => closePanel(BOTS_KEY)}>{t("Close")}</button>
        </div>
        <div style={{ padding: "6px 20px 20px" }}>
          <TabBots instance={instance || "default"} />
        </div>
      </div>
    </div>
  );
}
