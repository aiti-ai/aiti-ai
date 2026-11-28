/**
 * aiti-channels · admin URL derivation (F4, pure — unit-tested).
 *
 * Order: explicit adminOrigin (settings.json) → same-port subdomain swap on the
 * page origin (example.com:57442 → example.com:57442, scheme/port carried over)
 * → "" (panel shows an editable hint). NEVER invents a plausible-looking fake
 * domain — the v2 hard-coded cc.pi.example.com:8443 is the anti-pattern here.
 */

export function deriveAdminUrl(cfg: any, pageOrigin: string | null, adminOrigin?: string | null): string {
  const token = cfg?.management?.token || "";
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  if (adminOrigin && adminOrigin.trim()) return adminOrigin.trim().replace(/\/+$/, "") + "/" + q;
  if (!pageOrigin) return "";
  try {
    const u = new URL(pageOrigin);
    const h = u.hostname;
    // loopback / bare IP / IPv6 have no subdomain to swap — no guess
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h === "localhost" || h.endsWith(".localhost") || h.includes(":")) return "";
    const cc = new URL(pageOrigin);
    cc.hostname = `cc.${h}`;
    return cc.origin + "/" + q;
  } catch { return ""; }
}
