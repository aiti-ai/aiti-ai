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
import { useState, useEffect, useRef, useCallback } from "react";
import { apiUrl, t, extSvc, ensureMaterialized } from "./host-shim";
import { PLATFORM_SCHEMAS, platformSchema } from "../../lib/platform-schema.ts";
import { qrDataUrl } from "./qr";
import { buildDeepLink } from "../../lib/deep-link.ts";
import { btnStyle, cardStyle, inp, sectionTitle, chip, setState as setStatePub, getHostSessionId, Ic, ICON } from "./channels-app";
import { ProjectDetailPanel } from "./mgmt-tabs";

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
  /** stop polling AND clear the QR display state — a switched/abandoned scan
   *  must not keep rendering its stale QR + "waiting" rows */
  const reset = () => { stop(); setWiz(null); };
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
  return { wiz, setup, stop, reset };
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
/** Cross-view handoff: the remote view's Configure button switches to the bots tab
 *  with a preselected platform (consumed once on TabBots mount, then cleared). */
let autoNewPlatform: string | null = null;
/** "open the wizard with no platform preselected" (Onboarding step: no bots yet) */
let wizardAutoOpen = false;
export function openWizard() {
  wizardAutoOpen = true;
  autoNewPlatform = null;
  setStatePub({ tab: "bots", open: true, error: null, msg: null });
}
export function openBotsNew(platform?: string) {
  autoNewPlatform = platform || null;
  // F2: the bots dialog is retired — switch the panel tab instead
  // (setState's open branch itself forces the float present)
  setStatePub({ tab: "bots", open: true, error: null, msg: null });
}

export type WizardPrefill = { platform?: string; skipPlatform?: boolean; project?: string; workDir?: string; agentType?: string };

/** agent types that need extra options the wizard does not collect (acp needs
 *  a connector command); hidden from the wizard dropdown, cc-connect still
 *  supports them via hand-written config */
const NON_WIZARD_AGENTS = new Set(["acp"]);
/** the default agent, kept first in the dropdown */
const PREFERRED_AGENT = "piweb";

/** Bot wizard — the single creation path (plan §3.2): basics → platform → credentials → apply → verify,
 *  no tab switching; the apply action (reload vs restart) is driven by the creation
 *  path, not guessed by the user. */
/** top-level thinkingLevels map from /api/models ("provider:modelId" → levels) */
let thinkingLevelsTop: Record<string, string[]> = {};

/** per-CLI model naming hints (free-text model field for non-piweb agents) */
const CLI_MODEL_HINT: Record<string, string> = {
  claudecode: "e.g. claude-opus-4-5 / claude-sonnet-4-5",
  codex: "e.g. gpt-5.2-codex / gpt-5.1-codex-mini",
  cursor: "e.g. composer-1 / claude-sonnet-4-5",
  gemini: "e.g. gemini-3-pro / gemini-3-flash",
  opencode: "provider-qualified, see the CLI's model list",
  qoder: "e.g. qwen3.8-max",
  iflow: "e.g. glm-5.3",
  kimi: "e.g. kimi-k2.8",
  pi: "e.g. GLM-5.3-Flash / claude-opus-4-5",
};

