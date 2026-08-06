import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidBasicAuthorization,
  isWebPasswordEnabled,
} from "@/lib/web-auth";
import {
  getPiWebPort,
  getAllowLocal,
  getAllowLocalHosts,
  mapSelfTunnelToVhost,
  issueSelfForwardToken,
  isValidSelfForwardToken,
} from "@/lib/service-proxy-shared";

/**
 * pi-web security gate + embedded service-vhost proxy.
 *
 * pi-web's own traffic passes the DNS-rebinding / password gate. Service
 * virtual hosts (`<port>[-<label>].<domain>`) are handled IN PROCESS by the
 * service-tunnels instance shared on globalThis (created by
 * lib/service-tunnels-integration.ts): `st.proxy.resolve()` returns the
 * enrollment/auth/forward decision, and Next forwards via rewrite (its
 * internal http-proxy handles both HTTP and WebSocket upgrades). There is
 * exactly ONE implementation of vhost routing / allow-list / 403 — the
 * library's — and one public port; no separate proxy listener.
 */

// The live library instance created by lib/service-tunnels-integration.ts in
// the SAME process (verified: shared globalThis with the app server).
function liveServiceTunnels() {
  return globalThis.__piServiceTunnels ?? null;
}

export async function proxy(request: NextRequest) {
  // Public tunnel-domain requests for pi-web's OWN exposure are mapped to its
  // proxy virtual host: the middleware then authenticates them through the
  // same resolve() path as every other gateway entry (no whitelist backdoor —
  // a forged Host still hits the auth provider).
  const st = liveServiceTunnels();
  let host = request.headers.get("host");
  if (host && st?.proxy?.parseHost) {
    const hostname = host.replace(/^\[|\]$/g, "").split(":")[0];
    if (!st.proxy.parseHost(hostname)) {
      const mapped = mapSelfTunnelToVhost(hostname);
      if (mapped) {
        request.headers.set("host", mapped);
        host = mapped;
      }
    }
  }

  // Service virtual hosts: the library's in-process decision API (parse,
  // enrollment, per-site auth backends, forward-auth probe, login redirect)
  // runs HERE — no separate proxy port, one public port. Next then forwards
  // the request (rewrite target) or answers 403/302/401.
  if (host && st?.proxy?.parseHost(host)) {
    let decision: Awaited<ReturnType<typeof st.proxy.resolve>>;
    try {
      decision = await st.proxy.resolve({
        host,
        url: request.nextUrl.pathname + request.nextUrl.search,
        method: request.method,
        authorization: request.headers.get("authorization") ?? undefined,
        cookie: request.headers.get("cookie") ?? undefined,
        remoteAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined,
        forwardedProto: (request.headers.get("x-forwarded-proto") as "http" | "https") ?? undefined,
      });
    } catch (err) {
      // Fail closed: an unexpected resolve error must never open a path
      // around the auth gateway — answer 403 like every other deny.
      console.error("[pi-web] service vhost resolve failed:", err);
      return new NextResponse("service-tunnels: resolve error", {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
    switch (decision.kind) {
      case "deny":
        return new NextResponse(`service-tunnels: ${decision.body}`, {
          status: 403,
          headers: { "cache-control": "no-store" },
        });
      case "deny-auth":
        return new NextResponse("Authentication required", {
          status: 401,
          headers: { "cache-control": "no-store", "www-authenticate": decision.wwwAuthenticate },
        });
      case "pipe": {
        const url = new URL(`http://127.0.0.1:${decision.port}`);
        url.pathname = decision.url.split("?")[0] ?? "/";
        url.search = decision.url.includes("?") ? `?${decision.url.split("?")[1]}` : "";
        if (decision.port === getPiWebPort()) {
          // Self-exposure forward: switch Host to the loopback target so the
          // request does NOT match a service virtual host again on re-entry
          // (avoids a rewrite loop); the public host is preserved under
          // x-forwarded-host. With allowlocal=false the direct-access gate
          // refuses loopback hosts too — so the forward carries a one-shot
          // proof token (random, server-side only, never seen by the browser)
          // that lets the gate tell this authenticated forward from a raw
          // direct connection.
          if (!getAllowLocal()) {
            url.search = `${url.search ? url.search + "&" : "?"}__piSelfFwd=${issueSelfForwardToken()}`;
          }
          request.headers.set("x-forwarded-host", host);
          request.headers.set("host", `127.0.0.1:${decision.port}`);
        } else {
          // Child-process dev server: keep the public host untouched.
          request.headers.set("host", host);
        }
        return NextResponse.rewrite(url);
      }
      case "redirect":
        return NextResponse.redirect(decision.location, 302);
      case "forward":
        request.headers.set("host", host);
        return NextResponse.rewrite(decision.target);
    }
  }

  // pi-web's own traffic: direct-access gate. With allowlocal=false, requests
  // whose Host is NOT an operator-trusted host (deployment domains / explicit
  // allowHost list) are refused — including LOOPBACK hosts. External traffic
  // must go through an authenticated gateway (service virtual host or tunnel
  // exposure); a raw `http://127.0.0.1:<port>` request must NOT bypass it. The
  // ONLY loopback exception is a request carrying a valid self-exposure
  // forward token: that is pi-web's own vhost→self forward re-entering this
  // middleware after Next's external rewrite (custom headers do not survive
  // the rewrite, so the proof rides in the rewrite URL). API paths are
  // EXEMPT: they are already guarded by isApiRequestAllowed below
  // (Origin/DNS-rebinding/CSRF checks), and the two-phase allowlocal flow
  // needs the confirm/rescue API reachable while temporarily disabled.
  const isApiPath = request.nextUrl.pathname === "/api" || request.nextUrl.pathname.startsWith("/api/");
  if (!getAllowLocal() && !isApiPath) {
    const hostHeader = (request.headers.get("host") ?? "").toLowerCase();
    const hostname = hostHeader.replace(/^\[|\]$/g, "").split(":")[0];
    const fwdToken = request.nextUrl.searchParams.get("__piSelfFwd");
    const isSelfForward = isValidSelfForwardToken(fwdToken ?? "");
    if (!isSelfForward && !getAllowLocalHosts().includes(hostname)) {
      return new NextResponse("Forbidden: direct access is disabled (allowlocal=false)", {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
  }

  // pi-web's own security gate: DNS-rebinding protection + password. The host
  // allow-list already includes the allowlocal exception hosts (deployment
  // domains + explicit allowHost) via configuredHostnamesFromEnvironment, so
  // operator-protected front domains pass both gates.
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (
    isWebPasswordEnabled(password)
    && !isValidBasicAuthorization(request.headers.get("authorization"), password)
  ) {
    return new NextResponse("Authentication required", {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
      },
    });
  }

  return NextResponse.next();
}

// No matcher: the proxy must see every request so service-host paths (assets,
// SPA routes, /api/* under the virtual host) are intercepted. Non-service
// hosts return NextResponse.next() immediately, so pi-web's own traffic is
// unaffected apart from the existing security gate.
