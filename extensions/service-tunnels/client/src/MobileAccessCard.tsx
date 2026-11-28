/**
 * MobileAccessCard —— 「手机访问」简单卡（方案 §3.1，v2 入口 = 侧栏底行）。
 *
 * 五态状态机：loading / first（首次建号+暴露）/ expose-only（已有用户只暴露）/
 * ready（大二维码）/ pick（多通道挑一条）+ 两边界：unsafe（fail-closed）/
 * confirm（无认证候选必弹）。零自有服务端状态——只读 self-reco + 既有 action。
 * 刷新事件驱动（mount + focus/visibility/online），无 setInterval 无轮询。
 *
 * 测试：纯逻辑导出（pickCandidate / tierParams / confirmNeeded）在
 * mobile-card.test.mjs 用 esbuild bundle + 断言覆盖。
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n, apiUrl } from "./host-shim";
import { usePresent } from "@aiti-ai/ext-shared/ext-float-dock";
import { qrDataUrl, downloadQrPng } from "./qr";
import { FaceCaptureModal } from "./face-capture";
import { MOBILE_KEY, REMEMBER_KEY, tierParams, confirmNeeded, pickCandidate, pickTunnelTool, resolveReadyUrl, upgradeToPageProto, faceSelectable, schemeKey, appendQuery, launchUrlSafe, exposeToUrls, loadSourceMemory, saveSourceMemory, pageReachability, type Source, type MobileLaunch, type Reco, type RecoCandidate } from "./mobile-logic";
import { NoAuthBadge } from "./dialog/shared";
import { BotChannelsColumn } from "./bot-channels";

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

type View = "loading" | "first" | "expose-only" | "ready" | "pick" | "list" | "unsafe" | "confirm";
type Tier = "password" | "face" | "totp";

interface Props {
  onClose: () => void;
  onOpenPorts: () => void;
  onOpenSelf: () => void;
  /** Parametrized launch (client service "service-tunnels.mobile"; sources-and-service plan §3.2). */
  launch?: MobileLaunch | null;
}

function pageHttps(): boolean {
  return typeof location !== "undefined" && location.protocol === "https:";
}

/** Lightweight expose row (element of GET status?exposes-only=1). */
interface PortRow {
  name: string;
  label: string | null;
  provider: string | null;
  running: boolean;
  url: string | null;
  localUrl: string | null;
  baseUrl: string | null;
  domainUrl: string | null;
  loginUrl: string | null;
  altUrls: string[];
}

/** Shared ready QR block (self / ports / link all reuse; generated on render,
 *  copy + download PNG). */
function ReadyQr({ url, hint, t, size = 220 }: { url: string; hint?: string; t: (k: string) => string; size?: number }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    setQr(null);
    qrDataUrl(url, { size: 336 }).then((d) => { if (alive) setQr(d); }).catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [url]);
  const copy = useCallback(async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  }, [url]);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4 }}>
      {qr && <img src={qr} width={size} height={size} alt="QR" style={{ borderRadius: 8, marginTop: 10 }} />}
      {hint && <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all", textAlign: "center" }}>{hint}</div>}
      <div style={{ marginTop: 6, fontSize: 11, fontFamily: "var(--font-mono)", wordBreak: "break-all", color: "var(--text-dim, var(--text-muted))", textAlign: "center" }}>{url}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap", justifyContent: "center" }}>
        <button type="button" onClick={copy} style={{ height: 30, padding: "0 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", fontSize: 12, cursor: "pointer" }}>{copied ? t("mobile.copied") : t("mobile.copy")}</button>
        <button type="button" disabled={!qr} onClick={() => qr && downloadQrPng(qr, "pi-web-mobile.png")} style={{ height: 30, padding: "0 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", fontSize: 12, cursor: qr ? "pointer" : "default", opacity: qr ? 1 : 0.6 }}>{t("mobile.downloadPng")}</button>
      </div>
    </div>
  );
}

