/**
 * Generic OAuth orchestration.
 *
 * Three modes:
 *  - dcr-pkce        Yunxiao: metadata discovery + DCR + PKCE; landing page at
 *                    /<basePath?>/aiti-codehub/oauth/<provider> (middleware), same-origin
 *                    exchange, default callback base http://127.0.0.1:30141;
 *  - device-code     GitHub / GitLab: shared public app, no secret, no callback; the
 *                    server polls the token endpoint at the protocol interval;
 *  - client-credentials  pre-registered app (kept for future/self-hosted cases).
 *
 * Secrets never leave the server. State is one-shot (10 min); PKCE is S256.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DeviceGrant, ForgeAccount, ForgeOAuthDriver, ForgeProvider, OAuthMeta, OAuthTokens, ProviderConfig } from "./contract.ts";
import { createHttp, ForgeHttpError } from "./http.ts";
import type { ForgeRegistry } from "./registry.ts";
import type { Store } from "./store.ts";
import { beginDevice } from "./device.ts";
import { platformOf } from "./instances.ts";

export interface OAuthRuntime {
  store: Store;
  registry: ForgeRegistry;
  publish: (topic: string, data: Record<string, unknown>) => void;
}

const META_TTL_MS = 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function basePath(): string {
  const raw = String(process.env.PI_WEB_BASE_PATH || "").trim();
  if (!raw) return "";
  const p = "/" + raw.replace(/^\/+|\/+$/g, "");
  return p === "/" ? "" : p;
}

function firstHeader(req: Request, names: string[]): string {
  for (const n of names) {
    const v = req.headers.get(n);
    if (v && v.trim()) return v.trim();
  }
  return "";
}

function safeHost(host: string): string {
  const h = String(host || "").replace(/[\r\n\t ]/g, "");
  if (!h || !/^[A-Za-z0-9.:[\]-]+$/.test(h)) throw new Error("invalid host");
  return h;
}

function pageOrigin(req: Request): string {
  const proto = firstHeader(req, ["x-forwarded-proto"]) || new URL(req.url).protocol.replace(":", "") || "http";
  const host = firstHeader(req, ["x-forwarded-host", "host"]);
  if (!host) throw new Error("cannot derive the page origin from the request");
  return `${proto}://${safeHost(host)}`;
}

/** Public origin derived from the request (used by the settings UI to show the page callback). */
export function pageOriginForConfig(req: Request): string {
  return pageOrigin(req);
}

/**
 * Landing page URL for a callback base (base may already include a basePath).
 * The path segment is the PLATFORM, not the account: DCR registrations bind exact
 * redirect URIs, so a site-wide client can only be shared when every account of that
 * platform reports the same callback. The account travels in the OAuth `state`.
 */
export function landingUrl(base: string, platform: string): string {
  const b = String(base || "").trim().replace(/\/+$/, "");
  return `${b}/aiti-codehub/oauth/${encodeURIComponent(platform)}`;
}

function validateCallbackBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ForgeHttpError("OAuth callback base is not a valid URL", { status: 400, code: "bad_request" });
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ForgeHttpError("OAuth callback base must use https (loopback excepted)", { status: 400, code: "bad_request" });
  }
  return raw.replace(/\/+$/, "");
}

export interface OAuthStartInput {
  callbackMode?: "default" | "page" | "custom";
  customBase?: string;
}

export type OAuthStartResult =
  | { mode: "dcr-pkce" | "client-credentials"; url: string; redirectUri: string; callbackMode: string }
  | { mode: "device-code"; device: DeviceGrant };

async function metaFor(rt: OAuthRuntime, provider: ForgeProvider, cfg: ProviderConfig): Promise<OAuthMeta> {
  const driver = provider.auth.oauth;
  if (!driver) throw new Error(`${provider.id} does not support OAuth`);
  if (driver.metaFor) return driver.metaFor(cfg);
  if (driver.endpoints) return { ...driver.endpoints };
  if (!driver.discover) throw new Error(`${provider.id}: OAuth metadata source is missing`);
  const key = `oauth-meta:${cfg.baseUrl || provider.defaultBaseUrl || ""}`;
  const cached = rt.store.cacheGet<OAuthMeta>(String(provider.id), "meta", key, META_TTL_MS);
  if (cached) return cached;
  const dummy = createHttp(cfg.baseUrl || provider.defaultBaseUrl || "https://invalid.local");
  const meta = await driver.discover(cfg, dummy);
  rt.store.cacheSet(String(provider.id), "meta", key, meta);
  return meta;
}

