"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "@/lib/base-path";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

/** /api/extensions/status 返回的一行。 */
interface ExtStatusEntry {
  loaded: boolean;
  enabled?: boolean;
  error?: string;
  name?: string;
  version?: string;
  source?: string;
}

interface ExtStatusResponse {
  loaded: boolean;
  extensionsRoot: string;
  extraExtensionsRoots: string[];
  bundledExtensionsRoot: string;
  dataRoot: string;
  extensions: Record<string, ExtStatusEntry>;
}

/** 前端 loader 的 client 加载状态（graph / materialized）。 */
interface ClientLoadState {
  materialized: string[];
  prefetched: string[];
}

const SOURCE_LABELS: Record<string, string> = {
  user: "user",
  extra: "extra",
  dev: "dev",
  bundled: "bundled",
};

/**
 * 扩展管理界面（参考 PluginsConfig 的模态框形态）：
 *  - 列表：id / name / version / source / enabled / loaded / error
 *  - 操作：启用/禁用（持久化 + 热重载）、全部 reload、查看 client 加载状态
 *  - client 加载状态：哪些扩展已 materialize（bundle 已拉取 + register 已执行）
 */
export function ExtensionsConfig({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [status, setStatus] = useState<ExtStatusResponse | null>(null);
  const [clientLoad, setClientLoad] = useState<ClientLoadState>({ materialized: [], prefetched: [] });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/api/extensions/status"), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus(await res.json() as ExtStatusResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 读取前端 loader 的 client 加载状态（materialized / prefetched）。
  const readClientLoad = useCallback(async () => {
    const { materializedIds, prefetchedIds } = await import("./ext-client-loader");
    setClientLoad({ materialized: materializedIds(), prefetched: prefetchedIds() });
  }, []);

  useEffect(() => { void readClientLoad(); }, [readClientLoad]);

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(apiUrl("/api/extensions/status"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: enabled ? "enable" : "disable", id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
      // reload 会改 graph；前端 loader 也重拉 manifest 让变更生效。
      const { reloadExtensions } = await import("./ExtSlots");
      await reloadExtensions();
      await readClientLoad();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh, readClientLoad]);

  const reloadAll = useCallback(async () => {
    setBusy("*");
    setError(null);
    try {
      const { reloadExtensions } = await import("./ExtSlots");
      await reloadExtensions();
      await refresh();
      await readClientLoad();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh, readClientLoad]);

  const entries = status
    ? Object.entries(status.extensions).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 400,
        background: "rgba(0,0,0,0.45)", display: "flex",
        alignItems: "center", justifyContent: "center",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: isMobile ? "calc(100vw - 24px)" : 680,
          maxWidth: "calc(100vw - 24px)",
          maxHeight: "min(680px, 82vh)",
          display: "flex", flexDirection: "column",
          background: "var(--bg-panel)", border: "1px solid var(--border)",
          borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
          overflow: "hidden",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", flex: 1 }}>🧩 {t("extensions.title")}</span>
          <button
            type="button"
            onClick={() => void reloadAll()}
            disabled={busy !== null}
            style={actionBtn}
          >
            {busy === "*" ? "…" : t("extensions.reload")}
          </button>
          <button type="button" onClick={onClose} style={actionBtn}>{t("extensions.close")}</button>
        </div>

        {error && (
          <div style={{ padding: "8px 16px", fontSize: 12, color: "#ef4444", background: "rgba(239,68,68,0.08)", borderBottom: "1px solid var(--border)" }}>
            {error}
          </div>
        )}

        {/* list */}
        <div style={{ flex: 1, overflowY: "auto", padding: 8 }}>
          {!status ? (
            <div style={{ padding: 20, fontSize: 12, color: "var(--text-muted)" }}>…</div>
          ) : entries.length === 0 ? (
            <div style={{ padding: 20, fontSize: 12, color: "var(--text-muted)" }}>{t("extensions.none")}</div>
          ) : (
            entries.map(([id, entry]) => (
              <div
                key={id}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 10px", borderRadius: 8,
                  border: "1px solid var(--border)", marginBottom: 6,
                  background: "var(--bg)",
                }}
              >
                {/* identity */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{id}</span>
                    {entry.source && (
                      <span style={chip("var(--text-dim)", "var(--bg-hover)")}>{SOURCE_LABELS[entry.source] ?? entry.source}</span>
                    )}
                    {!entry.enabled && <span style={chip("#d97706", "rgba(217,119,6,0.12)")}>{t("extensions.disabled")}</span>}
                    {clientLoad.materialized.includes(id) && (
                      <span style={chip("#10b981", "rgba(16,185,129,0.12)")}>{t("extensions.clientLoaded")}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.name}{entry.version ? ` · v${entry.version}` : ""}
                    {!entry.enabled ? "" : entry.error ? ` · ⚠ ${entry.error}` : ""}
                  </div>
                </div>

                {/* actions */}
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  {entry.enabled === false ? (
                    <button type="button" disabled={busy === id} onClick={() => void setEnabled(id, true)} style={actionBtn}>
                      {busy === id ? "…" : t("extensions.enable")}
                    </button>
                  ) : (
                    <button type="button" disabled={busy === id || !entry.loaded} onClick={() => void setEnabled(id, false)} style={actionBtn}>
                      {busy === id ? "…" : t("extensions.disable")}
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* footer: roots */}
        {status && (
          <div style={{ padding: "8px 16px", borderTop: "1px solid var(--border)", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", lineHeight: 1.6 }}>
            <div>user: {status.extensionsRoot}</div>
            {status.extraExtensionsRoots.length > 0 && <div>extra: {status.extraExtensionsRoots.join(", ")}</div>}
            <div>bundled: {status.bundledExtensionsRoot}</div>
            <div>data: {status.dataRoot}</div>
          </div>
        )}
      </div>
    </div>
  );
}

const actionBtn: React.CSSProperties = {
  padding: "4px 12px", borderRadius: 6, fontSize: 12, cursor: "pointer",
  background: "var(--bg-hover)", border: "1px solid var(--border)",
  color: "var(--text)", whiteSpace: "nowrap",
};

function chip(color: string, bg: string): React.CSSProperties {
  return {
    padding: "0 7px", borderRadius: 8, fontSize: 10,
    background: bg, color, whiteSpace: "nowrap",
  };
}