export function MobileAccessCard({ onClose, onOpenPorts, onOpenSelf, launch }: Props) {
  const { t } = useI18n();
  const [reco, setReco] = useState<Reco | null>(null);
  const [view, setView] = useState<View>("loading");
  const [candidate, setCandidate] = useState<RecoCandidate | null>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tier, setTier] = useState<Tier>("password");
  const [tunnelTool, setTunnelTool] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [totpQr, setTotpQr] = useState<string | null>(null);
  const [faceOpen, setFaceOpen] = useState(false);
  const [toast, setToast] = useState("");
  const recoRef = useRef<Reco | null>(null);
  const aliveRef = useRef(true);
  // Bot Channels column: shown only when aiti-channels responds (graceful
  // absence → the card stays the original 400px single column)
  const [botsAvail, setBotsAvail] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch(apiUrl("/api/extensions/aiti-channels/bots"), { cache: "no-store", signal: AbortSignal.timeout(6000) })
      .then((r) => { if (alive) setBotsAvail(r.ok); })
      .catch(() => { if (alive) setBotsAvail(false); });
    return () => { alive = false; };
  }, []);

  // —— QR source switch (sources-and-service plan §3.1, v3: entry/page/ports) ——
  // link only appears when launched with {url}; a bare open applies memory
  // (Q2: remember the last tab + ports pick); default = entry — the original
  // card view (expose wizard: username/password + scheme + QR), kept intact
  // and always visible as its own tab.
  const safeLaunchUrl = launchUrlSafe(launch?.url);
  const [source, setSource] = useState<Source>(() => {
    if (safeLaunchUrl) return "link";
    if (launch?.query) return "page";
    return loadSourceMemory(typeof localStorage !== "undefined" ? localStorage : null)?.source ?? "entry";
  });
  const [portList, setPortList] = useState<Array<{ name: string; label: string | null; noAuth: boolean; urls: string[] }>>([]);
  const [portSel, setPortSel] = useState<string | null>(null);
  const [portsLoading, setPortsLoading] = useState(false);
  const [portNote, setPortNote] = useState("");
  const sourceRef = useRef(source);
  useEffect(() => { sourceRef.current = source; }, [source]);

  // Current-page URL (location.href as-is, parametrized query appended).
  const pageUrl = typeof location !== "undefined" ? appendQuery(location.href, launch?.query) : null;
  const pageReach = pageReachability(pageUrl);

  // Parametrized launch args changed (re-launching via svc({...}) while the
  // card is open also applies; §3.2). Args win: memory is not written.
  // {url} → link; {query} → page source.
  useEffect(() => {
    if (!launch) return;
    if (launchUrlSafe(launch.url)) { setSource("link"); return; }
    if (launch.query) setSource("page");
  }, [launch]);

  // ports source list (lightweight endpoint; event-driven refresh, no polling)
  const loadPorts = useCallback(() => {
    setPortsLoading(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status?exposes-only=1"))
      .then((r) => r.json() as Promise<{ exposes?: PortRow[] }>)
      .then((d) => {
        if (!aliveRef.current) return;
        const rows = (d.exposes ?? []).filter((e) => e.running)
          .map((e) => ({ name: e.name, label: e.label, noAuth: !e.provider, urls: exposeToUrls(e) }))
          .filter((r) => r.urls.length > 0);
        setPortList(rows);
        setPortsLoading(false);
        // Restore selection: current pick stays valid first; else memory; on
        // memory miss fall back to the first URL and say so.
        const all = rows.flatMap((r) => r.urls);
        setPortSel((prev) => {
          if (prev && all.includes(prev)) return prev;
          const mem = loadSourceMemory(typeof localStorage !== "undefined" ? localStorage : null);
          const want = mem?.source === "ports" ? (mem.portUrl ?? null) : null;
          if (want && all.includes(want)) return want;
          if (want) setPortNote(t("mobile.sourceRememberedGone"));
          return all[0] ?? null;
        });
      })
      .catch(() => { if (aliveRef.current) setPortsLoading(false); });
  }, [t]);

  const switchSource = useCallback((s: Source) => {
    setSource(s);
    if (s === "link") return; // a parametrized launch is governed by its args, not memory
    saveSourceMemory(typeof localStorage !== "undefined" ? localStorage : null, s === "ports" ? { source: "ports", portUrl: portSel ?? undefined } : { source: s });
    if (s === "ports") loadPorts();
  }, [portSel, loadPorts]);

  const pickPortUrl = useCallback((url: string) => {
    setPortSel(url);
    saveSourceMemory(typeof localStorage !== "undefined" ? localStorage : null, { source: "ports", portUrl: url });
  }, []);

  const post = useCallback((action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    }).then((r) => r.json() as Promise<Record<string, unknown>>), []);

  // —— 目标解析 + 就绪跳转 ——
  const applyReco = useCallback((d: Reco, deepToast?: string) => {
    recoRef.current = d;
    setReco(d);
    const chans = (d.self?.channels ?? []).filter((c) => !c.noAuth && c.url);
    if (chans.length > 1) { setView("pick"); return; }
    if (chans.length === 1) {
      setReadyUrl(upgradeToPageProto(chans[0].url, pageHttps()));
      setView("ready");
      if (deepToast) setToast(deepToast);
      return;
    }
    let remembered: { id?: string; tier?: string; tunnel?: string } | null = null;
    try { remembered = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "null"); } catch { /* ignore */ }
    const { candidate: pick, rememberedGone } = pickCandidate(d, remembered);
    if (!pick) { setView("unsafe"); if (deepToast) setToast(deepToast); return; }
    setCandidate(pick);
    setTunnelTool(pickTunnelTool(pick, remembered?.tunnel ?? null));
    if (rememberedGone) setToast(t("mobile.rememberedGone"));
    else if (deepToast) setToast(deepToast);
    setTier((pick.https) ? "face" : "password"); // Q1：https 候选默认刷脸档
    setView(d.hasUsers ? "expose-only" : "first");
  }, [t]);

  const load = useCallback((deep = false, toastMsg?: string) => {
    fetch(`${apiUrl("/api/extensions/service-tunnels/self-reco")}${deep ? "?deep=1" : ""}`)
      .then((r) => r.json() as Promise<Reco>)
      .then((d) => { if (aliveRef.current) applyReco(d, toastMsg); })
      .catch(() => { if (aliveRef.current) { setError(t("mobile.error")); setView("unsafe"); } });
  }, [applyReco, t]);

  // event-driven refresh (mount + focus + visibility + online; no polling). While the ports source is active, also refreshes the light list in sync.
  useEffect(() => {
    aliveRef.current = true;
    load();
    const onFocus = () => { load(); if (sourceRef.current === "ports") loadPorts(); };
    const onVis = () => { if (document.visibilityState === "visible") onFocus(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onFocus);
    return () => {
      aliveRef.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onFocus);
    };
  }, [load, loadPorts]);

  // self-source QR URL: ready channel + https upgrade. Note: launch.query is
  // scoped to the PAGE source only (v2 semantics) — the entry wizard's QR must
  // stay parameter-free.
  const selfQrUrl = view === "ready" && readyUrl ? upgradeToPageProto(readyUrl, pageHttps()) : null;

  const remember = (id: string) => {
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ id, tier, tunnel: tunnelTool ?? undefined })); } catch { /* ignore */ }
  };

  // —— 暴露执行（两步分调：user-add 先行；失败不静默 R9）——
  const doExpose = useCallback(async (c: RecoCandidate) => {
    if (!c) return;
    setBusy(true); setError("");
    try {
      const params = tierParams(tier);
      if (c.id === "lan") {
        // 局域网直连：不暴露，只开门（allowLocal；确认已在 confirm 态完成）
        const d = await post("self-allowlocal", { allowLocal: true, confirm: true });
        if (d.error) { setError(String(d.error)); return; }
      } else {
        const body: Record<string, unknown> = {
          action: "self-expose",
          mode: c.mode ?? "proxy",
          provider: c.auth === "none" ? "none" : (c.auth ?? "portal"),
          policy: params.policy,
          ...(c.id === "tunnel" ? { tunnel: pickTunnelTool(c, tunnelTool) } : {}),
          ...(params.providerParams ? { providerParams: params.providerParams } : {}),
        };
        const d = await post("self-expose", body);
        if (d.error) { setError(String(d.error)); return; }
      }
      remember(c.id);
      load(false);
    } catch (e) {
      setError(String(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [tier, tunnelTool, post, load]);

  // —— 首次提交：user-add →（刷脸采集 / TOTP 登记）→ 暴露 ——
  const submitFirst = useCallback(async () => {
    setError("");
    if (!username.trim() || !password) { setError(t("mobile.error")); return; }
    setBusy(true);
    try {
      const add = await post("user-add", { name: username.trim(), password, provider: "portal", site: "pi-web" });
      // 幂等：同名已存在也继续（R9）——手机登录用原密码，toast 说明；其余错误停下
      if (add.error) {
        if (!/exist|already|已存在|registered/i.test(String(add.error))) { setError(String(add.error)); return; }
        setToast(t("mobile.accountExists"));
      }
      const params = tierParams(tier);
      if (params.needTotp) {
        const d = await post("totp-enroll", { name: username.trim(), provider: "portal", site: "pi-web" });
        if (d.error) { setError(String(d.error)); return; }
        const otpauth = String(d.otpauthUrl ?? "");
        setTotpQr(await qrDataUrl(otpauth, { size: 220 }));
        setBusy(false);
        return; // 等「我已扫码添加」再暴露
      }
      if (params.needFace) {
        // 采集在本机（R4）；采集完成 onDone 回来继续暴露
        setFaceOpen(true);
        setBusy(false);
        return;
      }
      await doExpose(candidate!);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [username, password, tier, candidate, post, doExpose, t]);

  // 暴露中（仅密码档）直接入口
  const submitExposeOnly = useCallback(async () => {
    setError("");
    setBusy(true);
    try { await doExpose(candidate!); } finally { if (aliveRef.current) setBusy(false); }
  }, [candidate, doExpose]);

  const stop = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const d = await post("self-stop", {});
      if (d.error) { setError(String(d.error)); return; }
      try { localStorage.removeItem(REMEMBER_KEY); } catch { /* ignore */ }
      load();
    } catch (e) {
      if (aliveRef.current) setError(String(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [post, load]);

  // ---- 渲染 ----
  const row = { display: "flex", alignItems: "center", gap: 8, marginTop: 10 } as const;
  const input = { flex: 1, height: 30, padding: "0 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12 } as const;
  const btn = { height: 30, padding: "0 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-hover)", color: "var(--text)", fontSize: 12, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1 } as const;
  const badge = (b: string) => h_chip(t(`mobile.badge.${b}`));

  function h_chip(text: string, danger = false) {
    return (
      <span key={text} style={{ fontSize: 10, padding: "1px 6px", borderRadius: 999, border: `1px solid ${danger ? "var(--danger, #f87171)" : "var(--border)"}`, color: danger ? "var(--danger, #f87171)" : "var(--text-muted)", whiteSpace: "nowrap" }}>{text}</span>
    );
  }

  const riskyNote = candidate ? confirmNeeded(candidate) : false; // 确认弹层单独渲染
  void riskyNote;

  // Tunnel tool picker row (only when the tunnel candidate has >1 usable tool —
  // trycloudflare.com is occasionally unreachable, so cloudflared/ngrok/frpc are switchable)
  const tunnelToolRow = candidate?.id === "tunnel" && (candidate.tunnelOptions?.length ?? 0) > 1 ? (() => {
    const active = tunnelTool ?? candidate.tunnel ?? candidate.tunnelOptions?.[0];
    return (
      <div style={{ ...row, flexWrap: "wrap" }}>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("mobile.tunnelTool")}:</span>
        {candidate.tunnelOptions!.map((tool) => (
          <button key={tool} type="button" disabled={busy} onClick={() => setTunnelTool(tool)}
            title={tool === "cloudflared" ? t("mobile.tunnelCloudflaredHint") : undefined}
            style={{ ...btn, fontSize: 11, padding: "0 8px", height: 26, background: active === tool ? "var(--accent)" : "var(--bg-hover)", color: active === tool ? "#fff" : "var(--text)", borderColor: active === tool ? "var(--accent)" : "var(--border)" }}>
            {tool}
          </button>
        ))}
      </div>
    );
  })() : null;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        data-ext-float="1"
        data-ext-float-key={MOBILE_KEY}
        data-ext-float-w={740}
        data-ext-float-autoh="1"
        data-ext-float-full="1"
        style={{
          width: 740, maxWidth: "calc(100vw - 16px)", maxHeight: "min(86vh, 780px)", overflow: "auto",
          background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid var(--border)", position: "sticky", top: 0, background: "var(--bg)" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("mobile.title")}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{t("mobile.subtitle")}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="close" style={{ background: "none", border: "none", color: "var(--text-muted)", fontSize: 16, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ display: "flex", alignItems: "stretch" }}>
          <div style={{ flex: 1, minWidth: 0, padding: "12px 14px 14px", fontSize: 12, color: "var(--text)" }}>
          {/* QR source switch (§3.1 v3): service entry / current page / exposed */}
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            {(["entry", "page", "ports"] as Source[]).map((s) => (
              <button key={s} type="button" onClick={() => switchSource(s)}
                style={{ flex: 1, height: 28, borderRadius: 6, border: `1px solid ${source === s ? "var(--accent)" : "var(--border)"}`, background: source === s ? "var(--accent)" : "var(--bg-hover)", color: source === s ? "#fff" : "var(--text)", fontSize: 12, cursor: "pointer" }}>
                {s === "entry" ? t("mobile.tabEntry") : s === "page" ? t("mobile.tabPage") : t("mobile.tabPorts")}
              </button>
            ))}
          </div>

          {/* —— page source: QR of the current browser URL (§3.1 v2) —— */}
          {source === "page" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4 }}>
              {pageUrl && <ReadyQr url={pageUrl} hint={t("mobile.qrHint")} t={t} />}
              {pageReach === "loopback" && <div style={{ ...row, color: "var(--danger, #f87171)", fontSize: 11, justifyContent: "center", textAlign: "center" }}>{t("mobile.pageLoopbackHint")}</div>}
              {pageReach === "lan" && <div style={{ ...row, color: "var(--text-muted)", fontSize: 11, justifyContent: "center", textAlign: "center" }}>{t("mobile.pageLanHint")}</div>}
              {pageReach !== "public" && (
                <div style={{ ...row, justifyContent: "center" }}>
                  <button type="button" style={{ ...btn, background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" }} onClick={() => switchSource("entry")}>{t("mobile.setupAccess")}</button>
                </div>
              )}
            </div>
          )}

          {/* —— entry source: the original expose wizard, unchanged (§3.1 v3) —— */}
          {source === "entry" && (<>
          {toast && <div style={{ ...row, color: "var(--text-muted)", fontSize: 11 }}>{toast}</div>}
          {error && <div style={{ ...row, color: "var(--danger, #f87171)", fontSize: 11 }}>{error}</div>}

          {/* loading */}
          {view === "loading" && <div style={{ ...row, justifyContent: "center", padding: "24px 0", color: "var(--text-muted)" }}>…</div>}

          {/* S6 左：fail-closed */}
          {view === "unsafe" && (
            <div>
              <div style={{ fontWeight: 600, marginTop: 6 }}>{t("mobile.unsafeTitle")}</div>
              <div style={{ marginTop: 6, color: "var(--text-muted)" }}>{t("mobile.unsafeBody")}</div>
              <div style={{ ...row, alignItems: "flex-start" }}>1. {t("mobile.unsafeWay1")}</div>
              <div style={{ ...row, alignItems: "flex-start" }}>2. {t("mobile.unsafeWay2")}</div>
              {(reco?.absent ?? []).map((a) => (
                <div key={a.id} style={{ ...row, color: "var(--text-dim, var(--text-muted))", fontSize: 11 }}>{t(`mobile.reason.${a.reason}`)}</div>
              ))}
              <div style={{ ...row, justifyContent: "flex-end" }}>
                <button type="button" style={btn} onClick={onOpenSelf} title={t("mobile.fullSettingsTitle")}>{t("mobile.fullSettings")}</button>
              </div>
            </div>
          )}

          {/* S2 首次：建号 + 方案 + 登录档 */}
          {view === "first" && (
            <div>
              <div style={{ color: "var(--text-muted)" }}>{t("mobile.firstHint")}</div>
              <div style={row}>
                <input style={input} placeholder={t("mobile.username")} value={username} maxLength={40} onChange={(e) => setUsername((e.target as HTMLInputElement).value)} />
              </div>
              <div style={row}>
                <input style={input} type="password" placeholder={t("mobile.password")} value={password} maxLength={80} onChange={(e) => setPassword((e.target as HTMLInputElement).value)} />
              </div>
              {candidate && (
                <>
                  <div style={{ ...row, flexWrap: "wrap" }}>
                    <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("mobile.loginTier")}:</span>
                    {(["password", "face", "totp"] as Tier[]).map((tp) => {
                      const faceBlocked = tp === "face" && !faceSelectable(candidate, pageHttps());
                      return (
                        <button key={tp} type="button" disabled={faceBlocked || busy}
                          title={faceBlocked ? t("mobile.httpsHint") : t("mobile.tierFaceHint")}
                          onClick={() => setTier(tp)}
                          style={{ ...btn, background: tier === tp ? "var(--accent)" : "var(--bg-hover)", color: tier === tp ? "#fff" : "var(--text)", borderColor: tier === tp ? "var(--accent)" : "var(--border)", opacity: faceBlocked ? 0.4 : busy ? 0.6 : 1, cursor: faceBlocked || busy ? "default" : "pointer" }}>
                          {tp === "password" ? t("mobile.tierPassword") : tp === "face" ? t("mobile.tierFace") : t("mobile.tierTotp")}
                        </button>
                      );
                    })}
                  </div>
                  {tier === "face" && !candidate.https && <div style={{ ...row, color: "var(--text-muted)", fontSize: 11 }}>{t("mobile.httpsHint")}</div>}
                  <div style={{ ...row, flexWrap: "wrap" }}>
                    <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("mobile.scheme")}:</span>
                    {(reco?.candidates ?? []).filter((c) => c.available && !confirmNeeded(c)).map((c) => (
                      <button key={c.id} type="button" disabled={busy}
                        onClick={() => { setCandidate(c); setTunnelTool(pickTunnelTool(c, tunnelTool)); setTier(faceSelectable(c, pageHttps()) ? "face" : "password"); }}
                        style={{ ...btn, fontSize: 11, padding: "0 8px", height: 26, background: candidate.id === c.id ? "var(--accent)" : "var(--bg-hover)", color: candidate.id === c.id ? "#fff" : "var(--text)", borderColor: candidate.id === c.id ? "var(--accent)" : "var(--border)" }}>
                        {t(schemeKey(c.id))}
                      </button>
                    ))}
                    {(candidate.badges ?? []).map(badge)}
                  </div>
                  {tunnelToolRow}
                </>
              )}
              <div style={{ ...row, justifyContent: "flex-end" }}>
                <button type="button" style={btn} onClick={onOpenSelf} title={t("mobile.fullSettingsTitle")}>{t("mobile.fullSettings")}</button>
                <button type="button" style={{ ...btn, background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" }} disabled={busy} onClick={submitFirst}>
                  {busy ? t("mobile.working") : t("mobile.createAndExpose")}
                </button>
              </div>
            </div>
          )}

          {/* 已有用户：只暴露 */}
          {view === "expose-only" && candidate && (
            <div>
              <div style={{ ...row, flexWrap: "wrap" }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("mobile.scheme")}:</span>
                {(reco?.candidates ?? []).filter((c) => c.available && !confirmNeeded(c)).map((c) => (
                  <button key={c.id} type="button" disabled={busy}
                    onClick={() => { setCandidate(c); setTunnelTool(pickTunnelTool(c, tunnelTool)); setTier(faceSelectable(c, pageHttps()) ? "face" : "password"); }}
                    style={{ ...btn, fontSize: 11, padding: "0 8px", height: 26, background: candidate.id === c.id ? "var(--accent)" : "var(--bg-hover)", color: candidate.id === c.id ? "#fff" : "var(--text)", borderColor: candidate.id === c.id ? "var(--accent)" : "var(--border)" }}>
                    {t(schemeKey(c.id))}
                  </button>
                ))}
                {(candidate.badges ?? []).map(badge)}
              </div>
              {tunnelToolRow}
              <div style={{ ...row, justifyContent: "flex-end" }}>
                <button type="button" style={btn} disabled={busy} onClick={() => { setView("list"); load(true); }}>{t("mobile.switchScheme")}</button>
                <button type="button" style={btn} onClick={onOpenSelf} title={t("mobile.fullSettingsTitle")}>{t("mobile.fullSettings")}</button>
                <button type="button" style={{ ...btn, background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" }} disabled={busy} onClick={submitExposeOnly}>
                  {busy ? t("mobile.working") : t("mobile.exposeOnly")}
                </button>
              </div>
            </div>
          )}

          {/* TOTP 登记中间态 */}
          {totpQr && (
            <div style={{ ...row, flexDirection: "column", alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("mobile.totpSetup")}</div>
              {totpQr && <img src={totpQr} width={160} height={160} alt="TOTP" style={{ borderRadius: 8, marginTop: 6 }} />}
              <button type="button" style={{ ...btn, marginTop: 8 }} disabled={busy} onClick={() => { setTotpQr(null); doExpose(candidate!); }}>{t("mobile.totpDone")}</button>
            </div>
          )}

          {/* 刷脸采集（本机；复用既有 FaceCaptureModal） */}
          {faceOpen && (
            <FaceCaptureModal name={username.trim()} provider="portal" site="pi-web" t={t} mode="enroll"
              onClose={() => setFaceOpen(false)}
              onDone={() => { setFaceOpen(false); doExpose(candidate!); }} />
          )}

          {/* 无认证候选确认 */}
          {view === "confirm" && candidate && (
            <div>
              <div style={{ fontWeight: 600 }}>{t("mobile.riskConfirmTitle")}</div>
              <div style={{ marginTop: 6, color: "var(--text-muted)" }}>{t("mobile.riskConfirmBody")}</div>
              <div style={{ ...row, justifyContent: "flex-end" }}>
                <button type="button" style={btn} onClick={() => setView(reco?.hasUsers ? "expose-only" : "first")}>✕</button>
                <button type="button" style={{ ...btn, background: "var(--danger, #f87171)", borderColor: "var(--danger, #f87171)", color: "#fff" }} disabled={busy} onClick={() => { const c = candidate; setView(reco && reco.hasUsers ? "expose-only" : "first"); void doExpose(c); }}>
                  {busy ? t("mobile.working") : t("mobile.exposeOnly")}
                </button>
              </div>
            </div>
          )}

          {/* S3 ready: big QR (parametrized launch.query appended in selfQrUrl) */}
          {view === "ready" && selfQrUrl && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4 }}>
              <div style={{ fontWeight: 600 }}>{t("mobile.ready")}</div>
              <ReadyQr url={selfQrUrl} hint={t("mobile.qrHint")} t={t} />
              <div style={{ ...row, flexWrap: "wrap", justifyContent: "center" }}>
                <button type="button" style={btn} onClick={() => { setView("list"); load(true); }}>{t("mobile.switchScheme")}</button>
              </div>
              <div style={{ ...row, flexWrap: "wrap", justifyContent: "center", borderTop: "1px solid var(--border)", paddingTop: 8, width: "100%" }}>
                <button type="button" style={btn} disabled={busy} onClick={stop}>{t("mobile.stop")}</button>
                <button type="button" style={btn} onClick={onOpenPorts}>{t("mobile.openPorts")}</button>
                <button type="button" style={btn} onClick={onOpenSelf} title={t("mobile.fullSettingsTitle")}>{t("mobile.fullSettings")}</button>
              </div>
            </div>
          )}

          {/* S6 右：多通道挑一条 */}
          {view === "pick" && (
            <div>
              <div style={{ color: "var(--text-muted)" }}>{t("mobile.pickChannel")}</div>
              {(reco?.self?.channels ?? []).filter((c) => !c.noAuth && c.url).map((c) => (
                <button key={c.url} type="button" style={{ ...btn, ...row, width: "100%", justifyContent: "flex-start", textAlign: "left" }} onClick={() => { setReadyUrl(c.url ?? null); setView("ready"); }}>
                  {c.url}
                </button>
              ))}
            </div>
          )}

          {/* S5 清单（换个方案 / deep 探测） */}
          {view === "list" && (
            <div>
              {(reco?.candidates ?? []).map((c) => {
                const label = t(`mobile.scheme${c.id.charAt(0).toUpperCase()}${c.id.slice(1)}`);
                const deepPending = c.reason === "deep-only";
                return (
                  <div key={c.id} style={{ ...row, justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
                      <strong>{label}</strong>
                      {c.recommended && h_chip("★")}
                      {(c.badges ?? []).map((b) => h_chip(t(`mobile.badge.${b}`), b === "no-auth"))}
                      {!c.available && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t(`mobile.reason.${c.reason}`)}</span>}
                      {deepPending && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("mobile.reason.deep-only")}</span>}
                    </div>
                    {c.available && (
                      <button type="button" style={btn} disabled={busy}
                        onClick={() => { setCandidate(c); setTunnelTool(pickTunnelTool(c, tunnelTool)); if (confirmNeeded(c)) setView("confirm"); else if (!reco?.hasUsers) setView("first"); else void doExpose(c); }}>
                        {t("mobile.exposeOnly")}
                      </button>
                    )}
                  </div>
                );
              })}
              <div style={{ ...row, justifyContent: "flex-end" }}>
                <button type="button" style={btn} onClick={onOpenSelf} title={t("mobile.fullSettingsTitle")}>{t("mobile.fullSettings")}</button>
              </div>
            </div>
          )}
          </>)}

          {/* —— ports source (§3.1: every exposed URL from the ports dialog is
              QR-able; Q2 remembers the last pick) —— */}
          {source === "ports" && (
            <div>
              {portNote && <div style={{ ...row, color: "var(--text-muted)", fontSize: 11 }}>{portNote}</div>}
              {portsLoading ? (
                <div style={{ ...row, justifyContent: "center", padding: "24px 0", color: "var(--text-muted)" }}>…</div>
              ) : portList.length === 0 ? (
                <div>
                  <div style={{ color: "var(--text-muted)", padding: "10px 0" }}>{t("mobile.portsEmpty")}</div>
                  <div style={{ ...row, justifyContent: "flex-end" }}>
                    <button type="button" style={{ ...btn, background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" }} onClick={onOpenPorts}>{t("mobile.openPorts")}</button>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ ...row, marginTop: 4, color: "var(--text-muted)", fontSize: 11 }}>{t("mobile.portsPick")}</div>
                  {portList.map((r) => (
                    <div key={r.name} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <strong style={{ fontSize: 12 }}>{r.label || r.name}</strong>
                        {r.noAuth && <NoAuthBadge t={t} />}
                      </div>
                      {r.urls.map((u) => (
                        <button key={u} type="button" onClick={() => pickPortUrl(u)}
                          style={{ ...btn, ...row, width: "100%", justifyContent: "flex-start", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11, background: portSel === u ? "var(--bg-selected)" : "var(--bg-hover)", borderColor: portSel === u ? "var(--accent)" : "var(--border)", color: portSel === u ? "var(--accent)" : "var(--text)" }}>
                          {upgradeToPageProto(u, pageHttps()) ?? u}
                        </button>
                      ))}
                    </div>
                  ))}
                  {portSel && <ReadyQr url={upgradeToPageProto(portSel, pageHttps()) ?? portSel} hint={t("mobile.qrHint")} t={t} />}
                </div>
              )}
            </div>
          )}

          {/* —— custom link source (§3.2: parametrized {url} launch renders its QR) —— */}
          {source === "link" && safeLaunchUrl && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4 }}>
              <div style={{ fontWeight: 600, textAlign: "center" }}>{launch?.title || t("mobile.linkTitle")}</div>
              <ReadyQr url={safeLaunchUrl} hint={t("mobile.qrHint")} t={t} />
            </div>
          )}
          </div>
          {botsAvail && (
            <div style={{ width: 268, flexShrink: 0, borderLeft: "1px solid var(--border)", padding: "12px 12px 14px", background: "var(--bg-elevated, rgba(127,127,127,0.04))", display: "flex", flexDirection: "column" }}>
              <BotChannelsColumn />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