function allCallbacks(rt: OAuthRuntime, platform: string, input: OAuthStartInput, req: Request): { chosen: string; all: string[]; mode: string } {
  const mode = input.callbackMode === "page" || input.callbackMode === "custom" ? input.callbackMode : "default";
  const globalBase = rt.store.global().oauthCallbackBase || "http://127.0.0.1:30141";
  const defaultCb = landingUrl(validateCallbackBase(globalBase), platform);
  const pageCb = landingUrl(pageOrigin(req) + basePath(), platform);
  const customCb = input.customBase ? landingUrl(validateCallbackBase(input.customBase), platform) : undefined;
  const all = [...new Set([defaultCb, pageCb, customCb].filter(Boolean) as string[])];
  const chosen = mode === "page" ? pageCb : mode === "custom" ? customCb || defaultCb : defaultCb;
  return { chosen, all, mode };
}

/** Start an OAuth flow for one account instance. */
export async function startOAuth(rt: OAuthRuntime, instanceId: string, input: OAuthStartInput, req: Request): Promise<OAuthStartResult> {
  const platform = platformOf(instanceId);
  const provider = rt.registry.get(platform);
  if (!provider) throw new ForgeHttpError(`unknown provider: ${platform}`, { status: 404, code: "not_found" });
  const driver = provider.auth.oauth;
  if (!driver) throw new ForgeHttpError(`${platform} does not support OAuth`, { status: 400, code: "bad_request" });

  const cfg = rt.store.provider(instanceId);
  const meta = await metaFor(rt, provider, cfg);

  if (driver.mode === "device-code") {
    const clientId = String(cfg.clientId || driver.defaultClientId || "").trim();
    if (!clientId) {
      throw new ForgeHttpError(`${instanceId}: fill in the shared app Client ID first (device-code sign-in)`, { status: 400, code: "bad_request" });
    }
    if (!driver.deviceStart) throw new ForgeHttpError(`${instanceId}: device-code driver is incomplete`, { status: 500, code: "server" });
    const grant = await driver.deviceStart(cfg, meta, { clientId, scope: driver.scope });
    beginDevice(rt, provider, driver, cfg, meta, clientId, grant, instanceId);
    return { mode: "device-code", device: grant };
  }

  const { chosen, all, mode } = allCallbacks(rt, platform, input, req);
  let clientId = String(cfg.clientId || "");
  if (driver.mode === "dcr-pkce" && driver.register) {
    const covers = (uris: string[]) => uris.length > 0 && all.every((u) => uris.includes(u));
    const registered = Array.isArray(cfg.clientRedirects) ? cfg.clientRedirects : [];
    if (!clientId || !covers(registered)) {
      // Registrations are per site, not per account: a second account on the same
      // site reuses the client created for the first one (same redirect URIs).
      const site = cfg.baseUrl || provider.defaultBaseUrl || "";
      const shared = rt.store.dcrClient(site);
      if (shared && covers(shared.redirects)) {
        clientId = shared.clientId;
        rt.store.saveProvider(instanceId, { clientId, clientRedirects: shared.redirects });
      } else {
        const reg = await driver.register(cfg, meta, all);
        clientId = reg.clientId;
        rt.store.saveProvider(instanceId, { clientId, clientRedirects: all });
        rt.store.saveDcrClient(site, clientId, all);
      }
    }
  }
  if (!clientId) {
    throw new ForgeHttpError(`${instanceId}: fill in Client ID / Client Secret in Settings first`, { status: 400, code: "bad_request" });
  }

  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(24));
  rt.store.putOauthPending({
    state,
    instance: instanceId,
    platform,
    provider: instanceId,
    verifier,
    redirectUri: chosen,
    clientId,
    createdAt: Date.now(),
  });
  const url = driver.authorizeUrl(cfg, meta, {
    clientId,
    redirectUri: chosen,
    state,
    codeChallenge: challenge,
    scope: driver.scope,
  });
  return { mode: driver.mode, url, redirectUri: chosen, callbackMode: mode };
}

export interface CallbackResult {
  ok: boolean;
  error?: string;
  account?: ForgeAccount;
}

/**
 * Complete a redirect flow. Callers pass either the account (manual paste, started by
 * one instance) or the platform (landing-page exchange, where the state owns the
 * account). The single-use state is always consumed here.
 */
