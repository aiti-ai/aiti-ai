import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidBasicAuthorization,
  isWebPasswordEnabled,
} from "@/lib/web-auth";
import { isServicePortAllowed, getServiceHostSuffixes, stripBasePath } from "@/lib/service-proxy-shared";
import { proxyTarget } from "service-tunnels";

/**
 * Virtual-host service proxy + pi-web security gate.
 *
 * A request whose Host is `<port><suffix>` (e.g. 5173.pi.localhost) is
 * rewritten to http://127.0.0.1:<port> with the path left untouched, so the
 * proxied app's absolute URLs (/assets/..., /api/..., form actions, fetches)
 * keep resolving within the same virtual host. Only ports discovered on
 * pi-web's own process tree (see lib/service-ports.ts) are proxied; the
 * discovered set is cached and doubles as the allow-list.
 *
 * Service hosts still pass through the same DNS-rebinding and password checks
 * as pi-web itself — `*.pi.localhost` is loopback (allowed by default), and
 * remote suffixes must be added to PI_WEB_ALLOWED_HOSTS like any other host.
 *
 * Browsers resolve *.pi.localhost to 127.0.0.1 natively (RFC 6761), so local
 * use needs no DNS. For remote browsers set PI_WEB_SVC_HOST_SUFFIX (e.g.
 * .pi.lan with a wildcard DNS entry, or .svc.example.com).
 */
/**
 * Accepted service suffixes, in priority order: .pi.localhost, the explicit
 * PI_WEB_SVC_HOST_SUFFIX, and every operator-configured host from
 * PI_WEB_HOSTNAME / PI_WEB_ALLOWED_HOSTS. A deployment served at example.com
 * therefore answers <port>.example.com without extra configuration (the domain
 * is already trusted by the request-security gate).
 */
const SVC_HOST_RE = (() => {
  const alts = getServiceHostSuffixes().map((s) =>
    s.replace(/^\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  );
  return new RegExp(`^(\\d{2,5})\\.(${alts.join("|")})$`, "i");
})();

function isServiceHostRequest(request: NextRequest): number | null {
  const hostname = (request.headers.get("host") ?? "").split(":")[0].toLowerCase();
  const m = SVC_HOST_RE.exec(hostname);
  return m ? Number(m[1]) : null;
}

// pi-web's own sub-path deployment prefix (empty for root deployments). Service
// URLs carry it (so reverse proxies that path-route pi-web send them here) and
// it is stripped before forwarding so the service sees the original path.
const BASE_PATH = (process.env.PI_WEB_BASE_PATH ?? "").replace(/\/+$/, "");

export function proxy(request: NextRequest) {
  const svcPort = isServiceHostRequest(request);

  // Service virtual hosts route before the pi-web API gate: the path belongs
  // to the proxied service, not pi-web. Host allow-listing comes from the
  // suffix regex itself (loopback + PI_WEB_SVC_HOST_SUFFIX + configured
  // allowed hosts), so no extra host check here; the port allow-list
  // (discovery cache) and the password gate still apply.
  if (svcPort !== null) {
    if (!isServicePortAllowed(svcPort)) {
      return new NextResponse("Service port not allowed", { status: 403 });
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
    // target 由库的 proxyTarget() 构造：path 拼在显式 127.0.0.1:<port>
    // authority 之后，永不被 URL 解析器当 base-relative 覆盖（//evil.com、
    // //127.0.0.1:9999、反斜杠都只是普通 path）→ 无 SSRF 注入面。
    return NextResponse.rewrite(
      proxyTarget(svcPort, stripBasePath(request.nextUrl.pathname, BASE_PATH) + request.nextUrl.search),
    );
  }

  // pi-web's own security gate: DNS-rebinding protection + password.
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
