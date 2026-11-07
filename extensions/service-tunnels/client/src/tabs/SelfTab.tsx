/**
 * tabs/SelfTab — pi-web 自暴露 tab（M2 拆壳；自 ServicesDialog.tsx 原位迁出，逻辑零改动）。
 */
import { Fragment, useEffect, useState } from "react";
import { useI18n, useIsMobile, apiUrl, copyText } from "../host-shim";
import { ConfirmDialog, UrlRow, SchemaForm, providerDisplayLabel } from "../dialog/shared";
import { portmapProbeView } from "../lib-shared";
import type { ExposeInfo, SelfState } from "../dialog/types";

export /** Pi-web tab: self-exposure control + direct-access gate (allowlocal). */
function SelfTab({ self, t, openInNewTab, copy, copiedKey, onChanged, onGoManageUsers, exposes, onShowDetail, onStopExpose, injectSources, caps }: {
  self: SelfState | null;
  t: (k: string, params?: Record<string, string>) => string;
  openInNewTab: (url: string) => void;
  copy: (key: string, url: string) => void;
  copiedKey: string | null;
  onChanged: () => void;
  /** Switch to the Users tab (no users for the selected auth combo). */
  onGoManageUsers: () => void;
  /** All exposes — to find the one behind a tunnel/vhost URL for the detail modal. */
  exposes: ExposeInfo[];
  /** Open the expose detail modal (link open + stop live there). */
  onShowDetail: (ex: ExposeInfo) => void;
  /** Stop ONE expose by name (proxy vhost rows — removes binding + record). */
  onStopExpose: (name: string) => void;
  /** 注入源清单（公开配置勾选用） */
  injectSources: Array<{ id: string; label: string; description?: string }>;
  /** 库能力协商（M3）：exposeModes 决定 portmap/ipv6 模式选项是否出现
   *  （与 Ports 页同款门控；缺席=全显）。 */
  caps?: { exposeModes?: string[] } | null;
}) {
  // 多语:SelfTab 自身组件,单独拿 locale(与 ServicesDialog 的 stApi 一致)
  const { locale: selfLocale } = useI18n();
  // 暴露地址(tunnel / proxy vhost)点击 → 先弹详情,详情里可打开/停止;
  // 直连(回环/局域网)与例外域名仍直接打开。
  /** 暴露条目定位:tunnel 行按隧道名,vhost 行按 URL 匹配。 */
  const exposeFor = (u: { url: string; tunnel?: string }): ExposeInfo | undefined =>
    u.tunnel
      ? exposes.find((e) => e.name === u.tunnel)
      : exposes.find((e) => e.localUrl === u.url || e.baseUrl === u.url || e.domainUrl === u.url);

  const openOrDetail = (u: { url: string; tunnel?: string; authEntry?: boolean; label?: string }) => {
    if (!u.authEntry || (u.label ?? "").includes("allowHost")) { openInNewTab(u.url); return; }
    const ex = exposeFor(u);
    if (ex) onShowDetail(ex);
    else openInNewTab(u.url);
  };

  // proxy 虚拟主机行的停止目标(与 tunnel 行的红色停止一致):proxy 模式 →
  // 移除 binding + 记录;tunnel 行用各自的 doStopTunnel。
  const vhostStopName = (u: { url: string; tunnel?: string; authEntry?: boolean; label?: string; exposeName?: string }): string | undefined => {
    if (u.tunnel || !u.authEntry || (u.label ?? "").includes("allowHost")) return undefined;
    // exposeName 由服务端随 URL 条目下发(加载即有,不等 exposes 异步就绪)
    if (u.exposeName && (u.exposeName ?? "").startsWith("proxy:")) return u.exposeName;
    // fallback:先按 URL 匹配;URL 拼接不一致(basePath 来源不同等)时按 端口+site 兜底:
    // 自暴露的 proxy binding 一定是 site "pi-web" 的 proxy: 记录。
    const ex = exposeFor(u) ?? exposes.find((e) =>
      e.port === self?.port && (e.site === "pi-web" || (e.name ?? "").startsWith("expose-self-"))
      && (e.name ?? "").startsWith("proxy:"),
    );
    return ex && (ex.name ?? "").startsWith("proxy:") ? ex.name : undefined;
  };
  const [mode, setMode] = useState("tunnel");
  const [auth, setAuth] = useState("portal");
  // provider 列表来自库(数据驱动,与 Ports 页同源):oauth2-proxy / oauth2 变体 /
  // 插件 provider 自动出现——不硬编码 portal/basic/authelia
  const [providers, setProviders] = useState<string[] | null>(null);
  const [tunnel, setTunnel] = useState("cloudflared");
  // 隧道类型 schema 驱动(与 Ports 页同一数据源):serveo/bore/natapp/自定义
  // 类型都会出现,command 等 dangerous 类型隐藏——不再硬编码 4 项
  const [tunnelSchemas, setTunnelSchemas] = useState<Record<string, ParamSpec[]> | null>(null);
  const [tunnelMetas, setTunnelMetas] = useState<Record<string, { favorite?: boolean; dangerous?: boolean }> | null>(null);
  // 隧道/provider 参数(schema 驱动,与 Ports 页同款)——ngrok 等类型需要 token/domain
  const [tunnelParams, setTunnelParams] = useState<Record<string, string>>({});
  const [providerParams, setProviderParams] = useState<Record<string, string>>({});
  // M3 对齐（与 Ports 页同款）：portmap 路由器映射参数 + 探测；ipv6 直连地址（auto/候选/手动）
  const [pmParams, setPmParams] = useState<{ method: string; gateway: string; externalPort: string; leaseSeconds: string }>({ method: "auto", gateway: "", externalPort: "", leaseSeconds: "" });
  const [probeHint, setProbeHint] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [ipv6Addr, setIpv6Addr] = useState("auto");
  const [ipv6Manual, setIpv6Manual] = useState("");
  const [ipv6Cands, setIpv6Cands] = useState<Array<{ address: string; scope: string; iface: string }> | null>(null);
  const [ipv6Public, setIpv6Public] = useState<string[]>([]);
  const [authSchemas, setAuthSchemas] = useState<Record<string, ParamSpec[]> | null>(null);
  // provider 页面元数据(label/已配置)来自库——picker 显示友好名称用
  const [authMetas, setAuthMetas] = useState<Record<string, { label?: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copiedEnv, setCopiedEnv] = useState(false);
  const [allowHostsInput, setAllowHostsInput] = useState("");
  // 用户是否编辑过 allowHosts 输入框:未编辑时用当前生效值预填(输入即同步预览),
  // 一旦编辑就不再被轮询刷新覆盖
  const [allowHostsTouched, setAllowHostsTouched] = useState(false);
  // auth=none(无认证直接公开 pi-web)→ 泄露风险确认
  const [confirmNone, setConfirmNone] = useState(false);
  // 有本地用户库的 provider(portal/basic/authelia…)——公开前检查 site "pi-web" 是否有用户
  const [userManagers, setUserManagers] = useState<string[]>([]);
  // userManagers 清单是否已就绪(schema 拉取失败 → fail-closed,阻止直接公开)
  const [userManagersReady, setUserManagersReady] = useState(false);
  const [checking, setChecking] = useState(false);
  // 该 provider+site 无用户 → 提示去管理用户
  const [noUsers, setNoUsers] = useState<{ provider: string; site: string } | null>(null);
  // 有用户 → 列出用户名,让用户确认自己可登录
  const [userConfirm, setUserConfirm] = useState<{ provider: string; site: string; users: string[] } | null>(null);

  const exposing = self?.exposing ?? false;
  const allowLocal = self?.allowLocal ?? true;
  const hostname = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
  const warnNonLoopback = exposing && !loopback;

  const btn: React.CSSProperties = {
    padding: "5px 12px",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 12,
    border: "1px solid var(--border)",
    background: "none",
    color: "var(--text)",
  };
  const select: React.CSSProperties = {
    padding: "4px 6px",
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontSize: 12,
  };

  // 隧道类型 schema 来自库(与 Ports 页同一数据源),默认 cloudflared;
  // 不可用时回退到第一个非危险类型
  // Mount-once (same rationale as the schemas fetch above); self.auth is read
  // through the closure and only used to prefill the provider select.
  useEffect(() => {
    fetch(`${apiUrl("/api/extensions/service-tunnels/status")}?lang=${encodeURIComponent(selfLocale)}`)
      .then((r) => r.json())
      .then((d: { providerOrder?: string[]; defaultProvider?: string; tunnelSchemas?: Record<string, ParamSpec[]>; tunnelMetas?: Record<string, { favorite?: boolean; dangerous?: boolean }>; authProviderSchemas?: Record<string, ParamSpec[]>; authMetas?: Record<string, { label?: string }>; userManagers?: string[] }) => {
        // provider 顺序/默认值由库下发(authelia 可用性、Windows 回退等都在
        // service-tunnels 内决定)——oauth2-proxy 等在此出现,无硬编码
        const order = d.providerOrder ?? ["portal", "basic"];
        setProviders(["none", ...order]);
        // 预填当前生效的 provider(self.auth = 正在暴露的 provider / env 配置)
        if (self?.auth && order.includes(self.auth)) setAuth(self.auth);
        if (d.tunnelSchemas) setTunnelSchemas(d.tunnelSchemas);
        if (d.tunnelMetas) setTunnelMetas(d.tunnelMetas);
        if (d.authProviderSchemas) setAuthSchemas(d.authProviderSchemas);
        if (d.authMetas) setAuthMetas(d.authMetas);
        if (d.userManagers) setUserManagers(d.userManagers);
        setUserManagersReady(true);
        if (d.tunnelSchemas && d.tunnelMetas) {
          const available = Object.keys(d.tunnelSchemas).filter(
            (k) => !d.tunnelMetas?.[k]?.dangerous && k !== "command",
          );
          if (!available.includes("cloudflared")) setTunnel(available[0] ?? "cloudflared");
        }
      })
      .catch(() => {});
  // Mount-once (same rationale as the schemas fetch); self.auth is read
  // through the closure only to prefill the provider select.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleAllowLocal = (v: boolean) => {
    if (v === false) {
      // 关闭期间仍可访问的认证入口/例外域名(authEntries 含 allowHost 白名单)
      // 为空 → 弹窗提示并拒绝,不进入临时关闭——没有任何方式可访问,临时 30s 无意义
      if (authEntries.length === 0) {
        setRejectDialog(true);
        return;
      }
      // 第一阶段:服务端临时关闭(TTL 自动恢复),随即进入 30s 二次确认窗口
      setErr(null);
      setRestoredNotice(false);
      fetch(apiUrl("/api/extensions/service-tunnels/status"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "self-allowlocal", allowLocal: false, ttlMs: TTL_MS }),
      })
        .then((r) => r.json())
        .then((d: { error?: string }) => {
          if (d.error) { setErr(d.error); onChanged(); }
          else { setConfirmCountdown(CONFIRM_WINDOW); onChanged(); }
        })
        .catch(() => setErr(String(t("services.error"))))
        .finally(() => {});
      return;
    }
    // 开启/恢复:立即生效(安全操作)
    setErr(null);
    setRestoredNotice(false);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowlocal", allowLocal: true, confirm: true }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => { if (d.error) setErr(d.error); else onChanged(); })
      .catch(() => setErr(String(t("services.error"))));
  };

  // 第二阶段:二次确认 → 永久关闭
  const confirmDisableNow = () => {
    setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowlocal", allowLocal: false, confirm: true }),
    })
      .then(async (r) => {
        if (r.status === 403) { setBlockedHint(true); return null; } // 裸直连已被屏蔽:等自动恢复
        return r.json();
      })
      .then((d: { error?: string } | null) => { if (d === null) return; if (d.error) setErr(d.error); else { setConfirmCountdown(null); onChanged(); } })
      .catch(() => setErr(String(t("services.error"))));
  };

  // 取消/立即恢复(不等 TTL)
  const restoreNow = () => {
    setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowlocal", allowLocal: true, confirm: true }),
    })
      .then(async (r) => {
        if (r.status === 403) { setBlockedHint(true); return null; } // 裸直连已被屏蔽:等自动恢复
        return r.json();
      })
      .then((d: { error?: string } | null) => { if (d === null) return; if (d.error) setErr(d.error); else { setConfirmCountdown(null); setRestoredNotice(true); onChanged(); } })
      .catch(() => setErr(String(t("services.error"))));
  };

  // 两阶段关闭(Windows 分辨率式):第一阶段临时关闭(服务端 TTL 60s 自动恢复),
  // 30s 倒计时内二次确认才永久;超时/被锁点不了 → 服务端自动恢复,不会锁死
  const [confirmCountdown, setConfirmCountdown] = useState<number | null>(null); // null=未在确认
  const [restoredNotice, setRestoredNotice] = useState(false); // 超时自动恢复提示
  const [blockedHint, setBlockedHint] = useState(false); // 屏蔽期间按钮被 403 的温和提示
  const [rejectDialog, setRejectDialog] = useState(false); // 无可访问入口时拒绝关闭的弹窗
  const CONFIRM_WINDOW = 30; // 二次确认窗口(秒)
  const TTL_MS = 30_000; // 服务端临时关闭 TTL(与确认窗口一致,到期自动恢复)
  useEffect(() => {
    if (confirmCountdown === null) return;
    if (confirmCountdown <= 0) {
      // 窗口结束未确认 → 服务端 TTL 已自动恢复;关窗 + 提示
      setConfirmCountdown(null);
      setRestoredNotice(true);
      onChanged();
      return;
    }
    const t = setTimeout(() => setConfirmCountdown((c) => (c ?? 1) - 1), 1000);
    return () => clearTimeout(t);
  }, [confirmCountdown, onChanged]);
  // 关闭后仍可用的认证入口(虚拟主机/隧道 — 走代理认证,不受直连门禁影响)
  // 关闭期间仍可访问的认证入口:仅虚拟主机/隧道(authEntry),回环与局域网裸
  // 直连在 allowlocal=false 时同样 403,绝不列入
  const authEntries = (self?.urls ?? []).filter((u) => u.authEntry === true);
  // 暴露区地址:仅隧道/虚拟主机入口(排除 allowHost 例外域名)
  const exposeUrls = (self?.urls ?? []).filter((u) => u.authEntry === true && !u.label.includes("allowHost"));

  // allowHosts 输入框预填当前生效值(仅首次/未编辑时)
  useEffect(() => {
    if (!allowHostsTouched && (self?.allowHosts ?? []).length > 0) {
      setAllowHostsInput(self!.allowHosts.join(" "));
    }
  }, [self, allowHostsTouched]);

  const saveAllowHosts = () => {
    setErr(null);
    const hosts = allowHostsInput.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowhosts", hosts }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => { if (d.error) setErr(d.error); else onChanged(); })
      .catch(() => setErr(String(t("services.error"))));
  };

  const [injectSel, setInjectSel] = useState<string[]>([]);
  const doExpose = () => {
    setBusy(true); setErr(null);
    // M3 对齐（与 Ports 页同款装配）：portmap 空值不传；ipv6 auto 不传 → 库自动检测
    const portmapBody = mode === "portmap"
      ? Object.fromEntries(Object.entries({
          ...(pmParams.method && pmParams.method !== "auto" ? { method: pmParams.method } : {}),
          ...(pmParams.gateway.trim() ? { gateway: pmParams.gateway.trim() } : {}),
          ...(pmParams.externalPort.trim() ? { externalPort: Number(pmParams.externalPort) } : {}),
          ...(pmParams.leaseSeconds.trim() ? { leaseSeconds: Number(pmParams.leaseSeconds) } : {}),
        }).filter(([, v]) => v !== "" && v !== undefined))
      : undefined;
    let ipv6Body: { address: string } | undefined;
    if (mode === "ipv6") {
      const addr = ipv6Addr === "__manual" ? ipv6Manual.trim() : (ipv6Addr !== "auto" ? ipv6Addr : "");
      if (addr) ipv6Body = { address: addr };
    }
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "self-expose",
        mode,
        provider: auth, // "none" 必须保留字符串,exposeSelf 判断 opts.auth === "none";传 undefined 会走默认 portal
        tunnel,
        tunnelParams,
        providerParams,
        ...(portmapBody && Object.keys(portmapBody).length ? { portmap: portmapBody } : {}),
        ...(ipv6Body ? { ipv6: ipv6Body } : {}),
        ...(injectSel.length ? { inject: injectSel } : {}),
      }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => { if (d.error) setErr(d.error); else onChanged(); })
      .catch(() => setErr(String(t("services.error"))))
      .finally(() => setBusy(false));
  };

  const checkUsers = () => {
    // 用户库清单未就绪(schema 拉取失败/进行中)→ fail-closed,提示重试而非静默公开
    if (!userManagersReady) {
      setErr(t("services.userCheckUnavailable"));
      return;
    }
    // 无本地用户库的 provider(oauth2-proxy 等)→ 无可检查,直接公开
    if (!userManagers.includes(auth)) { doExpose(); return; }
    setChecking(true); setErr(null);
    // pi-web 自暴露的认证域是 site "pi-web"(独立用户库,与 dev 服务分开)
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "user-list", provider: auth, site: "pi-web" }),
    })
      .then((r) => r.json())
      .then((d: { users?: { provider: string; users: { name: string; displayName: string }[] }[]; error?: string }) => {
        if (d.error) { setErr(d.error); return; }
        const entry = (d.users ?? []).find((x) => x.provider === auth);
        const users = entry?.users ?? [];
        if (users.length === 0) { setNoUsers({ provider: auth, site: "pi-web" }); return; }
        setUserConfirm({ provider: auth, site: "pi-web", users: users.map((u) => u.displayName || u.name) });
      })
      .catch(() => setErr(String(t("services.error"))))
      .finally(() => setChecking(false));
  };

  const startExpose = () => {
    // auth=none → pi-web 无认证直接公开,泄露风险确认
    if (auth === "none") { setConfirmNone(true); return; }
    // 带认证 → 检查 site "pi-web" 下该 provider 是否有可登录用户,再公开
    checkUsers();
  };

  // 单渠道停止:只停该隧道进程(如 localtunnel),vhost 绑定保留
  const doStopTunnel = (name: string) => {
    setBusy(true); setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-stop-tunnel", name }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => { if (d.error) setErr(d.error); else onChanged(); })
      .catch(() => setErr(String(t("services.error"))))
      .finally(() => setBusy(false));
  };

  // 永久配置文本:allowHost 用输入框**实时值**(输入即同步,不等保存);tunnel/
  // provider 参数按 PI_WEB_EXPOSE 的 tunnel./provider. 前缀嵌套键序列化
  const liveAllowHosts = allowHostsInput.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
  const tunnelParamStr = Object.entries(tunnelParams).map(([k, v]) => `tunnel.${k}=${v}`).join(",");
  const providerParamStr = Object.entries(providerParams).map(([k, v]) => `provider.${k}=${v}`).join(",");
  // env 片段：tunnel 参数只在需要隧道的模式带上（portmap/ipv6 不走隧道）。
  // 注：库启动钩子（PI_WEB_EXPOSE 解析）目前只认 tunnel/proxy/both/none——
  // portmap/ipv6 为运行时（UI/API）专有，env 路径待库侧放开。
  const envSnippet = `PI_WEB_EXPOSE="mode=${mode},auth=${auth}${mode === "tunnel" || mode === "both" ? `,tunnel=${tunnel}` : ""}${tunnelParamStr ? `,${tunnelParamStr}` : ""}${providerParamStr ? `,${providerParamStr}` : ""}${liveAllowHosts.length ? `,allowHost=${liveAllowHosts.join(",allowHost=")}` : ""}"`;
  const copyEnv = () => {
    copyText(envSnippet).then(() => {
      setCopiedEnv(true);
      setTimeout(() => setCopiedEnv(false), 1500);
    }).catch(() => {});
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Access URLs */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 8 }}>
          {t("services.selfAccessUrls")} <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>· port {self?.port ?? "?"}</span>
        </div>
        {!self?.urls?.length ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("services.none")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {self.urls.map((u) => {
              // allowlocal=false 时,局域网直连入口被门禁拒绝 → 标灰不可打开
              const gated = !allowLocal && u.gated === true;
              return (
                <div key={u.url} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, opacity: gated ? 0.45 : 1 }}>
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", width: 110 }}>{u.labelKey ? t(u.labelKey, u.labelParams) : u.label}</span>
                  {u.noAuth && <NoAuthBadge t={t} />}
                  <button onClick={() => { if (!gated) openOrDetail(u); }}
                    title={gated ? t("services.selfGatedHint") : u.url}
                    disabled={gated}
                    style={{ flex: 1, textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: gated ? "var(--text-dim)" : "var(--accent)", cursor: gated ? "not-allowed" : "pointer", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: gated ? "line-through" : "none" }}>
                    {u.url}
                  </button>
                  <button onClick={() => copy(`self-${u.url}`, u.url)} style={{ ...btn, padding: "3px 8px", flexShrink: 0 }}>
                    {copiedKey === `self-${u.url}` ? "✓" : t("services.copy")}
                  </button>
                  {u.tunnel && (
                    <button onClick={() => doStopTunnel(u.tunnel!)} disabled={busy} title={t("services.selfStopTunnelHint")}
                      style={{ ...btn, padding: "3px 8px", flexShrink: 0, color: "var(--danger, #f87171)" }}>
                      {t("services.selfStopTunnel")}
                    </button>
                  )}
                  {vhostStopName(u) && (
                    /* proxy 虚拟主机行:与 tunnel 行一致,外面直接可停止(移除 binding) */
                    <button onClick={() => onStopExpose(vhostStopName(u)!)} disabled={busy} title={t("services.selfStopVhostHint")}
                      style={{ ...btn, padding: "3px 8px", flexShrink: 0, color: "var(--danger, #f87171)" }}>
                      {t("services.exposeStop")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 无认证暴露 → 红色告警框（与页面顶部 🔴 条幅同源） */}
      {self?.unauthenticated && (
        <div style={{ border: "1px solid var(--danger, #f87171)", borderRadius: 8, padding: "8px 10px", background: "rgba(248,113,113,0.08)", fontSize: 12, color: "var(--danger, #f87171)" }}>
          🔴 {t("services.selfNoAuth")} — {t("services.selfNoAuthSummary")}
        </div>
      )}

      {warnNonLoopback && (
        <div style={{ border: "1px solid var(--danger, #f87171)", borderRadius: 8, padding: "8px 10px", background: "rgba(248,113,113,0.08)", fontSize: 12, color: "var(--danger, #f87171)" }}>
          ⚠ {t("services.selfWarning")}
        </div>
      )}

      {/* Expose controls */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>
          {t("services.selfExpose")}
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: exposing ? (self?.unauthenticated ? "var(--danger, #f87171)" : "#16a34a") : "var(--text-dim)" }}>
            ● {exposing ? t("services.selfExposing") : t("services.selfNotExposing")}
          </span>
        </div>
        {exposing && exposeUrls.length > 0 && (
          <div style={{ border: self?.unauthenticated ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(22,163,74,0.3)", background: self?.unauthenticated ? "rgba(248,113,113,0.06)" : "rgba(22,163,74,0.06)", borderRadius: 6, padding: "8px 10px", marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: self?.unauthenticated ? "var(--danger, #f87171)" : "#16a34a", marginBottom: 5 }}>{t("services.selfExposeUrls")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {exposeUrls.map((u) => (
                <div key={u.url} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", width: 96 }}>{u.labelKey ? t(u.labelKey, u.labelParams) : u.label}</span>
                  {u.noAuth && <NoAuthBadge t={t} />}
                  <button onClick={() => openOrDetail(u)} title={u.url}
                    style={{ flex: 1, textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {u.url}
                  </button>
                  <button onClick={() => copy(`self-expose-${u.url}`, u.url)} style={{ ...btn, padding: "3px 8px", flexShrink: 0 }}>
                    {copiedKey === `self-expose-${u.url}` ? "✓" : t("services.copy")}
                  </button>
                  {vhostStopName(u) && (
                    <button onClick={() => onStopExpose(vhostStopName(u)!)} disabled={busy} title={t("services.selfStopVhostHint")}
                      style={{ ...btn, padding: "3px 8px", flexShrink: 0, color: "var(--danger, #f87171)" }}>
                      {t("services.exposeStop")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>{t("services.selfExposeHint")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t("services.selfMode")}:
            <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ ...select, marginLeft: 4 }}>
              <option value="proxy">proxy</option>
              <option value="both">both</option>
              <option value="tunnel">tunnel</option>
              {/* M3 对齐：portmap/ipv6——库能力门控（与 Ports 页同款；缺席=全显） */}
              {(!caps?.exposeModes || caps.exposeModes.includes("portmap")) && <option value="portmap">portmap (router)</option>}
              {(!caps?.exposeModes || caps.exposeModes.includes("ipv6")) && <option value="ipv6">ipv6 (direct)</option>}
            </select>
          </label>
          <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t("services.selfAuth")}:
            <select value={auth} onChange={(e) => setAuth(e.target.value)} style={{ ...select, marginLeft: 4 }}>
              {/* 数据驱动:与 Ports 页同一 provider 列表(schema 拉取失败时回退 4 项) */}
              {(providers ?? ["none", "portal", "basic", "authelia"]).map((p) => (
                <option key={p} value={p}>{providerDisplayLabel(p, t, authMetas)}</option>
              ))}
            </select>
          </label>
          {(mode === "tunnel" || mode === "both") && (
            <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("services.selfTunnel")}:
              <select value={tunnel} onChange={(e) => setTunnel(e.target.value)} style={{ ...select, marginLeft: 4 }}>
                {[...Object.entries(tunnelSchemas ?? {})]
                  // 与 Ports 页同一过滤:dangerous 类型(纯 command 等)不出现
                  .filter(([p]) => !tunnelMetas?.[p]?.dangerous && p !== "command")
                  .sort((a, b) => {
                    const fa = tunnelMetas?.[a[0]]?.favorite ? 1 : 0;
                    const fb = tunnelMetas?.[b[0]]?.favorite ? 1 : 0;
                    if (fa !== fb) return fb - fa;
                    return a[1].length - b[1].length;
                  })
                  .map(([k]) => (
                    <option key={k} value={k}>{k}{tunnelMetas?.[k]?.favorite ? " ★" : ""}</option>
                  ))}
              </select>
            </label>
          )}
          {/* 注入源勾选（公开配置的一部分，随 self-expose 提交） */}
          {injectSources.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>🧰 {t("services.injectJs")}</span>
              {injectSources.map((s) => {
                const on = injectSel.includes(s.id);
                return (
                  <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer", color: on ? "var(--text)" : "var(--text-dim)" }} title={s.description ?? ""}>
                    <input type="checkbox" checked={on} onChange={(e) => setInjectSel((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))} style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                    {s.label}
                  </label>
                );
              })}
            </div>
          )}
          {/* 始终显示"暴露"按钮——可同时启用多个渠道(隧道/虚拟主机);
              单个渠道在地址行用各自的红色"停止"按钮,不再提供"停止全部" */}
          <button onClick={startExpose} disabled={busy || checking} style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600 }}>
            {busy ? "…" : t("services.selfExposeBtn")}
          </button>
        </div>
        {/* 隧道参数(schema 驱动,同 Ports 页):ngrok 的 token/domain、frpc 的
            server/token 等随所选隧道类型出现 */}
        {(mode === "tunnel" || mode === "both") && tunnelSchemas?.[tunnel] && (
          <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }}>
              {t("services.tunnelParams")}
              {tunnelMetas?.[tunnel]?.favorite && (
                <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "var(--accent)", color: "#fff", fontSize: 9, fontWeight: 600 }}>
                  {t("services.recommended")}
                </span>
              )}
            </div>
            <SchemaForm specs={tunnelSchemas[tunnel]} values={tunnelParams} onChange={(k, v) => setTunnelParams((prev) => ({ ...prev, [k]: v }))} t={t} />
          </div>
        )}
        {/* auth provider 参数(schema 驱动) */}
        {auth && auth !== "none" && authSchemas?.[auth] && authSchemas[auth].length > 0 && (
          <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }}>{t("services.authParams")}</div>
            <SchemaForm specs={authSchemas[auth]} values={providerParams} onChange={(k, v) => setProviderParams((prev) => ({ ...prev, [k]: v }))} t={t} />
          </div>
        )}
        {/* M3 对齐：portmap 模式——路由器映射参数 + 探测路由器（与 Ports 页同款） */}
        {mode === "portmap" && (
          <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600, marginBottom: 4 }}>{t("ui.portmap.title")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <label style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {t("ui.portmap.method")}
                <select value={pmParams.method} onChange={(e) => setPmParams({ ...pmParams, method: e.target.value })} style={{ ...select, display: "block", marginTop: 2 }}>
                  <option value="auto">auto</option><option value="upnp">UPnP</option><option value="pcp">NAT-PMP/PCP</option><option value="ssh-router">ssh-router</option>
                </select>
              </label>
              <label style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {t("ui.portmap.gateway")}
                <input value={pmParams.gateway} onChange={(e) => setPmParams({ ...pmParams, gateway: e.target.value })} placeholder="192.168.1.1"
                  style={{ ...select, display: "block", marginTop: 2, width: 120, background: "var(--bg)", color: "var(--text)" }} />
              </label>
              <label style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {t("ui.portmap.externalPort")}
                <input value={pmParams.externalPort} onChange={(e) => setPmParams({ ...pmParams, externalPort: e.target.value.replace(/\D/g, "") })} placeholder={t("ui.portmap.autoAssign")}
                  style={{ ...select, display: "block", marginTop: 2, width: 80, background: "var(--bg)", color: "var(--text)" }} />
              </label>
              <label style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {t("ui.portmap.leaseSeconds")}
                <input value={pmParams.leaseSeconds} onChange={(e) => setPmParams({ ...pmParams, leaseSeconds: e.target.value.replace(/\D/g, "") })} placeholder="1800"
                  style={{ ...select, display: "block", marginTop: 2, width: 80, background: "var(--bg)", color: "var(--text)" }} />
              </label>
              <button
                disabled={probing}
                onClick={() => {
                  setProbing(true); setProbeHint(t("ui.portmap.probing"));
                  const gw = pmParams.gateway.trim();
                  fetch(apiUrl(`/api/extensions/service-tunnels/portmap-probe${gw ? `?gateway=${encodeURIComponent(gw)}` : ""}`))
                    .then((r) => r.json())
                    .then((d: { ipClass?: string; upnp?: { ok?: boolean }; pcp?: { ok?: boolean }; error?: string }) => {
                      if (d.error) { setProbeHint(t("ui.portmap.probeFail", { error: d.error })); return; }
                      setProbeHint(t(portmapProbeView(d).key));
                    })
                    .catch((e) => setProbeHint(t("ui.portmap.probeFail", { error: String(e) })))
                    .finally(() => setProbing(false));
                }}
                style={{ ...select, alignSelf: "flex-end", padding: "4px 12px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", cursor: probing ? "default" : "pointer" }}>
                {probing ? "…" : t("ui.portmap.probe")}
              </button>
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
              {probeHint ?? t("ui.portmap.hint")}
            </div>
          </div>
        )}
        {/* M3 对齐：ipv6 模式——候选地址下拉（懒加载；auto/候选含出口标注/手动输入） */}
        {mode === "ipv6" && (
          <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600, marginBottom: 4 }}>
              {t("ui.ports.ipv6Address")} <span style={{ fontWeight: 400 }}>({t("ui.ports.ipv6Optional")})</span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select value={ipv6Addr} onChange={(e) => {
                setIpv6Addr(e.target.value);
                if (e.target.value !== "auto" && ipv6Cands === null) {
                  fetch(apiUrl("/api/extensions/service-tunnels/ipv6-addresses"))
                    .then((r) => r.json())
                    .then((d: { addresses?: Array<{ address: string; scope: string; iface: string }>; public?: string[] }) => {
                      setIpv6Cands(d.addresses ?? []);
                      setIpv6Public(d.public ?? []);
                    })
                    .catch(() => { setIpv6Cands([]); setIpv6Public([]); });
                }
              }} style={{ ...select, minWidth: 220 }}>
                <option value="auto">{t("ui.ipv6.auto")}</option>
                {(ipv6Cands ?? []).filter((a) => a.scope === "global").map((a) => (
                  <option key={a.address} value={a.address}>{`[${a.address}] (${a.iface}${ipv6Public.includes(a.address) ? `, ${t("ui.ipv6.public")}` : ""})`}</option>
                ))}
                {(ipv6Cands ?? []).filter((a) => a.scope !== "global").map((a) => (
                  <option key={a.address} value={a.address}>{`[${a.address}] (${a.iface}, ${a.scope})`}</option>
                ))}
                <option value="__manual">{t("ui.ipv6.manual")}</option>
              </select>
              {ipv6Addr === "__manual" && (
                <input value={ipv6Manual} onChange={(e) => setIpv6Manual(e.target.value)} placeholder="2001:db8::1"
                  style={{ ...select, flex: 1, minWidth: 160, background: "var(--bg)", color: "var(--text)" }} />
              )}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>{t("ui.ports.ipv6Hint")}</div>
          </div>
        )}
        {err && <div style={{ fontSize: 12, color: "var(--danger, #f87171)", marginTop: 8 }}>{err}</div>}
      </div>


      {/* allowlocal — 放暴露控制下方（selfExposeHint 提示“直连 127/局域网由下方 allowlocal 开关控制”） */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }} title={t("services.selfAllowLocalHint")}>
        <input
          type="checkbox"
          checked={allowLocal}
          onChange={(e) => toggleAllowLocal(e.target.checked)}
          style={{ accentColor: "var(--accent)", cursor: "pointer", marginTop: 2 }}
        />
        <span style={{ fontSize: 12, color: "var(--text)" }}>
          <b>{t("services.selfAllowLocal")}</b>
          <span style={{ display: "block", color: "var(--text-dim)", fontSize: 11, marginTop: 2 }}>{t("services.selfAllowLocalHint")}</span>
          {!exposing && !allowLocal && (
            <span style={{ display: "block", color: "#d97706", fontSize: 11, marginTop: 4 }}>⚠ {t("services.selfNotExposingHint")}</span>
          )}
        </span>
      </label>

      {/* allowHosts — operator-protected front domains kept reachable when allowlocal=false */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>
          {t("services.selfAllowHosts")}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{t("services.selfAllowHostsHint")}</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={allowHostsInput}
            onChange={(e) => { setAllowHostsInput(e.target.value); setAllowHostsTouched(true); }}
            placeholder="backup.example.com vpn.example.com"
            style={{ flex: 1, padding: "4px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }}
          />
          <button onClick={saveAllowHosts} style={{ ...btn, flexShrink: 0 }}>{t("services.selfAllowHostsSave")}</button>
        </div>
        {(self?.allowHosts ?? []).length > 0 && (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
            {t("services.selfAllowHostsCurrent")}: <span style={{ fontFamily: "var(--font-mono)" }}>{self!.allowHosts.join(", ")}</span>
          </div>
        )}
      </div>

      {/* env snippet */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>{t("services.selfEnvHint")}</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <code style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, padding: "5px 8px", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{envSnippet}</code>
          <button onClick={copyEnv} style={{ ...btn, flexShrink: 0 }}>{copiedEnv ? "✓" : t("services.copy")}</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>{t("services.selfEnvNote")}</div>
      </div>

      {/* 两阶段关闭确认窗:已临时关闭,30s 内二次确认才永久;超时自动恢复 */}
      {confirmCountdown !== null && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 520, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--danger, #f87171)", marginBottom: 8 }}>⚠ {t("services.lockoutTitle", { ttl: String(TTL_MS / 1000) })}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>
              {t("services.lockoutCountdown", { window: String(CONFIRM_WINDOW), ttl: String(TTL_MS / 1000) })}
            </div>
            {/* 倒计时 + 进度条 */}
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: confirmCountdown <= 10 ? "var(--danger, #f87171)" : "var(--text)", fontVariantNumeric: "tabular-nums", minWidth: 40 }}>{confirmCountdown}s</span>
                <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--bg-hover)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(confirmCountdown / CONFIRM_WINDOW) * 100}%`, background: confirmCountdown <= 10 ? "var(--danger, #f87171)" : "var(--accent)", transition: "width 1s linear" }} />
                </div>
              </div>
              <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.lockoutAutoRestore")}</div>
            </div>
            {blockedHint && (
              <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 6, background: "rgba(217,119,6,0.1)", border: "1px solid rgba(217,119,6,0.35)", fontSize: 11, color: "#d97706" }}>
                {t("services.lockoutBlockedHint", { ttl: String(TTL_MS / 1000) })}
              </div>
            )}
            {/* 仍可用入口:可点开验证 */}
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>{t("services.lockoutStillWorks")}</div>
              {authEntries.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 6 }}>
                  {authEntries.map((u) => (
                    <div key={u.url} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                      <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{u.labelKey ? t(u.labelKey, u.labelParams) : u.label}</span>
                      <span style={{ flex: 1, fontFamily: "var(--font-mono)", overflowWrap: "anywhere", color: "var(--text)" }}>{u.url}</span>
                      <button onClick={() => openInNewTab(u.url)} style={{ ...btn, padding: "3px 10px", flexShrink: 0, color: "var(--accent)" }}>
                        {t("services.lockoutVerify")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button onClick={restoreNow} style={{ ...btn, flexShrink: 0 }}>{t("services.lockoutRestore")}</button>
              <span style={{ flex: 1 }} />
              <button
                onClick={confirmDisableNow}
                style={{ ...btn, background: "var(--danger, #f87171)", border: "none", color: "#fff", fontWeight: 600 }}
              >
                {t("services.lockoutConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 无可访问入口:拒绝关闭的弹窗提示 */}
      {rejectDialog && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setRejectDialog(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ position: "relative", width: 460, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
            <button onClick={() => setRejectDialog(false)} aria-label={t("services.close")} title={t("services.close")}
              style={{ position: "absolute", top: 8, right: 8, background: "none", border: "none", color: "var(--text-muted, #aaa)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--danger, #f87171)", marginBottom: 8 }}>⚠ {t("services.lockoutNoEntryTitle")}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>{t("services.lockoutNoEntry")}</div>
          </div>
        </div>
      )}
      {restoredNotice && (
        <div style={{ marginTop: 6, padding: "6px 10px", borderRadius: 6, background: "rgba(22,163,74,0.1)", border: "1px solid rgba(22,163,74,0.35)", fontSize: 11, color: "#16a34a" }}>
          ✓ {t("services.lockoutRestored")}
        </div>
      )}
      {confirmNone && (
        <ConfirmDialog
          title={t("services.confirmNoAuthTitle")}
          body={t("services.confirmNoAuthBodySelf")}
          confirmLabel={t("services.exposeConfirm")}
          cancelLabel={t("services.exposeAbort")}
          onConfirm={() => { setConfirmNone(false); doExpose(); }}
          onCancel={() => setConfirmNone(false)}
        />
      )}
      {noUsers && (
        <ConfirmDialog
          title={t("services.confirmNoUsersTitle")}
          body={t("services.confirmNoUsersBody", { provider: noUsers.provider, site: noUsers.site })}
          confirmLabel={t("services.confirmNoUsersGo")}
          cancelLabel={t("services.exposeAbort")}
          onConfirm={() => { setNoUsers(null); onGoManageUsers(); }}
          onCancel={() => setNoUsers(null)}
        />
      )}
      {userConfirm && (
        <ConfirmDialog
          title={t("services.confirmUsersTitle")}
          body={
            <div>
              <div style={{ fontSize: 11, lineHeight: 1.7 }}>{t("services.confirmUsersBody", { provider: userConfirm.provider, site: userConfirm.site })}</div>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text)" }}>
                {userConfirm.users.map((u) => <li key={u}>{u}</li>)}
              </ul>
            </div>
          }
          confirmLabel={t("services.confirmUsersConfirm")}
          cancelLabel={t("services.exposeAbort")}
          onConfirm={() => { setUserConfirm(null); doExpose(); }}
          onCancel={() => setUserConfirm(null)}
        />
      )}
    </div>
  );
}

