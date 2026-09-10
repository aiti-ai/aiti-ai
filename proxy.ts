import { NextResponse, type NextRequest } from "next/server";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidWebSessionToken,
  isValidBasicAuthorization,
  isWebPasswordEnabled,
  PI_WEB_SESSION_COOKIE,
} from "@/lib/web-auth";

/**
 * pi-web security gate（service-tunnels 已抽离为扩展）。
 *
 * pi-web's own traffic passes the DNS-rebinding / password gate. Service
 * virtual hosts (`<port>[-<label>].<domain>`) and the allowlocal direct-access
 * gate are handled by the service-tunnels EXTENSION's middleware hook (called
 * below, before the core gates): its vhost/proxy/auth decisions run in-process
 * against the library instance shared on globalThis (created by the extension
 * at startup). Unhandled requests fall through to the core gates here.
 */

// Extension middleware hooks (registry lives on globalThis, created by the
// app server in instrumentation — the middleware bundle never imports
// extension code). Extensions own their host/path namespaces; unhandled
// requests fall through to the core gates. A throwing hook is fail-closed.
export async function proxy(request: NextRequest) {
  const extRegistry = globalThis.__piWebExt;
  if (extRegistry) {
    try {
      const extRes = await extRegistry.middleware(request);
      if (extRes.handled) return extRes.response;
    } catch (err) {
      console.error("[pi-web] extension middleware failed:", err);
      return new NextResponse("extension middleware error", {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
  }

  // pi-web's own security gate: DNS-rebinding protection + password. The host
  // allow-list includes the allowlocal exception hosts (deployment domains +
  // explicit allowHost from the service-tunnels extension's self-expose
  // config, read via configuredHostnamesFromEnvironment) so operator-protected
  // front domains pass both gates.
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  // 扩展静态资源（/api/extensions/<id>/<file>.<js|html|...>）：script/img 标签 no-cors 加载
  // 跨域无 Origin/Origin:null 时默认门禁会 403——静态资源是公共产物（无敏感数据），放行；
  // 扩展 API（claim/sse/mcp 等，带数据语义）保持门禁（API_ALLOW_ORIGINS 配置放行 + secret 凭证）。
  // 扩展声明的公开 API（publicApi，如 service-tunnels 注入的无后缀端点 meter-version）同样放行。
  const extApiMatch = isApiRequest
    ? request.nextUrl.pathname.match(/^\/api\/extensions\/([^/]+)\/(.+)$/)
    : null;
  const isPublicApi = !!(extApiMatch
    && typeof (globalThis as unknown as { __piWebExtIsPublicApi?: (extId: string, apiPath: string) => boolean }).__piWebExtIsPublicApi === "function"
    && (globalThis as unknown as { __piWebExtIsPublicApi: (extId: string, apiPath: string) => boolean }).__piWebExtIsPublicApi(extApiMatch[1], extApiMatch[2]));
  const isStaticAsset = isApiRequest
    && (/^\/api\/extensions\/[^/]+\/[^/]+\.(js|mjs|html|css|json|map)$/.test(request.nextUrl.pathname)
      || isPublicApi);
  const isTrustedRequest = isApiRequest
    ? (isStaticAsset || isApiRequestAllowed(request))
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const password = process.env.PI_WEB_PASSWORD;
  if (!isWebPasswordEnabled(password)) {
    if (request.nextUrl.pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  const authenticated = isValidWebSessionToken(request.cookies.get(PI_WEB_SESSION_COOKIE)?.value, password)
    || (isApiRequest && isValidBasicAuthorization(request.headers.get("authorization"), password));
  if (request.nextUrl.pathname === "/login") {
    return authenticated
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }
  if (request.nextUrl.pathname === "/api/web-auth") return NextResponse.next();

  if (!authenticated) {
    if (!isApiRequest) {
      const loginUrl = new URL("/login", request.url);
      if (request.nextUrl.search) {
        loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      }
      return NextResponse.redirect(loginUrl);
    }
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

// No matcher: the proxy must see every request so extension middleware hooks
// (service vhosts, tunnel-domain mapping) are intercepted before the gates.
// Non-matching hosts return NextResponse.next() immediately from the ext hook
// chain, so pi-web's own traffic is unaffected apart from the security gate.
