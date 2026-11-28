/**
 * Yunxiao OAuth 2.0 driver — Dynamic Client Registration + PKCE (S256).
 *
 * No client_secret and no pre-registration: the first login registers a public client
 * with both redirect URIs (page origin + loopback) and stores the issued client_id.
 * Endpoints are discovered from /.well-known/oauth-authorization-server because the
 * authorization endpoint may live on another domain than the API.
 */
import { createHttp } from "../../server/http.ts";
import { getJson, postForm, postJson } from "../../server/oauth-helpers.ts";
import type { ForgeAccount, ForgeOAuthDriver, OAuthMeta, OAuthTokens, ProviderConfig } from "../../server/contract.ts";
import { ALLOWED_HOSTS, apiBase, DEFAULT_BASE_URL } from "./api.ts";

function toTokens(raw: unknown): OAuthTokens {
  const o = (raw || {}) as Record<string, unknown>;
  const expiresIn = Number(o.expires_in);
  return {
    accessToken: String(o.access_token || ""),
    refreshToken: o.refresh_token ? String(o.refresh_token) : undefined,
    tokenType: o.token_type ? String(o.token_type) : "Bearer",
    expiry: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
  };
}

async function discover(cfg: ProviderConfig): Promise<OAuthMeta> {
  const base = apiBase(cfg) || DEFAULT_BASE_URL;
  const raw = (await getJson(`${base}/.well-known/oauth-authorization-server`, { allowedHosts: ALLOWED_HOSTS })) as Record<string, unknown>;
  const authorizationEndpoint = String(raw.authorization_endpoint || "");
  const tokenEndpoint = String(raw.token_endpoint || "");
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error("Yunxiao OAuth metadata is incomplete");
  return {
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: raw.registration_endpoint ? String(raw.registration_endpoint) : undefined,
    issuer: raw.issuer ? String(raw.issuer) : undefined,
  };
}

export const yunxiaoOAuth: ForgeOAuthDriver = {
  mode: "dcr-pkce",
  discover,

  async register(cfg, meta, redirectUris) {
    const endpoint = meta.registrationEndpoint;
    if (!endpoint) throw new Error("Yunxiao OAuth metadata has no registration endpoint");
    const raw = (await postJson(endpoint, {
      client_name: "aiti-codehub",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, { allowedHosts: ALLOWED_HOSTS })) as Record<string, unknown>;
    const clientId = String(raw.client_id || "");
    if (!clientId) throw new Error("Yunxiao DCR did not return a client_id");
    return { clientId, raw };
  },

  authorizeUrl(_cfg, meta, input) {
    const url = new URL(meta.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", input.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (input.scope) url.searchParams.set("scope", input.scope);
    return url.toString();
  },

  async exchange(cfg, meta, input) {
    const raw = await postForm(meta.tokenEndpoint, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    }, { allowedHosts: ALLOWED_HOSTS });
    const tokens = toTokens(raw);
    if (!tokens.accessToken) throw new Error("Yunxiao token exchange returned no access_token");
    return tokens;
  },

  async refresh(cfg, meta, input) {
    const raw = await postForm(meta.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    }, { allowedHosts: ALLOWED_HOSTS });
    const tokens = toTokens(raw);
    if (!tokens.accessToken) throw new Error("Yunxiao token refresh returned no access_token");
    return tokens;
  },

  async account(cfg, _http, tokens) {
    const http = createHttp(apiBase(cfg), {
      headers: {
        "x-yunxiao-token": tokens.accessToken,
        authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    const raw = await http.json<Record<string, unknown>>("/oapi/v1/platform/user");
    const last = raw.lastOrganization;
    const orgId = typeof last === "string"
      ? last
      : last && typeof last === "object"
        ? String((last as Record<string, unknown>).id || (last as Record<string, unknown>).identifier || "")
        : "";
    const account: ForgeAccount = {
      provider: "yunxiao",
      userId: String(raw.id || ""),
      username: String(raw.username || raw.nickName || ""),
      displayName: String(raw.name || raw.nickName || raw.username || ""),
      avatarUrl: raw.avatarUrl ? String(raw.avatarUrl) : undefined,
      extra: orgId ? { orgId } : undefined,
    };
    return account;
  },
};
