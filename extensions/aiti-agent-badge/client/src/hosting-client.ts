/**
 * Hosting data client for aiti-agent-badge.
 *
 * - GET /api/sessions/[id]/hosting: agent identity + live hosting snapshot
 * - POST same path: switch a cold/idle pi session's hosting mode
 * - live refresh: aiti-event-bus `running` topic (no polling, no fallback
 *   channel; if the bus is absent the manual refresh button still works)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, extSvc } from "./host-shim";

export type HostingMode = "in-process" | "subprocess" | "subprocess-detached";
export type HostingModeState = HostingMode | "external" | "tui-bridge" | null;
export type LocalizedText = string | { en?: string; zh?: string };

export type HostingModeOption = {
  mode: HostingMode;
  available: boolean;
  reason?: string;
};

export type HostingInfo = {
  ok: true;
  sessionId: string;
  nativeSessionId: string;
  sessionFile?: string;
  cwd?: string;
  agent: string;
  /** pi can also run in-process; external backends only host subprocesses. */
  agentKind: "pi" | "external";
  agentLabel?: LocalizedText;
  agentHint?: LocalizedText;
  agentDescription?: LocalizedText;
  providerType?: string;
  providerLabel?: string;
  alive: boolean;
  running: boolean;
  mode: HostingModeState;
  detached: boolean;
  detachedPreference: boolean;
  nextStartMode: HostingMode;
  runner?: string;
  detachAvailable: boolean;
  detachReason?: string;
  switchSupported: boolean;
  switchDisabledReason: "running" | "external" | "tui-bridge" | "unsupported" | null;
  modes: HostingModeOption[];
};

export type SwitchResult = {
  ok: true;
  mode: HostingMode;
  info: HostingInfo;
};

export type HostingState = {
  info: HostingInfo | null;
  loading: boolean;
  error: string | null;
  switching: HostingMode | null;
};

const EMPTY: HostingState = { info: null, loading: false, error: null, switching: null };

export function localizeText(value: LocalizedText | undefined, locale: string): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (!value) return undefined;
  const zh = locale.toLowerCase().startsWith("zh");
  return (zh ? value.zh : value.en) || value.en || value.zh || undefined;
}

async function readJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
  return body;
}

export async function fetchHosting(sessionId: string): Promise<HostingInfo> {
  const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/hosting`), {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  return (await readJson(response)) as HostingInfo;
}

export async function switchHosting(sessionId: string, mode: HostingMode): Promise<SwitchResult> {
  const response = await fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/hosting`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ mode }),
  });
  return (await readJson(response)) as SwitchResult;
}

type SubscribeTopics = (
  handler: (frame: Record<string, unknown>) => void,
  types: string[],
) => { ready?: boolean; off?: () => void } | undefined;

export function useHosting(sessionId: string | null | undefined) {
  const [state, setState] = useState<HostingState>(EMPTY);
  const requestRef = useRef(0);
  const infoRef = useRef<HostingInfo | null>(null);

  useEffect(() => {
    infoRef.current = state.info;
  }, [state.info]);

  const refresh = useCallback(async (silent = false) => {
    if (!sessionId) return;
    const seq = ++requestRef.current;
    if (!silent) setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const info = await fetchHosting(sessionId);
      if (seq !== requestRef.current) return;
      setState((prev) => ({ ...prev, info, loading: false, error: null }));
    } catch (error) {
      if (seq !== requestRef.current) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [sessionId]);

  useEffect(() => {
    requestRef.current++;
    if (!sessionId) {
      setState(EMPTY);
      return;
    }
    setState(EMPTY);
    void refresh();
    return () => { requestRef.current++; };
  }, [sessionId, refresh]);

  // Live running-set updates: the bus frame is the only automatic trigger.
  // Mode changes made elsewhere are picked up by the manual refresh button.
  const running = state.info?.running ?? false;
  const nativeSessionId = state.info?.nativeSessionId;
  useEffect(() => {
    if (!sessionId) return;
    const subscribe = extSvc<SubscribeTopics>("aiti-event-bus.subscribe-topics");
    if (typeof subscribe !== "function") return;
    let last = running;
    let subscription: { off?: () => void } | undefined;
    try {
      subscription = subscribe((frame) => {
        if (!frame || frame.type !== "running" || !Array.isArray(frame.runningSessionIds)) return;
        const ids = frame.runningSessionIds as string[];
        const now = ids.includes(sessionId) || (nativeSessionId ? ids.includes(nativeSessionId) : false);
        if (now === last) return;
        last = now;
        void refresh(true);
      }, ["running"]);
    } catch {
      return;
    }
    return () => {
      try { subscription?.off?.(); } catch { /* already gone */ }
    };
  }, [sessionId, nativeSessionId, running, refresh]);

  const switchMode = useCallback(async (mode: HostingMode): Promise<{ ok: boolean; error?: string }> => {
    if (!sessionId) return { ok: false, error: "session id is missing" };
    setState((prev) => ({ ...prev, switching: mode, error: null }));
    try {
      const result = await switchHosting(sessionId, mode);
      setState((prev) => ({ ...prev, info: result.info ?? prev.info, switching: null, error: null }));
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => ({ ...prev, switching: null, error: message }));
      return { ok: false, error: message };
    }
  }, [sessionId]);

  return { ...state, refresh, switchMode };
}

export type HostingController = ReturnType<typeof useHosting>;
