/**
 * Virtual OAuth landing page (non-/api path, so the provider redirect is not blocked by
 * pi-web's cross-site gate). Runs before the core gates; only exact instance paths are
 * handled, everything else is passed through untouched.
 *
 * The path segment is a platform id ("yunxiao" / "github" / ...): the account lives in
 * the OAuth state so every account of a platform reports the same redirect URI and can
 * share one DCR registration.
 */
import { landingHtml } from "./landing.ts";

const PROVIDER_RE = /\/aiti-codehub\/oauth\/([a-z0-9][a-z0-9_-]*)$/;

export function createMiddleware(hasPlatform: (id: string) => boolean) {
  return async (req: Request): Promise<{ handled: boolean; response?: Response }> => {
    try {
      if (req.method !== "GET") return { handled: false };
      const url = new URL(req.url);
      const path = url.pathname;
      // Never intercept the extension API (exchange/status/start live under /api).
      if (path.includes("/api/")) return { handled: false };
      const m = PROVIDER_RE.exec(path);
      if (!m) return { handled: false };
      const platform = m[1];
      if (!hasPlatform(platform)) return { handled: false };
      return {
        handled: true,
        response: new Response(landingHtml(platform), {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        }),
      };
    } catch {
      return { handled: false };
    }
  };
}