export async function finishOAuth(
  rt: OAuthRuntime,
  target: { instance?: string; platform?: string } | string,
  code: string,
  state: string,
): Promise<CallbackResult> {
  // Legacy callers passed the instance id directly.
  const want = typeof target === "string" ? { instance: target } : target;
  const pending = rt.store.takeOauthPending(state);
  const pendingInstance = pending ? String(pending.instance || pending.provider || "") : "";
  const instanceId = String(want.instance || pendingInstance || "");
  const platform = want.platform || platformOf(instanceId);
  const matches = !!pending && (want.instance
    ? pendingInstance === want.instance
    : platformOf(pendingInstance) === platform);
  const provider = rt.registry.get(platform);
  if (!provider?.auth.oauth) return { ok: false, error: "provider does not support OAuth" };
  if (!matches || !instanceId) {
    rt.publish("aiti-codehub:oauth", { instance: instanceId, platform, ok: false, error: "invalid_state" });
    return { ok: false, error: "state is invalid or expired — start the sign-in again" };
  }

  const cfg = rt.store.provider(instanceId);
  try {
    const meta = await metaFor(rt, provider, cfg);
    const tokens = await provider.auth.oauth.exchange(cfg, meta, {
      clientId: pending.clientId,
      clientSecret: cfg.clientSecret,
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
    });
    const dummy = createHttp(provider.defaultBaseUrl || "https://invalid.local");
    const account = await provider.auth.oauth.account({ ...cfg, authType: "oauth", token: tokens.accessToken }, dummy, tokens);
    const patch: Partial<ProviderConfig> = {
      authType: "oauth",
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      account,
      needsLogin: false,
    };
    const org = (cfg.orgId || account.extra?.orgId || "").trim();
    if (org) patch.orgId = org;
    rt.store.setTokens(instanceId, tokens, patch);
    rt.publish("aiti-codehub:oauth", { instance: instanceId, platform, ok: true, account });
    return { ok: true, account };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    rt.store.saveProvider(instanceId, { needsLogin: true });
    rt.publish("aiti-codehub:oauth", { instance: instanceId, platform, ok: false, error: message });
    return { ok: false, error: message };
  }
}

/** Manual fallback: a pasted redirect URL (or code+state) completes the flow. */
export async function manualOAuth(rt: OAuthRuntime, instanceId: string, input: { url?: string; code?: string; state?: string }): Promise<CallbackResult> {
  let code = String(input.code || "");
  let state = String(input.state || "");
  if (input.url) {
    try {
      const u = new URL(input.url);
      if (u.searchParams.get("error")) return { ok: false, error: u.searchParams.get("error_description") || u.searchParams.get("error") || "authorization_error" };
      code = u.searchParams.get("code") || "";
      state = u.searchParams.get("state") || "";
    } catch {
      return { ok: false, error: "callback URL is not a valid URL" };
    }
  }
  if (!code || !state) return { ok: false, error: "missing code / state" };
  return finishOAuth(rt, { instance: instanceId }, code, state);
}

const refreshInflight = new Map<string, Promise<ProviderConfig>>();

/** Refresh the access token when it is close to expiry (single flight). */
export function refreshIfNeeded(rt: OAuthRuntime, instanceId: string): Promise<ProviderConfig> {
  const cfg = rt.store.provider(instanceId);
  if (cfg.authType !== "oauth" || !cfg.token) return Promise.resolve(cfg);
  if (!cfg.expiry) return Promise.resolve(cfg);
  if (cfg.expiry - Date.now() > REFRESH_MARGIN_MS) return Promise.resolve(cfg);
  if (!cfg.refreshToken) {
    rt.store.saveProvider(instanceId, { needsLogin: true });
    return Promise.reject(new ForgeHttpError("OAuth session expired — please sign in again", { status: 401, code: "auth" }));
  }
  const running = refreshInflight.get(instanceId);
  if (running) return running;

  const provider = rt.registry.get(platformOf(instanceId));
  const driver = provider?.auth.oauth;
  if (!provider || !driver?.refresh) {
    rt.store.saveProvider(instanceId, { needsLogin: true });
    return Promise.reject(new ForgeHttpError("This platform does not support automatic token refresh — please sign in again", { status: 401, code: "auth" }));
  }

  const task = (async () => {
    try {
      const meta = await metaFor(rt, provider, cfg);
      const tokens = await driver.refresh!(cfg, meta, {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        refreshToken: cfg.refreshToken!,
      });
      const next = rt.store.setTokens(instanceId, tokens, { authType: "oauth", needsLogin: false });
      rt.publish("aiti-codehub:oauth", { instance: instanceId, platform: provider.id, ok: true, refreshed: true });
      return next;
    } catch (e) {
      rt.store.saveProvider(instanceId, { needsLogin: true });
      const message = e instanceof Error ? e.message : String(e);
      rt.publish("aiti-codehub:oauth", { instance: instanceId, platform: provider.id, ok: false, error: message });
      throw new ForgeHttpError(`OAuth token refresh failed: ${message}`, { status: 401, code: "auth" });
    } finally {
      refreshInflight.delete(instanceId);
    }
  })();
  refreshInflight.set(instanceId, task);
  return task;
}

/** Redacted OAuth status for the settings UI. */
export function oauthStatus(rt: OAuthRuntime, instanceId: string): Record<string, unknown> {
  const cfg = rt.store.provider(instanceId);
  return {
    authType: cfg.authType || (rt.registry.get(platformOf(instanceId))?.auth.oauth ? "oauth" : "pat"),
    hasToken: !!cfg.token,
    hasRefreshToken: !!cfg.refreshToken,
    hasClientSecret: !!cfg.clientSecret,
    needsLogin: !!cfg.needsLogin,
    expiry: cfg.expiry,
    clientId: cfg.clientId || "",
    redirectUri: cfg.redirectUri || "",
    account: cfg.account || null,
    accountError: cfg.accountError || "",
  };
}

export type { OAuthTokens, ForgeOAuthDriver };
