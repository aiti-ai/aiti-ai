/**
 * Gitee OAuth driver (authorization code). Requires a Gitee third-party application.
 */
import { postForm } from "../../server/oauth-helpers.ts";
import type { ForgeOAuthDriver, OAuthTokens, ProviderConfig } from "../../server/contract.ts";
import { getUser } from "./api.ts";

const ALLOWED = ["gitee.com"];

export function endpoints(): { authorizationEndpoint: string; tokenEndpoint: string } {
  return {
    authorizationEndpoint: "https://gitee.com/oauth/authorize",
    tokenEndpoint: "https://gitee.com/oauth/token",
  };
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

export const giteeOAuth: ForgeOAuthDriver = {
  mode: "client-credentials",
  scope: "projects issues",
  metaFor: () => endpoints(),

  authorizeUrl(_cfg, meta, input) {
    const url = new URL(meta.authorizationEndpoint);
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", input.state);
    if (input.scope) url.searchParams.set("scope", input.scope);
    return url.toString();
  },

  async exchange(cfg: ProviderConfig, meta, input) {
    const raw = await postForm(meta.tokenEndpoint, {
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    }, { allowedHosts: ALLOWED });
    const tokens = toTokens(raw);
    if (!tokens.accessToken) throw new Error("Gitee token exchange returned no access_token");
    return tokens;
  },

  async refresh(_cfg, meta, input) {
    const raw = await postForm(meta.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    }, { allowedHosts: ALLOWED });
    const tokens = toTokens(raw);
    if (!tokens.accessToken) throw new Error("Gitee token refresh returned no access_token");
    return tokens;
  },

  async account(cfg, _http, tokens) {
    const account = await getUser({ ...cfg, token: tokens.accessToken });
    return { ...account, provider: "gitee" };
  },
};

export const GITEE_ENDPOINTS = endpoints();
