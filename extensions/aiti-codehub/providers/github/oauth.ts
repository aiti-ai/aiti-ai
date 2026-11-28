/**
 * GitHub OAuth: device flow (RFC 8628) with a shared OAuth App (Device Flow enabled).
 * No client secret, no callback. Endpoint paths work for github.com and GHES.
 */
import { postForm } from "../../server/oauth-helpers.ts";
import type { DeviceGrant, DevicePollResult, ForgeOAuthDriver, OAuthMeta, OAuthTokens, ProviderConfig } from "../../server/contract.ts";
import { getUser, webBase } from "./api.ts";

function allowedHosts(cfg: ProviderConfig): string[] {
  try {
    return ["github.com", new URL(webBase(cfg)).hostname];
  } catch {
    return ["github.com"];
  }
}

export function endpointsFor(cfg: ProviderConfig): OAuthMeta {
  const base = webBase(cfg);
  return { authorizationEndpoint: `${base}/login/device/code`, tokenEndpoint: `${base}/login/oauth/access_token` };
}

function toTokens(raw: unknown): OAuthTokens {
  const o = (raw || {}) as Record<string, unknown>;
  const expiresIn = Number(o.expires_in);
  return {
    accessToken: String(o.access_token || ""),
    refreshToken: o.refresh_token ? String(o.refresh_token) : undefined,
    tokenType: o.token_type ? String(o.token_type) : "bearer",
    expiry: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
  };
}

export const githubOAuth: ForgeOAuthDriver = {
  mode: "device-code",
  scope: "read:user read:org repo",
  // Public shared OAuth App (Device Flow enabled). Settings clientId overrides it.
  defaultClientId: "Ov23livau47c6u0EG4PX",
  metaFor: (cfg) => endpointsFor(cfg),

  authorizeUrl() {
    throw new Error("GitHub uses the device flow; no authorization URL");
  },

  async deviceStart(cfg, _meta, p): Promise<DeviceGrant> {
    const raw = (await postForm(`${webBase(cfg)}/login/device/code`, {
      client_id: p.clientId,
      scope: p.scope || "read:user read:org repo",
    }, { allowedHosts: allowedHosts(cfg) })) as Record<string, unknown>;
    return {
      deviceCode: String(raw.device_code || ""),
      userCode: String(raw.user_code || ""),
      verificationUri: String(raw.verification_uri || ""),
      verificationUriComplete: raw.verification_uri_complete ? String(raw.verification_uri_complete) : undefined,
      expiresIn: Number(raw.expires_in) || 900,
      interval: Number(raw.interval) || 5,
    };
  },

  async devicePoll(cfg, _meta, p): Promise<DevicePollResult> {
    const raw = (await postForm(`${webBase(cfg)}/login/oauth/access_token`, {
      client_id: p.clientId,
      device_code: p.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }, { allowedHosts: allowedHosts(cfg) })) as Record<string, unknown>;
    const error = raw.error ? String(raw.error) : "";
    if (error === "authorization_pending") return { status: "pending" };
    if (error === "slow_down") return { status: "slow_down" };
    if (error) throw new Error(`${error}: ${String(raw.error_description || "")}`);
    return toTokens(raw);
  },

  async exchange() {
    throw new Error("GitHub device flow has no authorization-code exchange");
  },

  async account(cfg, _http, tokens) {
    const account = await getUser({ ...cfg, token: tokens.accessToken });
    return { ...account, provider: "github" };
  },
};