function BotWizard({ instance, prefill, onDone, onClose }: { instance: string; prefill: WizardPrefill; onDone: () => void; onClose: () => void }) {
  const [step, setStep] = useState(1);
  const [base, setBase] = useState({ project: prefill.project || "", workDir: prefill.workDir || "", agentType: prefill.agentType || "piweb" });
  const [platform, setPlatform] = useState<string | null>(prefill.platform || null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [apply, setApply] = useState<{ kind: "reload" | "restart"; done: boolean } | null>(null);
  const [verify, setVerify] = useState<{ state: "" | "ok" | "warn" | "error"; detail: string } | null>(null);
  // Model selector (same as the new-session dialog): options from /api/models,
  // persisted per work_dir via model-pref-set; the IM session starts with the
  // picked model (initialModel).
  const [modelList, setModelList] = useState<Array<{ id: string; name: string; provider: string; providerName?: string }>>([]);
  const [modelSel, setModelSel] = useState<string>(""); // "provider:modelId" or "" = follow pi-web default
  const [thinkingSel, setThinkingSel] = useState<string>("");
  // non-piweb agents: free-text model (each CLI has its own model naming)
  const [cliModel, setCliModel] = useState("");
  const [modelPrefsLoaded, setModelPrefsLoaded] = useState(false);
  // Phase B: pi-web session backends (Backend dropdown, same as new-session)
  const [backends, setBackends] = useState<Array<{ type: string; label: string }>>([]);
  const [backendSel, setBackendSel] = useState<string>(""); // "" = pi-local (in-process, as-is)
  const thinkingLevelsForSel: string[] = (() => {
    if (!modelSel) return [];
    const key = modelSel.replace(":", "/");
    const tl = thinkingLevelsTop[key];
    return Array.isArray(tl) ? tl : [];
  })();
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cwd = workDirOf() || "";
        // POST form: cwd travels in the JSON body, never in the URL/access log.
        const r = await fetch(apiUrl("/api/models"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cwd ? { cwd } : {}), cache: "no-store" });
        const d = await r.json();
        if (!alive) return;
        setModelList(Array.isArray(d.modelList) ? d.modelList : []);
        setThinkingLevelsTop(d.thinkingLevels && typeof d.thinkingLevels === "object" ? d.thinkingLevels : {});
        // prefill from the stored pref for this wizard's work_dir (if already set)
        const wd = (base.workDir || cwd || "").trim();
        if (wd) {
          const pr = await fetch(API("/api/extensions/aiti-channels/model-pref-get"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: wd }), cache: "no-store" }).then((x) => x.json()).catch(() => null);
          if (alive && pr?.ok && pr.pref) {
            if (pr.pref.backend) setBackendSel(pr.pref.backend);
            setModelSel(`${pr.pref.provider}:${pr.pref.modelId}`);
            if (pr.pref.thinkingLevel) setThinkingSel(pr.pref.thinkingLevel);
          }
        }
        setModelPrefsLoaded(true);
      } catch { if (alive) setModelPrefsLoaded(true); }
    })();
    return () => { alive = false; };
  }, []);
  // Phase B: pi-web session backends for the Backend dropdown — standalone effect:
  // a failure only empties this dropdown (= Pi local only), it does not affect the models fetch
  const fetchBackends = useCallback(async () => {
    try {
      const r = await fetch(apiUrl("/api/session-backends"), { cache: "no-store" });
      const d = await r.json();
      if (Array.isArray(d.providers)) setBackends(d.providers.map((p: any) => ({ type: p.type, label: p.label || p.type })));
    } catch { /* endpoint unreachable → dropdown stays Pi-local-only */ }
  }, []);
  useEffect(() => { void fetchBackends(); }, [fetchBackends]);

  // agent list: dynamic from cc-connect (bot-meta /agents) — never drifts from
  // the running binary's supported set; acp (needs connector args) is filtered
  const [agentList, setAgentList] = useState<string[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(API(`/api/extensions/aiti-channels/bot-meta?instance=${encodeURIComponent(instance)}`), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const agents: string[] = Array.isArray(d.agents) ? d.agents : [];
        const rest = agents.filter((a) => a !== PREFERRED_AGENT && !NON_WIZARD_AGENTS.has(a)).sort();
        setAgentList([PREFERRED_AGENT, ...rest]);
      })
      .catch(() => { if (alive) setAgentList([PREFERRED_AGENT, "claudecode", "codex", "cursor", "gemini", "opencode", "qoder"]); });
    return () => { alive = false; };
  }, [instance]);

  // aiti-folder is a lazy extension — its client service registers only after
  // its own UI first loads, so the button is ALWAYS shown and the click
  // ensures materialization first (F6 pattern); if the service is still absent
  // (extension not deployed/disabled) the manual path input remains the way.
  const pickWorkDir = async () => {
    const get = () => extSvc<{ directory?: (p?: { initialPath?: string }) => Promise<string | null> }>("aiti-folder.pick");
    let svc = get();
    if (!svc || typeof svc.directory !== "function") {
      const mat = ensureMaterialized("aiti-folder");
      if (!mat) return;
      await mat;
      svc = get();
      if (!svc || typeof svc.directory !== "function") return;
    }
    try {
      const picked = await svc.directory({ initialPath: base.workDir || undefined });
      if (picked) setBase((b) => ({ ...b, workDir: picked }));
    } catch { /* cancelled */ }
  };
  // scan path: onDone fires after setup/save → the instance needs a restart to connect
  const { wiz, setup, stop: stopWiz, reset: resetWiz } = useScanWizard(instance, () => { onDone(); setApply({ kind: "restart", done: false }); setStep(4); });
  const sch = platform ? platformSchema(platform) : null;
  const scanning = platform ? SCAN_PLATFORMS.includes(platform) : false;

  const createTokenBot = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(API(`/api/extensions/aiti-channels/bot-create-token?instance=${encodeURIComponent(instance)}`), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project: base.project.trim(), type: platform, options: fields,
          work_dir: base.workDir.trim() || undefined, agent_type: base.agentType,
          // non-piweb agents: model → the server's surgical config append writes
          // a full agent block (type + model + platform)
          ...(base.agentType !== "piweb" && (cliModel.trim() || (base.agentType === "pi" && modelSel)) ? { model: cliModel.trim() || modelSel.split(":").pop() } : {}),
          ...(base.agentType === "pi" && thinkingSel ? { thinking: thinkingSel } : {}),
        }),
      });
      const d = await r.json();
      if (!d.ok && d.status !== 201) { setErr(d.error || `HTTP ${r.status}`); setBusy(false); return; }
      // restart_required sits at different depths depending on the response wrapper
      // (action json vs mgmt passthrough payload)
      const rr = !!(d.restart_required ?? d.data?.restart_required ?? d.data?.data?.restart_required);
      setApply({ kind: rr ? "restart" : "reload", done: false });
      onDone();
      setBusy(false);
      setStep(4);
    } catch (e: any) { setBusy(false); setErr(e.message); }
  };

  const doApply = async () => {
    if (!apply) return;
    setBusy(true); setErr(null);
    try {
      const action = apply.kind === "restart" ? "restart-cc" : "reload-cc";
      const r = await fetch(API(`/api/extensions/aiti-channels/${action}?instance=${encodeURIComponent(instance)}`), { method: "POST" });
      const d = await r.json();
      if (!d.ok) setErr(d.error || `HTTP ${r.status}`);
      else { setApply({ ...apply, done: true }); setStep(5); }
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };

  const sendTest = async () => {
    setBusy(true); setVerify(null);
    try {
      const r = await fetch(API(`/api/extensions/aiti-channels/send?instance=${encodeURIComponent(instance)}`), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ project: base.project.trim(), message: t("你好，这是一条链路测试消息。") }),
      });
      const d = await r.json();
      if (d.ok) setVerify({ state: "ok", detail: t("测试消息已发出（mgmt send）——去 IM 确认收到。") });
      else if ((d.error || "").includes("无活跃会话")) setVerify({ state: "warn", detail: t("新项目还没有活跃会话：先在 IM 里给这个机器人发一条消息，会话激活后回来再发测试。") });
      else setVerify({ state: "error", detail: d.error || `HTTP ${r.status}` });
    } catch (e: any) { setVerify({ state: "error", detail: e.message }); }
    setBusy(false);
  };

  const StepDot = ({ n, label }: { n: number; label: string }) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: step === n ? 700 : 500, color: step === n ? "#4f46e5" : "#6b7280" }}>
      <span style={{ width: 16, height: 16, borderRadius: 8, background: step === n ? "#6366f1" : "rgba(127,127,127,0.15)", color: step === n ? "#fff" : "#6b7280", fontSize: 10, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{n}</span>
      {label}
    </span>
  );

  /** persist backend + model/thinking selection for this bot's cwd (called on Next) */
  const saveModelPref = async () => {
    const cwd = base.workDir.trim() || workDirOf() || "";
    if (!cwd) return;
    try {
      if (base.agentType === "piweb" && (modelSel || backendSel)) {
        // backend alone (no model) is valid: the backend's own default model applies
        const [provider, modelId] = modelSel ? modelSel.split(":") : [backendSel, "default"];
        await fetch(API("/api/extensions/aiti-channels/model-pref-set"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, backend: backendSel || undefined, provider, modelId, thinkingLevel: thinkingSel }) });
      } else if (base.agentType === "piweb") {
        await fetch(API("/api/extensions/aiti-channels/model-pref-clear"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
      }
    } catch { /* pref save is best-effort — the wizard continues either way */ }
  };

  return (
    <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 10, borderColor: "rgba(99,102,241,0.35)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={sectionTitle}>{t("机器人向导")}</div>
        <div style={{ display: "flex", gap: 12, marginLeft: "auto", flexWrap: "wrap" }}>
          <StepDot n={1} label={t("基础")} />
          <StepDot n={2} label={t("平台")} />
          <StepDot n={3} label={t("凭据")} />
          <StepDot n={4} label={t("生效")} />
          <StepDot n={5} label={t("验证")} />
        </div>
        <button style={{ ...btnStyle }} onClick={() => { resetWiz(); onClose(); }}>{t("取消")}</button>
      </div>
      {err && <div style={{ fontSize: 12, color: "#ea580c" }}>{t("Failed: ") + err}</div>}

      {step === 1 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input placeholder={t("Bot name (= cc-connect project name)")} value={base.project} onChange={(e) => setBase({ ...base, project: e.target.value })} style={inp} />
            <input placeholder={t("work_dir (defaults to the current workspace)")} value={base.workDir} onChange={(e) => setBase({ ...base, workDir: e.target.value })} style={inp} />
            <select value={base.agentType} onChange={(e) => setBase({ ...base, agentType: e.target.value })} style={{ ...inp, flex: "0 0 170px", cursor: "pointer" }}>
              {(agentList || [PREFERRED_AGENT, "claudecode", "codex", "cursor", "gemini", "opencode", "qoder"]).map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }}
              onClick={() => void pickWorkDir()}>{t("选择工作目录…")}</button>
            <span style={{ fontSize: 11, color: "#6b7280" }}>{t("或直接输入路径")}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {base.agentType === "piweb" && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#6b7280" }}>
                {t("Backend")}
                <select value={backendSel} onFocus={() => { if (backends.length === 0) void fetchBackends(); }} onChange={(e) => { setBackendSel(e.target.value); setModelSel(""); }} style={{ ...inp, flex: "0 0 240px", cursor: "pointer" }}>
                  <option value="">{t("Pi 本地进程（默认）")}</option>
                  {backends.map((b) => <option key={b.type} value={b.type}>{b.label}</option>)}
                </select>
              </label>
            )}
            {base.agentType === "piweb" || base.agentType === "pi" ? (
              <>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#6b7280" }}>
                  {t("Model")}
                  <select value={modelSel} onChange={(e) => { setModelSel(e.target.value); if (!e.target.value) setThinkingSel(""); }} style={{ ...inp, flex: "0 0 240px", cursor: "pointer" }}>
                    <option value="">{base.agentType === "piweb" ? t("跟随 pi-web 默认") : t("跟随 pi CLI 默认")}</option>
                    {modelList.map((m) => (
                      <option key={`${m.provider}:${m.id}`} value={base.agentType === "pi" ? m.id : `${m.provider}:${m.id}`}>{`${m.providerName || m.provider} — ${m.name}`}</option>
                    ))}
                  </select>
                </label>
                {modelSel && thinkingLevelsForSel.length > 0 && (
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#6b7280" }}>
                    {t("Thinking")}
                    <select value={thinkingSel} onChange={(e) => setThinkingSel(e.target.value)} style={{ ...inp, flex: "0 0 140px", cursor: "pointer" }}>
                      <option value="">{t("默认")}</option>
                      {thinkingLevelsForSel.map((lv) => <option key={lv} value={lv}>{lv}</option>)}
                    </select>
                  </label>
                )}
              </>
            ) : (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#6b7280" }}>
                {t("Model")}
                <input value={cliModel} onChange={(e) => setCliModel(e.target.value)} placeholder={CLI_MODEL_HINT[base.agentType] || t("模型名以 CLI 自身的命名为准")} style={{ ...inp, flex: "0 0 240px" }} />
              </label>
            )}
          </div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>{t("机器人名 = cc-connect 项目名（1:1）。work_dir 留空 = 当前工作区。")}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }}
              disabled={!base.project.trim()}
              onClick={() => { void saveModelPref(); setStep(prefill.skipPlatform ? 4 : 2); }}>{prefill.skipPlatform ? t("下一步（纯项目，跳过平台）") : t("下一步：选平台")}</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 11, color: "#6b7280" }}>{t("扫码直建（确认页显示 OpenClaw 字样属预期）")}：</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {SCAN_PLATFORMS.map((p) => (
              <button key={p} onClick={() => { resetWiz(); setPlatform(p); setStep(3); }}
                style={{ ...btnStyle, ...(platform === p ? { background: "rgba(99,102,241,0.14)", color: "#4f46e5", borderColor: "rgba(99,102,241,0.35)" } : {}) }}>
                {pfIcon(p) + " " + pfName(p)}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>{t("Token 表单平台")}：</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PLATFORM_SCHEMAS.filter((p) => !SCAN_PLATFORMS.includes(p.type)).map((p) => (
              <button key={p.type} onClick={() => { resetWiz(); setPlatform(p.type); setFields({}); setStep(3); }}
                style={{ ...btnStyle, fontSize: 11, ...(platform === p.type ? { background: "rgba(99,102,241,0.14)", color: "#4f46e5", borderColor: "rgba(99,102,241,0.35)" } : {}) }}>
                {pfIcon(p.type) + " " + pfName(p.type)}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={btnStyle} onClick={() => { resetWiz(); setPlatform(null); setStep(4); }}>{t("跳过（纯项目创建）")}</button>
            <button style={btnStyle} onClick={() => { resetWiz(); setStep(1); }}>{t("上一步")}</button>
          </div>
        </div>
      )}

      {step === 3 && platform && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{`${pfIcon(platform)} ${pfName(platform)}`}</div>
          {platform === "weixin" && (
            <div style={{ fontSize: 11, color: "#92400e", background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "7px 10px", lineHeight: 1.6 }}>
              {"⚠️ " + t(OPENCLAW_NOTE)}
            </div>
          )}
          {sch && (
            <div style={{ fontSize: 11, color: "#6b7280", lineHeight: 1.7 }}>
              {sch.guide.steps.map((g, i) => <div key={i}>{`${i + 1}. ${g}`}</div>)}
              {sch.guide.link && <div><a href={sch.guide.link.url} target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>{sch.guide.link.label} ↗</a></div>}
            </div>
          )}
          {scanning ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }}
                disabled={busy || wiz?.phase === "scanning"} onClick={() => void setup(platform, base.project.trim(), base.workDir.trim())}>
                {wiz?.phase === "scanning" ? t("Waiting for scan confirmation…") : <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={13} paths={ICON.mobile} />{t("Scan & create")}</span>}
              </button>
              <button style={btnStyle} onClick={() => setStep(2)}>{t("上一步")}</button>
            </div>
          ) : (
            <>
              {sch && sch.fields.map((f) => (
                <div key={f.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ fontSize: 10, color: "#6b7280" }}>{`${f.label}${f.required ? " *" : ""}`}</span>
                  <input type={f.secret ? "password" : "text"} placeholder={f.ph || ""} value={fields[f.key] || ""}
                    onChange={(e) => setFields({ ...fields, [f.key]: e.target.value })} style={inp} />
                </div>
              ))}
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }}
                  disabled={busy} onClick={() => void createTokenBot()}>{t("Create (add-platform; applies after restart)")}</button>
                <button style={btnStyle} onClick={() => { resetWiz(); setStep(2); }}>{t("上一步")}</button>
              </div>
            </>
          )}
          {/* scan live area */}
          {wiz && wiz.phase !== "idle" && (
            <div style={{ background: "var(--bg-hover, rgba(127,127,127,0.08))", borderRadius: 10, padding: 12, display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
              {wiz.qrImg && <img src={wiz.qrImg} alt="QR" width={150} height={150} style={{ borderRadius: 8, background: "#fff" }} />}
              <div style={{ fontSize: 12, color: "#6b7280", lineHeight: 1.8, flex: 1, minWidth: 200 }}>
                {wiz.phase === "loading" && <span>{t("Fetching QR code…")}</span>}
                {wiz.phase === "scanning" && <>
                  <div>{`${t("Scan with")} ${pfName(wiz.platform)} ${t("and confirm")}`}</div>
                  {wiz.fallbackUrl && <div><a href={wiz.fallbackUrl} target="_blank" rel="noreferrer" style={{ color: "#6366f1" }}>{t("Cannot scan? Open the link on your phone")}</a></div>}
                </>}
                {wiz.phase === "saving" && <div style={{ color: "#6366f1" }}>{t("Authorized — saving credentials and creating the project…")}</div>}
                {wiz.phase === "error" && <div style={{ color: "#ea580c" }}>{t("Failed: ") + (wiz.err || "")}</div>}
              </div>
            </div>
          )}
        </div>
      )}

      {step === 4 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {!apply && <div style={{ fontSize: 12, color: "#6b7280" }}>{t("纯项目创建：项目写入 config 后需一次 reload 热应用。")}</div>}
          {apply && <div style={{ fontSize: 12, color: "#16a34a" }}>{apply.done ? t("已生效。") : apply.kind === "restart" ? t("凭据已保存——需要重启实例让平台连上（restart_required）。") : t("项目已创建——reload 即可热应用。")}</div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {!apply && <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }} disabled={busy}
              onClick={() => setApply({ kind: "reload", done: false })}>{t("热应用 reload")}</button>}
            {apply && !apply.done && <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }} disabled={busy}
              onClick={() => void doApply()}>{apply.kind === "restart" ? t("重启实例（restart-cc）") : t("热应用 reload")}</button>}
            {apply && !apply.done && <button style={btnStyle} disabled={busy} onClick={() => setStep(5)}>{t("稍后手动生效")}</button>}
            {apply?.done && <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }} onClick={() => setStep(5)}>{t("下一步：验证")}</button>}
            {step > 1 && <button style={btnStyle} onClick={() => setStep(1)}>{t("回到基础")}</button>}
          </div>
        </div>
      )}

      {step === 5 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, color: "#6b7280" }}>{t("验证步：向新项目发一条测试消息（mgmt send；新项目需先在 IM 里激活一次会话）。")}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...btnStyle, background: "rgba(99,102,241,0.14)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.35)" }} disabled={busy}
              onClick={() => void sendTest()}>{busy ? t("Sending…") : <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={13} paths={ICON.send} />{t("发测试消息")}</span>}</button>
            <button style={btnStyle} onClick={() => { setStatePub({ tab: "chat" }); }}>{t("去对话 tab 实时看")}</button>
            <button style={btnStyle} onClick={() => { resetWiz(); onClose(); }}>{t("完成")}</button>
          </div>
          {verify && (
            <div style={{ fontSize: 12, lineHeight: 1.7, borderRadius: 8, padding: "8px 10px", color: verify.state === "ok" ? "#16a34a" : verify.state === "warn" ? "#92400e" : "#ea580c", background: verify.state === "ok" ? "rgba(34,197,94,0.1)" : verify.state === "warn" ? "rgba(245,158,11,0.1)" : "rgba(239,68,68,0.08)", border: `1px solid ${verify.state === "ok" ? "rgba(34,197,94,0.3)" : verify.state === "warn" ? "rgba(245,158,11,0.3)" : "rgba(239,68,68,0.3)"}` }}>
              {verify.detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
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
  // wizard open state: platform preselect (remote view handoff) or a bare open
  // (Onboarding "no bots yet"); prefill.skipPlatform = pure project creation
  const [wizard, setWizard] = useState<WizardPrefill | null>(
    preselect ? { platform: preselect } : wizardAutoOpen ? { skipPlatform: false } : null
  );
  wizardAutoOpen = false;
  const [manageProj, setManageProj] = useState<string | null>(null);

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

  const startCreate = (type?: string, opts?: { skipPlatform?: boolean }) => {
    setSel(null);
    setWizard(type ? { platform: type } : { skipPlatform: !!opts?.skipPlatform });
  };

  const granSupported = selBot ? selBot.platforms.some((p) => RICH_CARD_PLATFORMS.includes(p)) : false;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* header — F7: the create button lives here (it was only reachable from the retired
          bots dialog before, i.e. unreachable); opens the create form in place */}
      <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{t("Bots")}</span>
        <span style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{`${meta.version || t("unknown")} · ${meta.running ? t("running") : t("not running")}`}</span>
        {!meta.mgmtReachable && meta.mgmtError && <span style={{ fontSize: 11, color: "#ea580c" }}>{meta.mgmtError}</span>}
        <button style={{ ...btnStyle, marginLeft: "auto", color: "#4f46e5" }} onClick={() => startCreate("telegram")}>{"+ " + t("新建机器人")}</button>
        <button style={{ ...btnStyle }} onClick={() => startCreate(undefined, { skipPlatform: true })}>{"+ " + t("纯项目")}</button>
        <button style={{ ...btnStyle }} onClick={() => void reload()}>{t("刷新")}</button>
      </div>

      {/* bot list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {bots.length === 0 && <div style={{ ...cardStyle, color: "#6b7280", fontSize: 12 }}>{t("No bots yet — click “New bot” to start")}</div>}
        {bots.map((b) => (
          <div key={b.name} onClick={() => { setSel(sel === b.name ? null : b.name); setWizard(null); }}
            style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 10, cursor: "pointer", ...(sel === b.name ? { border: "1px solid #6366f1" } : {}) }}>
            <span style={{ fontSize: 16 }}>{pfIcon(b.platforms[0] || "")}</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{b.name}</span>
            {b.platforms.map((p) => <span key={p} style={chip("rgba(99,102,241,0.12)", "#6366f1")}>{pfName(p)}</span>)}
            <span style={chip(b.bound ? "rgba(34,197,94,0.15)" : "rgba(245,158,11,0.18)", b.bound ? "#16a34a" : "#d97706")}>{b.bound ? t("Bound") : t("Unbound")}</span>
            <span style={chip("rgba(127,127,127,0.12)", "#6b7280")}>{b.card_mode}</span>
            {b.sessions_count != null && <span style={{ fontSize: 11, color: "#6b7280" }}>{`${t("Sessions")} ${b.sessions_count}`}</span>}
            <span style={{ marginLeft: "auto", fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>{b.work_dir || ""}</span>
            <button style={{ ...btnStyle, fontSize: 11 }} onClick={(e) => { e.stopPropagation(); setManageProj(manageProj === b.name ? null : b.name); }}>{t("项目设置")}</button>
          </div>
        ))}
      </div>
      {manageProj && <ProjectDetailPanel instance={instance} project={manageProj} onClose={() => setManageProj(null)} />}

      {/* create / wizard — five steps, single creation path (plan §3.2) */}
      {wizard && (
        <BotWizard instance={instance} prefill={wizard} onDone={() => void reload()} onClose={() => setWizard(null)} />
      )}

      {/* detail (selected bot) */}
      {selBot && !wizard && (
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
                onClick={() => { setSel(null); setWizard({ project: selBot.name, platform: selBot.platforms.find((p) => SCAN_PLATFORMS.includes(p)) || "feishu", workDir: selBot.work_dir || "" }); }}>
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

/** Mobile remote view — an in-panel tab since v3 (F2): the old full-screen dialog
 *  used to be buried under the panel portal (cross stacking-context z is
 *  meaningless); as a tab it can't lose that fight. */
export function RemoteView() {
  const sessionId = getHostSessionId();
  const deepLink = buildDeepLink((() => { try { return window.location.href; } catch { return ""; } })(), sessionId);
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    qrDataUrl(deepLink, { size: 200 }).then((d) => { if (alive) setQr(d); }).catch(() => {});
    return () => { alive = false; };
  }, [deepLink]);
  // F6: service-tunnels is a lazy extension (clientImmediately:false) — its mobile
  // service only registers after its own entry is first opened. ensureMaterialized
  // then re-fetch (aiti-pair openOnPhone pattern); still absent → explicit error
  // instead of the silent clipboard fallback the v2 audit flagged as a dud.
  const openPhoneCard = () => {
    const lookup = () => (typeof extSvc === "function" ? extSvc<(o: { url: string; title?: string }) => void>("service-tunnels.mobile") : null);
    const direct = typeof lookup() === "function" ? lookup() : null;
    if (typeof direct === "function") { direct({ url: deepLink, title: t("移动端远程控制") }); return; }
    const mat = ensureMaterialized("service-tunnels");
    if (mat) {
      mat.then(() => {
        const svc = lookup();
        if (typeof svc !== "function") throw new Error("service-tunnels.mobile still absent after materialize (deployed/disabled?)");
        svc({ url: deepLink, title: t("移动端远程控制") });
      }).catch((e: Error) => { void navigator.clipboard?.writeText?.(deepLink).catch(() => {}); console.warn("[aiti-channels] phone card:", e.message); });
      return;
    }
    void navigator.clipboard?.writeText?.(deepLink).catch(() => {});
  };
  const copy = () => { void navigator.clipboard?.writeText?.(deepLink).catch(() => {}); };
  const quick = ["weixin", "feishu", "lark", "telegram"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ display: "inline-flex" }}><Ic size={18} paths={ICON.mobile} /></span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{t("移动端远程控制")}</div>
          <div style={{ fontSize: 11.5, color: "#6b7280", marginTop: 2 }}>{t("扫码或在手机上打开链接，远程控制此工作台。")}</div>
        </div>
        <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={() => openBotsNew()}>{t("配置机器人通道 →")}</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
        {/* left: scan to open */}
        <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}><span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICON.mobile} />{t("扫码连接")}</span></div>
          <div style={{ fontSize: 11.5, color: "#6b7280", lineHeight: 1.6 }}>{t("用手机相机扫码，在移动端打开此工作台（登录后接管当前会话）。")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: 8, background: "#22c55e" }} />
            <span style={{ fontSize: 12 }}>{(sessionId ? t("携带当前会话") : t("工作台首页")) + " · " + t("扫码或复制链接")}</span>
            <button style={{ ...btnStyle, marginLeft: "auto" }} onClick={copy}>{<Ic size={13} paths={ICON.clipboard} /> }</button>
          </div>
          <div style={{ background: "#fff", borderRadius: 12, width: 216, height: 216, margin: "8px auto", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {qr ? <img src={qr} alt="QR" width={188} height={188} style={{ borderRadius: 6 }} /> : <span style={{ color: "#9ca3af", fontSize: 11 }}>{t("二维码生成中…")}</span>}
          </div>
          <div style={{ fontSize: 10.5, color: "#6b7280", textAlign: "center", lineHeight: 1.6, wordBreak: "break-all" }}>{deepLink}</div>
          <button style={{ ...btnStyle }} onClick={openPhoneCard}>{t("打开手机访问卡（service-tunnels）")}</button>
        </div>
        {/* right: bot channel */}
        <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}><span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Ic size={13} paths={ICON.bot} />{t("用机器人通道")}</span></div>
          <div style={{ fontSize: 11.5, color: "#6b7280", lineHeight: 1.6 }}>{t("连接一个聊天机器人，适合长时移动接入。")}</div>
          {quick.map((p) => (
            <div key={p} style={{ display: "flex", alignItems: "center", gap: 10, background: "var(--bg-hover, rgba(127,127,127,0.06))", borderRadius: 10, padding: "8px 10px" }}>
              <span style={{ fontSize: 15 }}>{pfIcon(p)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700 }}>{pfName(p)}</div>
                <div style={{ fontSize: 10.5, color: "#6b7280", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t(PLATFORM_SRC[p]?.src || "")}</div>
              </div>
              <button style={{ ...btnStyle, color: "#4f46e5" }} onClick={() => openBotsNew(p)}>{t("去配置")}</button>
            </div>
          ))}
          <div style={{ fontSize: 10.5, color: "#6b7280", lineHeight: 1.6, background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.25)", borderRadius: 8, padding: "6px 8px" }}>
            {t("通道来源：所有渠道经 cc-connect 走官方平台 API；微信扫码页出现 OpenClaw 字样 = 与 OpenClaw 插件共用的 ilink 网关——属预期行为。")}
          </div>
          <button style={{ ...btnStyle, marginTop: "auto" }} onClick={() => openBotsNew()}><span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Ic size={13} paths={ICON.bot} />{t("机器人管理")}</span></button>
        </div>
      </div>
    </div>
  );
}
