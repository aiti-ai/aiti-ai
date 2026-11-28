/**
 * GitLab OAuth: device flow (GitLab 17.1+, non-confidential application).
 * No client secret, no callback. Works for gitlab.com and self-hosted instances.
 */
import { postForm } from "../../server/oauth-helpers.ts";
import type { DeviceGrant, DevicePollResult, ForgeOAuthDriver, OAuthMeta, OAuthTokens, ProviderConfig } from "../../server/contract.ts";
import { getUser, webBase } from "./api.ts";

function allowedHosts(cfg: ProviderConfig): string[] {
  try {
    return ["gitlab.com", new URL(webBase(cfg)).hostname];
  } catch {
    return ["gitlab.com"];
  }
}

export function endpointsFor(cfg: ProviderConfig): OAuthMeta {
  const base = webBase(cfg);
  return { authorizationEndpoint: `${base}/oauth/authorize_device`, tokenEndpoint: `${base}/oauth/token` };
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

export const gitlabOAuth: ForgeOAuthDriver = {
  mode: "device-code",
  scope: "read_api read_user",
  // Public shared non-confidential Application (Device Flow, GitLab 17.1+).
  defaultClientId: "aa54a41e851666240c3e232394783ebb5bb708502e7288e634776e7ac22f578a",
  metaFor: (cfg) => endpointsFor(cfg),

  authorizeUrl() {
    throw new Error("GitLab uses the device flow; no authorization URL");
  },

  async deviceStart(cfg, _meta, p): Promise<DeviceGrant> {
    const raw = (await postForm(`${webBase(cfg)}/oauth/authorize_device`, {
      client_id: p.clientId,
      scope: p.scope || "read_api read_user",
    }, { allowedHosts: allowedHosts(cfg) })) as Record<string, unknown>;
    return {
      deviceCode: String(raw.device_code || ""),
      userCode: String(raw.user_code || ""),
      verificationUri: String(raw.verification_uri || raw.verification_url || ""),
      verificationUriComplete: raw.verification_uri_complete ? String(raw.verification_uri_complete) : undefined,
      expiresIn: Number(raw.expires_in) || 900,
      interval: Number(raw.interval) || 5,
    };
  },

  async devicePoll(cfg, _meta, p): Promise<DevicePollResult> {
    const raw = (await postForm(`${webBase(cfg)}/oauth/token`, {
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
    throw new Error("GitLab device flow has no authorization-code exchange");
  },

  async refresh(cfg, meta, input) {
    const raw = await postForm(meta.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    }, { allowedHosts: allowedHosts(cfg) }) as Record<string, unknown>;
    const tokens = toTokens(raw);
    if (!tokens.accessToken) throw new Error("GitLab token refresh returned no access_token");
    return tokens;
  },

  async account(cfg, _http, tokens) {
    const account = await getUser({ ...cfg, token: tokens.accessToken });
    return { ...account, provider: "gitlab" };
  },
};
