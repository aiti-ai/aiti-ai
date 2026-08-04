import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { apiUrl, BASE_PATH } from "@/lib/base-path";
import { copyText } from "@/lib/clipboard";

export interface ServicePortInfo {
  port: number;
  pid: number;
  process: string;
  cmdline: string;
  /** Every concrete address the port is listening on (wildcards expanded). */
  addresses: string[];
}

interface TunnelInfo {
  name: string;
  cmd: string;
  running: boolean;
  pid: number | null;
  url: string | null;
  lastOutput: string;
}

interface TunnelCommandTemplate {
  name: string;
  cmd: string;
  requiresAuth?: boolean;
}

interface ServicesResponse {
  services: ServicePortInfo[];
  serviceHostSuffix: string;
  serviceHostSuffixes: string[];
  tunnels: TunnelInfo[];
  platform: string;
}

function formatAddrForUrl(addr: string): string {
  return addr.includes(":") ? `[${addr}]` : addr;
}

function isLikelyIp(hostname: string): boolean {
  if (hostname.includes(":")) return true; // IPv6 literal
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

export function ServicesDialog({ onClose }: { onClose: () => void }) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [data, setData] = useState<ServicesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const refresh = useCallback((force = false) => {
    if (!force) setLoading(false);
    fetch(apiUrl(`/api/services${force ? "?refresh=1" : ""}`))
      .then((r) => r.json())
      .then((d: ServicesResponse) => {
        setData(d);
        setError(null);
      })
      .catch(() => setError(String(t("services.error"))))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    refresh(true);
    const id = setInterval(() => refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const scheme = typeof window !== "undefined" ? window.location.protocol : "http:";
  const pagePort = typeof window !== "undefined" && window.location.port
    ? `:${window.location.port}`
    : "";
  const hostname = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";

  // Suffixes in display priority: current page domain first (so a deployment at
  // example.com proposes <port>.example.com:<page-port>), then the configured ones.
  const suffixes = data?.serviceHostSuffixes ?? [".pi.localhost"];
  const tunnels = data?.tunnels ?? [];
  const currentDomainSuffix =
    hostname && !isLikelyIp(hostname) && hostname !== "localhost"
      ? `.${hostname}`
      : null;
  const orderedSuffixes = currentDomainSuffix
    ? [currentDomainSuffix, ...suffixes.filter((s) => s !== currentDomainSuffix)]
    : suffixes;

  // Service URLs carry pi-web's basePath (e.g. /dev) so reverse proxies that
  // path-route pi-web (nginx `location /dev/`) forward them here; proxy.ts
  // strips the basePath before reaching the service. No trailing slash: with a
  // basePath, ".../dev/" triggers Next's basePath 308 redirect.
  const proxyUrl = (port: number, suffix: string) => `${scheme}//${port}${suffix}${pagePort}${BASE_PATH}`;
  const directUrl = (port: number, addr: string) => `http://${formatAddrForUrl(addr)}:${port}/`;

  // Open in a new browser TAB: window.open without size features opens a tab,
  // and the button click is a user gesture so popup blockers allow it.
  // so popup blockers allow it.
  const openInNewTab = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const copy = (key: string, url: string) => {
    copyText(url).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    }).catch(() => {});
  };

  // Only startup-configured tunnels in the footer section; one-off per-port
  // tunnels (name port-<port>-<tool>) live in their port card instead.
  const configuredTunnels = tunnels.filter((tun) => !tun.name.startsWith("port-"));

  // Per-port tunnels grouped by port, for the global bar at the top of the list.
  const portTunnelsByPort = new Map<number, TunnelInfo[]>();
  for (const tun of tunnels) {
    const m = /^port-(\d+)-(.+)$/.exec(tun.name);
    if (!m) continue;
    const port = Number(m[1]);
    const arr = portTunnelsByPort.get(port) ?? [];
    arr.push(tun);
    portTunnelsByPort.set(port, arr);
  }

  const revealPort = useCallback((port: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(port);
      return next;
    });
    // Wait for the expanded drawer to render, then scroll the card into view.
    setTimeout(() => {
      document.getElementById(`port-card-${port}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }, []);

  const toggleTunnel = useCallback((req: { action: "start" | "stop"; name?: string; port?: number; tool?: string }) => {
    fetch(apiUrl("/api/tunnels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    })
      .then((r) => r.json())
      .then((d: { tunnels?: TunnelInfo[] }) => {
        const t = d.tunnels;
        if (t) setData((prev) => (prev ? { ...prev, tunnels: t } : prev));
      })
      .catch(() => {});
  }, []);

  const toggleExpand = (port: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(port)) next.delete(port);
      else next.add(port);
      return next;
    });
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{
        width: isMobile ? "calc(100vw - 16px)" : 600,
        maxWidth: "calc(100vw - 16px)",
        height: isMobile ? "calc(100dvh - 16px)" : "min(620px, 82vh)",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("services.title")}</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("services.auto")}</span>
          </div>
          <button onClick={onClose} title={t("services.close")} aria-label={t("services.close")} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
          {portTunnelsByPort.size > 0 && (
            <div style={{ padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>{t("services.activePortTunnels")}</div>
              {[...portTunnelsByPort.entries()].flatMap(([port, tuns]) =>
                tuns.map((tn) => ({ port, tn }))
              ).map(({ port, tn }) => (
                <div key={tn.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, background: "var(--bg)", marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--accent)", minWidth: 44, flexShrink: 0 }}>{port}</span>
                  <span style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 1 }}>
                    {tn.name.replace(`port-${port}-`, "")}
                  </span>
                  <span style={{ fontSize: 10, color: tn.running ? "#16a34a" : "var(--text-dim)", flexShrink: 0 }}>
                    {tn.running ? t("services.tunnelRunning") : t("services.tunnelStopped")}
                  </span>
                  <span style={{ flex: 1 }} />
                  {tn.running && tn.url ? (
                    <button onClick={() => openInNewTab(tn.url!)} style={{ flexShrink: 0, padding: "3px 12px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                      {t("services.open")}
                    </button>
                  ) : null}
                  <button onClick={() => revealPort(port)} style={{ flexShrink: 0, padding: "3px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
                    {t("services.details")}
                  </button>
                </div>
              ))}
            </div>
          )}
          {error ? (
            <div style={{ fontSize: 13, color: "#f87171", padding: 12 }}>{error}</div>
          ) : loading && !data ? (
            <div style={{ fontSize: 13, color: "var(--text-dim)", padding: 12 }}>{t("services.loading")}</div>
          ) : !data || data.services.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-dim)", padding: 20, textAlign: "center" }}>
              {t("services.none")}
            </div>
          ) : (
            data.services.map((s) => {
              const isOpen = expanded.has(s.port);
              const directUrls = s.addresses.map((addr) => ({ addr, url: directUrl(s.port, addr) }));
              const proxyUrls = orderedSuffixes.map((suffix) => ({ suffix, url: proxyUrl(s.port, suffix) }));
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
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.cmdline || s.process || `pid ${s.pid}`}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t("services.listenOn")} {s.addresses.join(", ")} · pid {s.pid}
                      </div>
                    </div>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      style={{ flexShrink: 0, color: "var(--text-dim)", transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>

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
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "10px 0 6px" }}>{t("services.viaProxy")}</div>
                      {proxyUrls.map(({ suffix, url }) => (
                        <UrlRow key={url} url={url}
                          isMobile={isMobile}
                          label={suffix === currentDomainSuffix ? t("services.currentDomain") : suffix === ".pi.localhost" ? t("services.sameMachine") : suffix}
                          copied={copiedKey === url} onCopy={() => copy(url, url)} onOpen={() => openInNewTab(url)} />
                      ))}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                        <button
                          onClick={() => openInNewTab(primaryUrl)}
                          style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, flexShrink: 0 }}
                        >
                          {t("services.open")}
                        </button>
                        <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{primaryUrl}</span>
                      </div>
                      <PortTunnelSection
                        port={s.port}
                        tunnels={tunnels}
                        toggleTunnel={toggleTunnel}
                        openInNewTab={openInNewTab}
                        copy={copy}
                        copiedKey={copiedKey}
                        t={t}
                        isMobile={isMobile}
                      />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Deployment explainer — collapsible sections (summary title, detail on click) */}
        <div style={{ padding: "8px 14px 10px", borderTop: "1px solid var(--border)", flexShrink: 0, background: "var(--bg-panel)", maxHeight: "38%", overflowY: "auto" }}>
          {/* Expose methods: DNS + tunnel */}
          <SummarySection title={t("services.expose")}>
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>
              <div>• {t("services.exposeLocal")}</div>
              <div>• {t("services.exposeLan")}</div>
              <div>• {t("services.exposePublic")}</div>
              {currentDomainSuffix && (
                <div>• {t("services.configCurrent", { host: currentDomainSuffix, pagePort, basePath: BASE_PATH })}</div>
              )}
              <div>• {t("services.exposeTunnel")}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, margin: "4px 0 2px 10px", whiteSpace: "pre-wrap" }}>{t("services.exposeTunnelExamples")}</div>
              {configuredTunnels.map((tun) => (
                <div key={tun.name} style={{ marginTop: 8, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontWeight: 600, color: "var(--text-muted)", fontSize: 11 }}>{tun.name}</span>
                    <span style={{ fontSize: 10, color: tun.running ? "#16a34a" : "var(--text-dim)" }}>
                      {tun.running ? t("services.tunnelRunning") : t("services.tunnelStopped")}
                      {tun.pid ? ` · pid ${tun.pid}` : ""}
                    </span>
                    <span style={{ flex: 1 }} />
                    {tun.running ? (
                      <button onClick={() => toggleTunnel({ action: "stop", name: tun.name })} style={{ padding: "3px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 }}>
                        {t("services.tunnelStop")}
                      </button>
                    ) : (
                      <button onClick={() => toggleTunnel({ action: "start", name: tun.name })} style={{ padding: "3px 10px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
                        {t("services.tunnelStart")}
                      </button>
                    )}
                  </div>
                  {tun.url ? (
                    <button onClick={() => openInNewTab(tun.url!)}
                      style={{ display: "block", marginTop: 4, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", textAlign: "left" }}>
                      {tun.url}
                    </button>
                  ) : (
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 4, wordBreak: "break-all" }}>{tun.cmd}</div>
                  )}
                  {!tun.url && tun.lastOutput && (
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-all", marginTop: 3, maxHeight: 60, overflowY: "auto" }}>{tun.lastOutput}</div>
                  )}
                </div>
              ))}
            </div>
          </SummarySection>

          {/* Access control warning before exposing */}
          <SummarySection title={t("services.auth")}>
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>
              {t("services.authBody").split("\n").map((line, i) => (
                <div key={i}>{line}</div>
              ))}
              <div style={{ color: "#d97706", marginTop: 4 }}>{t("services.authHint")}</div>
            </div>
          </SummarySection>
        </div>

        {/* Footer */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1, lineHeight: 1.5 }}>
            {t("services.hint")}
          </span>
          <button onClick={() => refresh(true)} disabled={loading} style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: loading ? "default" : "pointer", fontSize: 13, flexShrink: 0 }}>
            {t("services.refresh")}
          </button>
        </div>
      </div>
    </div>
  );
}

function PortTunnelSection({ port, tunnels, toggleTunnel, openInNewTab, copy, copiedKey, t, isMobile }: {
  port: number;
  tunnels: TunnelInfo[];
  toggleTunnel: (req: { action: "start" | "stop"; name?: string; port?: number; tool?: string }) => void;
  openInNewTab: (url: string) => void;
  copy: (key: string, url: string) => void;
  copiedKey: string | null;
  t: (key: string, params?: Record<string, string>) => string;
  isMobile: boolean;
}) {
  const [templates, setTemplates] = useState<TunnelCommandTemplate[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(apiUrl(`/api/tunnels?port=${port}`))
      .then((r) => r.json())
      .then((d: { templates?: TunnelCommandTemplate[] }) => {
        if (alive) setTemplates(d.templates ?? []);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [port]);

  // Per-tool tunnels coexist on one port (one localtunnel, one cloudflared, ...);
  // the global bar and the port card both list every tool.
  const portTunnels = tunnels.filter((tn) => tn.name.startsWith(`port-${port}-`));
  const openTools = new Set(portTunnels.map((tn) => tn.name.replace(`port-${port}-`, "")));
  const labelW = isMobile ? 62 : 80;

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "10px 0 0", marginTop: 10, background: "var(--bg-panel)" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "4px 0 6px" }}>
        {t("services.portTunnel")}
      </div>

      {/* Status cards for every open tool: URL on its own next line */}
      {portTunnels.map((tn) => (
        <div key={tn.name} style={{ padding: "8px 10px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)", marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", flexShrink: 0 }}>
              {tn.name.replace(`port-${port}-`, "")}
            </span>
            <span style={{ fontSize: 10, color: tn.running ? "#16a34a" : "var(--text-dim)", flexShrink: 0 }}>
              {tn.running ? t("services.tunnelRunning") : t("services.tunnelStopped")}
              {tn.pid ? ` · pid ${tn.pid}` : ""}
            </span>
            <span style={{ flex: 1 }} />
            <button onClick={() => toggleTunnel({ action: tn.running ? "stop" : "start", name: tn.name })}
              style={{ flexShrink: 0, padding: "4px 14px", background: tn.running ? "none" : "var(--accent)", border: tn.running ? "1px solid var(--border)" : "none", borderRadius: 5, color: tn.running ? "var(--text-muted)" : "#fff", cursor: "pointer", fontSize: 11, fontWeight: tn.running ? 400 : 600 }}>
              {tn.running ? t("services.tunnelStop") : t("services.tunnelStart")}
            </button>
          </div>
          {tn.url ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7 }}>
              <button onClick={() => openInNewTab(tn.url!)}
                title={tn.url}
                style={{ flex: 1, minWidth: 0, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: isMobile ? 10 : 11, color: "var(--accent)", textAlign: "left", overflowWrap: "anywhere", wordBreak: "break-all" }}>
                {tn.url}
              </button>
              <button onClick={() => copy(`active-${tn.name}`, tn.url!)}
                title={copiedKey === `active-${tn.name}` ? "✓" : "⧉"}
                style={{ flexShrink: 0, width: 24, height: 24, background: "none", border: "none", borderRadius: 5, color: copiedKey === `active-${tn.name}` ? "#16a34a" : "var(--text-dim)", cursor: "pointer", fontSize: 12 }}>
                {copiedKey === `active-${tn.name}` ? "✓" : "⧉"}
              </button>
            </div>
          ) : (
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 6, overflowWrap: "anywhere", wordBreak: "break-all" }}>{tn.cmd}</div>
          )}
        </div>
      ))}

      {/* Templates for tools NOT open on this port yet */}
      {templates === null ? null : templates.filter((tpl) => !openTools.has(tpl.name)).map((tpl) => (
        <div key={tpl.name} style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 6px", borderRadius: 6, background: "var(--bg)", marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", minWidth: labelW, flexShrink: 0 }}>
            {tpl.name}{tpl.requiresAuth ? ` (${t("services.needsAuth")})` : ""}
          </span>
          <code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: isMobile ? 9 : 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{tpl.cmd}</code>
          <button onClick={() => copy(`tpl-${port}-${tpl.name}`, tpl.cmd)}
            title={copiedKey === `tpl-${port}-${tpl.name}` ? "✓" : "⧉"}
            style={{ flexShrink: 0, width: 24, height: 24, background: "none", border: "none", borderRadius: 5, color: copiedKey === `tpl-${port}-${tpl.name}` ? "#16a34a" : "var(--text-dim)", cursor: "pointer", fontSize: 12 }}>
            {copiedKey === `tpl-${port}-${tpl.name}` ? "✓" : "⧉"}
          </button>
          <button onClick={() => toggleTunnel({ action: "start", port, tool: tpl.name })}
            style={{ flexShrink: 0, padding: "4px 12px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
            {t("services.tunnelStart")}
          </button>
        </div>
      ))}
      <div style={{ fontSize: 10, color: "var(--text-dim)", margin: "4px 0 8px" }}>{t("services.portTunnelHint")}</div>
    </div>
  );
}

function SummarySection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: "3px 0", cursor: "pointer", color: "var(--text-muted)", fontSize: 11, fontWeight: 600, textAlign: "left" }}
      >
        <span style={{ flex: 1 }}>{title}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && <div style={{ marginTop: 4 }}>{children}</div>}
    </div>
  );
}

function UrlRow({ url, label, copied, onCopy, onOpen, isMobile }: { url: string; label: string; copied: boolean; onCopy: () => void; onOpen: () => void; isMobile: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 6, background: "var(--bg)" }}>
      <span style={{ fontSize: 10, color: "var(--text-dim)", minWidth: isMobile ? 66 : 92, flexShrink: 0 }}>{label}</span>
      <button onClick={onOpen} title={url}
        style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {url}
      </button>
      <button onClick={onCopy} title={copied ? "✓" : "⧉"} style={{ flexShrink: 0, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 5, color: copied ? "#16a34a" : "var(--text-dim)", cursor: "pointer", fontSize: 12 }}>
        {copied ? "✓" : "⧉"}
      </button>
    </div>
  );
}
