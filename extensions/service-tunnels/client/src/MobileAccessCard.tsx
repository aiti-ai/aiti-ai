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
import { usePresent } from "../../../_shared/ext-float-dock";
import { qrDataUrl, downloadQrPng } from "./qr";
import { FaceCaptureModal } from "./face-capture";
import { MOBILE_KEY, REMEMBER_KEY, tierParams, confirmNeeded, pickCandidate, resolveReadyUrl, upgradeToPageProto, faceSelectable, schemeKey, type Reco, type RecoCandidate } from "./mobile-logic";

// ---------------------------------------------------------------------------
// 组件
// ---------------------------------------------------------------------------

type View = "loading" | "first" | "expose-only" | "ready" | "pick" | "list" | "unsafe" | "confirm";
type Tier = "password" | "face" | "totp";

interface Props {
  onClose: () => void;
  onOpenPorts: () => void;
  onOpenSelf: () => void;
}

function pageHttps(): boolean {
  return typeof location !== "undefined" && location.protocol === "https:";
}

export function MobileAccessCard({ onClose, onOpenPorts, onOpenSelf }: Props) {
  const { t } = useI18n();
  const [reco, setReco] = useState<Reco | null>(null);
  const [view, setView] = useState<View>("loading");
  const [candidate, setCandidate] = useState<RecoCandidate | null>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tier, setTier] = useState<Tier>("password");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [totpQr, setTotpQr] = useState<string | null>(null);
  const [faceOpen, setFaceOpen] = useState(false);
  const [toast, setToast] = useState("");
  const recoRef = useRef<Reco | null>(null);
  const aliveRef = useRef(true);

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
    let remembered: { id?: string } | null = null;
    try { remembered = JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "null"); } catch { /* ignore */ }
    const { candidate: pick, rememberedGone } = pickCandidate(d, remembered);
    if (!pick) { setView("unsafe"); if (deepToast) setToast(deepToast); return; }
    setCandidate(pick);
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

  // 事件驱动刷新（mount + focus + visibility + online；无轮询）
  useEffect(() => {
    aliveRef.current = true;
    load();
    const onFocus = () => load();
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onFocus);
    return () => {
      aliveRef.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onFocus);
    };
  }, [load]);

  // 就绪态出码（readyUrl 变化即重出；隧道 URL 变化自动跟新）
  useEffect(() => {
    if (view !== "ready" || !readyUrl) { setQr(null); return; }
    let alive = true;
    qrDataUrl(upgradeToPageProto(readyUrl, pageHttps()), { size: 336 }).then((d) => { if (alive) setQr(d); }).catch(() => { if (alive) setQr(null); });
    return () => { alive = false; };
  }, [view, readyUrl]);

  const remember = (id: string) => {
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify({ id, tier })); } catch { /* ignore */ }
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
          ...(c.id === "tunnel" ? { tunnel: c.tunnel ?? "cloudflared" } : {}),
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
  }, [tier, post, load]);

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
    setBusy(true);
    try {
      await post("self-stop", {});
      try { localStorage.removeItem(REMEMBER_KEY); } catch { /* ignore */ }
      load();
    } finally { if (aliveRef.current) setBusy(false); }
  }, [post, load]);

  const copyUrl = useCallback(async () => {
    if (!readyUrl) return;
    try { await navigator.clipboard.writeText(readyUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  }, [readyUrl]);

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

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div
        data-ext-float="1"
        data-ext-float-key={MOBILE_KEY}
        data-ext-float-w={400}
        data-ext-float-autoh="1"
        data-ext-float-full="1"
        style={{
          width: 400, maxWidth: "calc(100vw - 16px)", maxHeight: "min(86vh, 780px)", overflow: "auto",
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

        <div style={{ padding: "12px 14px 14px", fontSize: 12, color: "var(--text)" }}>
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
                        onClick={() => { setCandidate(c); setTier(faceSelectable(c, pageHttps()) ? "face" : "password"); }}
                        style={{ ...btn, fontSize: 11, padding: "0 8px", height: 26, background: candidate.id === c.id ? "var(--accent)" : "var(--bg-hover)", color: candidate.id === c.id ? "#fff" : "var(--text)", borderColor: candidate.id === c.id ? "var(--accent)" : "var(--border)" }}>
                        {t(schemeKey(c.id))}
                      </button>
                    ))}
                    {(candidate.badges ?? []).map(badge)}
                  </div>
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
                    onClick={() => { setCandidate(c); setTier(faceSelectable(c, pageHttps()) ? "face" : "password"); }}
                    style={{ ...btn, fontSize: 11, padding: "0 8px", height: 26, background: candidate.id === c.id ? "var(--accent)" : "var(--bg-hover)", color: candidate.id === c.id ? "#fff" : "var(--text)", borderColor: candidate.id === c.id ? "var(--accent)" : "var(--border)" }}>
                    {t(schemeKey(c.id))}
                  </button>
                ))}
                {(candidate.badges ?? []).map(badge)}
              </div>
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

          {/* S3 就绪：大二维码 */}
          {view === "ready" && readyUrl && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4 }}>
              <div style={{ fontWeight: 600 }}>{t("mobile.ready")}</div>
              {qr && <img src={qr} width={220} height={220} alt="QR" style={{ borderRadius: 8, marginTop: 10 }} />}
              <div style={{ marginTop: 8, fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all", textAlign: "center" }}>{t("mobile.qrHint")}</div>
              <div style={{ marginTop: 6, fontSize: 11, fontFamily: "var(--font-mono)", wordBreak: "break-all", color: "var(--text-dim, var(--text-muted))" }}>{upgradeToPageProto(readyUrl, pageHttps())}</div>
              <div style={{ ...row, flexWrap: "wrap", justifyContent: "center" }}>
                <button type="button" style={btn} onClick={copyUrl}>{copied ? t("mobile.copied") : t("mobile.copy")}</button>
                <button type="button" style={btn} disabled={!qr} onClick={() => qr && downloadQrPng(qr, "pi-web-mobile.png")}>{t("mobile.downloadPng")}</button>
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
                        onClick={() => { setCandidate(c); if (confirmNeeded(c)) setView("confirm"); else if (!reco?.hasUsers) setView("first"); else void doExpose(c); }}>
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
        </div>
      </div>
    </div>
  );
}
