/**
 * tabs/PortsTab — 服务端口 tab（M2 拆壳）：
 *   - PortsTab：壳层 ports tab 体（自 ServicesDialog.tsx 原位迁出；props 接线）
 *   - AuthExposeSection：暴露表单（原位迁出）+ P3a portmap/ipv6 扩展
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { useI18n, useIsMobile, apiUrl, BASE_PATH } from "../host-shim";
import { UrlRow, SchemaForm, ConfirmDialog, providerDisplayLabel } from "../dialog/shared";
import { identityView, modeOf, ddnsBadge, portmapProbeView } from "../lib-shared";
import type { ExposeInfo, SelfState, ServicesResponse } from "../dialog/types";

const formatAddrForUrl = (addr: string): string => (addr.includes(":") ? `[${addr}]` : addr);

/** 端口 tab 体：props 与原壳层闭包一一对应（标识符不变，行为零差异）。 */
export function PortsTab({
  t, isMobile, data, self, error, loading,
  allowDownload, setAllowDownload,
  expanded, toggleExpand,
  copy, copiedKey, openInNewTab,
  stopExpose, setDetailFor,
  logsFor, setLogsFor, logsData, setLogsData, logsLoading, setLogsLoading,
  injectEntries, toggleInject,
  suffixes, currentDomainSuffix,
  scheme, pagePort,
  injectSources, caps,
  onGoManageUsers, refresh,
}: {
  t: (key: string, params?: Record<string, string>) => string;
  isMobile: boolean;
  data: ServicesResponse | null;
  self: SelfState | null;
  error: string | null;
  loading: boolean;
  allowDownload: boolean | null;
  setAllowDownload: (v: boolean) => void;
  expanded: ReadonlySet<number>;
  toggleExpand: (port: number) => void;
  copy: (key: string, url: string) => void;
  copiedKey: string | null;
  openInNewTab: (url: string) => void;
  stopExpose: (name: string) => void;
  setDetailFor: (ex: ExposeInfo | null) => void;
  logsFor: string | null;
  setLogsFor: (v: string | null) => void;
  logsData: { access: string; error: string } | null;
  setLogsData: (v: { access: string; error: string } | null) => void;
  logsLoading: boolean;
  setLogsLoading: (v: boolean) => void;
  injectEntries: Array<{ port: number; basePath?: string }> | null;
  toggleInject: (port: number, on: boolean, basePath?: string) => void;
  suffixes: string[];
  currentDomainSuffix: string | null;
  scheme: string;
  pagePort: string;
  injectSources: Array<{ id: string; label: string; description?: string; enabled?: boolean }>;
  caps: { portIdentity: boolean; exposeModes: string[] } | null;
  onGoManageUsers: () => void;
  refresh: (force?: boolean) => void;
}) {
  const directUrl = (port: number, addr: string) => `http://${formatAddrForUrl(addr)}:${port}/`;
  // 外部登记端口：点击展开 → 按需 detect（进程发现 + HTTP 识别）
  const [extExpanded, setExtExpanded] = useState<ReadonlySet<number>>(new Set());
  const [extDetect, setExtDetect] = useState<Record<number, { loading: boolean; data: { service?: { pid?: number; process?: string; cmdline?: string; addresses?: string[] } | null; identity?: Record<string, unknown> | null } | null }>>({});
  const detectExt = (port: number) => {
    setExtDetect((m) => ({ ...m, [port]: { loading: true, data: m[port]?.data ?? null } }));
    fetch(apiUrl(`/api/extensions/service-tunnels/detect?port=${port}`))
      .then((r) => r.json())
      .then((d: { service?: { pid?: number; process?: string; cmdline?: string; addresses?: string[] } | null; identity?: Record<string, unknown> | null }) => {
        setExtDetect((m) => ({ ...m, [port]: { loading: false, data: d } }));
      })
      .catch(() => setExtDetect((m) => ({ ...m, [port]: { loading: false, data: null } })));
  };
  const toggleExt = (port: number) => {
    setExtExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(port)) next.delete(port);
      else next.add(port);
      return next;
    });
    // 首次展开即探测（已有数据/进行中则复用；显式「重新检测」按钮才强制）
    if (!extDetect[port]) detectExt(port);
  };
  // 手动新增外部端口（登记 = PATCH /enroll，与 vhost 代理/注入同一条链路）
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState("");
  const submitAdd = () => {
    const port = Number(addDraft.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    if ((data?.services ?? []).some((s) => s.port === port)) { setAddOpen(false); setAddDraft(""); return; }
    toggleInject(port, true);
    setAddOpen(false);
    setAddDraft("");
  };
  // P2 重命名：✎ → 行内输入 → POST port-label（留空清除）
  const [renameFor, setRenameFor] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const saveRename = (port: number) => {
    const label = renameDraft.trim();
    fetch(apiUrl("/api/extensions/service-tunnels/port-label"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port, label }),
    })
      .then(() => { setRenameFor(null); refresh(false); })
      .catch(() => {});
  };
  return (
          <>
            {/* Safety toggle — allow on-demand tool downloads */}
        {allowDownload !== null && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 18px", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text)", cursor: "pointer", flexShrink: 0 }} title={t("services.allowToolDownloadHint")}>
            <input
              type="checkbox"
              checked={allowDownload}
              onChange={(e) => {
                const next = e.target.checked;
                setAllowDownload(next);
                fetch(apiUrl("/api/extensions/service-tunnels/status"), {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "set-allow-tool-download", allowDownload: next }),
                }).catch(() => setAllowDownload(!next));
              }}
              style={{ accentColor: "var(--accent)", cursor: "pointer" }}
            />
            <span>{t("services.allowToolDownload")}</span>
            {(data?.toolStatus ?? []).filter((x) => x.source === null).length > 0 && (
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                ({t("services.toolsMissing")}: {(data?.toolStatus ?? []).filter((x) => x.source === null).map((x) => x.name).join(", ")})
              </span>
            )}
          </label>
        )}

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
          {(data?.exposes ?? []).some((e) => e.running) && (
            <div style={{ padding: "8px 10px", border: "1px solid var(--accent)", borderRadius: 8, background: "var(--bg-panel)", marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>{t("services.activeExposes")}</div>
              {(data?.exposes ?? []).filter((e) => e.running).map((ex) => {
                const primaryUrl = [ex.url, ex.localUrl, ex.baseUrl, ex.domainUrl].find((x): x is string => Boolean(x)) ?? "";
                return (
                <div key={ex.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", flexWrap: "wrap", fontSize: 11 }}>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", flexShrink: 0 }}>127.0.0.1:{ex.port}</span>
                  <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-muted)", flexShrink: 0 }}>{modeOf(ex) || "?"}</span>
                  <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-dim)", flexShrink: 0 }}>{ex.protocol ?? "http"}</span>
                  {ex.provider ? (
                    <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-muted)", flexShrink: 0 }}>auth: {ex.provider}</span>
                  ) : (
                    /* auth=none → 无认证告警,标红 */
                    <span title={t("services.noAuthWarnHint")}
                      style={{ padding: "1px 7px", background: "rgba(248,113,113,0.15)", border: "1px solid rgba(248,113,113,0.45)", borderRadius: 4, color: "#f87171", fontWeight: 600, flexShrink: 0 }}>
                      ⚠ {t("services.exposeProviderNone")}
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: ex.running ? "#16a34a" : "var(--text-dim)", flexShrink: 0 }}>{ex.running ? t("services.tunnelRunning") : t("services.tunnelStopped")}</span>
                  {/* 点击不直接打开页面 → 弹详情(来源详情 + 停止),链接在弹窗内才新窗口打开 */}
                  <button onClick={() => setDetailFor(ex)} title={t("services.exposeDetailHint")}
                    style={{ flex: 1, minWidth: 120, textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {primaryUrl || t("services.exposeDetail")} ›
                  </button>
                  {/* 列表页直接停止(tunnel 停隧道进程 / proxy 移除 binding+记录) */}
                  <button onClick={() => stopExpose(ex.name)} title={t("services.exposeStopHint")}
                    style={{ flexShrink: 0, padding: "3px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "#f87171", cursor: "pointer", fontSize: 11 }}>
                    {t("services.exposeStop")}
                  </button>
                  {ex.accessLog && (
                    <button onClick={() => { setLogsFor(logsFor === ex.name ? null : ex.name); if (logsFor !== ex.name) { setLogsLoading(true); fetch(apiUrl(`/api/extensions/service-tunnels/status?logs=${encodeURIComponent(ex.name)}`)).then((r) => r.json()).then((d: { access?: string; error?: string }) => { setLogsData({ access: d.access ?? "", error: d.error ?? "" }); setLogsLoading(false); }).catch(() => { setLogsLoading(false); setLogsData({ access: "(failed to read logs)", error: "" }); }); } }} style={{ flexShrink: 0, padding: "3px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>{logsFor === ex.name ? t("services.exposeLogsHide") : t("services.exposeLogs")}</button>
                  )}
                </div>
                );
              })}
              {logsFor && logsData && (
                <div style={{ marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>access log{logsLoading ? " …" : ""}</div>
                  <pre style={{ maxHeight: 120, overflow: "auto", margin: 0, padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, fontSize: 9, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text)" }}>{logsData.access || "(empty)"}</pre>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", margin: "6px 0 4px" }}>error log</div>
                  <pre style={{ maxHeight: 120, overflow: "auto", margin: 0, padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, fontSize: 9, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#f87171" }}>{logsData.error || "(empty)"}</pre>
                </div>
              )}
            </div>
          )}
          {error ? (
            <div style={{ fontSize: 13, color: "#f87171", padding: 12 }}>{error}</div>
          ) : loading && !data ? (
            <div style={{ fontSize: 13, color: "var(--text-dim)", padding: 12 }}>{t("services.loading")}</div>
          ) : !data || (data.services ?? []).length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-dim)", padding: 20, textAlign: "center" }}>
              {t("services.none")}
            </div>
          ) : (
            (data.services ?? []).map((s) => {
              const isOpen = expanded.has(s.port);
              const directUrls = s.addresses.map((addr) => ({ addr, url: directUrl(s.port, addr) }));
              // REAL proxy addresses from service-tunnels exposes (mode
              // proxy/both) — the old default "port.basehost" display is gone.
              const proxyExposes = (data?.exposes ?? []).filter((e) => e.port === s.port && (e.localUrl || e.baseUrl || e.domainUrl));
              // 每条暴露链接挂上它所属的 expose —— 点击不直接打开页面,
              // 而是弹该通道的详情(mode/auth/隧道/参数/开启时间/停止)。
              const proxyUrls = proxyExposes.flatMap((e) => [
                ...(e.localUrl ? [{ url: e.localUrl, label: e.site && e.site !== "default" ? e.site : t("services.proxyLocal"), ex: e }] : []),
                ...(e.baseUrl ? [{ url: e.baseUrl, label: t("services.proxyDomain"), ex: e }] : []),
                ...(e.domainUrl ? [{ url: e.domainUrl, label: t("services.proxyDomain"), ex: e }] : []),
                // 回环域名 vhost（*.localhost:真实pi-web端口）
                ...(e.altUrls ?? []).map((url) => ({ url, label: t("services.proxyLocalDomain"), ex: e })),
              ]);
              // Deployment entry: <port>.<page-domain><basePath> — served by
              // pi-web's own virtual-host proxy (deployment domain from
              // PI_WEB_BASE_DOMAIN / page host + PI_WEB_BASE_PATH), only for
              // actually-exposed ports.
              if (proxyExposes.length > 0 && currentDomainSuffix && !currentDomainSuffix.startsWith(".localhost") && currentDomainSuffix !== ".pi.localhost") {
                proxyUrls.push({ url: `${scheme}//${s.port}${currentDomainSuffix}${pagePort}${BASE_PATH}`, label: t("services.proxyDeploy"), ex: proxyExposes[0] });
              }
              // 按 URL 去重（保留后一个）：expose 的 baseUrl 规范化 scheme 后与部署域推断
              // URL 完全相同 → UrlRow key 冲突（React 同 key 告警 + 潜在状态错乱）。
              // 从后向前遍历，后 push 的（部署域推断条目）优先保留。
              const seenUrls = new Set<string>();
              for (let ui = proxyUrls.length - 1; ui >= 0; ui--) {
                const pu = proxyUrls[ui]!;
                if (seenUrls.has(pu.url)) { proxyUrls.splice(ui, 1); continue; }
                seenUrls.add(pu.url);
              }
              const primaryUrl = proxyUrls[0]?.url ?? directUrls[0]?.url ?? "";
              return (
                <div key={s.port} id={`port-card-${s.port}`} style={{ marginBottom: 6, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {/* Collapsed row — click to expand */}
                  <div
                    onClick={() => toggleExpand(s.port)}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(s.port); } }}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", cursor: "pointer", background: isOpen ? "var(--bg-panel)" : "none" }}
                    onMouseEnter={(e) => { if (!isOpen) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { if (!isOpen) e.currentTarget.style.background = "none"; }}
                  >
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--accent)", minWidth: 52 }}>{s.port}</span>
                    {(() => {
                      // P2 服务识别主行：label > title（identityView 单源规则）+ favicon + tooltip；
                      // 无能力/无数据 → 回落 cmdline（旧行为）。
                      if (!caps?.portIdentity) return null;
                      const idv = identityView(s.identity);
                      const tooltip = [idv.detected ? `${t("ui.ports.detected")}: ${idv.detected}` : null, idv.tooltip].filter(Boolean).join(" · ");
                      const main = idv.title ?? s.cmdline ?? s.process ?? `pid ${s.pid}`;
                      return (
                        <>
                          {idv.icon && <img src={idv.icon} alt="" loading="lazy" title={tooltip || undefined}
                            style={{ width: 18, height: 18, borderRadius: 4, objectFit: "contain", background: "var(--bg-hover)", flexShrink: 0 }}
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div title={tooltip || undefined} style={{ fontSize: 12, fontWeight: idv.hasLabel ? 600 : 400, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {main}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {t("services.listenOn")} {s.addresses.join(", ")} · pid {s.pid}
                            </div>
                          </div>
                        </>
                      );
                    })()}
                    {(!caps?.portIdentity || !identityView(s.identity).title) && (
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {s.cmdline || s.process || `pid ${s.pid}`}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t("services.listenOn")} {s.addresses.join(", ")} · pid {s.pid}
                        </div>
                      </div>
                    )}
                    {caps?.portIdentity && (
                      <button onClick={(e) => { e.stopPropagation(); setRenameFor(renameFor === s.port ? null : s.port); setRenameDraft(s.identity?.label ?? ""); }}
                        title={t("ui.ports.rename")}
                        style={{ flexShrink: 0, padding: "2px 7px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-dim)", cursor: "pointer", fontSize: 11 }}>✎</button>
                    )}
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      style={{ flexShrink: 0, color: "var(--text-dim)", transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>

                  {renameFor === s.port && (
                    <div style={{ borderTop: "1px solid var(--border)", padding: "8px 10px", background: "var(--bg-panel)", display: "flex", gap: 6, alignItems: "center" }}>
                      <input autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") saveRename(s.port); if (e.key === "Escape") setRenameFor(null); }}
                        placeholder={t("ui.ports.renamePrompt")}
                        style={{ flex: 1, minWidth: 0, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12 }} />
                      <button onClick={() => { setRenameDraft(""); saveRename(s.port); }} title={t("ui.ports.renameHint")}
                        style={{ flexShrink: 0, padding: "4px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "#f87171", cursor: "pointer", fontSize: 11 }}>{t("ui.ports.renameClear")}</button>
                      <button onClick={() => saveRename(s.port)}
                        style={{ flexShrink: 0, padding: "4px 12px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("ui.ports.renameSave")}</button>
                    </div>
                  )}
                  {/* Expanded area — access methods */}
                  {isOpen && (
                    <div style={{ borderTop: "1px solid var(--border)", padding: "10px 12px", background: "var(--bg-panel)" }}>
                      {directUrls.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "4px 0 6px" }}>{t("services.direct")}</div>
                          {directUrls.map(({ addr, url }) => (
                            <UrlRow key={url} url={url} label={addr === "127.0.0.1" || addr === "::1" ? "localhost" : addr}
                              isMobile={isMobile}
                              copied={copiedKey === url} onCopy={() => copy(url, url)} onOpen={() => openInNewTab(url)} />
                          ))}
                        </>
                      )}
                      {proxyUrls.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "10px 0 6px" }}>{t("services.viaProxy")}</div>
                          {proxyUrls.map(({ url, label, ex }) => (
                            <UrlRow key={url} url={url}
                              isMobile={isMobile}
                              label={label}
                              copied={copiedKey === url} onCopy={() => copy(url, url)} onOpen={() => setDetailFor(ex)} />
                          ))}
                        </>
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                        <button
                          onClick={() => (proxyUrls[0]?.ex ? setDetailFor(proxyUrls[0].ex) : openInNewTab(primaryUrl))}
                          style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, flexShrink: 0 }}
                        >
                          {t("services.open")}
                        </button>
                        <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{primaryUrl}</span>
                      </div>
                      <AuthExposeSection port={s.port} t={t} openInNewTab={openInNewTab}
                        exposes={(data?.exposes ?? []).filter((e) => e.port === s.port)}
                        serviceBasePath={injectEntries?.find((e) => e.port === s.port)?.basePath}
                        onSetBasePath={(p, bp) => toggleInject(p, true, bp)}
                        injectSources={injectSources}
                        caps={caps}
                        onStopExpose={stopExpose}
                        onChanged={() => refresh(false)}
                        onGoManageUsers={onGoManageUsers} />
                      {/* BasePath：公开的端口转发属性（与注入无关） */}
                      {/* 注入 JS（AITI 调试器）——proxy 模式已生效；tunnel 模式由 service-tunnels 开发中 */}
                    </div>
                  )}
                </div>
              );
            })
          )}
          {/* 已登记的外部端口以普通卡片形式混入列表（进程扫描看不到，但 vhost
              代理确实在暴露），加 icon 标记外部 + 取消登记入口；点击展开按需
              detect（进程发现 + HTTP title/favicon 识别），与常规卡片同信息量。 */}
          {(injectEntries ?? []).filter((e) => !(data?.services ?? []).some((s) => s.port === e.port) && e.port !== self?.port).map((e) => {
            const vhostUrl = currentDomainSuffix
              ? `${scheme}//${e.port}${currentDomainSuffix}${pagePort}${e.basePath ?? BASE_PATH}`
              : `http://${e.port}${suffixes[0] ?? ".pi.localhost"}${e.basePath ?? ""}`;
            const isExtOpen = extExpanded.has(e.port);
            const det = extDetect[e.port];
            const idv = det?.data?.identity ? identityView(det.data.identity as Parameters<typeof identityView>[0]) : null;
            const svc = det?.data?.service ?? null;
            const extMain = idv?.title ?? svc?.cmdline ?? svc?.process ?? (svc?.pid !== undefined ? `pid ${svc.pid}` : null);
            const extTooltip = [idv?.detected ? `${t("ui.ports.detected")}: ${idv.detected}` : null, idv?.tooltip].filter(Boolean).join(" · ") || undefined;
            return (
              <div key={`ext-${e.port}`} style={{ marginBottom: 6, border: "1px dashed var(--border)", borderRadius: 8, overflow: "hidden" }}>
                <div
                  onClick={() => toggleExt(e.port)}
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExtOpen}
                  onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleExt(e.port); } }}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", cursor: "pointer", background: isExtOpen ? "var(--bg-panel)" : "none" }}
                >
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--accent)", minWidth: 52, flexShrink: 0 }}>{e.port}</span>
                  {idv?.icon && <img src={idv.icon} alt="" loading="lazy" title={extTooltip}
                    style={{ width: 18, height: 18, borderRadius: 4, objectFit: "contain", background: "var(--bg-hover)", flexShrink: 0 }}
                    onError={(ev) => { (ev.target as HTMLImageElement).style.display = "none"; }} />}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div title={extTooltip} style={{ fontSize: 12, fontWeight: idv?.hasLabel ? 600 : 400, color: "var(--text)", display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {extMain ?? <span title={t("services.enrolledExtHint")} style={{ padding: "0 5px", background: "var(--bg-hover)", borderRadius: 4, fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>🔌 {t("services.enrolledExtNotTree")}</span>}
                      </span>
                      {e.basePath && <span title={t("services.enrolledBasePathHint")} style={{ padding: "0 5px", background: "var(--bg-hover)", borderRadius: 4, fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>base {e.basePath}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {det?.loading ? `${t("services.extDetecting")}` : (extMain
                        ? [
                            svc?.addresses?.length ? `${t("services.listenOn")} ${svc.addresses.join(", ")}` : null,
                            svc?.pid !== undefined ? `pid ${svc.pid}` : null,
                            det?.data?.identity ? (det.data.identity as { protocol?: string }).protocol || null : null,
                          ].filter(Boolean).join(" · ") || vhostUrl
                        : vhostUrl)}
                    </div>
                  </div>
                  <button onClick={(ev) => { ev.stopPropagation(); detectExt(e.port); }} disabled={det?.loading} title={t("services.extDetectHint")}
                    style={{ flexShrink: 0, padding: "3px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-dim)", cursor: det?.loading ? "default" : "pointer", fontSize: 11 }}>
                    {det?.loading ? "…" : det?.data ? t("services.extDetectRedo") : t("services.extDetect")}
                  </button>
                  <button onClick={(ev) => { ev.stopPropagation(); openInNewTab(vhostUrl); }} title={vhostUrl} style={{ flexShrink: 0, padding: "4px 12px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("services.open")}</button>
                  <button onClick={(ev) => { ev.stopPropagation(); toggleInject(e.port, false); }} title={t("services.enrolledUnenrollHint")}
                    style={{ flexShrink: 0, padding: "4px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "#f87171", cursor: "pointer", fontSize: 11 }}>
                    {t("services.enrolledUnenroll")}
                  </button>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    style={{ flexShrink: 0, color: "var(--text-dim)", transform: isExtOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </div>
                {isExtOpen && (
                  <div style={{ borderTop: "1px dashed var(--border)", padding: "8px 12px", background: "var(--bg-panel)", fontSize: 11, color: "var(--text-dim)" }}>
                    {det?.loading ? (
                      <span>⏳ {t("services.extDetecting")}</span>
                    ) : !det?.data || (!extMain && !det.data.identity) ? (
                      <span>{t("services.extDetectNone")}</span>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {extMain && <div style={{ color: "var(--text)" }}>{extMain}</div>}
                        {(det.data.identity as { status?: number; server?: string; contentType?: string }).status !== undefined && (
                          <div>HTTP {(det.data.identity as { status?: number }).status}{(det.data.identity as { server?: string }).server ? ` · ${(det.data.identity as { server?: string }).server}` : ""}{(det.data.identity as { contentType?: string }).contentType ? ` · ${(det.data.identity as { contentType?: string }).contentType}` : ""}</div>
                        )}
                        {svc?.cmdline && extMain !== svc.cmdline && <div style={{ fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{svc.cmdline}</div>}
                        {svc?.addresses?.length ? <div>{t("services.listenOn")} {svc.addresses.join(", ")}</div> : null}
                      </div>
                    )}
                    {/* 检测到监听地址 → 直连入口（与常规卡一致） */}
                    {(svc?.addresses ?? []).length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "4px 0 6px" }}>{t("services.direct")}</div>
                        {svc!.addresses!.map((addr) => {
                          const url = directUrl(e.port, addr);
                          return (
                            <UrlRow key={url} url={url} label={addr === "127.0.0.1" || addr === "::1" ? "localhost" : addr}
                              isMobile={isMobile}
                              copied={copiedKey === url} onCopy={() => copy(url, url)} onOpen={() => openInNewTab(url)} />
                          );
                        })}
                      </div>
                    )}
                    {/* 常规 expose 表单（模式/隧道/协议/认证/方案）——外部端口与自发现端口同一套 */}
                    <AuthExposeSection port={e.port} t={t} openInNewTab={openInNewTab}
                      exposes={(data?.exposes ?? []).filter((ex) => ex.port === e.port)}
                      serviceBasePath={e.basePath}
                      onSetBasePath={(p, bp) => toggleInject(p, true, bp)}
                      injectSources={injectSources}
                      caps={caps}
                      onStopExpose={stopExpose}
                      onChanged={() => refresh(false)}
                      onGoManageUsers={onGoManageUsers} />
                  </div>
                )}
              </div>
            );
          })}
          {/* 新增外部端口：手动登记（vhost 代理 + 注入链路同 enroll） */}
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {!addOpen ? (
              <button onClick={() => setAddOpen(true)} title={t("services.extAddHint")}
                style={{ padding: "4px 12px", background: "none", border: "1px dashed var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
                ＋ {t("services.extAdd")}
              </button>
            ) : (
              <>
                <input autoFocus value={addDraft} onChange={(ev) => setAddDraft(ev.target.value.replace(/\D/g, ""))}
                  onKeyDown={(ev) => { if (ev.key === "Enter") submitAdd(); if (ev.key === "Escape") { setAddOpen(false); setAddDraft(""); } }}
                  placeholder={t("services.extAddPlaceholder")}
                  style={{ width: 110, padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }} />
                <button onClick={submitAdd} disabled={!addDraft.trim()}
                  style={{ padding: "4px 12px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{t("services.extAddConfirm")}</button>
                <button onClick={() => { setAddOpen(false); setAddDraft(""); }}
                  style={{ padding: "4px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>{t("services.exposeAbort")}</button>
              </>
            )}
          </div>
        </div>

        {/* Bottom: configured tunnels + info entries (open modals) */}
        <div style={{ padding: "8px 14px 10px", borderTop: "1px solid var(--border)", flexShrink: 0, background: "var(--bg-panel)", maxHeight: "34%", overflowY: "auto" }}>
                    <div style={{ display: "flex", gap: 16, padding: "4px 0", flexWrap: "wrap" }}>
            <button onClick={() => setInfoModal("access")}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)", fontSize: 11, textAlign: "left" }}>
              {t("services.infoAccess")} ›
            </button>
            <button onClick={() => setInfoModal("auth")}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)", fontSize: 11, textAlign: "left" }}>
              {(data?.exposes ?? []).length > 0 ? "⚠ " : "🔒 "}
              {t("services.infoAuth")} ›
            </button>
          </div>
        </div>
          </>
  );
}

/**
 * Public access with auth — pick a provider, optionally require sign-in,
 * and open the tunnel through the service-tunnels nginx gateway.
 */
export function AuthExposeSection({ port, t, openInNewTab, exposes, onStopExpose, onChanged, onGoManageUsers, serviceBasePath, onSetBasePath, injectSources, caps }: {
  port: number;
  t: (key: string, params?: Record<string, string>) => string;
  openInNewTab: (url: string) => void;
  /** This port's exposes (running or not) — decides the button state. */
  exposes: ExposeInfo[];
  /** Stop ONE expose by name (the currently-selected combo's channel). */
  onStopExpose: (name: string) => void;
  /** 端口通用属性 serviceBasePath：expose 时写入 open binding（跟端口走） */
  serviceBasePath?: string;
  /** 方案回填时同步端口的 Base Path（写入 inject-ports 登记，与手改 Base Path 行等效）。 */
  onSetBasePath?: (port: number, basePath: string) => void;
  /** 注入源清单（公开表单勾选用） */
  injectSources: Array<{ id: string; label: string; description?: string }>;
  /** P3a：capabilities（exposeModes 门控 portmap/ipv6 选项；缺省只三态）。 */
  caps?: { exposeModes: string[] } | null;
  /** Re-fetch exposes after a successful expose (so the button flips to stop). */
  onChanged: () => void;
  /** Switch to the Users tab (no users for the selected auth combo). */
  onGoManageUsers: () => void;
}) {
  // 多语:子组件独立拿 locale(与服务页一致,?lang= 与切换同步)
  const { locale: secLocale } = useI18n();
  const [provider, setProvider] = useState<string | null>(null);
  // Provider list arrives from the server (library-computed); empty until then.
  const [providers, setProviders] = useState<string[]>([]);
  const [tunnel, setTunnel] = useState("cloudflared");
  const [protocol, setProtocol] = useState<"http" | "https" | "tcp">("http");
  // P3a: mode 五态（portmap/ipv6 按 capabilities.exposeModes 门控显示）
  const [mode, setMode] = useState<"tunnel" | "proxy" | "both" | "portmap" | "ipv6">("tunnel");
  const [site, setSite] = useState("");
  const [sites, setSites] = useState<string[]>([]);
  const [tcpTunnels, setTcpTunnels] = useState<string[]>([]);
  const [tunnelSchemas, setTunnelSchemas] = useState<Record<string, ParamSpec[]> | null>(null);
  const [tunnelMetas, setTunnelMetas] = useState<Record<string, { favorite?: boolean; dangerous?: boolean }> | null>(null);
  const [authSchemas, setAuthSchemas] = useState<Record<string, ParamSpec[]> | null>(null);
  // provider 页面元数据(label/已配置)来自库——picker 显示友好名称用
  const [authMetas, setAuthMetas] = useState<Record<string, { label?: string }> | null>(null);
  const [tunnelParams, setTunnelParams] = useState<Record<string, string>>({});
  const [providerParams, setProviderParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string | null; loginUrl?: string; localUrl?: string; baseUrl?: string; domainUrl?: string; altUrls?: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // auth=none / tcp 裸隧道(无网关认证)→ 公开前需要泄露风险确认
  const [confirmNone, setConfirmNone] = useState(false);
  // 有本地用户库的 provider(portal/basic/authelia…)——公开前检查该组合是否有用户
  const [userManagers, setUserManagers] = useState<string[]>([]);
  // userManagers 清单是否已就绪(schema 拉取失败 → fail-closed,阻止直接公开)
  const [userManagersReady, setUserManagersReady] = useState(false);
  const [checking, setChecking] = useState(false);
  // 该 provider+site 无用户 → 提示去管理用户
  const [noUsers, setNoUsers] = useState<{ provider: string; site: string } | null>(null);
  // 有用户 → 列出用户名,让用户确认自己可登录
  const [userConfirm, setUserConfirm] = useState<{ provider: string; site: string; users: string[] } | null>(null);

  // ---- 公开方案（preset）+「上次使用」自动回填 ----
  const [presets, setPresets] = useState<Array<{ id: string; name: string; updatedAt: number }>>([]);
  const [lastUsedAt, setLastUsedAt] = useState<number | null>(null);
  const [presetId, setPresetId] = useState("__last__");
  const [presetName, setPresetName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  // 另存为：方案应用后自动执行的动作（一键启用调试）
  const [presetActions, setPresetActions] = useState<{ enroll?: boolean; expose?: boolean }>({ enroll: false, expose: false });
  // Base Path 表单字段草稿（并入公开表单：编辑后随公开提交 + 失焦/回车落盘 binding）
  const [bpDraft, setBpDraft] = useState<string | null>(null);
  // 注入源勾选（公开配置的一部分：本通道页面注入哪些源）——注入与端口/全局无关
  const [injectSel, setInjectSel] = useState<string[]>([]);
  // 登录信息按钮（库内置注入：FAB 显示登录用户名 + 退出登录，可拖动四边停靠）
  const [loginInfoButton, setLoginInfoButton] = useState(false);
  const [presetBusy, setPresetBusy] = useState(false);
  // 预填（上次使用/方案）后，端口协议探测不再覆盖表单——用户保存的选优先生效
  const prefilledRef = useRef(false);

  /** 把一份方案配置回填进表单。 */
  // P3a: portmap 参数与 ipv6 入口地址草稿
  const [pmParams, setPmParams] = useState<{ method: string; gateway: string; externalPort: string; leaseSeconds: string }>({ method: "auto", gateway: "", externalPort: "", leaseSeconds: "" });
  const [ipv6Addr, setIpv6Addr] = useState("auto");
  const [ipv6Manual, setIpv6Manual] = useState("");
  const [ipv6Cands, setIpv6Cands] = useState<Array<{ address: string; scope: string; iface: string }> | null>(null);
  const [ipv6Public, setIpv6Public] = useState<string[]>([]);
  const [probeHint, setProbeHint] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const modeAllowsTunnel = mode === "tunnel" || mode === "both";

  const applyPresetConfig = (cfg: {
    provider: string | null;
    tunnel: string;
    protocol: "http" | "https" | "tcp";
    mode: "tunnel" | "proxy" | "both" | "portmap" | "ipv6";
    site: string;
    serviceBasePath?: string;
    inject?: string[];
    loginInfoButton?: boolean;
    tunnelParams: Record<string, string>;
    providerParams: Record<string, string>;
  }) => {
    prefilledRef.current = true;
    setProvider(cfg.provider ?? "none");
    setInjectSel(Array.isArray(cfg.inject) ? cfg.inject.filter((s) => typeof s === "string") : []);
    setLoginInfoButton(cfg.loginInfoButton === true);
    setTunnel(cfg.tunnel || "cloudflared");
    setProtocol(cfg.protocol ?? "http");
    setMode(cfg.protocol === "tcp" ? "tunnel" : (cfg.mode ?? "tunnel"));
    setPmParams({ method: "auto", gateway: "", externalPort: "", leaseSeconds: "" });
    setIpv6Addr("auto"); setIpv6Manual("");
    setSite(cfg.site ?? "");
    setTunnelParams({ ...(cfg.tunnelParams ?? {}) });
    setProviderParams({ ...(cfg.providerParams ?? {}) });
    // Base Path 是端口属性（存 aiti 扩展 inject-ports 登记，不在本组件 state）——与当前值
    // 不同才写，避免每次回填都发一次 PUT。方案未存该字段（旧方案）则不动。
    if (cfg.serviceBasePath !== undefined && cfg.serviceBasePath !== (serviceBasePath ?? "")) {
      onSetBasePath?.(port, cfg.serviceBasePath);
    }
  };

  /** 拉取一份方案（id 或 "__last__"）解密回填；失败提示不阻断手填。 */
  const loadPresetIntoForm = (id: string) => {
    setPresetBusy(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-load", id }),
    })
      .then((r) => r.json())
      .then((d: { config?: Parameters<typeof applyPresetConfig>[0] & { actions?: { enroll?: boolean; expose?: boolean } }; error?: string }) => {
        if (d.error || !d.config) {
          if (id !== "__last__") setError(d.error ?? t("services.presetLoadFailed"));
          return;
        }
        setError(null);
        applyPresetConfig(d.config);
        // 一键动作（enroll/expose/开启注入源）——仅手动选择方案时执行；
        // 上次使用（__last__）是打开对话框的自动回填，不自动公开（避免误伤）。
        // 传整个 config：动作参数直接用方案值（表单 state 异步，闭包滞后）。
        if (id !== "__last__") applyPresetActions(d.config);
      })
      .catch(() => { if (id !== "__last__") setError(t("services.presetLoadFailed")); })
      .finally(() => setPresetBusy(false));
  };

  /** 执行方案的 actions：enroll 登记端口 → expose 立即公开 → inject 开启注入源。
   *  全部用方案 config 的参数（不经表单 state——setState 异步，闭包值滞后）。
   *  串行执行（enroll 先落盘 serviceBasePath，公开依赖它）。失败静默。 */
  const applyPresetActions = (cfg: Parameters<typeof applyPresetConfig>[0] & { actions?: { enroll?: boolean; expose?: boolean } }) => {
    const actions = cfg.actions;
    if (!actions) return;
    if (actions.enroll) {
      // 方案无 basePath → 只登记端口，保留现有 serviceBasePath（不清除）
      const body = { port, ...(cfg.serviceBasePath ? { basePath: cfg.serviceBasePath } : {}) };
      fetch(apiUrl("/api/extensions/service-tunnels/enroll"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    }
    if (actions.expose) {
      // 走完整安全链（go → confirmNone/checkUsers 确认弹窗）——方案一键公开
      // 不裸奔：auth=none 无认证确认、带认证检查用户库，与手动公开同保护。
      go({
        provider: cfg.provider ?? (cfg.protocol === "tcp" ? null : "none"),
        tunnel: cfg.tunnel || "cloudflared",
        protocol: cfg.protocol,
        mode: cfg.mode,
        site: cfg.site ?? "",
        tunnelParams: cfg.tunnelParams,
        providerParams: cfg.providerParams,
        ...(cfg.serviceBasePath ? { serviceBasePath: cfg.serviceBasePath } : {}),
      });
    }
  };

  // Tunnel types + provider params come from service-tunnels schemas
  // (data-driven — adding a tunnel type / auth provider needs NO dialog
  // changes). Provider order/default come from the library too.
  // Mount-once fetch: secLocale only selects the server-side response language;
  // re-fetching on language switch would reset the dialog mid-interaction.
  // status 与「上次使用」preset 并行拉（原先串行：status 完成后才发 preset 请求，
  // 打开对话框多等一个 RTT）。preset 请求在无记录时返回 error，静默忽略。
  useEffect(() => {
    setPresetBusy(true);
    const statusP = fetch(`${apiUrl("/api/extensions/service-tunnels/status")}?lang=${encodeURIComponent(secLocale)}`)
      .then((r) => r.json())
      .catch(() => null);
    const presetP = fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-load", id: "__last__" }),
    })
      .then((r) => r.json())
      .catch(() => null);
    Promise.all([statusP, presetP]).then(([d, presetD]) => {
      if (!d) return;
      {
        // providerOrder/defaultProvider come from the library — no provider
        // names hardcoded here (authelia availability, Windows fallback etc.
        // are decided in service-tunnels).
        const order = d.providerOrder ?? ["portal", "basic"];
        setProviders(["none", ...order]);
        const preferred = d.defaultProvider ?? order[0] ?? "portal";
        setProvider((cur) => (cur === null ? (order.includes(preferred) ? preferred : (order[0] ?? "portal")) : cur));
        if (d.tunnelSchemas) setTunnelSchemas(d.tunnelSchemas);
        if (d.tunnelMetas) setTunnelMetas(d.tunnelMetas);
        if (d.authProviderSchemas) setAuthSchemas(d.authProviderSchemas);
        if (d.authMetas) setAuthMetas(d.authMetas);
        // Skip dangerous tunnel types (TunnelMeta.dangerous — e.g. "command",
        // which runs a raw shell command) when picking a tcp-capable default;
        // name fallback covers service-tunnels versions without the flag.
        if (d.tunnelTcpSupport) setTcpTunnels(d.tunnelTcpSupport.filter((k) => !d.tunnelMetas?.[k]?.dangerous && k !== "command"));
        if (d.sites) setSites(d.sites.filter((s) => s.name !== "default").map((s) => s.name));
        if (d.userManagers) setUserManagers(d.userManagers);
        setUserManagersReady(true);
        // 方案清单 + 「上次使用」自动回填（省去每次重复选择；没有记录则保持默认）
        // presetD 是并行拉取的 __last__ 结果——直接应用（无需再发一次 preset 请求）
        if (d.exposePresets) {
          setPresets(d.exposePresets.presets ?? []);
          setLastUsedAt(d.exposePresets.lastUsedAt ?? null);
          if (d.exposePresets.lastUsedAt && presetD?.config) applyPresetConfig(presetD.config);
        }
      }
    }).finally(() => setPresetBusy(false));
  // Mount-once: secLocale only selects the server-side response language.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-detect the port's protocol (http/https/tcp) so the user sees it up
  // front and the tunnel options adjust (tcp → only tcp-capable tunnels).
  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    fetch(apiUrl(`/api/extensions/service-tunnels/status?detect=${port}`))
      .then((r) => r.json())
      .then((d: { protocol?: "http" | "https" | "tcp" }) => {
        // 预填过方案/上次使用 → 用户保存的选择优先，探测不覆盖
        if (!cancelled && d.protocol && !prefilledRef.current) setProtocol(d.protocol);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [port]);

  /** 公开（公开按钮 / 方案 actions.expose 共用）。overrides 由方案提供——
   *  直接传 config 参数，不依赖表单 state（setState 异步，闭包值滞后会按旧值公开）。 */
  const doExpose = (overrides?: Partial<{
    provider: string | null;
    tunnel: string;
    protocol: "http" | "https" | "tcp";
    mode: "tunnel" | "proxy" | "both" | "portmap" | "ipv6";
    site: string;
    tunnelParams: Record<string, string>;
    providerParams: Record<string, string>;
    serviceBasePath?: string;
  }>) => {
    const p = overrides?.provider ?? (protocol === "tcp" ? null : provider);
    const t = overrides?.tunnel ?? tunnel;
    const proto = overrides?.protocol ?? protocol;
    const m = overrides?.mode ?? (proto === "tcp" ? "tunnel" : mode);
    // P3a: portmap/ipv6 模式的表单参数（portmap 空值不传；ipv6 auto 不传 → 库自动检测）
    const portmapBody = m === "portmap"
      ? Object.fromEntries(Object.entries({
          ...(pmParams.method && pmParams.method !== "auto" ? { method: pmParams.method } : {}),
          ...(pmParams.gateway.trim() ? { gateway: pmParams.gateway.trim() } : {}),
          ...(pmParams.externalPort.trim() ? { externalPort: Number(pmParams.externalPort) } : {}),
          ...(pmParams.leaseSeconds.trim() ? { leaseSeconds: Number(pmParams.leaseSeconds) } : {}),
        }).filter(([, v]) => v !== "" && v !== undefined))
      : undefined;
    let ipv6Body: { address: string } | undefined;
    if (m === "ipv6") {
      const addr = ipv6Addr === "__manual" ? ipv6Manual.trim() : (ipv6Addr !== "auto" ? ipv6Addr : "");
      if (addr) ipv6Body = { address: addr };
    }
    const s = overrides?.site ?? site;
    const tp = overrides?.tunnelParams ?? tunnelParams;
    const pp = overrides?.providerParams ?? providerParams;
    const bp = overrides && "serviceBasePath" in overrides ? overrides.serviceBasePath : serviceBasePath;
    setBusy(true);
    setError(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "expose",
        port,
        auth: p !== "none" && proto !== "tcp",
        // tcp exposes never carry gateway auth — the library's expose tcp
        // path ignores the provider; send it as-is (no name hardcoding here).
        provider: p,
        tunnel: t,
        protocol: proto,
        mode: m,
        site: s || undefined,
        tunnelParams: tp,
        providerParams: pp,
        ...(portmapBody && Object.keys(portmapBody).length ? { portmap: portmapBody } : {}),
        ...(ipv6Body ? { ipv6: ipv6Body } : {}),
        ...(bp ? { serviceBasePath: bp } : {}),
        ...(injectSel.length ? { inject: injectSel } : {}),
        ...(loginInfoButton ? { loginInfoButton: true } : {}),
      }),
    })
      .then((r) => r.json())
      .then((d: { url?: string | null; loginUrl?: string; localUrl?: string; baseUrl?: string; domainUrl?: string; altUrls?: string[]; error?: string }) => {
        if (d.error) {
          setError(d.error);
          setResult(null);
        } else {
          setResult({ url: d.url ?? null, loginUrl: d.loginUrl, localUrl: d.localUrl, baseUrl: d.baseUrl, domainUrl: d.domainUrl, altUrls: d.altUrls });
          // 服务端已把本次选项记为「上次使用」——本地时间同步（下拉显示用）
          setLastUsedAt(Date.now());
          setPresetId("__last__");
          onChanged();
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const checkUsers = (overrides?: Parameters<typeof doExpose>[0]) => {
    const p = overrides ? (overrides.provider ?? "none") : (protocol === "tcp" ? null : provider);
    const s = overrides ? (overrides.site ?? "") : site;
    // 用户库清单未就绪(schema 拉取失败/进行中)→ fail-closed,提示重试而非静默公开
    if (!userManagersReady) {
      setError(t("services.userCheckUnavailable"));
      return;
    }
    // 无本地用户库的 provider(oauth2-proxy 等)→ 无可检查,直接公开
    if (!p || !userManagers.includes(p)) { doExpose(overrides); return; }
    setChecking(true);
    setError(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "user-list", provider: p, site: s || undefined }),
    })
      .then((r) => r.json())
      .then((d: { users?: { provider: string; users: { name: string; displayName: string }[] }[]; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        const entry = (d.users ?? []).find((x) => x.provider === provider);
        const users = entry?.users ?? [];
        if (users.length === 0) { setNoUsers({ provider, site: site || "default" }); return; }
        setUserConfirm({
          provider,
          site: site || "default",
          users: users.map((u) => u.displayName || u.name),
        });
      })
      .catch(() => setError(String(t("services.error"))))
      .finally(() => setChecking(false));
  };

  /** 待确认的公开参数（方案 actions.expose 传入；确认弹窗确认后执行）。 */
  const exposeOverrideRef = useRef<Parameters<typeof doExpose>[0] | null>(null);

  const go = (overrides?: Parameters<typeof doExpose>[0]) => {
    // 参数用 overrides ?? 表单 state（方案一键公开同样走完整安全链）
    exposeOverrideRef.current = overrides ?? null;
    const p = overrides ? (overrides.provider ?? "none") : (protocol === "tcp" ? null : provider);
    const proto = overrides ? (overrides.protocol ?? "http") : protocol;
    // auth=none(或 tcp 裸隧道,无网关认证)→ 直接公开有泄露风险,先确认
    if (p === "none" || proto === "tcp") {
      setConfirmNone(true);
      return;
    }
    // 带认证 → 检查对应 site+provider 是否有可登录用户,再公开
    checkUsers(overrides);
  };

  // 当前表单选择是否已经有一条 RUNNING 的暴露:端口 + 模式 + provider + 隧道
  // + 协议 + 站点全部一致才算“已暴露”→ 按钮变“停止”(只停这一条,同端口
  // 其他通道不受影响);其他情况按钮为“公开”——同一端口可同时开多条通道
  // (不同隧道 / 不同 provider)互为备份,一条挂了不至于掉线。
  // P3a: portmap/ipv6 不参与「已暴露」匹配（停止走列表行）；tcp 强制 tunnel 不变
  const effectiveMode: "tunnel" | "proxy" | "both" | "portmap" | "ipv6" = protocol === "tcp" ? "tunnel" : mode;
  const selectedProvider = protocol === "tcp" ? undefined : provider === "none" ? undefined : provider;
  const normSite = (s?: string) => (s === undefined || s === "" ? "default" : s);
  const existing = (mode === "portmap" || mode === "ipv6") ? undefined : exposes.find((e) => {
    if (e.port !== port || !e.running) return false;
    const m: "tunnel" | "proxy" | "both" = (e.name ?? "").startsWith("proxy:")
      ? "proxy"
      : // both-mode records carry localUrl ("" when transport is in-process,
        // i.e. pi-web's middleware); tunnel-only records have none.
        e.localUrl !== undefined
        ? "both"
        : "tunnel";
    if (m !== effectiveMode) return false;
    if (effectiveMode !== "proxy") {
      if (e.tunnelType !== tunnel) return false;
      if (e.protocol && e.protocol !== protocol) return false;
    }
    if ((e.provider ?? undefined) !== (selectedProvider ?? undefined)) return false;
    if (normSite(e.site) !== normSite(site || undefined)) return false;
    return true;
  });

  const stop = () => {
    if (!existing) return;
    setResult(null);
    setError(null);
    onStopExpose(existing.name);
  };

  const select = { padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, flexShrink: 0 };

  /** 当前表单选项 → 方案配置（保存/另存共用一份果照）。Base Path 跟端口走
   *  （inject-ports 登记），一并入方案，加载时同步回写。 */
  const currentConfig = () => ({
    provider: protocol === "tcp" ? null : (provider ?? null),
    tunnel: tunnel || "cloudflared",
    protocol,
    mode: protocol === "tcp" ? "tunnel" : mode,
    site: site || "",
    serviceBasePath: serviceBasePath ?? "",
    tunnelParams: { ...tunnelParams },
    providerParams: { ...providerParams },
    inject: [...injectSel],
    loginInfoButton,
    // 一键动作：方案应用后自动执行（enroll/expose/开启注入源）
    actions: {
      ...(presetActions.enroll ? { enroll: true } : {}),
      ...(presetActions.expose ? { expose: true } : {}),
    },
  });

  /** 方案名自动生成：【模式】+【auth】@站点（tcp 无 auth 段；站点空不挂）。 */
  const suggestPresetName = () => {
    const modePart = protocol === "tcp" ? "tunnel" : mode;
    const authPart = protocol === "tcp" || !provider || provider === "none" ? "none" : provider;
    const sitePart = site || "default";
    return `${modePart}+${authPart}@${sitePart}`;
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    setPresetBusy(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-save", name, presetConfig: currentConfig() }),
    })
      .then((r) => r.json())
      .then((d: { saved?: { id: string }; presets?: { presets: Array<{ id: string; name: string; updatedAt: number }> }; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        if (d.presets) setPresets(d.presets.presets ?? []);
        if (d.saved?.id) setPresetId(d.saved.id);
        setSaveOpen(false);
        setPresetName("");
        // 动作勾选重置为默认——避免下次另存时残留「立即公开」等误触发
        setPresetActions({ enroll: false, expose: false });
      })
      .catch(() => setError(t("services.error")))
      .finally(() => setPresetBusy(false));
  };

  const deletePreset = () => {
    if (presetId === "__last__") return;
    setPresetBusy(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-delete", id: presetId }),
    })
      .then((r) => r.json())
      .then((d: { presets?: { presets: Array<{ id: string; name: string; updatedAt: number }> }; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        if (d.presets) setPresets(d.presets.presets ?? []);
        setPresetId("__last__");
      })
      .catch(() => setError(t("services.error")))
      .finally(() => setPresetBusy(false));
  };


  // 表单就绪门控：首次加载（providerOrder/方案/探测回填完成）前不渲染表单——
  // 避免用户看到硬编码默认值 → 异步回填逐个跳变（provider/tunnel/mode/protocol
  // 依次替换，“精分”）。readyRef 保证只在首帧骨架后一次到位。
  // 就绪条件：providers 已拉回（providerOrder 决定默认 provider）且「上次使用」
  // 回填流程已决定（有记录 → 回填完；无记录 → 保持默认）。
  // 表单就绪门控：providers 已拉回 **且** 预设回填已决定（lastUsed 异步加载完成/
  // 无预设/fetch 失败）前不渲染表单——避免用户看到默认值→异步回填逐个跳变
  // （provider/tunnel/mode 依次替换，“精分”）。
  // forceReady：3s 兜底——预设 fetch 异常挂起时不至于永远空白。
  const [formReady, setFormReady] = useState(false);
  const [forceReady, setForceReady] = useState(false);
  const presetsSettled = !presetBusy;
  useEffect(() => {
    if (providers.length > 0 && (presetsSettled || forceReady) && !formReady) {
      const t = setTimeout(() => setFormReady(true), 0);
      return () => clearTimeout(t);
    }
  }, [providers, presetsSettled, forceReady, formReady]);
  useEffect(() => {
    const t = setTimeout(() => setForceReady(true), 3000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "10px 0 0", marginTop: 10, background: "var(--bg-panel)" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "4px 0 6px" }}>
        {t("services.exposeSection")}
      </div>
      {!formReady ? (
        /* 骨架：加载中占位（高度近似，避免跳动） */
        <div style={{ padding: "14px 0", fontSize: 11, color: "var(--text-dim)" }}>⏳ {t("services.exposeLoading")}</div>
      ) : (
      <Fragment>
      {/* 方案：下拉选已存方案/上次使用；另存当前选项为方案 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.preset")}</span>
        <select
          value={presetId}
          onChange={(e) => { setPresetId(e.target.value); loadPresetIntoForm(e.target.value); }}
          disabled={presetBusy}
          style={select}
          title={t("services.presetHint")}
        >
          <option value="__last__">
            {lastUsedAt ? `${t("services.presetLastUsed")}（${new Date(lastUsedAt).toLocaleString()}）` : t("services.presetLastUsedNone")}
          </option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {presetId !== "__last__" && (
          <button onClick={deletePreset} disabled={presetBusy} title={t("services.presetDeleteHint")}
            style={{ flexShrink: 0, padding: "3px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "#f87171", cursor: "pointer", fontSize: 11 }}>
            {t("services.presetDelete")}
          </button>
        )}
        {!saveOpen ? (
          <button onClick={() => { setSaveOpen(true); setPresetName(suggestPresetName()); }}
            title={t("services.presetSaveAsHint")}
            style={{ flexShrink: 0, padding: "3px 10px", background: "var(--bg-hover)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text)", cursor: "pointer", fontSize: 11 }}>
            ＋ {t("services.presetSaveAs")}
          </button>
        ) : (
          <>
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") savePreset(); if (e.key === "Escape") { setSaveOpen(false); setPresetName(""); } }}
              placeholder={t("services.presetNamePlaceholder")}
              autoFocus
              style={{ padding: "3px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, width: 120 }}
            />
            <button onClick={savePreset} disabled={presetBusy || !presetName.trim()}
              style={{ flexShrink: 0, padding: "3px 10px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: presetBusy || !presetName.trim() ? "default" : "pointer", fontSize: 11 }}>
              {t("services.presetSave")}
            </button>
            {/* 一键动作：应用方案时自动执行（登记/公开/开启注入源） */}
            <div style={{ width: "100%", display: "flex", gap: 10, flexWrap: "wrap", padding: "2px 0 0", fontSize: 10, color: "var(--text-dim)" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} title={t("services.presetActionsEnrollHint")}>
                <input type="checkbox" checked={!!presetActions.enroll} onChange={(e) => setPresetActions((p) => ({ ...p, enroll: e.target.checked }))} style={{ accentColor: "var(--accent)" }} />
                {t("services.presetActionsEnroll")}
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} title={t("services.presetActionsExposeHint")}>
                <input type="checkbox" checked={!!presetActions.expose} onChange={(e) => setPresetActions((p) => ({ ...p, expose: e.target.checked }))} style={{ accentColor: "var(--accent)" }} />
                {t("services.presetActionsExpose")}
              </label>
            </div>
            <button onClick={() => { setSaveOpen(false); setPresetName(""); }}
              style={{ flexShrink: 0, padding: "3px 10px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
              {t("services.exposeAbort")}
            </button>
          </>
        )}
      </div>
      {/* 模式（tcp 仅 tunnel） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeMode")}</span>
        <select value={protocol === "tcp" ? "tunnel" : mode} onChange={(e) => setMode(e.target.value as "tunnel" | "proxy" | "both" | "portmap" | "ipv6")} disabled={protocol === "tcp"} style={select}>
          <option value="tunnel">{t("services.exposeModeTunnel")}</option>
          <option value="proxy">{t("services.exposeModeProxy")}</option>
          <option value="both">{t("services.exposeModeBoth")}</option>
          {(!caps?.exposeModes || caps.exposeModes.includes("portmap")) && <option value="portmap">portmap (router)</option>}
          {(!caps?.exposeModes || caps.exposeModes.includes("ipv6")) && <option value="ipv6">ipv6 (direct)</option>}
        </select>
        {/* 站点（认证域）只对有本地用户库的 provider（basic/authelia/portal，
            库的 userManagers）有意义——none/oauth2 系无用户库，站点字段不适用，
            不渲染。 */}
        {(provider ?? "") !== "none" && userManagers.includes(provider ?? "") && (
          <>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeSite")}</span>
            <select value={site} onChange={(e) => setSite(e.target.value)} style={select}>
              <option value="">{t("services.exposeSiteDefault")}</option>
              {sites.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </>
        )}
      </div>
      {/* tunnel 选项 + 协议（仅 tunnel/both；proxy/portmap/ipv6 无隧道） */}
      {modeAllowsTunnel && (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeProtocol")}</span>
        <select value={protocol} onChange={(e) => { const p = e.target.value as "http" | "https" | "tcp"; setProtocol(p); if (p === "tcp") setTunnel((cur) => (tcpTunnels.includes(cur) ? cur : (tcpTunnels[0] ?? cur))); if (p === "tcp") setMode("tunnel"); }} style={select}>
          <option value="http">http</option>
          <option value="https">https</option>
          <option value="tcp">tcp</option>
        </select>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeTunnelTool")}</span>
        <select value={tunnel} onChange={(e) => setTunnel(e.target.value)} style={select}>
          {[...Object.entries(tunnelSchemas ?? {})]
            // dangerous types (library TunnelMeta.dangerous — "command" runs a
            // raw shell command) are hidden from the one-click picker; name
            // fallback keeps older service-tunnels versions safe too.
            .filter(([p]) => !tunnelMetas?.[p]?.dangerous && p !== "command")
            .filter(([p]) => protocol !== "tcp" || tcpTunnels.includes(p))
            // 推荐(零账号/参数少)优先, 再按参数数量少在前
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
      </div>
      )}
      {/* tunnel 参数 */}
      {modeAllowsTunnel && tunnelSchemas?.[tunnel] && (
        <div style={{ marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
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
      {/* P3a: portmap 模式——路由器映射参数 + 探测路由器 */}
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
      {/* P3a: ipv6 模式——候选地址下拉（懒加载；auto/候选含出口标注/手动输入） */}
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
      {/* Base Path：公开表单字段（端口真实服务前缀，如 vite base=/dev → dev）。
          编辑失焦/回车即写 binding（持久化）；公开/另存方案也带上。 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Base Path</span>
        <input
          type="text"
          value={bpDraft ?? serviceBasePath ?? ""}
          placeholder={t("services.injectJsBasePathPlaceholder")}
          onChange={(e) => setBpDraft(e.target.value)}
          onBlur={() => { if (bpDraft !== null) { onSetBasePath?.(port, bpDraft); setBpDraft(null); } }}
          onKeyDown={(e) => { if (e.key === "Enter") { onSetBasePath?.(port, bpDraft ?? serviceBasePath ?? ""); setBpDraft(null); (e.target as HTMLInputElement).blur(); } }}
          title={t("services.injectJsBasePathHint")}
          style={{ width: 90, padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)" }}
        />
      </div>
      {/* 登录信息按钮（库内置注入）：FAB 显示登录用户名 + 退出登录——仅带认证 provider */}
      {provider && provider !== "none" && protocol !== "tcp" && (
        <label style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8, fontSize: 10, cursor: "pointer", color: loginInfoButton ? "var(--text)" : "var(--text-dim)" }} title={t("services.loginInfoButtonHint")}>
          <input
            type="checkbox"
            checked={loginInfoButton}
            onChange={(e) => setLoginInfoButton(e.target.checked)}
            style={{ accentColor: "var(--accent)", cursor: "pointer" }}
          />
          👤 {t("services.loginInfoButton")}
        </label>
      )}
      {/* 注入源勾选：公开配置的一部分（本通道页面注入哪些源）——随公开提交 */}
      {injectSources.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>🧰 {t("services.injectJs")}</span>
          {injectSources.map((s) => {
            const on = injectSel.includes(s.id);
            return (
              <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, cursor: "pointer", color: on ? "var(--text)" : "var(--text-dim)" }} title={s.description ?? ""}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => setInjectSel((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))}
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                />
                {s.label}
              </label>
            );
          })}
        </div>
      )}
      {/* auth 选项 + 立即公开（认证 provider 在站点之前——站点仅对
          basic/authelia/portal 适用，跟认证联动） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeProvider")}</span>
        <select value={provider ?? ""} onChange={(e) => {
          const next = e.target.value;
          setProvider(next);
          // 切到无本地用户库的 provider（none/oauth2 系）→ 站点不适用，清空
          if (!userManagers.includes(next)) setSite("");
        }} style={select}>
          <option value="" disabled>{t("services.selectProvider")}</option>
          {providers.map((p) => <option key={p} value={p}>{providerDisplayLabel(p, t, authMetas)}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        {existing ? (
          <button
            onClick={stop}
            title={t("services.exposeStopHint")}
            style={{ flexShrink: 0, padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
          >
            {t("services.exposeStop")}
          </button>
        ) : (
          <button
            onClick={go}
            disabled={busy || checking}
            style={{ flexShrink: 0, padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: busy || checking ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
          >
            {busy ? t("services.exposing") : t("services.exposeGo")}
          </button>
        )}
      </div>
      {/* auth 参数 */}
      {provider && provider !== "none" && authSchemas?.[provider] && authSchemas[provider].length > 0 && (
        <div style={{ marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }}>{t("services.authParams")}</div>
          <SchemaForm specs={authSchemas[provider]} values={providerParams} onChange={(k, v) => setProviderParams((prev) => ({ ...prev, [k]: v }))} t={t} />
        </div>
      )}
      {error && <div style={{ fontSize: 11, color: "#f87171", marginTop: 6 }}>{t("services.exposeFailed")}: {error}</div>}
      {result && (result.url || result.localUrl || result.baseUrl || result.domainUrl || (result.altUrls ?? []).length > 0) && (
        <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeResult")}</div>
          {[result.url, result.localUrl, result.baseUrl, result.domainUrl, ...(result.altUrls ?? [])].filter(Boolean).map((u) => (
            <button key={u} onClick={() => openInNewTab(u!)}
              style={{ display: "block", maxWidth: "100%", marginTop: 2, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", textAlign: "left", overflowWrap: "anywhere", wordBreak: "break-all" }}>
              {u}
            </button>
          ))}
          {result.loginUrl && (
            <button onClick={() => openInNewTab(result.loginUrl!)}
              style={{ marginTop: 6, padding: "4px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 }}>
              {t("services.openLogin")}
            </button>
          )}
        </div>
      )}
      {confirmNone && (
        <ConfirmDialog
          title={t("services.confirmNoAuthTitle")}
          body={t("services.confirmNoAuthBodyPort", { port: String(port) })}
          confirmLabel={t("services.exposeConfirm")}
          cancelLabel={t("services.exposeAbort")}
          onConfirm={() => { setConfirmNone(false); doExpose(exposeOverrideRef.current); exposeOverrideRef.current = null;; }}
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
          onConfirm={() => { setUserConfirm(null); doExpose(exposeOverrideRef.current); exposeOverrideRef.current = null;; }}
          onCancel={() => setUserConfirm(null)}
        />
      )}
      </Fragment>
      )}
    </div>
  );
}
