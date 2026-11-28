/**
 * OAuth device-code flow (RFC 8628) for GitHub / GitLab.
 *
 * Polling is the one protocol-mandated exception to the "no polling" rule: the token
 * endpoint must be polled at the server-provided interval while a login is pending.
 * The loop stops on success, cancellation, expiry or an unrecoverable error.
 */
import type { DeviceGrant, ForgeOAuthDriver, ForgeProvider, OAuthMeta, ProviderConfig } from "./contract.ts";
import { createHttp } from "./http.ts";

interface DeviceRuntime {
  store: import("./store.ts").Store;
  publish: (topic: string, data: Record<string, unknown>) => void;
}

interface DeviceSession {
  /** Instance id (multi-account): the session map key. */
  provider: string;
  /** Platform id (adapter + event payloads). */
  platform: string;
  clientId: string;
  grant: DeviceGrant;
  meta: OAuthMeta;
  interval: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
  lastError?: string;
}

const sessions = new Map<string, DeviceSession>();
/** Last outcome per instance (so the UI can explain why the code vanished). */
const outcomes = new Map<string, { state: "success" | "error" | "expired" | "cancelled"; error?: string; userCode?: string; at: number }>();

export function activeDevice(providerId: string): DeviceSession | undefined {
  return sessions.get(providerId);
}

export function deviceStatus(instanceId: string): Record<string, unknown> {
  const s = sessions.get(instanceId);
  if (s) {
    return {
      state: "pending",
      userCode: s.grant.userCode,
      verificationUri: s.grant.verificationUri,
      verificationUriComplete: s.grant.verificationUriComplete,
      interval: s.interval,
      expiresAt: s.expiresAt,
    };
  }
  const o = outcomes.get(instanceId);
  return o ? { ...o } : { state: "idle" };
}

export function cancelDevice(instanceId: string): boolean {
  const s = sessions.get(instanceId);
  if (!s) return false;
  s.cancelled = true;
  if (s.timer) clearTimeout(s.timer);
  outcomes.set(instanceId, { state: "cancelled", userCode: s.grant.userCode, at: Date.now() });
  sessions.delete(instanceId);
  return true;
}

function stop(s: DeviceSession): void {
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  sessions.delete(s.provider);
}

function schedule(rt: DeviceRuntime, provider: ForgeProvider, driver: ForgeOAuthDriver, cfg: ProviderConfig, s: DeviceSession): void {
  if (s.cancelled) return;
  const wait = Math.max(1, s.interval) * 1000;
  s.timer = setTimeout(() => {
    void poll(rt, provider, driver, cfg, s);
  }, wait);
  try {
    (s.timer as unknown as { unref?: () => void }).unref?.();
  } catch {
    /* ignore */
  }
}

async function poll(rt: DeviceRuntime, provider: ForgeProvider, driver: ForgeOAuthDriver, cfg: ProviderConfig, s: DeviceSession): Promise<void> {
  if (s.cancelled) return;
  if (Date.now() >= s.expiresAt) {
    outcomes.set(s.provider, { state: "expired", error: "device_code_expired", userCode: s.grant.userCode, at: Date.now() });
    stop(s);
    rt.store.saveProvider(s.provider, { needsLogin: true });
    rt.publish("aiti-codehub:oauth", { instance: s.provider, platform: s.platform, ok: false, error: "device_code_expired" });
    return;
  }
  try {
    const r = await driver.devicePoll!(cfg, s.meta, { clientId: s.clientId, deviceCode: s.grant.deviceCode });
    if ("status" in r && r.status === "pending") {
      schedule(rt, provider, driver, cfg, s);
      return;
    }
    if ("status" in r && r.status === "slow_down") {
      s.interval += 5;
      schedule(rt, provider, driver, cfg, s);
      return;
    }
    const tokens = r as import("./contract.ts").OAuthTokens;
    const dummy = createHttp(provider.defaultBaseUrl || "https://invalid.local");
    // The token is the login result; an account/profile read failure (e.g. GitLab
    // app without read_user) must not discard it. Store the token and flag the
    // account error for the settings UI instead.
    let account: import("./contract.ts").ForgeAccount | undefined;
    let accountError: string | undefined;
    try {
      account = await driver.account(cfg, dummy, tokens);
    } catch (e) {
      accountError = e instanceof Error ? e.message : String(e);
    }
    const patch: Partial<ProviderConfig> = {
      authType: "oauth",
      clientId: s.clientId,
      ...(account ? { account } : {}),
      ...(accountError ? { accountError } : { accountError: undefined }),
      needsLogin: false,
    };
    const org = (cfg.orgId || account?.extra?.orgId || "").trim();
    if (org) patch.orgId = org;
    rt.store.setTokens(s.provider, tokens, patch);
    outcomes.set(s.provider, { state: "success", userCode: s.grant.userCode, at: Date.now() });
    stop(s);
    rt.publish("aiti-codehub:oauth", { instance: s.provider, platform: s.platform, ok: true, account, ...(accountError ? { accountError } : {}) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Transient network errors keep retrying; explicit protocol errors stop the flow.
    if (/authorization_pending/i.test(message)) {
      schedule(rt, provider, driver, cfg, s);
      return;
    }
    if (/slow_down/i.test(message)) {
      s.interval += 5;
      schedule(rt, provider, driver, cfg, s);
      return;
    }
    s.lastError = message;
    outcomes.set(s.provider, { state: "error", error: message, userCode: s.grant.userCode, at: Date.now() });
    stop(s);
    rt.store.saveProvider(s.provider, { needsLogin: true });
    rt.publish("aiti-codehub:oauth", { instance: s.provider, platform: s.platform, ok: false, error: message });
  }
}

/** Begin a device flow and start the server-side poll loop. */
export function beginDevice(
  rt: DeviceRuntime,
  provider: ForgeProvider,
  driver: ForgeOAuthDriver,
  cfg: ProviderConfig,
  meta: OAuthMeta,
  clientId: string,
  grant: DeviceGrant,
  instanceId: string,
): void {
  cancelDevice(instanceId);
  const s: DeviceSession = {
    provider: instanceId,
    platform: String(provider.id),
    clientId,
    grant,
    meta,
    interval: Math.max(1, Number(grant.interval) || 5),
    expiresAt: Date.now() + Math.max(30, Number(grant.expiresIn) || 900) * 1000,
    timer: null,
    cancelled: false,
  };
  outcomes.delete(instanceId);
  sessions.set(s.provider, s);
  schedule(rt, provider, driver, cfg, s);
}
